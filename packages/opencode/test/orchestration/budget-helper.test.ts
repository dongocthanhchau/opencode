import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { createBudget } from "../../src/orchestration/budget"

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cvis-budget-"))
  const runtime = ManagedRuntime.make(Database.layerFromPath(path.join(root, "state.db")))
  const { db } = await runtime.runPromise(Database.Service)
  const now = Date.now()
  await runtime.runPromise(Effect.gen(function* () {
    yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('p1',${root},'[]',${now},${now})`)
    for (const sid of ["ses1", "ses2", "ses_mgr", "ses_unmanaged"])
      yield* db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'p1',${sid},${root},${sid},'v1',${now},${now})`)
    yield* db.run(sql`INSERT INTO cvis_project_goal(id,project_id,title,objective,status,budget_tokens,metadata,time_created,time_updated) VALUES('g1','p1','Goal','Obj','active',10000,${JSON.stringify({ activated_at: now, manager_session_id: "ses_mgr" })},${now},${now})`)
    for (const [taskID, sid, rid] of [["t1", "ses1", "r1"], ["t2", "ses2", "r2"]]) {
      yield* db.run(sql`INSERT INTO cvis_task(id,project_id,goal_id,title,role,status,scope,attempt,revision,active_run_id,time_created,time_updated) VALUES(${taskID},'p1','g1',${taskID},'implementer','running',${JSON.stringify({ max_tokens: 5000 })},1,1,${rid},${now},${now})`)
      yield* db.run(sql`INSERT INTO cvis_task_run(id,task_id,session_id,attempt,revision,status,tokens_used,time_started,time_created,time_updated) VALUES(${rid},${taskID},${sid},1,1,'running',0,${now},${now},${now})`)
      yield* db.run(sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},'p1','implementer',${taskID},'busy',${now},${now})`)
    }
  }))
  return { db, runtime, now, budget: createBudget(db) }
}

test("failed/cancelled receipts include cache and exclude READY and later reuse", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(Effect.gen(function* () {
      yield* f.db.run(sql`UPDATE cvis_task_run SET status='failed',time_finished=${f.now+10} WHERE id='r1'`)
      for (const [id, time, amount] of [["ready", f.now - 1, 900], ["during", f.now + 1, 200], ["later", f.now + 11, 800]] as const)
        yield* f.db.run(sql`INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(${id},'ses1',${time},${time},${JSON.stringify({ role: "assistant", tokens: { input: amount, output: 50, cache: { read: 20 } } })})`)
      yield* f.budget.reconcile("p1")
      expect(yield* f.budget.spend({ taskID: "t1" })).toBe(270)
      yield* f.budget.reconcile("p1")
      expect(yield* f.budget.spend({ taskID: "t1" })).toBe(270)
      yield* f.db.run(sql`UPDATE cvis_task_run SET status='cancelled' WHERE id='r1'`)
      expect(yield* f.budget.spend({ taskID: "t1" })).toBe(270)
    }))
  } finally { await f.runtime.dispose() }
})

test("goal sums all tasks and manager exactly once including completed runs", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(Effect.gen(function* () {
      yield* f.db.run(sql`UPDATE cvis_task_run SET status='done',tokens_used=250 WHERE id='r1'`)
      yield* f.db.run(sql`UPDATE cvis_task_run SET tokens_used=100 WHERE id='r2'`)
      yield* f.db.run(sql`INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('manager','ses_mgr',${f.now+1},${f.now+1},${JSON.stringify({ role: "assistant", tokens: { input: 100, output: 10 } })})`)
      expect(yield* f.budget.spend({ taskID: "t1" })).toBe(250)
      expect(yield* f.budget.spend({ goalID: "g1" })).toBe(460)
    }))
  } finally { await f.runtime.dispose() }
})

test("reservation clamps output and replaces own prior hold", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(Effect.gen(function* () {
      expect(yield* f.budget.prepareTurn({ sessionID: "ses1", inputTokensEstimate: 4900, requestID: "req1" })).toBe(100)
      expect(yield* f.budget.prepareTurn({ sessionID: "ses1", inputTokensEstimate: 4800, requestID: "req2" })).toBe(200)
      expect(yield* f.budget.spend({ taskID: "t1", includeReservations: true })).toBe(5000)
      yield* f.db.run(sql`UPDATE cvis_task_run SET result=json_set(result,'$.usage_finalized',json('true')) WHERE id='r1'`)
      expect(yield* f.budget.spend({ taskID: "t1", includeReservations: true })).toBe(0)
    }))
  } finally { await f.runtime.dispose() }
})

test("serialized concurrent goal reservations cannot overbook", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.db.run(sql`UPDATE cvis_project_goal SET budget_tokens=5000 WHERE id='g1'`))
    const attempts = await Promise.allSettled(["ses1", "ses2"].map((sid) => f.runtime.runPromise(f.budget.prepareTurn({ sessionID: sid, inputTokensEstimate: 4500, requestID: sid }))))
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1)
  } finally { await f.runtime.dispose() }
})

test("live assistant consumption prevents another provider call", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.db.run(sql`INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('spent','ses1',${f.now+1},${f.now+1},${JSON.stringify({ role: "assistant", tokens: { input: 5000 } })})`))
    await expect(f.runtime.runPromise(f.budget.prepareTurn({ sessionID: "ses1", inputTokensEstimate: 1, requestID: "blocked" }))).rejects.toThrow("Budget exhausted")
  } finally { await f.runtime.dispose() }
})

test("paused goal, stale revision and archived session deny admission", async () => {
  const f = await fixture()
  try {
    await f.runtime.runPromise(f.db.run(sql`UPDATE cvis_project_goal SET status='paused' WHERE id='g1'`))
    await expect(f.runtime.runPromise(f.budget.prepareTurn({ sessionID: "ses1", inputTokensEstimate: 1, requestID: "paused" }))).rejects.toThrow()
    await f.runtime.runPromise(f.db.run(sql`UPDATE cvis_project_goal SET status='active' WHERE id='g1'`))
    await f.runtime.runPromise(f.db.run(sql`UPDATE cvis_task SET revision=2 WHERE id='t1'`))
    await expect(f.runtime.runPromise(f.budget.prepareTurn({ sessionID: "ses1", inputTokensEstimate: 1, requestID: "stale" }))).rejects.toThrow()
    await f.runtime.runPromise(f.db.run(sql`UPDATE session SET time_archived=1 WHERE id='ses2'`))
    await expect(f.runtime.runPromise(f.budget.prepareTurn({ sessionID: "ses2", inputTokensEstimate: 1, requestID: "archived" }))).rejects.toThrow()
  } finally { await f.runtime.dispose() }
})

test("unmanaged remains unchanged and invalid estimates fail", async () => {
  const f = await fixture()
  try {
    expect(await f.runtime.runPromise(f.budget.prepareTurn({ sessionID: "ses_unmanaged", inputTokensEstimate: 10, requestID: "free" }))).toBeUndefined()
    for (const amount of [-1, NaN, Infinity, 0.5])
      await expect(f.runtime.runPromise(f.budget.prepareTurn({ sessionID: "ses1", inputTokensEstimate: amount, requestID: "invalid" }))).rejects.toThrow()
  } finally { await f.runtime.dispose() }
})
