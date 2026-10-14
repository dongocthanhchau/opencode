import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MemoryCapture } from "../../src/memory/capture"
import { SessionID } from "../../src/session/schema"

const root = mkdtempSync(path.join(tmpdir(), "cvis-scope-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(MemoryCapture.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

process.env.OPENCODE_MEMORY_VAULT = path.join(root, "vault")
process.env.OPENCODE_MEMORY_EMBED_URL = "http://127.0.0.1:9"

const SUMMARY =
  "- The quasar xylophone array requires zephyr calibration every cycle for stable harmonics.\n" +
  "- Operators must log every zephyr drift event with a timestamp for later auditing purposes."

function seedSummary(sid: string, text: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(${"msg_" + sid},${sid},${NOW},${NOW},'{"role":"assistant","summary":true}')`,
    )
    yield* db.run(
      sql`INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(${"prt_" + sid},${"msg_" + sid},${sid},${NOW},${NOW},${JSON.stringify(JSON.stringify({ type: "text", text }))})`,
    )
  })
}

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const pid of ["scope-p", "scope-q"]) {
        yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(${pid},${root},'[]',${NOW},${NOW})`)
      }
      for (const [sid, pid] of [
        ["ses_a", "scope-p"],
        ["ses_b", "scope-p"],
        ["ses_q", "scope-q"],
      ] as [string, string][]) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},${pid},${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
      }
      yield* seedSummary("ses_a", SUMMARY)
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("fresh captures land in the session tier", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      yield* svc.capture({ sessionID: SessionID.make("ses_a") })
      const { db } = yield* Database.Service
      const items = (yield* db.run(
        sql`SELECT id, scope, session_id, project_id FROM memory_item`,
      )) as unknown as { id: string; scope: string; session_id: string; project_id: string }[]
      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        expect(item.scope).toBe("session")
        expect(item.session_id).toBe("ses_a")
        expect(item.project_id).toBe("scope-p")
      }
    }),
  )
})

test("remember stores global tiers and dedupes", async () => {
  const out = await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      return yield* svc.remember({
        scope: "user",
        text: "The operator prefers nebula piston dashboards with waffle charts for every review.",
      })
    }),
  )
  expect(out.deduped).toBe(false)
  const again = await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      return yield* svc.remember({
        scope: "user",
        text: "The operator prefers nebula piston dashboards with waffle charts for every review.",
      })
    }),
  )
  expect(again.deduped).toBe(true)
  expect(again.itemID).toBe(out.itemID)
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rows = (yield* db.run(sql`SELECT scope, project_id, session_id FROM memory_item WHERE id = ${out.itemID}`)) as unknown as {
        scope: string
        project_id: string | null
        session_id: string | null
      }[]
      expect(rows.length).toBe(1)
      expect(rows[0].scope).toBe("user")
      expect(rows[0].project_id).toBeNull()
      expect(rows[0].session_id).toBeNull()
    }),
  )
})

test("promotion moves session items to project, with guardrails", async () => {
  const itemID = await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rows = (yield* db.run(sql`SELECT id FROM memory_item WHERE session_id = 'ses_a' LIMIT 1`)) as unknown as {
        id: string
      }[]
      return rows[0].id
    }),
  )
  const promoted = await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      return yield* svc.setScope({ id: itemID, scope: "project", sessionID: SessionID.make("ses_b") })
    }),
  )
  expect(promoted.scope).toBe("project")
  const backByStranger = await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      return yield* svc.setScope({ id: itemID, scope: "session", sessionID: SessionID.make("ses_b") })
    }).pipe(Effect.flip),
  )
  expect(backByStranger).toMatchObject({ _tag: "MemoryScopeError" })
  const backByOwner = await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      return yield* svc.setScope({ id: itemID, scope: "session", sessionID: SessionID.make("ses_a") })
    }),
  )
  expect(backByOwner.scope).toBe("session")
  const crossProject = await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      return yield* svc.setScope({ id: itemID, scope: "project", sessionID: SessionID.make("ses_q") })
    }).pipe(Effect.flip),
  )
  expect(crossProject).toMatchObject({ _tag: "MemoryScopeError" })
})

test("legacy rows without an explicit scope read as project tier", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(
        sql`INSERT INTO memory_item(id,project_id,kind,status,claim,topic,hash,time_created,time_updated) VALUES('mit_legacy','scope-p','fact','active','The legacy cobalt array needs harbor maintenance every quarter.','legacy','legacylegacylegacy',${NOW},${NOW})`,
      )
      const rows = (yield* db.run(sql`SELECT scope FROM memory_item WHERE id = 'mit_legacy'`)) as unknown as {
        scope: string
      }[]
      expect(rows[0].scope).toBe("project")
    }),
  )
})
