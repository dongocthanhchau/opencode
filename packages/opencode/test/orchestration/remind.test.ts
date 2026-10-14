import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-remind-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

function remind(taskID: string, sessionID: string, note?: string) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* svc.remindTask({ taskID, sessionID, note })
    }),
  )
}

function report(taskID: string, sessionID: string, text: string) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* svc.reportTask({ taskID, sessionID, text })
    }),
  )
}

function events(taskID: string, sessionID: string) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* svc.listTaskEvents({ taskID, sessionID })
    }),
  )
}

function failWith(effect: Effect.Effect<unknown, unknown, any>) {
  return runtime.runPromise(Effect.flip(effect))
}

function remindEff(taskID: string, sessionID: string, note?: string) {
  return Effect.gen(function* () {
    const svc = yield* Orchestration.Service
    return yield* svc.remindTask({ taskID, sessionID, note })
  })
}

function reportEff(taskID: string, sessionID: string, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Orchestration.Service
    return yield* svc.reportTask({ taskID, sessionID, text })
  })
}

function eventsEff(taskID: string, sessionID: string, limit?: number) {
  return Effect.gen(function* () {
    const svc = yield* Orchestration.Service
    return yield* svc.listTaskEvents({ taskID, sessionID, limit })
  })
}

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const pid of ["r-p", "r-q"]) {
        yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(${pid},${root},'[]',${NOW},${NOW})`)
      }
      yield* db.run(
        sql`INSERT INTO cvis_project_goal(id,project_id,title,objective,status,time_created,time_updated) VALUES('rg1','r-p','goal','objective','active',${NOW},${NOW})`,
      )
      const tasks: [string, string, string, string | null][] = [
        ["t_run", "implementer", "running", "rg1"],
        ["t_open", "implementer", "queued", "rg1"],
        ["t_done", "implementer", "done", "rg1"],
        ["t_mgr", "manager", "running", "rg1"],
        ["t_out", "implementer", "running", null],
      ]
      for (const [tid, role, status, goal] of tasks) {
        const pid = tid === "t_out" ? "r-q" : "r-p"
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,goal_id,title,role,status,time_created,time_updated) VALUES(${tid},${pid},${goal},${tid},${role},${status},${NOW},${NOW})`,
        )
      }
      const bindings: [string, string, string, string][] = [
        ["ses_w", "r-p", "implementer", "t_run"],
        ["ses_w2", "r-p", "implementer", "t_done"],
        ["ses_mgr", "r-p", "manager", "t_mgr"],
        ["ses_out", "r-q", "implementer", "t_out"],
      ]
      for (const [sid, pid, role, tid] of bindings) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},${pid},${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},${pid},${role},${tid},'busy',${NOW},${NOW})`,
        )
      }
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("worker report lands a task.reported event", async () => {
  const out = await report("t_run", "ses_w", "Halfway through the migration, no blockers.")
  expect(out).toMatchObject({ taskID: "t_run", status: "running" })
  const listed = await events("t_run", "ses_w")
  expect(listed.map((e) => e.type)).toContain("task.reported")
})

test("manager reminds an unassigned open task", async () => {
  const out = await remind("t_open", "ses_mgr", "Please pick this up.")
  expect(out).toMatchObject({ taskID: "t_open", status: "queued" })
  const listed = await events("t_open", "ses_mgr")
  const reminded = listed.filter((e) => e.type === "task.reminded")
  expect(reminded.length).toBe(1)
  expect(reminded[0].payload).toMatchObject({ note: "Please pick this up.", by: "ses_mgr" })
})

test("closed tasks refuse reminders and idle tasks refuse reports", async () => {
  const r1 = await failWith(remindEff("t_done", "ses_w2"))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failWith(reportEff("t_open", "ses_mgr", "status update"))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("outsiders cannot remind, report, or read across projects", async () => {
  const r1 = await failWith(remindEff("t_run", "ses_out", "hi"))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failWith(reportEff("t_run", "ses_mgr", "manager covering"))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r3 = await failWith(eventsEff("t_run", "ses_out"))
  expect(r3).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("report text bounds and event limits are enforced", async () => {
  const r1 = await failWith(reportEff("t_run", "ses_w", "   "))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failWith(reportEff("t_run", "ses_w", "x".repeat(4001)))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r3 = await failWith(eventsEff("t_run", "ses_w", 0))
  expect(r3).toMatchObject({ _tag: "CvisInvalidTransition" })
})
