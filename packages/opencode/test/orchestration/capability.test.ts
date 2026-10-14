import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-cap-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

type CapSvc = {
  proposeCapability: (input: {
    projectID: string
    kind: string
    name: string
    description: string
    source?: string
    installPayload?: Record<string, unknown>
    reason?: string
    actorSessionID: string
  }) => Effect.Effect<{ id: string; version: number }, any>
  setCapabilityStatus: (input: { id: string; status: string; actorSessionID: string }) => Effect.Effect<{ id: string; status: string }, any>
  listCapabilities: (input: { projectID: string; kind?: string; status?: string }) => Effect.Effect<{ id: string; kind: string; name: string; version: number; description: string; status: string }[], any>
}

function withSvc<R>(fn: (svc: CapSvc) => Effect.Effect<R, unknown, any>) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* fn(svc)
    }),
  )
}

function failSvc(fn: (svc: CapSvc) => Effect.Effect<unknown, unknown, any>) {
  return runtime.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        return yield* fn(svc)
      }),
    ),
  )
}

const DESC = "A browser automation capability for end-to-end verification of web flows."

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const pid of ["cp-p", "cp-q"]) {
        yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(${pid},${root},'[]',${NOW},${NOW})`)
      }
      for (const [sid, role, tid] of [["ses_cm", "manager", "t_cm"], ["ses_cw", "implementer", "t_cw"]] as [string, string, string][]) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'cp-p',${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES(${tid},'cp-p',${tid},${role},'running',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},'cp-p',${role},${tid},'busy',${NOW},${NOW})`,
        )
      }
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_co','cp-q','o',${root},'o','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('t_co','cp-q','o','implementer','running',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_co','cp-q','implementer','t_co','busy',${NOW},${NOW})`,
      )
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("any bound participant can propose, versions auto-increment", async () => {
  const v1 = await withSvc((svc) =>
    svc.proposeCapability({ projectID: "cp-p", kind: "mcp", name: "playwright", description: DESC, actorSessionID: "ses_cw" }),
  )
  expect(v1.version).toBe(1)
  const v2 = await withSvc((svc) =>
    svc.proposeCapability({ projectID: "cp-p", kind: "mcp", name: "playwright", description: DESC + " v2 notes.", actorSessionID: "ses_cm" }),
  )
  expect(v2.version).toBe(2)
  expect(v2.id).not.toBe(v1.id)
})

test("proposals are validated", async () => {
  const r1 = await failSvc((svc) =>
    svc.proposeCapability({ projectID: "cp-p", kind: "plugin", name: "x", description: DESC, actorSessionID: "ses_cw" }),
  )
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failSvc((svc) =>
    svc.proposeCapability({ projectID: "cp-p", kind: "tool", name: "x", description: "short", actorSessionID: "ses_cw" }),
  )
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r3 = await failSvc((svc) =>
    svc.proposeCapability({ projectID: "cp-p", kind: "tool", name: "x", description: DESC, actorSessionID: "ses_co" }),
  )
  expect(r3).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("lifecycle flows with manager approval and auto-retire", async () => {
  const v1 = await withSvc((svc) =>
    svc.proposeCapability({ projectID: "cp-p", kind: "skill", name: "review", description: DESC, actorSessionID: "ses_cw" }),
  )
  const r1 = await failSvc((svc) => svc.setCapabilityStatus({ id: v1.id, status: "active", actorSessionID: "ses_cm" }))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failSvc((svc) => svc.setCapabilityStatus({ id: v1.id, status: "canary", actorSessionID: "ses_cw" }))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
  await withSvc((svc) => svc.setCapabilityStatus({ id: v1.id, status: "canary", actorSessionID: "ses_cm" }))
  await withSvc((svc) => svc.setCapabilityStatus({ id: v1.id, status: "active", actorSessionID: "ses_cm" }))
  const v2 = await withSvc((svc) =>
    svc.proposeCapability({ projectID: "cp-p", kind: "skill", name: "review", description: DESC + " Improved.", actorSessionID: "ses_cw" }),
  )
  await withSvc((svc) => svc.setCapabilityStatus({ id: v2.id, status: "canary", actorSessionID: "ses_cm" }))
  await withSvc((svc) => svc.setCapabilityStatus({ id: v2.id, status: "active", actorSessionID: "ses_cm" }))
  const actives = await withSvc((svc) => svc.listCapabilities({ projectID: "cp-p", kind: "skill", status: "active" }))
  expect(actives.map((a) => a.version)).toEqual([2])
  const retired = await withSvc((svc) => svc.listCapabilities({ projectID: "cp-p", status: "deprecated" }))
  expect(retired.map((r) => r.version)).toEqual([1])
})

test("deprecate closes the loop and list filters work", async () => {
  const all = await withSvc((svc) => svc.listCapabilities({ projectID: "cp-p" }))
  expect(all.length).toBeGreaterThanOrEqual(4)
  const v2 = all.find((a) => a.name === "review" && a.version === 2)
  await withSvc((svc) => svc.setCapabilityStatus({ id: v2!.id, status: "deprecated", actorSessionID: "ses_cm" }))
  const actives = await withSvc((svc) => svc.listCapabilities({ projectID: "cp-p", status: "active" }))
  expect(actives.length).toBe(0)
  const mcps = await withSvc((svc) => svc.listCapabilities({ projectID: "cp-p", kind: "mcp" }))
  expect(mcps.length).toBe(2)
})
