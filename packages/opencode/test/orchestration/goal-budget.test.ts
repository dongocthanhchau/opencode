import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-goal-budget-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()
const PROJECT_A = "proj-a"
const PROJECT_B = "proj-b"
const GOAL_A = "goal_test_a"
const MANAGER_SES = "ses_manager"
const OTHER_SES = "ses_other_proj"
const ARCHIVED_SES = "ses_archived"
const IMPLEMENTER_SES = "ses_implementer"

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(
        sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(${PROJECT_A},${root},'[]',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(${PROJECT_B},${root},'[]',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_project_goal(id,project_id,title,objective,status,budget_tokens,time_created,time_updated) VALUES(${GOAL_A},${PROJECT_A},'Test goal','Objective','active',NULL,${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${MANAGER_SES},${PROJECT_A},${MANAGER_SES},${root},'Manager','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,status,time_created,time_updated) VALUES(${MANAGER_SES},${PROJECT_A},'manager','idle',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${OTHER_SES},${PROJECT_B},${OTHER_SES},${root},'Other','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,status,time_created,time_updated) VALUES(${OTHER_SES},${PROJECT_B},'manager','idle',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,time_archived) VALUES(${ARCHIVED_SES},${PROJECT_A},${ARCHIVED_SES},${root},'Archived','v1',${NOW},${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${IMPLEMENTER_SES},${PROJECT_A},${IMPLEMENTER_SES},${root},'Implementer','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,status,time_created,time_updated) VALUES(${IMPLEMENTER_SES},${PROJECT_A},'implementer','idle',${NOW},${NOW})`,
      )
    }),
  )
})

afterAll(() => runtime.dispose())

test("success: sets budget when expectedBudget matches null", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      yield* svc.updateGoalBudget({
        goalID: GOAL_A,
        budgetTokens: 50000,
        expectedBudget: null,
        reason: "initial budget grant",
        actorSessionID: MANAGER_SES,
      })
      const result = yield* svc.budget({ goalID: GOAL_A })
      expect(result.cap).toBe(50000)
    }),
  )
})

test("success: updates budget when expectedBudget matches current cap", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      yield* svc.updateGoalBudget({
        goalID: GOAL_A,
        budgetTokens: 100000,
        expectedBudget: 50000,
        reason: "increase budget",
        actorSessionID: MANAGER_SES,
      })
      const result = yield* svc.budget({ goalID: GOAL_A })
      expect(result.cap).toBe(100000)
    }),
  )
})

test("CAS mismatch: rejects when expectedBudget does not match current cap", async () => {
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        yield* svc.updateGoalBudget({
          goalID: GOAL_A,
          budgetTokens: 200000,
          expectedBudget: 99999,
          reason: "stale update",
          actorSessionID: MANAGER_SES,
        })
      }),
    ),
  ).rejects.toThrow()
})

test("cross-project actor: rejects when actor session belongs to different project", async () => {
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        yield* svc.updateGoalBudget({
          goalID: GOAL_A,
          budgetTokens: 50000,
          expectedBudget: 100000,
          reason: "cross project attempt",
          actorSessionID: OTHER_SES,
        })
      }),
    ),
  ).rejects.toThrow()
})

test("archived actor: rejects when actor session is archived", async () => {
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        yield* svc.updateGoalBudget({
          goalID: GOAL_A,
          budgetTokens: 50000,
          expectedBudget: 100000,
          reason: "archived actor",
          actorSessionID: ARCHIVED_SES,
        })
      }),
    ),
  ).rejects.toThrow()
})

test("non-manager actor: rejects when actor binding role is not manager", async () => {
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        yield* svc.updateGoalBudget({
          goalID: GOAL_A,
          budgetTokens: 50000,
          expectedBudget: 100000,
          reason: "implementer should not update budget",
          actorSessionID: IMPLEMENTER_SES,
        })
      }),
    ),
  ).rejects.toThrow()
})

test("invalid budgetTokens: rejects zero", async () => {
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        yield* svc.updateGoalBudget({
          goalID: GOAL_A,
          budgetTokens: 0,
          expectedBudget: 100000,
          reason: "zero tokens",
          actorSessionID: MANAGER_SES,
        })
      }),
    ),
  ).rejects.toThrow()
})

test("invalid budgetTokens: rejects negative", async () => {
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        yield* svc.updateGoalBudget({
          goalID: GOAL_A,
          budgetTokens: -1,
          expectedBudget: 100000,
          reason: "negative tokens",
          actorSessionID: MANAGER_SES,
        })
      }),
    ),
  ).rejects.toThrow()
})

test("invalid reason: rejects empty string", async () => {
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        yield* svc.updateGoalBudget({
          goalID: GOAL_A,
          budgetTokens: 50000,
          expectedBudget: 100000,
          reason: "   ",
          actorSessionID: MANAGER_SES,
        })
      }),
    ),
  ).rejects.toThrow()
})

test("paused goal stays paused after budget update", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const GOAL_PAUSED = "goal_test_paused"
      const now = Date.now()
      yield* db.run(
        sql`INSERT INTO cvis_project_goal(id,project_id,title,objective,status,budget_tokens,time_created,time_updated) VALUES(${GOAL_PAUSED},${PROJECT_A},'Paused goal','Objective','paused',10000,${now},${now})`,
      )
      const svc = yield* Orchestration.Service
      yield* svc.updateGoalBudget({
        goalID: GOAL_PAUSED,
        budgetTokens: 20000,
        expectedBudget: 10000,
        reason: "extend paused goal budget",
        actorSessionID: MANAGER_SES,
      })
      const row = yield* db
        .select({
          status: sql<string>`status`,
          budget_tokens: sql<number | null>`budget_tokens`,
        })
        .from(sql`cvis_project_goal`)
        .where(sql`id = ${GOAL_PAUSED}`)
        .get()
      expect(row?.status).toBe("paused")
      expect(row?.budget_tokens).toBe(20000)
    }),
  )
})

test("invalid fractional budgetTokens: rejects float", async () => {
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        yield* svc.updateGoalBudget({
          goalID: GOAL_A,
          budgetTokens: 12345.67,
          expectedBudget: 100000,
          reason: "fractional tokens",
          actorSessionID: MANAGER_SES,
        })
      }),
    ),
  ).rejects.toThrow()
})

test("invalid NaN budgetTokens: rejects NaN", async () => {
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        yield* svc.updateGoalBudget({
          goalID: GOAL_A,
          budgetTokens: NaN,
          expectedBudget: 100000,
          reason: "NaN tokens",
          actorSessionID: MANAGER_SES,
        })
      }),
    ),
  ).rejects.toThrow()
})

test("invalid Infinity budgetTokens: rejects Infinity", async () => {
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        yield* svc.updateGoalBudget({
          goalID: GOAL_A,
          budgetTokens: Infinity,
          expectedBudget: 100000,
          reason: "Infinity tokens",
          actorSessionID: MANAGER_SES,
        })
      }),
    ),
  ).rejects.toThrow()
})

test("event is recorded after successful budget update", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const GOAL_EVT = "goal_test_evt"
      const now = Date.now()
      yield* db.run(
        sql`INSERT INTO cvis_project_goal(id,project_id,title,objective,status,budget_tokens,time_created,time_updated) VALUES(${GOAL_EVT},${PROJECT_A},'Event goal','Objective','active',5000,${now},${now})`,
      )
      const svc = yield* Orchestration.Service
      yield* svc.updateGoalBudget({
        goalID: GOAL_EVT,
        budgetTokens: 10000,
        expectedBudget: 5000,
        reason: "event test",
        actorSessionID: MANAGER_SES,
      })
      const events = yield* svc.listEvents({ projectID: PROJECT_A })
      const budgetEvent = events.find(
        (e) => e.type === "goal.budget.updated" && e.entityID === GOAL_EVT,
      )
      expect(budgetEvent).toBeDefined()
      const payload = budgetEvent!.payload as Record<string, unknown>
      expect(payload.old_cap).toBe(5000)
      expect(payload.new_cap).toBe(10000)
      expect(payload.reason).toBe("event test")
      expect(payload.actor).toBe(MANAGER_SES)
    }),
  )
})
