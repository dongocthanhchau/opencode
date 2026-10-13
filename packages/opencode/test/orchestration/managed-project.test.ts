import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-managed-project-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const pid of ["native-a", "native-b"]) {
        yield* db.run(
          sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(${pid},${root},'[]',${NOW},${NOW})`,
        )
      }
    }),
  )
})

afterAll(() => runtime.dispose())

test("register creates a planning row and re-registering the slug is idempotent", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      const first = yield* svc.registerManagedProject({ slug: "cvismem", type: "core", owner: "CVIS", mission: "Own memory" })
      const row = yield* svc.getManagedProject({ id: first.id })
      expect(row.slug).toBe("cvismem")
      expect(row.status).toBe("planning")
      expect(row.native_project_id).toBeNull()
      const second = yield* svc.registerManagedProject({ slug: "cvismem", type: "work" })
      expect(second.id).toBe(first.id)
      const rows = yield* svc.listManagedProjects({})
      expect(rows.filter((r) => r.slug === "cvismem")).toHaveLength(1)
    }),
  )
})

test("register rejects bad slugs and unknown types", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      for (const slug of ["Bad Slug", "x", "a".repeat(60), ""]) {
        const exit = yield* svc.registerManagedProject({ slug }).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }
      const exit = yield* svc.registerManagedProject({ slug: "valid-slug", type: "nope" }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})

test("link binds a native project and refuses ambiguous or missing natives", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      const a = yield* svc.registerManagedProject({ slug: "link-a" })
      const b = yield* svc.registerManagedProject({ slug: "link-b" })
      yield* svc.linkManagedProject({ id: a.id, nativeProjectID: "native-a" })
      expect((yield* svc.getManagedProject({ slug: "link-a" })).native_project_id).toBe("native-a")
      yield* svc.linkManagedProject({ id: a.id, nativeProjectID: "native-a" })
      const missing = yield* svc.linkManagedProject({ id: b.id, nativeProjectID: "ghost" }).pipe(Effect.exit)
      expect(missing._tag).toBe("Failure")
      const clash = yield* svc.linkManagedProject({ id: b.id, nativeProjectID: "native-a" }).pipe(Effect.exit)
      expect(clash._tag).toBe("Failure")
      yield* svc.linkManagedProject({ id: b.id, nativeProjectID: "native-b" })
      const absent = yield* svc.getManagedProject({ slug: "no-such-slug" }).pipe(Effect.exit)
      expect(absent._tag).toBe("Failure")
    }),
  )
})

test("status follows the lifecycle and rejects jumps and terminal exits", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      const { id } = yield* svc.registerManagedProject({ slug: "lifecycle" })
      const jump = yield* svc.setManagedProjectStatus({ id, status: "active" }).pipe(Effect.exit)
      expect(jump._tag).toBe("Failure")
      for (const status of ["ready", "active", "paused", "active", "completed"]) {
        yield* svc.setManagedProjectStatus({ id, status })
      }
      expect((yield* svc.getManagedProject({ id })).status).toBe("completed")
      const reopen = yield* svc.setManagedProjectStatus({ id, status: "active" }).pipe(Effect.exit)
      expect(reopen._tag).toBe("Failure")
      const unknown = yield* svc.setManagedProjectStatus({ id, status: "flying" }).pipe(Effect.exit)
      expect(unknown._tag).toBe("Failure")
      const listed = yield* svc.listManagedProjects({ status: "completed" })
      expect(listed.map((r) => r.slug)).toContain("lifecycle")
      const badFilter = yield* svc.listManagedProjects({ status: "flying" }).pipe(Effect.exit)
      expect(badFilter._tag).toBe("Failure")
    }),
  )
})

test("managed identity survives deletion of the linked native project row", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      const { db } = yield* Database.Service
      yield* db.run(
        sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('native-c',${root},'[]',${Date.now()},${Date.now()})`,
      )
      const { id } = yield* svc.registerManagedProject({ slug: "survivor" })
      yield* svc.linkManagedProject({ id, nativeProjectID: "native-c" })
      yield* db.run(sql`DELETE FROM project WHERE id='native-c'`)
      const row = yield* svc.getManagedProject({ id })
      expect(row.slug).toBe("survivor")
      expect(row.native_project_id).toBe("native-c")
    }),
  )
})
