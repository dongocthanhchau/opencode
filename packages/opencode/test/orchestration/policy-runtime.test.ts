import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OrchestrationPolicy } from "../../src/orchestration/policy"

const root = mkdtempSync(path.join(tmpdir(), "cvis-policy-runtime-"))
const outside = mkdtempSync(path.join(tmpdir(), "cvis-policy-outside-"))
mkdirSync(path.join(root, "src"))
symlinkSync(outside, path.join(root, "src", "escape"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(OrchestrationPolicy.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = Date.now()
      yield* db.run(
        sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('policy-p',${root},'[]',${now},${now})`,
      )
      const fixtures = [
        ["ses_writer", "implementer"],
        ["ses_reader", "verifier"],
      ] as const
      for (const [sid, role] of fixtures) {
        const tid = `task_${role}`
        const rid = `run_${role}`
        const scope = JSON.stringify({
          read_paths: ["src"],
          write_paths: role === "implementer" ? ["src"] : [],
          tools: ["bash"],
        })
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'policy-p',${sid},${root},${sid},'v1',${now},${now})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,title,role,status,scope,active_run_id,attempt,time_created,time_updated) VALUES(${tid},'policy-p',${tid},${role},'running',${scope},${rid},1,${now},${now})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_task_run(id,task_id,session_id,attempt,revision,status,time_created,time_updated) VALUES(${rid},${tid},${sid},1,1,'running',${now},${now})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},'policy-p',${role},${tid},'busy',${now},${now})`,
        )
      }
    }),
  )
})
afterAll(() => runtime.dispose())

async function execute(sessionID: string, tool: string, args: Record<string, unknown>, effect: () => void) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const policy = yield* OrchestrationPolicy.Service
      yield* policy.authorize({ sessionID, tool, args })
      yield* Effect.sync(effect)
    }),
  )
}

test("actual policy permits scoped write", async () => {
  const target = path.join(root, "src", "allowed.ts")
  await execute("ses_writer", "write", { filePath: target, content: "ok" }, () => writeFileSync(target, "ok"))
  expect(existsSync(target)).toBe(true)
})

test("out-of-scope write never reaches filesystem effect", async () => {
  const target = path.join(root, "forbidden.ts")
  await expect(
    execute("ses_writer", "write", { filePath: target }, () => writeFileSync(target, "bad")),
  ).rejects.toThrow()
  expect(existsSync(target)).toBe(false)
})

test("new file below existing symlink never reaches outside path", async () => {
  const target = path.join(root, "src", "escape", "new.ts")
  await expect(
    execute("ses_writer", "write", { filePath: target }, () => writeFileSync(target, "bad")),
  ).rejects.toThrow()
  expect(existsSync(path.join(outside, "new.ts"))).toBe(false)
})

test("verifier cannot write via either edit or shell", async () => {
  const target = path.join(root, "src", "verifier-write.ts")
  for (const tool of ["write", "edit", "bash"]) {
    await expect(
      execute("ses_reader", tool, { filePath: target, command: "write source" }, () => writeFileSync(target, "bad")),
    ).rejects.toThrow()
  }
  expect(existsSync(target)).toBe(false)
})

test("unknown MCP call fails closed", async () => {
  let executed = false
  await expect(
    execute("ses_writer", "new_external_write", {}, () => {
      executed = true
    }),
  ).rejects.toThrow()
  expect(executed).toBe(false)
})

test("catalog advertises only actual role capabilities", async () => {
  const visible = await runtime.runPromise(
    OrchestrationPolicy.Service.use((policy) =>
      policy.catalog({
        sessionID: "ses_reader",
        tools: ["read", "write", "bash", "cvis_verify", "cvis_create_task", "unknown_mcp"],
      }),
    ),
  )
  expect(visible).toEqual(["read", "cvis_verify"])
})

test("cancelled task blocks subsequent turns and tool effects", async () => {
  await runtime.runPromise(
    Database.Service.use(({ db }) =>
      db.run(sql`UPDATE cvis_task SET status='cancelled' WHERE id='task_implementer'`).pipe(Effect.orDie),
    ),
  )
  await expect(execute("ses_writer", "__turn__", {}, () => {})).rejects.toThrow()
})
