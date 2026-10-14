import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-tmpl-canary-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

type TmplSvc = {
  renderTemplate: (input: { name: string; vars: Record<string, string>; version?: number; bucketKey?: string }) => Effect.Effect<{ text: string; tokens: number; version: number; status: string }, any>
  setTemplateRollout: (input: { name: string; version: number; pct: number; actorSessionID: string }) => Effect.Effect<unknown, any>
  setTemplateStatus: (input: { name: string; version: number; status: string; actorSessionID: string }) => Effect.Effect<unknown, any>
  templateMetrics: (input: { name: string }) => Effect.Effect<{ version: number; status: string; runs: number; checks: number; passRate: number | null; avgTokens: number | null }[], any>
}

function withSvc<R>(fn: (svc: TmplSvc) => Effect.Effect<R, any, any>) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* fn(svc)
    }),
  )
}

function failWith(effect: Effect.Effect<unknown, unknown, any>) {
  return runtime.runPromise(Effect.flip(effect))
}

function failSvc(fn: (svc: TmplSvc) => Effect.Effect<unknown, unknown, any>) {
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
      const svc = yield* Orchestration.Service
      yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('tx-p',${root},'[]',${NOW},${NOW})`)
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_tm','tx-p','m',${root},'m','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('t_tm','tx-p','m','manager','running',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_tm','tx-p','manager','t_tm','busy',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_tw','tx-p','w',${root},'w','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('t_tw','tx-p','w','implementer','running',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_tw','tx-p','implementer','t_tw','busy',${NOW},${NOW})`,
      )
      yield* svc.createTemplate({ name: "canarytest", body: "stable body {{x}}", inputs: [{ name: "x", required: true }] })
      yield* svc.createTemplate({ name: "canarytest", body: "canary body {{x}}", inputs: [{ name: "x", required: true }], status: "canary" })
      yield* db.run(
        sql`INSERT INTO cvis_task_run(id,task_id,session_id,attempt,revision,status,tokens_used,result,time_created,time_updated) VALUES('run_s1','t_tw','ses_tw',1,1,'done',100,${JSON.stringify({ template: { name: "canarytest", version: 1 } })},${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task_run(id,task_id,session_id,attempt,revision,status,tokens_used,result,time_created,time_updated) VALUES('run_s2','t_tw','ses_tw',2,1,'done',300,${JSON.stringify({ template: { name: "canarytest", version: 1 } })},${NOW},${NOW})`,
      )
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("stable serves by default, canary only inside its rollout", async () => {
  const plain = await withSvc((svc) => svc.renderTemplate({ name: "canarytest", vars: { x: "1" } }))
  expect(plain).toMatchObject({ version: 1, status: "stable" })
  expect(plain.text).toContain("stable body")
  await withSvc((svc) => svc.setTemplateRollout({ name: "canarytest", version: 2, pct: 100, actorSessionID: "ses_tm" }))
  const inBucket = await withSvc((svc) =>
    svc.renderTemplate({ name: "canarytest", vars: { x: "1" }, bucketKey: "task-any" }),
  )
  expect(inBucket).toMatchObject({ version: 2, status: "canary" })
  await withSvc((svc) => svc.setTemplateRollout({ name: "canarytest", version: 2, pct: 0, actorSessionID: "ses_tm" }))
  const outBucket = await withSvc((svc) =>
    svc.renderTemplate({ name: "canarytest", vars: { x: "1" }, bucketKey: "task-any" }),
  )
  expect(outBucket).toMatchObject({ version: 1, status: "stable" })
  const pinned = await withSvc((svc) => svc.renderTemplate({ name: "canarytest", vars: { x: "1" }, version: 2 }))
  expect(pinned.text).toContain("canary body")
})

test("rollout and status changes are guarded", async () => {
  const r1 = await failSvc((svc) => svc.setTemplateRollout({ name: "canarytest", version: 1, pct: 50, actorSessionID: "ses_tm" }))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failSvc((svc) => svc.setTemplateRollout({ name: "canarytest", version: 2, pct: 101, actorSessionID: "ses_tm" }))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r3 = await failSvc((svc) => svc.setTemplateRollout({ name: "canarytest", version: 2, pct: 50, actorSessionID: "ses_tw" }))
  expect(r3).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r4 = await failSvc((svc) => svc.setTemplateStatus({ name: "canarytest", version: 1, status: "retired", actorSessionID: "ses_tm" }))
  expect(r4).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("promote flips serving, rollback restores the old stable", async () => {
  await withSvc((svc) => svc.setTemplateStatus({ name: "canarytest", version: 2, status: "stable", actorSessionID: "ses_tm" }))
  const promoted = await withSvc((svc) => svc.renderTemplate({ name: "canarytest", vars: { x: "1" } }))
  expect(promoted).toMatchObject({ version: 2, status: "stable" })
  await withSvc((svc) => svc.setTemplateStatus({ name: "canarytest", version: 2, status: "retired", actorSessionID: "ses_tm" }))
  const rolled = await withSvc((svc) => svc.renderTemplate({ name: "canarytest", vars: { x: "1" } }))
  expect(rolled).toMatchObject({ version: 1, status: "stable" })
  const pinnedDead = await failSvc((svc) => svc.renderTemplate({ name: "canarytest", vars: { x: "1" }, version: 2 }))
  expect(pinnedDead).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("metrics compare versions from run receipts", async () => {
  const metrics = await withSvc((svc) => svc.templateMetrics({ name: "canarytest" }))
  const v1 = metrics.find((m) => m.version === 1)
  const v2 = metrics.find((m) => m.version === 2)
  expect(v1).toMatchObject({ runs: 2, avgTokens: 200, passRate: null })
  expect(v2).toMatchObject({ runs: 0, avgTokens: null })
})
