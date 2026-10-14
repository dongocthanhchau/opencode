import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-exec-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()
const COMMANDS = ["echo hello", "false", "sleep 5", "seq 1 20000"]

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('exec-p',${root},'[]',${NOW},${NOW})`)
      const sessions: [string, boolean][] = [
        ["ses_exec", false],
        ["ses_mgr", false],
        ["ses_free", false],
        ["ses_arch", true],
        ["ses_paused", false],
      ]
      for (const [sid, archived] of sessions) {
        if (archived) {
          yield* db.run(
            sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,time_archived) VALUES(${sid},'exec-p',${sid},${root},${sid},'v1',${NOW},${NOW},${NOW})`,
          )
        } else {
          yield* db.run(
            sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'exec-p',${sid},${root},${sid},'v1',${NOW},${NOW})`,
          )
        }
      }
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,scope,time_created,time_updated) VALUES('task_exec','exec-p','exec','implementer','running',${JSON.stringify({ read_paths: ["src"], commands: COMMANDS })},${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_exec','exec-p','implementer','task_exec','busy',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('task_mgr','exec-p','mgr','manager','running',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_mgr','exec-p','manager','task_mgr','busy',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,scope,time_created,time_updated) VALUES('task_arch','exec-p','arch','implementer','running',${JSON.stringify({ commands: COMMANDS })},${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_arch','exec-p','implementer','task_arch','busy',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,scope,time_created,time_updated) VALUES('task_paused','exec-p','p','implementer','paused',${JSON.stringify({ commands: COMMANDS })},${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_paused','exec-p','implementer','task_paused','busy',${NOW},${NOW})`,
      )
    }),
  )
})

afterAll(() => runtime.dispose())

function exec(taskID: string, sessionID: string, command: string, timeoutMs?: number) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* svc.runCheckCommand({ taskID, sessionID, command, timeoutMs })
    }),
  )
}

test("allowlisted command runs and returns a receipt", async () => {
  const receipt = await exec("task_exec", "ses_exec", "echo hello")
  expect(receipt.exitCode).toBe(0)
  expect(receipt.output).toContain("hello")
  expect(receipt.truncated).toBe(false)
  expect(receipt.durationMs).toBeGreaterThanOrEqual(0)
})

test("only exact allowlist strings run", async () => {
  for (const attempt of ["echo hello world", " echo hello", "echo hello;", "ECHO HELLO"]) {
    const err = await runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        return yield* svc.runCheckCommand({ taskID: "task_exec", sessionID: "ses_exec", command: attempt })
      }).pipe(Effect.flip),
    )
    expect(err).toMatchObject({ _tag: "CvisInvalidTransition", to: "command not in task allowlist" })
  }
})

test("nonzero exits are receipts, not thrown errors", async () => {
  const receipt = await exec("task_exec", "ses_exec", "false")
  expect(receipt.exitCode).toBe(1)
})

test("timeout kills the command and reports it", async () => {
  const receipt = await exec("task_exec", "ses_exec", "sleep 5", 400)
  expect(receipt.exitCode).toBe(124)
  expect(receipt.durationMs).toBeLessThan(5000)
})

test("output is capped with a truncation flag", async () => {
  const receipt = await exec("task_exec", "ses_exec", "seq 1 20000")
  expect(receipt.exitCode).toBe(0)
  expect(receipt.truncated).toBe(true)
  expect(receipt.output.length).toBe(65536)
})

test("wrong role, unbound, archived, and paused contexts are denied", async () => {
  await expect(exec("task_mgr", "ses_mgr", "echo hello")).rejects.toThrow()
  await expect(exec("task_exec", "ses_free", "echo hello")).rejects.toThrow()
  await expect(exec("task_arch", "ses_arch", "echo hello")).rejects.toThrow()
  await expect(exec("task_paused", "ses_paused", "echo hello")).rejects.toThrow()
  await expect(exec("task_exec", "ses_exec", "echo hello", 50)).rejects.toThrow()
  await expect(exec("task_exec", "ses_exec", "echo hello", 700_000)).rejects.toThrow()
})
