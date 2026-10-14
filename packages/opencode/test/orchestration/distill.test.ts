import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-distill-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

function svcEff(fn: (svc: any) => Effect.Effect<any, any, any>): Promise<any> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* fn(svc)
    }),
  )
}

function failSvc(fn: (svc: any) => Effect.Effect<unknown, unknown, any>) {
  return runtime.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        return yield* fn(svc)
      }),
    ),
  )
}

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('ds-p',${root},'[]',${NOW},${NOW})`)
      for (const [sid, role, tid] of [["ses_dm", "manager", "t_dm"], ["ses_dw", "implementer", "t_dw"]] as [string, string, string][]) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'ds-p',${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES(${tid},'ds-p',${tid},${role},'running',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},'ds-p',${role},${tid},'busy',${NOW},${NOW})`,
        )
      }
      for (let i = 0; i < 3; i++) {
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES(${"t_done" + i},'ds-p',${"done work " + i},'implementer','done',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_task_run(id,task_id,session_id,attempt,status,tokens_used,time_created,time_updated) VALUES(${"run_d" + i},${"t_done" + i},'ses_dw',1,'done',${100 * (i + 1)},${NOW},${NOW})`,
        )
      }
      for (let i = 0; i < 2; i++) {
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES(${"t_res" + i},'ds-p',${"research " + i},'researcher','done',${NOW},${NOW})`,
        )
      }
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("repeated done roles distill drafts with events and inbox", async () => {
  const out = await svcEff((svc) => svc.distillSkills({ projectID: "ds-p", actorSessionID: "ses_dw" }))
  expect(out).toMatchObject([{ role: "implementer", count: 3 }])
  expect(out[0].path).toContain("auto-implementer-3x")
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = (yield* db.run(sql`SELECT type FROM cvis_event WHERE type = 'skill.distilled'`)) as unknown as { type: string }[]
      expect(events.length).toBe(1)
      const inbox = (yield* db.run(sql`SELECT kind, to_session FROM cvis_message WHERE kind = 'question'`)) as unknown as { kind: string; to_session: string }[]
      expect(inbox.length).toBe(1)
      expect(inbox[0].to_session).toBe("ses_dm")
    }),
  )
  const { readFileSync, existsSync } = await import("node:fs")
  expect(existsSync(out[0].path)).toBe(true)
  expect(readFileSync(out[0].path, "utf8")).toContain("name: implementer-flow")
})

test("distill is idempotent and threshold-aware", async () => {
  const again = await svcEff((svc) => svc.distillSkills({ projectID: "ds-p", actorSessionID: "ses_dw" }))
  expect(again).toEqual([])
  const high = await svcEff((svc) => svc.distillSkills({ projectID: "ds-p", actorSessionID: "ses_dw", minRepeats: 5 }))
  expect(high).toEqual([])
  const r1 = await failSvc((svc) => svc.distillSkills({ projectID: "ds-p", actorSessionID: "ses_dw", minRepeats: 1 }))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
})
