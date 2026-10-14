import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-hooks-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()
const OLD = NOW - 3 * 3_600_000

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

let seq = 100

function evt(entity: string, id: string, type: string, at: number) {
  seq += 1
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`INSERT INTO cvis_event(id,project_id,entity_kind,entity_id,type,sequence,payload,time_created,time_updated) VALUES(${"evt_h" + seq},'hx-p',${entity},${id},${type},${seq},'{}',${at},${at})`)
  })
}

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('hx-p',${root},'[]',${NOW},${NOW})`)
      for (const [sid, role, tid] of [["ses_hm", "manager", "t_hm"], ["ses_hw", "implementer", "t_hw0"]] as [string, string, string][]) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'hx-p',${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES(${tid},'hx-p',${tid},${role},'running',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},'hx-p',${role},${tid},'busy',${NOW},${NOW})`,
        )
      }
      const mkTask = (tid: string, scope: string | null) =>
        db.run(sql`INSERT INTO cvis_task(id,project_id,title,role,status,scope,time_created,time_updated) VALUES(${tid},'hx-p',${tid},'implementer','running',${scope},${NOW},${NOW})`)
      yield* mkTask("t_fail", null)
      yield* mkTask("t_stall", null)
      yield* mkTask("t_hot", JSON.stringify({ max_tokens: 100 }))
      yield* mkTask("t_rej", null)
      const mkRun = (id: string, tid: string, attempt: number, status: string, tokens: number, at: number) =>
        db.run(sql`INSERT INTO cvis_task_run(id,task_id,session_id,attempt,status,tokens_used,time_created,time_updated) VALUES(${id},${tid},'ses_hw',${attempt},${status},${tokens},${at},${at})`)
      yield* mkRun("run_f1", "t_fail", 1, "failed", 10, NOW - 1000)
      yield* mkRun("run_f2", "t_fail", 2, "failed", 20, NOW)
      yield* mkRun("run_h1", "t_hot", 1, "running", 90, NOW)
      yield* evt("task", "t_fail", "task.claimed", NOW)
      yield* evt("task", "t_hot", "task.claimed", NOW)
      yield* evt("task", "t_stall", "task.claimed", OLD)
      yield* evt("task", "t_rej", "task.claimed", OLD)
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("analyzer files fail-streak, stalled, and budget-hot findings", async () => {
  const out = await svcEff((svc) => svc.analyzeTraces({ projectID: "hx-p", actorSessionID: "ses_hm" }))
  const kinds = out.map((f: { kind: string; entityID: string }) => `${f.kind}:${f.entityID}`).sort()
  expect(kinds).toEqual(["budget-hot:t_hot", "fail-streak:t_fail", "stalled:t_hm", "stalled:t_hw0", "stalled:t_rej", "stalled:t_stall"].sort())
  const again = await svcEff((svc) => svc.analyzeTraces({ projectID: "hx-p", actorSessionID: "ses_hm" }))
  expect(again).toEqual([])
})

test("apply attaches a verifier and refuses repeats and outsiders", async () => {
  const findings = await svcEff((svc) => svc.analyzeTraces({ projectID: "hx-p", actorSessionID: "ses_hm" }))
  void findings
  const rows = (await svcEff((svc: any) => svc.listTaskEvents({ taskID: "t_fail", sessionID: "ses_hm" }))) as { type: string; payload: unknown }[]
  void rows
  const found = await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return (yield* db.run(sql`SELECT id, payload FROM cvis_event WHERE type = 'harness.finding'`)) as unknown as { id: string; payload: string }[]
    }),
  )
  const failFinding = found.map((r) => ({ id: r.id, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload })).find((r) => r.payload.kind === "fail-streak")!.id
  const r0 = await failSvc((svc: any) => svc.applyFinding({ findingEventID: failFinding, actorSessionID: "ses_hw" }))
  expect(r0).toMatchObject({ _tag: "CvisInvalidTransition" })
  const applied = await svcEff((svc: any) => svc.applyFinding({ findingEventID: failFinding, actorSessionID: "ses_hm" }))
  expect((applied as { approved: boolean }).approved).toBe(true)
  const reviewTasks = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return (yield* db.run(sql`SELECT id, role FROM cvis_task WHERE scope LIKE '%review_task_id%'`)) as unknown as { id: string; role: string }[]
    }),
  ))
  expect(reviewTasks.length).toBe(1)
  expect(reviewTasks[0].role).toBe("verifier")
  const r1 = await failSvc((svc: any) => svc.applyFinding({ findingEventID: failFinding, actorSessionID: "ses_hm" }))
  expect(r1).toMatchObject({ _tag: "CvisConflict" })
})

test("apply pauses stalls, extends hot budgets, and records rejections", async () => {
  const ids = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return (yield* db.run(sql`SELECT id, entity_id FROM cvis_event WHERE type = 'harness.finding'`)) as unknown as { id: string; entity_id: string }[]
    }),
  ))
  const byEntity = new Map(ids.map((r) => [r.entity_id, r.id]))
  await svcEff((svc: any) => svc.applyFinding({ findingEventID: byEntity.get("t_stall")!, actorSessionID: "ses_hm" }))
  const stalled = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return (yield* db.run(sql`SELECT status FROM cvis_task WHERE id = 't_stall'`)) as unknown as { status: string }[]
    }),
  ))
  expect(stalled[0].status).toBe("paused")
  await svcEff((svc: any) => svc.applyFinding({ findingEventID: byEntity.get("t_hot")!, actorSessionID: "ses_hm" }))
  const cap = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return (yield* db.run(sql`SELECT scope FROM cvis_task WHERE id = 't_hot'`)) as unknown as { scope: string }[]
    }),
  ))
  expect(JSON.parse(cap[0].scope).max_tokens).toBe(125)
  await svcEff((svc: any) => svc.applyFinding({ findingEventID: byEntity.get("t_rej")!, actorSessionID: "ses_hm", approve: false }))
  const still = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return (yield* db.run(sql`SELECT status FROM cvis_task WHERE id = 't_rej'`)) as unknown as { status: string }[]
    }),
  ))
  expect(still[0].status).toBe("running")
})
