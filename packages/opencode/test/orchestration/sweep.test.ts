import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-sweep-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const pid of ["sweep-p", "sweep-q"]) {
        yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(${pid},${root},'[]',${NOW},${NOW})`)
      }
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_live','sweep-p','ses_live',${root},'Live','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,time_archived) VALUES('ses_gone','sweep-p','ses_gone',${root},'Gone','v1',${NOW},${NOW},${NOW})`,
      )
      const tasks: [string, string, string, string | null][] = [
        ["t_archived", "running", "sweep-p", "ses_gone"],
        ["t_missing", "running", "sweep-p", "ses_ghost"],
        ["t_unassigned", "running", "sweep-p", null],
        ["t_verifying", "verifying", "sweep-p", "ses_gone"],
        ["t_healthy", "running", "sweep-p", "ses_live"],
        ["t_queued", "queued", "sweep-p", "ses_gone"],
        ["t_other", "running", "sweep-q", "ses_gone"],
      ]
      for (const [tid, status, project, assigned] of tasks) {
        if (assigned === null) {
          yield* db.run(
            sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES(${tid},${project},${tid},'implementer',${status},${NOW},${NOW})`,
          )
        } else {
          yield* db.run(
            sql`INSERT INTO cvis_task(id,project_id,title,role,status,assigned_session,time_created,time_updated) VALUES(${tid},${project},${tid},'implementer',${status},${assigned},${NOW},${NOW})`,
          )
        }
      }
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_gone','sweep-p','implementer','t_archived','busy',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_live','sweep-p','implementer','t_healthy','busy',${NOW},${NOW})`,
      )
    }),
  )
})

afterAll(() => runtime.dispose())

test("sweep pauses orphaned running tasks and leaves healthy ones alone", async () => {
  const out = await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* svc.sweepOrphanedTasks({ projectID: "sweep-p" })
    }),
  )
  expect([...out.paused].sort()).toEqual(["t_archived", "t_missing", "t_unassigned", "t_verifying"])
})

test("swept tasks pause cleanly and bindings release only for the swept", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const statusOf = (id: string) =>
        db.run(sql`SELECT status FROM cvis_task WHERE id=${id}`).pipe(Effect.orDie)
      expect(((yield* statusOf("t_archived"))[0] as unknown as { status: string }).status).toBe("paused")
      expect(((yield* statusOf("t_healthy"))[0] as unknown as { status: string }).status).toBe("running")
      expect(((yield* statusOf("t_queued"))[0] as unknown as { status: string }).status).toBe("queued")
      const bindings = (yield* db
        .run(sql`SELECT session_id,status,task_id FROM cvis_session_binding`)
        .pipe(Effect.orDie)) as unknown as { session_id: string; status: string; task_id: string | null }[]
      const gone = bindings.find((b) => b.session_id === "ses_gone")!
      expect(gone.status).toBe("idle")
      expect(gone.task_id).toBeNull()
      const live = bindings.find((b) => b.session_id === "ses_live")!
      expect(live).toMatchObject({ status: "busy", task_id: "t_healthy" })
    }),
  )
})

test("unfiltered sweep catches other projects and repeats are no-ops", async () => {
  const out = await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* svc.sweepOrphanedTasks({})
    }),
  )
  expect(out).toEqual({ paused: ["t_other"] })
  const again = await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* svc.sweepOrphanedTasks({})
    }),
  )
  expect(again).toEqual({ paused: [] })
})
