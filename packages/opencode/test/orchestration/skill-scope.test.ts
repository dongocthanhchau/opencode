import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OrchestrationPolicy } from "../../src/orchestration/policy"

const root = mkdtempSync(path.join(tmpdir(), "cvis-skill-scope-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(OrchestrationPolicy.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

function worker(tid: string, sid: string, project: string, scope: Record<string, unknown>) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},${project},${sid},${root},${sid},'v1',${NOW},${NOW})`,
    )
    yield* db.run(
      sql`INSERT INTO cvis_task(id,project_id,title,role,status,scope,active_run_id,attempt,time_created,time_updated) VALUES(${tid},${project},${tid},'implementer','running',${JSON.stringify(scope)},${"run_" + tid},1,${NOW},${NOW})`,
    )
    yield* db.run(
      sql`INSERT INTO cvis_task_run(id,task_id,session_id,attempt,revision,status,time_created,time_updated) VALUES(${"run_" + tid},${tid},${sid},1,1,'running',${NOW},${NOW})`,
    )
    yield* db.run(
      sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},${project},'implementer',${tid},'busy',${NOW},${NOW})`,
    )
  })
}

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const pid of ["skill-p", "skill-q"]) {
        yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(${pid},${root},'[]',${NOW},${NOW})`)
      }
      yield* db.run(
        sql`INSERT INTO cvis_managed_project(id,slug,type,owner,mission,status,native_project_id,metadata,time_created,time_updated) VALUES('mp_skill','skill-proj','work','CVIS','Skills','active','skill-p',${JSON.stringify({ skills: ["managed-skill"] })},${NOW},${NOW})`,
      )
    }),
  )
  await runtime.runPromise(worker("task_override", "ses_override", "skill-p", { read_paths: ["src"], skills: ["customize-opencode"] }))
  await runtime.runPromise(worker("task_proj", "ses_proj", "skill-p", { read_paths: ["src"] }))
  await runtime.runPromise(worker("task_free", "ses_free", "skill-q", { read_paths: ["src"] }))
  await runtime.runPromise(worker("task_empty", "ses_empty", "skill-p", { read_paths: ["src"], skills: [] }))
})

afterAll(() => runtime.dispose())

async function authorize(sessionID: string, name: unknown) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const policy = yield* OrchestrationPolicy.Service
      yield* policy.authorize({ sessionID, tool: "skill", args: { name } })
    }),
  )
}

test("task scope allowlist overrides the managed project default", async () => {
  await authorize("ses_override", "customize-opencode")
  await expect(authorize("ses_override", "managed-skill")).rejects.toThrow("Skill not in project allowlist")
})

test("managed metadata allowlist applies when the task has none", async () => {
  await authorize("ses_proj", "managed-skill")
  await expect(authorize("ses_proj", "customize-opencode")).rejects.toThrow("Skill not in project allowlist")
})

test("no allowlist anywhere preserves previous open behavior", async () => {
  await authorize("ses_free", "anything-goes")
})

test("missing skill name is rejected", async () => {
  await expect(authorize("ses_proj", undefined)).rejects.toThrow("Skill name required")
})

test("catalog hides the skill tool only when the allowlist is explicitly empty", async () => {
  const visible = await runtime.runPromise(
    OrchestrationPolicy.Service.use((policy) => policy.catalog({ sessionID: "ses_empty", tools: ["read", "skill"] })),
  )
  expect(visible).toEqual(["read"])
  const shown = await runtime.runPromise(
    OrchestrationPolicy.Service.use((policy) => policy.catalog({ sessionID: "ses_proj", tools: ["read", "skill"] })),
  )
  expect(shown).toEqual(["read", "skill"])
})
