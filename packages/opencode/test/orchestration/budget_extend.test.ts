import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-budget-ext-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()
const AUTO = JSON.stringify({ step_pct: 50, max_steps: 1 })

function extendEff(kind: "goal" | "task", id: string, actorSessionID: string) {
  return Effect.gen(function* () {
    const svc = yield* Orchestration.Service
    return yield* svc.requestBudgetExtension({ kind, id, actorSessionID })
  })
}

function failWith(effect: Effect.Effect<unknown, unknown, any>) {
  return runtime.runPromise(Effect.flip(effect))
}

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const svc = yield* Orchestration.Service
      yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('bx-p',${root},'[]',${NOW},${NOW})`)
      yield* db.run(
        sql`INSERT INTO cvis_project_goal(id,project_id,title,objective,status,budget_tokens,metadata,time_created,time_updated) VALUES('bxg','bx-p','g','o','planning',1000,${JSON.stringify({ auto_extend: { step_pct: 50, max_steps: 5 } })},${NOW},${NOW})`,
      )
      for (const [sid, role, tid, ttitle, trole] of [
        ["ses_bm", "manager", "t_bmgr", "m", "manager"],
        ["ses_bw", "implementer", "bt1", "w", "implementer"],
      ] as [string, string, string, string, string][]) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'bx-p',${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,goal_id,title,role,status,time_created,time_updated) VALUES(${tid},'bx-p','bxg',${ttitle},${trole},'running',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},'bx-p',${role},${tid},'busy',${NOW},${NOW})`,
        )
      }
      yield* svc.setGoalStatus({ id: "bxg", status: "active" })
      const mkTask = (tid: string, scope: string) =>
        db.run(
          sql`INSERT INTO cvis_task(id,project_id,goal_id,title,role,status,scope,time_created,time_updated) VALUES(${tid},'bx-p','bxg',${tid},'implementer','queued',${scope},${NOW},${NOW})`,
        )
      yield* mkTask("bt_cap", JSON.stringify({ max_tokens: 100, auto_extend: { step_pct: 50, max_steps: 1 } }))
      yield* mkTask("bt_old", JSON.stringify({ max_tokens: 100 }))
      yield* mkTask("bt_nocap", JSON.stringify({}))
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_bw2','bx-p','w2',${root},'w2','v1',${NOW},${NOW})`,
      )
      const claim = (tid: string, sid: string) =>
        Effect.gen(function* () {
          const svc = yield* Orchestration.Service
          return yield* svc.claimTask({ taskID: tid, sessionID: sid })
        })
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_bw2','bx-p','implementer','bt_cap','idle',${NOW},${NOW})`,
      )
      const c1 = yield* claim("bt_cap", "ses_bw2")
      yield* db.run(sql`UPDATE cvis_task_run SET tokens_used = 100 WHERE id = ${c1.runID}`)
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_bw3','bx-p','w3',${root},'w3','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_bw3','bx-p','implementer','bt_old','idle',${NOW},${NOW})`,
      )
      yield* claim("bt_old", "ses_bw3")
      yield* db.run(sql`UPDATE cvis_event SET time_created = ${NOW - 7_200_000} WHERE entity_id = 'bt_old'`)
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_bw4','bx-p','w4',${root},'w4','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_bw4','bx-p','implementer','bt_nocap','idle',${NOW},${NOW})`,
      )
      yield* claim("bt_nocap", "ses_bw4")
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("live task steps its cap up and records the event", async () => {
  const out = await runtime.runPromise(extendEff("task", "bt_cap", "ses_bw2"))
  expect(out).toMatchObject({ extended: true, oldCap: 100, newCap: 150, stepsUsed: 1 })
  const events = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* db.run(sql`SELECT type FROM cvis_event WHERE entity_id = 'bt_cap' AND type = 'budget.extended'`)
    }),
  )) as unknown as { type: string }[]
  expect(events.length).toBe(1)
})

test("past the ceiling it files an approval inbox instead of spending", async () => {
  const err = await failWith(extendEff("task", "bt_cap", "ses_bw2"))
  expect(err).toMatchObject({ _tag: "CvisConflict" })
  expect(String((err as { reason: string }).reason)).toContain("approval requested")
  const inbox = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* db.run(sql`SELECT kind, to_session FROM cvis_message WHERE kind = 'question'`)
    }),
  )) as unknown as { kind: string; to_session: string }[]
  expect(inbox.length).toBe(1)
  expect(inbox[0].to_session).toBe("ses_bm")
  const err2 = await failWith(extendEff("task", "bt_cap", "ses_bw2"))
  expect(err2).toMatchObject({ _tag: "CvisConflict" })
  const inbox2 = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* db.run(sql`SELECT kind FROM cvis_message WHERE kind = 'question'`)
    }),
  )) as unknown as { kind: string }[]
  expect(inbox2.length).toBe(1)
  const reqEvents = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* db.run(sql`SELECT type FROM cvis_event WHERE entity_id = 'bt_cap' AND type = 'budget.extension_requested'`)
    }),
  )) as unknown as { type: string }[]
  expect(reqEvents.length).toBe(1)
})

test("stale work and missing caps are refused", async () => {
  const r1 = await failWith(extendEff("task", "bt_old", "ses_bw3"))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failWith(extendEff("task", "bt_nocap", "ses_bw4"))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("live goal steps its cap up", async () => {
  const out = await runtime.runPromise(extendEff("goal", "bxg", "ses_bw2"))
  expect(out).toMatchObject({ extended: true, oldCap: 1000, newCap: 1500 })
})
