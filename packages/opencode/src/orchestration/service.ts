import { Context, Effect, Layer, Schema } from "effect"
import { and, eq, gt, inArray, max } from "drizzle-orm"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { MessageTable as SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "../session/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  CvisCheckTable,
  CvisEventTable,
  CvisPromptTemplateTable,
  CvisMessageTable,
  CvisProjectGoalTable,
  CvisSessionBindingTable,
  CvisTaskRunTable,
  CvisTaskTable,
} from "@opencode-ai/core/orchestration/sql"
import {
  BindingStatus,
  canTransitionBinding,
  canTransitionGoal,
  canTransitionRun,
  canTransitionTask,
  checklistProgress,
  GoalStatus,
  MessageKind,
  RunStatus,
  TaskStatus,
} from "./machine"
import {
  Role,
  canonicalPath,
  checkResolvedPaths,
  effectiveRuleset,
  pathAllowed,
  scopesOverlap,
  toRuleset,
  validateScope,
} from "./roles"
import { OrchestrationTemplates } from "./templates"
import { estimate } from "@/util/token"
import type { TaskScope } from "./roles"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("CvisNotFound", {
  entity: Schema.String,
  id: Schema.String,
}) {}

export class InvalidTransitionError extends Schema.TaggedErrorClass<InvalidTransitionError>()("CvisInvalidTransition", {
  entity: Schema.String,
  id: Schema.String,
  from: Schema.String,
  to: Schema.String,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("CvisConflict", {
  entity: Schema.String,
  id: Schema.String,
  reason: Schema.String,
}) {}

export interface Interface {
  readonly createGoal: (input: {
    projectID: string
    title: string
    objective: string
    budgetTokens?: number
  }) => Effect.Effect<{ id: string }, NotFoundError | InvalidTransitionError>
  readonly setGoalStatus: (input: {
    id: string
    status: GoalStatus
    reason?: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly createTask: (input: {
    projectID: string
    goalID?: string
    title: string
    description?: string
    role: Role
    priority?: number
    scope?: { read_paths?: string[]; write_paths?: string[]; tools?: string[]; max_tokens?: number }
    acceptance?: { id: string; label: string; weight: number }[]
    dependencies?: string[]
  }) => Effect.Effect<{ id: string }, NotFoundError | InvalidTransitionError>
  readonly setTaskStatus: (input: {
    id: string
    status: TaskStatus
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly startRun: (input: {
    taskID: string
    sessionID: string
  }) => Effect.Effect<{ id: string; attempt: number }, NotFoundError | InvalidTransitionError | ConflictError>
  readonly setRunStatus: (input: {
    id: string
    status: RunStatus
    tokensUsed?: number
    result?: Record<string, unknown>
    error?: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly claimTask: (input: {
    taskID: string
    sessionID: string
    projectDenies?: string[]
  }) => Effect.Effect<{ runID: string; attempt: number }, NotFoundError | InvalidTransitionError | ConflictError>
  readonly pauseTask: (input: {
    taskID: string
    reason?: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly cancelTask: (input: {
    taskID: string
    reason?: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly submitResult: (input: {
    runID: string
    result?: Record<string, unknown>
    tokensUsed?: number
    error?: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError | ConflictError>
  readonly inbox: (input: {
    sessionID: string
    projectID: string
  }) => Effect.Effect<{ id: string; kind: string; from: string; taskID: string | null; body: unknown; time: number }[]>
  readonly verifyCheck: (input: {
    taskID: string
    checkID: string
    runID?: string
    sessionID: string
    verdict: "pass" | "fail"
    evidence?: Record<string, unknown>
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly taskProgress: (input: {
    taskID: string
  }) => Effect.Effect<{ percent: number; passed: string[]; pending: string[] }, NotFoundError>
  readonly goalProgress: (input: {
    goalID: string
  }) => Effect.Effect<
    { percent: number; tasks: { id: string; title: string; status: string; percent: number }[] },
    NotFoundError
  >
  readonly reviseTask: (input: {
    taskID: string
    title?: string
    description?: string
    scope?: { read_paths?: string[]; write_paths?: string[]; tools?: string[]; max_tokens?: number }
    acceptance?: { id: string; label: string; weight: number }[]
  }) => Effect.Effect<{ revision: number }, NotFoundError | InvalidTransitionError>
  readonly budget: (input: {
    goalID?: string
    taskID?: string
  }) => Effect.Effect<{ used: number; cap: number | null }, NotFoundError>
  readonly settleReview: (input: {
    taskID: string
    sessionID: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly recover: (input: { projectID: string }) => Effect.Effect<{ taskID: string; runID: string }[]>
  readonly listTemplates: (input: {
    role?: string
  }) => Effect.Effect<{ id: string; name: string; role: string | null; version: number }[]>
  readonly createTemplate: (input: {
    name: string
    role?: string
    body: string
    inputs?: { name: string; required: boolean }[]
  }) => Effect.Effect<{ id: string; version: number }, InvalidTransitionError>
  readonly renderTemplate: (input: {
    name: string
    vars: Record<string, string>
  }) => Effect.Effect<{ text: string; tokens: number }, NotFoundError | InvalidTransitionError>
  readonly contextPack: (input: { taskID: string }) => Effect.Effect<Record<string, unknown>, NotFoundError>
  readonly handoffBrief: (input: { sessionID: string }) => Effect.Effect<Record<string, unknown>, NotFoundError>
  readonly reuseCheck: (input: {
    sessionID: string
    taskID: string
  }) => Effect.Effect<{ eligible: boolean; reasons: string[] }, NotFoundError>
  readonly cleanCandidates: (input: {
    projectID: string
    idleDays: number
  }) => Effect.Effect<{ id: string; title: string; reason: string; time: number }[]>
  readonly archiveIdle: (input: { projectID: string; idleDays?: number }) => Effect.Effect<string[]>
  readonly projectSnapshot: (input: { projectID: string }) => Effect.Effect<
    {
      eventCursor: number
      goals: { id: string; title: string; status: string; percent: number; used: number; cap: number | null }[]
      columns: {
        status: string
        tasks: { id: string; title: string; role: string; percent: number; goalID: string | null }[]
      }[]
      bindings: { session: string; role: string; status: string; task: string | null }[]
    },
    NotFoundError
  >
  readonly taskDetail: (input: { taskID: string }) => Effect.Effect<Record<string, unknown>, NotFoundError>
  readonly bindSession: (input: {
    sessionID: string
    projectID: string
    role: Role
    taskID?: string
    managerSession?: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly setBindingStatus: (input: {
    sessionID: string
    status: BindingStatus
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly sendMessage: (input: {
    projectID: string
    taskID?: string
    runID?: string
    fromSession: string
    toSession?: string
    kind: MessageKind
    body?: Record<string, unknown>
    idempotencyKey?: string
  }) => Effect.Effect<{ id: string }, InvalidTransitionError>
  readonly ackMessage: (input: { id: string }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly buildRuleset: (input: {
    role: Role
    scope?: TaskScope
    projectRules?: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[]
  }) => Effect.Effect<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }[]>
  readonly checkScope: (input: {
    scope: TaskScope
    worktree?: string
    projectDenies?: string[]
  }) => Effect.Effect<string[]>
  readonly resolveScope: (input: {
    worktree: string
    paths: string[]
  }) => Effect.Effect<{ resolved: { original: string; resolved: string }[]; escapes: string[] }>
  readonly listTasks: (input: {
    projectID: string
    status?: TaskStatus
  }) => Effect.Effect<
    { id: string; title: string; role: string; status: string; attempt: number; goalID: string | null }[]
  >
  readonly listEvents: (input: {
    projectID: string
    cursor?: number
    limit?: number
  }) => Effect.Effect<{ id: string; type: string; entity: string; entityID: string; payload: unknown; time: number }[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CvisOrchestration") {}

function newID(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function isRole(role: string): role is Role {
  return (["manager", "researcher", "implementer", "verifier", "maintenance"] as readonly string[]).includes(role)
}

function isMessageKind(kind: string): kind is MessageKind {
  return (
    ["assign", "progress", "question", "blocked", "result", "review", "cancel", "ack"] as readonly string[]
  ).includes(kind)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service

    const recordEvent = Effect.fn("Cvis.recordEvent")(function* (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
      input: { projectID: string; entity: string; entityID: string; type: string; payload?: Record<string, unknown> },
    ) {
      const latest = yield* tx
        .select({ value: max(CvisEventTable.sequence) })
        .from(CvisEventTable)
        .get()
      yield* tx
        .insert(CvisEventTable)
        .values({
          id: newID("evt"),
          project_id: ProjectV2.ID.make(input.projectID),
          entity_kind: input.entity,
          entity_id: input.entityID,
          type: input.type,
          sequence: (latest?.value ?? 0) + 1,
          payload: input.payload ?? null,
        })
        .run()
    })

    const createGoal = Effect.fn("Cvis.createGoal")(function* (input: {
      projectID: string
      title: string
      objective: string
      budgetTokens?: number
    }) {
      const id = newID("goal")
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(CvisProjectGoalTable)
              .values({
                id,
                project_id: ProjectV2.ID.make(input.projectID),
                title: input.title,
                objective: input.objective,
                status: "planning",
                budget_tokens: input.budgetTokens ?? null,
              })
              .run()
            yield* recordEvent(tx, {
              projectID: input.projectID,
              entity: "goal",
              entityID: id,
              type: "goal.created",
            })
          }),
        )
        .pipe(Effect.orDie)
      return { id }
    })

    const setGoalStatus = Effect.fn("Cvis.setGoalStatus")(function* (input: {
      id: string
      status: GoalStatus
      reason?: string
    }) {
      const row = yield* db
        .select()
        .from(CvisProjectGoalTable)
        .where(eq(CvisProjectGoalTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "goal", id: input.id })
      if (!canTransitionGoal(row.status as GoalStatus, input.status)) {
        return yield* new InvalidTransitionError({ entity: "goal", id: input.id, from: row.status, to: input.status })
      }
      const metadata: Record<string, unknown> = { ...(row.metadata ?? {}) }
      if (input.status === "active" && typeof metadata.activated_at !== "number") {
        const managers = yield* db
          .select()
          .from(CvisSessionBindingTable)
          .where(eq(CvisSessionBindingTable.project_id, row.project_id))
          .all()
          .pipe(Effect.orDie)
        metadata.manager_session_id = managers.find((binding) => binding.role === "manager")?.session_id ?? null
        metadata.activated_at = Date.now()
      }
      if (input.status === "completed" || input.status === "cancelled") metadata.completed_at = Date.now()
      if (input.status === "completed") {
        const tasks = yield* db
          .select()
          .from(CvisTaskTable)
          .where(eq(CvisTaskTable.goal_id, row.id))
          .all()
          .pipe(Effect.orDie)
        const required = tasks.filter(
          (task) =>
            !(
              task.role === "verifier" &&
              task.weight === 0 &&
              task.scope?.review_task_id &&
              typeof task.scope.review_revision === "number" &&
              tasks.some(
                (target) =>
                  target.id === task.scope?.review_task_id &&
                  target.revision > (task.scope?.review_revision ?? Infinity),
              )
            ),
        )
        if (!required.length || required.some((task) => task.status !== "done")) {
          return yield* new InvalidTransitionError({
            entity: "goal",
            id: row.id,
            from: row.status,
            to: "completed: unfinished tasks",
          })
        }
        for (const task of required) {
          const gate = yield* doneGate(task.id)
          if (!gate.ok)
            return yield* new InvalidTransitionError({
              entity: "goal",
              id: row.id,
              from: row.status,
              to: `completed: ${gate.reason}`,
            })
        }
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(CvisProjectGoalTable)
              .set({ status: input.status, metadata })
              .where(eq(CvisProjectGoalTable.id, input.id))
              .run()
            yield* recordEvent(tx, {
              projectID: row.project_id,
              entity: "goal",
              entityID: input.id,
              type: `goal.${input.status}`,
              payload: input.reason ? { reason: input.reason } : undefined,
            })
          }),
        )
        .pipe(Effect.orDie)
      if (input.status === "paused" || input.status === "cancelled") {
        const tasks = yield* db
          .select()
          .from(CvisTaskTable)
          .where(eq(CvisTaskTable.goal_id, row.id))
          .all()
          .pipe(Effect.orDie)
        for (const task of tasks) {
          if (["running", "verifying"].includes(task.status)) {
            if (input.status === "paused") yield* pauseTask({ taskID: task.id })
            else yield* cancelTask({ taskID: task.id })
          }
        }
      }
    })

    const createTask = Effect.fn("Cvis.createTask")(function* (input: {
      projectID: string
      goalID?: string
      title: string
      description?: string
      role: Role
      priority?: number
      scope?: { read_paths?: string[]; write_paths?: string[]; tools?: string[]; max_tokens?: number }
      acceptance?: { id: string; label: string; weight: number }[]
      dependencies?: string[]
    }) {
      if (!isRole(input.role)) {
        return yield* new InvalidTransitionError({ entity: "task", id: "new", from: "", to: input.role })
      }
      const scopeErrors = validateScope(input.scope ?? {}, {})
      if (scopeErrors.length)
        return yield* new InvalidTransitionError({
          entity: "task",
          id: "new",
          from: "scope",
          to: scopeErrors.join("; "),
        })
      const acceptance = input.acceptance ?? [
        { id: "verification", label: "Independent verification of the task goal", weight: 100 },
      ]
      if (
        !acceptance.length ||
        new Set(acceptance.map((item) => item.id)).size !== acceptance.length ||
        acceptance.some(
          (item) => !item.id?.trim() || !item.label?.trim() || !Number.isSafeInteger(item.weight) || item.weight <= 0,
        )
      ) {
        return yield* new InvalidTransitionError({
          entity: "task",
          id: "new",
          from: "acceptance",
          to: "valid weighted criteria required",
        })
      }
      if (input.goalID) {
        const goal = yield* db
          .select()
          .from(CvisProjectGoalTable)
          .where(eq(CvisProjectGoalTable.id, input.goalID))
          .get()
          .pipe(Effect.orDie)
        if (!goal) return yield* new NotFoundError({ entity: "goal", id: input.goalID })
        if (goal.project_id !== input.projectID || ["completed", "cancelled"].includes(goal.status)) {
          return yield* new InvalidTransitionError({
            entity: "task",
            id: "new",
            from: input.projectID,
            to: "invalid project goal",
          })
        }
      }
      for (const dep of input.dependencies ?? []) {
        const found = yield* db
          .select({ id: CvisTaskTable.id, project_id: CvisTaskTable.project_id })
          .from(CvisTaskTable)
          .where(eq(CvisTaskTable.id, dep))
          .get()
          .pipe(Effect.orDie)
        if (!found) return yield* new NotFoundError({ entity: "task", id: dep })
        if (found.project_id !== input.projectID) {
          return yield* new InvalidTransitionError({
            entity: "task",
            id: "new",
            from: dep,
            to: "cross-project-dependency",
          })
        }
      }
      const id = newID("task")
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(CvisTaskTable)
              .values({
                id,
                project_id: ProjectV2.ID.make(input.projectID),
                goal_id: input.goalID ?? null,
                title: input.title,
                description: input.description ?? "",
                role: input.role,
                priority: input.priority ?? 0,
                status: "draft",
                scope: input.scope ?? null,
                acceptance,
                dependencies: input.dependencies ?? null,
              })
              .run()
            yield* recordEvent(tx, {
              projectID: input.projectID,
              entity: "task",
              entityID: id,
              type: "task.created",
              payload: input.goalID ? { goalID: input.goalID } : undefined,
            })
          }),
        )
        .pipe(Effect.orDie)
      return { id }
    })

    const setTaskStatus = Effect.fn("Cvis.setTaskStatus")(function* (input: { id: string; status: TaskStatus }) {
      const row = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "task", id: input.id })
      if (!canTransitionTask(row.status as TaskStatus, input.status)) {
        return yield* new InvalidTransitionError({ entity: "task", id: input.id, from: row.status, to: input.status })
      }
      if (input.status === "running" && !row.active_run_id)
        return yield* new InvalidTransitionError({ entity: "task", id: row.id, from: row.status, to: "claim required" })
      if (input.status === "done") {
        const gate = yield* doneGate(row.id)
        if (!gate.ok) {
          return yield* new InvalidTransitionError({
            entity: "task",
            id: input.id,
            from: row.status,
            to: `done(${gate.reason})`,
          })
        }
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(CvisTaskTable).set({ status: input.status }).where(eq(CvisTaskTable.id, input.id)).run()
            if (input.status === "done" && row.active_run_id) {
              yield* tx
                .update(CvisTaskRunTable)
                .set({ status: "done", time_finished: Date.now() })
                .where(eq(CvisTaskRunTable.id, row.active_run_id))
                .run()
              yield* tx
                .update(CvisSessionBindingTable)
                .set({ status: "idle", task_id: null })
                .where(eq(CvisSessionBindingTable.task_id, row.id))
                .run()
            }
            yield* recordEvent(tx, {
              projectID: row.project_id,
              entity: "task",
              entityID: input.id,
              type: `task.${input.status}`,
              payload: { from: row.status },
            })
          }),
        )
        .pipe(Effect.orDie)
    })

    const startRun = Effect.fn("Cvis.startRun")(function* (input: { taskID: string; sessionID: string }) {
      const claim = yield* claimTask(input)
      return { id: claim.runID, attempt: claim.attempt }
    })

    const setRunStatus = Effect.fn("Cvis.setRunStatus")(function* (input: {
      id: string
      status: RunStatus
      tokensUsed?: number
      result?: Record<string, unknown>
      error?: string
    }) {
      const row = yield* db
        .select()
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "run", id: input.id })
      if (!canTransitionRun(row.status as RunStatus, input.status)) {
        return yield* new InvalidTransitionError({ entity: "run", id: input.id, from: row.status, to: input.status })
      }
      const task = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, row.task_id))
        .get()
        .pipe(Effect.orDie)
      if (!task || task.active_run_id !== row.id || task.revision !== row.revision || task.attempt !== row.attempt)
        return yield* new InvalidTransitionError({ entity: "run", id: row.id, from: row.status, to: "stale attempt" })
      if (input.status === "done" || input.status === "verifying") {
        return yield* new InvalidTransitionError({
          entity: "run",
          id: row.id,
          from: row.status,
          to: "submit and independent verification required",
        })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(CvisTaskRunTable)
              .set({
                status: input.status,
                tokens_used: input.tokensUsed ?? row.tokens_used,
                result: input.result ?? row.result,
                error: input.error ?? row.error,
                time_started: input.status === "running" && row.time_started == null ? Date.now() : row.time_started,
                time_finished:
                  input.status === "done" || input.status === "failed" || input.status === "cancelled"
                    ? Date.now()
                    : row.time_finished,
              })
              .where(eq(CvisTaskRunTable.id, input.id))
              .run()
            if (input.status === "failed" || input.status === "cancelled") {
              yield* tx
                .update(CvisTaskTable)
                .set({ status: input.status, active_run_id: null, assigned_session: null })
                .where(eq(CvisTaskTable.id, row.task_id))
                .run()
              yield* tx
                .update(CvisSessionBindingTable)
                .set({ status: "idle", task_id: null })
                .where(eq(CvisSessionBindingTable.task_id, row.task_id))
                .run()
            }
            yield* recordEvent(tx, {
              projectID: task?.project_id ?? "",
              entity: "run",
              entityID: input.id,
              type: `run.${input.status}`,
              payload: { from: row.status },
            })
          }),
        )
        .pipe(Effect.orDie)
    })

    const claimTask = Effect.fn("Cvis.claimTask")(function* (input: {
      taskID: string
      sessionID: string
      projectDenies?: string[]
    }) {
      const task = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      if (task.status !== "queued") {
        return yield* new InvalidTransitionError({ entity: "task", id: input.taskID, from: task.status, to: "running" })
      }
      if (task.goal_id) {
        const goal = yield* db
          .select()
          .from(CvisProjectGoalTable)
          .where(eq(CvisProjectGoalTable.id, task.goal_id))
          .get()
          .pipe(Effect.orDie)
        if (!goal || goal.status !== "active")
          return yield* new ConflictError({ entity: "task", id: task.id, reason: "goal is not active" })
        if (goal?.budget_tokens != null && (yield* goalSpend(goal.id)) >= goal.budget_tokens) {
          return yield* new ConflictError({ entity: "task", id: input.taskID, reason: "goal budget exhausted" })
        }
      }
      {
        const scope = (task.scope ?? {}) as { max_tokens?: number }
        if (scope.max_tokens != null && (yield* taskSpend(task.id)) >= scope.max_tokens) {
          return yield* new ConflictError({ entity: "task", id: input.taskID, reason: "task token budget exhausted" })
        }
      }
      const sinfo = yield* sessions
        .get(SessionID.make(input.sessionID))
        .pipe(Effect.mapError(() => new NotFoundError({ entity: "session", id: input.sessionID })))
      if (sinfo.projectID !== task.project_id) {
        return yield* new ConflictError({
          entity: "task",
          id: input.taskID,
          reason: "session belongs to another project",
        })
      }
      const scope = (task.scope ?? {}) as TaskScope
      const scopeErrors = validateScope(scope, { worktree: sinfo.directory, projectDenies: input.projectDenies })
      if (scopeErrors.length > 0) {
        return yield* new ConflictError({ entity: "task", id: input.taskID, reason: scopeErrors.join("; ") })
      }
      const root = canonicalPath(sinfo.directory)
      for (const scoped of [...(scope.read_paths ?? []), ...(scope.write_paths ?? [])]) {
        const resolved = canonicalPath(path.resolve(root, scoped))
        if (!pathAllowed(resolved, [root]))
          return yield* new ConflictError({ entity: "task", id: task.id, reason: `symlink escapes project: ${scoped}` })
      }
      for (const dep of task.dependencies ?? []) {
        const depRow = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, dep)).get().pipe(Effect.orDie)
        if (!depRow || depRow.status !== "done") {
          return yield* new ConflictError({ entity: "task", id: input.taskID, reason: `dependency not done: ${dep}` })
        }
      }
      const active = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.project_id, task.project_id))
        .all()
        .pipe(Effect.orDie)
      const clashes = active.filter(
        (other) =>
          other.id !== task.id &&
          (other.status === "running" || other.status === "verifying") &&
          scopesOverlap(scope, (other.scope ?? {}) as TaskScope),
      )
      if (clashes.length > 0) {
        return yield* new ConflictError({
          entity: "task",
          id: input.taskID,
          reason: `write scope overlaps running task: ${clashes.map((c) => c.id).join(",")}`,
        })
      }
      const current = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (
        current &&
        (current.status !== "idle" || current.role !== task.role || current.project_id !== task.project_id)
      ) {
        return yield* new InvalidTransitionError({
          entity: "binding",
          id: input.sessionID,
          from: current.task_id ?? current.status,
          to: input.taskID,
        })
      }
      const ceiling = current?.permission_ceiling ?? sinfo.permission ?? []
      const ruleset = toRuleset(effectiveRuleset({ role: task.role as Role, scope, projectRules: ceiling }))
      const existing = ((sinfo.metadata ?? {}) as Record<string, unknown>) ?? {}
      const cvis = { role: task.role, taskID: input.taskID, projectID: task.project_id }
      const outcome = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const won = yield* tx
              .update(CvisTaskTable)
              .set({ status: "running" })
              .where(
                and(
                  eq(CvisTaskTable.id, task.id),
                  eq(CvisTaskTable.status, "queued"),
                  eq(CvisTaskTable.revision, task.revision),
                ),
              )
              .returning({ id: CvisTaskTable.id })
              .all()
            if (!won.length)
              return yield* new ConflictError({ entity: "task", id: task.id, reason: "concurrent or stale claim" })
            const fresh = yield* tx.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get()
            if (!fresh) return yield* new NotFoundError({ entity: "task", id: task.id })
            const occupant = yield* tx
              .select()
              .from(CvisSessionBindingTable)
              .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
              .get()
            if (
              occupant &&
              (occupant.status !== "idle" || occupant.role !== task.role || occupant.project_id !== task.project_id)
            ) {
              return yield* new ConflictError({
                entity: "session",
                id: input.sessionID,
                reason: "session is not eligible for reuse",
              })
            }
            const activeTasks = yield* tx
              .select()
              .from(CvisTaskTable)
              .where(eq(CvisTaskTable.project_id, task.project_id))
              .all()
            const normalizedScope = (value: TaskScope): TaskScope => ({
              ...value,
              write_paths: (value.write_paths ?? []).map((r) => canonicalPath(path.resolve(root, r))),
            })
            if (
              activeTasks.some(
                (other) =>
                  other.id !== task.id &&
                  ["running", "verifying"].includes(other.status) &&
                  scopesOverlap(normalizedScope(scope), normalizedScope(other.scope ?? {})),
              )
            ) {
              return yield* new ConflictError({ entity: "task", id: task.id, reason: "overlapping active write scope" })
            }
            if (task.goal_id) {
              const goal = yield* tx
                .select()
                .from(CvisProjectGoalTable)
                .where(eq(CvisProjectGoalTable.id, task.goal_id))
                .get()
              if (!goal || goal.status !== "active")
                return yield* new ConflictError({ entity: "goal", id: task.goal_id, reason: "goal is not active" })
            }
            const prior = yield* tx
              .select({ attempt: CvisTaskRunTable.attempt })
              .from(CvisTaskRunTable)
              .where(eq(CvisTaskRunTable.task_id, input.taskID))
              .all()
            const attempt = prior.reduce((max, r) => Math.max(max, r.attempt), 0) + 1
            const runID = newID("run")
            yield* tx
              .insert(CvisTaskRunTable)
              .values({
                id: runID,
                task_id: input.taskID,
                session_id: input.sessionID,
                attempt,
                revision: task.revision,
                status: "pending",
                lease_expires: Date.now() + Math.max(1000, Number(process.env.CVIS_RUN_LEASE_MS) || 120_000),
              })
              .onConflictDoNothing()
              .run()
            const check = yield* tx
              .select({ id: CvisTaskRunTable.id })
              .from(CvisTaskRunTable)
              .where(eq(CvisTaskRunTable.id, runID))
              .get()
            if (!check) {
              return yield* new ConflictError({ entity: "task", id: input.taskID, reason: "concurrent claim won" })
            }
            yield* tx
              .insert(CvisSessionBindingTable)
              .values({
                session_id: input.sessionID,
                project_id: task.project_id,
                role: task.role,
                task_id: input.taskID,
                manager_session: current?.manager_session ?? null,
                status: "busy",
                permission_ceiling: ceiling,
              })
              .onConflictDoUpdate({
                target: CvisSessionBindingTable.session_id,
                set: { role: task.role, task_id: input.taskID, status: "busy", permission_ceiling: ceiling },
              })
              .run()
            yield* tx
              .update(CvisTaskTable)
              .set({ active_run_id: runID, assigned_session: input.sessionID, attempt })
              .where(eq(CvisTaskTable.id, task.id))
              .run()
            yield* tx
              .update(SessionTable)
              .set({ permission: ruleset, metadata: { ...existing, cvis } })
              .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
              .run()
            yield* recordEvent(tx, {
              projectID: task.project_id,
              entity: "task",
              entityID: input.taskID,
              type: "task.claimed",
              payload: { sessionID: input.sessionID, attempt },
            })
            return { runID, attempt }
          }),
        )
        .pipe(Effect.orDie)
      return outcome
    })

    const pauseTask = Effect.fn("Cvis.pauseTask")(function* (input: { taskID: string; reason?: string }) {
      const row = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      if (!canTransitionTask(row.status as TaskStatus, "paused")) {
        return yield* new InvalidTransitionError({ entity: "task", id: input.taskID, from: row.status, to: "paused" })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(CvisTaskTable)
              .set({ status: "paused", active_run_id: null, assigned_session: null })
              .where(eq(CvisTaskTable.id, input.taskID))
              .run()
            yield* tx
              .update(CvisSessionBindingTable)
              .set({ status: "idle", task_id: null })
              .where(eq(CvisSessionBindingTable.task_id, input.taskID))
              .run()
            const open = yield* tx
              .select()
              .from(CvisTaskRunTable)
              .where(eq(CvisTaskRunTable.task_id, input.taskID))
              .all()
            for (const run of open) {
              if (run.status === "running" || run.status === "pending" || run.status === "verifying") {
                yield* tx
                  .update(CvisTaskRunTable)
                  .set({ status: "cancelled", error: "task paused", time_finished: Date.now() })
                  .where(eq(CvisTaskRunTable.id, run.id))
                  .run()
                yield* recordEvent(tx, {
                  projectID: row.project_id,
                  entity: "run",
                  entityID: run.id,
                  type: "run.cancelled",
                  payload: { reason: "task paused" },
                })
              }
            }
            yield* recordEvent(tx, {
              projectID: row.project_id,
              entity: "task",
              entityID: input.taskID,
              type: "task.paused",
              payload: input.reason ? { reason: input.reason } : undefined,
            })
          }),
        )
        .pipe(Effect.orDie)
      const runs = yield* db
        .select()
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.task_id, input.taskID))
        .all()
        .pipe(Effect.orDie)
      for (const run of runs)
        yield* runState.cancel(SessionID.make(run.session_id)).pipe(Effect.catchCause(() => Effect.void))
    })

    const cancelTask = Effect.fn("Cvis.cancelTask")(function* (input: { taskID: string; reason?: string }) {
      const row = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      if (!canTransitionTask(row.status as TaskStatus, "cancelled")) {
        return yield* new InvalidTransitionError({
          entity: "task",
          id: input.taskID,
          from: row.status,
          to: "cancelled",
        })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(CvisTaskTable)
              .set({ status: "cancelled", active_run_id: null, assigned_session: null })
              .where(eq(CvisTaskTable.id, input.taskID))
              .run()
            yield* tx
              .update(CvisSessionBindingTable)
              .set({ status: "idle", task_id: null })
              .where(eq(CvisSessionBindingTable.task_id, input.taskID))
              .run()
            const open = yield* tx
              .select()
              .from(CvisTaskRunTable)
              .where(eq(CvisTaskRunTable.task_id, input.taskID))
              .all()
            for (const run of open) {
              if (run.status === "running" || run.status === "pending" || run.status === "verifying") {
                yield* tx
                  .update(CvisTaskRunTable)
                  .set({ status: "cancelled", error: "task cancelled", time_finished: Date.now() })
                  .where(eq(CvisTaskRunTable.id, run.id))
                  .run()
              }
            }
            yield* recordEvent(tx, {
              projectID: row.project_id,
              entity: "task",
              entityID: input.taskID,
              type: "task.cancelled",
              payload: input.reason ? { reason: input.reason } : undefined,
            })
          }),
        )
        .pipe(Effect.orDie)
      const runs = yield* db
        .select()
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.task_id, input.taskID))
        .all()
        .pipe(Effect.orDie)
      for (const run of runs)
        yield* runState.cancel(SessionID.make(run.session_id)).pipe(Effect.catchCause(() => Effect.void))
    })

    const submitResult = Effect.fn("Cvis.submitResult")(function* (input: {
      runID: string
      result?: Record<string, unknown>
      tokensUsed?: number
      error?: string
    }) {
      const row = yield* db
        .select()
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.id, input.runID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "run", id: input.runID })
      if (row.status !== "running") {
        return yield* new InvalidTransitionError({ entity: "run", id: input.runID, from: row.status, to: "verifying" })
      }
      const newer = yield* db
        .select()
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.task_id, row.task_id))
        .all()
        .pipe(Effect.orDie)
      const maxAttempt = newer.reduce((max, r) => Math.max(max, r.attempt), 0)
      if (row.attempt < maxAttempt) {
        const task = yield* db
          .select()
          .from(CvisTaskTable)
          .where(eq(CvisTaskTable.id, row.task_id))
          .get()
          .pipe(Effect.orDie)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* recordEvent(tx, {
                projectID: task?.project_id ?? "",
                entity: "run",
                entityID: input.runID,
                type: "run.late-result-ignored",
                payload: { attempt: row.attempt, maxAttempt },
              })
            }),
          )
          .pipe(Effect.orDie)
        return yield* new ConflictError({
          entity: "run",
          id: input.runID,
          reason: `stale attempt ${row.attempt}, latest is ${maxAttempt}`,
        })
      }
      const task = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, row.task_id))
        .get()
        .pipe(Effect.orDie)
      if (!task || task.status !== "running" || task.active_run_id !== row.id || task.revision !== row.revision) {
        return yield* new ConflictError({ entity: "run", id: input.runID, reason: "task is no longer running" })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const validTask = yield* tx.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, row.task_id)).get()
            const validRun = yield* tx.select().from(CvisTaskRunTable).where(eq(CvisTaskRunTable.id, row.id)).get()
            if (
              !validTask ||
              validTask.status !== "running" ||
              validTask.active_run_id !== row.id ||
              validTask.revision !== row.revision ||
              validRun?.status !== "running"
            ) {
              return yield* new ConflictError({
                entity: "run",
                id: row.id,
                reason: "execution was cancelled or revised",
              })
            }
            yield* tx
              .update(CvisTaskRunTable)
              .set({
                status: "verifying",
                result: input.result ?? null,
                error: input.error ?? null,
                tokens_used: input.tokensUsed ?? row.tokens_used,
              })
              .where(eq(CvisTaskRunTable.id, input.runID))
              .run()
            yield* tx
              .update(CvisTaskTable)
              .set({ status: input.error ? "failed" : "verifying" })
              .where(eq(CvisTaskTable.id, task.id))
              .run()
            yield* recordEvent(tx, {
              projectID: task.project_id,
              entity: "run",
              entityID: input.runID,
              type: "run.submitted",
            })
          }),
        )
        .pipe(Effect.orDie)
    })

    const inbox = Effect.fn("Cvis.inbox")(function* (input: { sessionID: string; projectID: string }) {
      const rows = yield* db
        .select()
        .from(CvisMessageTable)
        .where(eq(CvisMessageTable.project_id, input.projectID))
        .all()
        .pipe(Effect.orDie)
      return rows
        .filter(
          (row) =>
            row.status === "sent" &&
            (row.to_session === input.sessionID || (row.to_session == null && row.from_session !== input.sessionID)),
        )
        .sort((a, b) => a.time_created - b.time_created)
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          from: row.from_session,
          taskID: row.task_id,
          body: row.body as unknown,
          time: row.time_created,
        }))
    })

    const taskSpend = Effect.fn("Cvis.taskSpend")(function* (taskID: string) {
      const runs = yield* db
        .select({ tokens: CvisTaskRunTable.tokens_used })
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.task_id, taskID))
        .all()
        .pipe(Effect.orDie)
      return runs.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
    })

    const goalSpend = Effect.fn("Cvis.goalSpend")(function* (goalID: string) {
      const tasks = yield* db
        .select({ id: CvisTaskTable.id })
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.goal_id, goalID))
        .all()
        .pipe(Effect.orDie)
      let sum = 0
      for (const task of tasks) sum += yield* taskSpend(task.id)
      const goal = yield* db
        .select()
        .from(CvisProjectGoalTable)
        .where(eq(CvisProjectGoalTable.id, goalID))
        .get()
        .pipe(Effect.orDie)
      if (typeof goal?.metadata?.manager_session_id === "string" && typeof goal.metadata.activated_at === "number") {
        const messages = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, SessionID.make(goal.metadata.manager_session_id)))
          .all()
          .pipe(Effect.orDie)
        for (const message of messages) {
          if (
            message.time_created < goal.metadata.activated_at ||
            (typeof goal.metadata.completed_at === "number" && message.time_created > goal.metadata.completed_at)
          )
            continue
          const data = message.data
          const tokens = (
            data as unknown as {
              tokens?: {
                input?: number
                output?: number
                reasoning?: number
                cache?: { read?: number; write?: number }
              }
            }
          ).tokens
          if (data.role === "assistant" && tokens)
            sum +=
              (tokens.input ?? 0) +
              (tokens.output ?? 0) +
              (tokens.reasoning ?? 0) +
              (tokens.cache?.read ?? 0) +
              (tokens.cache?.write ?? 0)
        }
      }
      return sum
    })

    const doneGate: (taskID: string) => Effect.Effect<{ ok: boolean; reason?: string }> = Effect.fn("Cvis.doneGate")(
      function* (taskID: string) {
        const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, taskID)).get().pipe(Effect.orDie)
        if (!task) return { ok: false, reason: "missing task" }
        if (task.role === "verifier" && task.scope?.review_task_id && task.status === "done") {
          const target = yield* db
            .select()
            .from(CvisTaskTable)
            .where(eq(CvisTaskTable.id, task.scope.review_task_id))
            .get()
            .pipe(Effect.orDie)
          const proof = yield* db
            .select()
            .from(CvisEventTable)
            .where(and(eq(CvisEventTable.entity_id, task.id), eq(CvisEventTable.type, "review.completed")))
            .get()
            .pipe(Effect.orDie)
          if (!target || target.role === "verifier" || target.status !== "done" || !proof)
            return { ok: false, reason: "review completion receipt missing" }
          return yield* doneGate(target.id)
        }
        const acceptance = (task.acceptance ?? []) as { id: string; label: string; weight: number }[]
        if (acceptance.length > 0 && task.active_run_id) {
          const run = yield* db
            .select()
            .from(CvisTaskRunTable)
            .where(eq(CvisTaskRunTable.id, task.active_run_id))
            .get()
            .pipe(Effect.orDie)
          if (
            !run ||
            !["verifying", "done"].includes(run.status) ||
            run.revision !== task.revision ||
            run.attempt !== task.attempt
          )
            return { ok: false, reason: "latest attempt not verified" }
          const checks = yield* db
            .select()
            .from(CvisCheckTable)
            .where(eq(CvisCheckTable.task_id, taskID))
            .all()
            .pipe(Effect.orDie)
          const valid = checks.filter(
            (c) => c.verdict === "pass" && c.revision === task.revision && c.run_id === run.id && c.evidence !== null,
          )
          for (const check of valid) {
            const files = check.evidence?.files
            if (!Array.isArray(files) || !files.length) return { ok: false, reason: "artifact evidence missing" }
            for (const file of files) {
              if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string")
                return { ok: false, reason: "invalid artifact receipt" }
              const bytes = yield* fs.readFile(file.path).pipe(Effect.option)
              if (bytes._tag === "None" || createHash("sha256").update(bytes.value).digest("hex") !== file.sha256)
                return { ok: false, reason: "artifact changed after verification" }
            }
          }
          const passed = new Set(valid.map((c) => c.check_id))
          const missing = acceptance.filter((item) => !passed.has(item.id)).map((item) => item.id)
          if (missing.length > 0) return { ok: false, reason: `unchecked: ${missing.join(",")}` }
          return { ok: true }
        }
        return { ok: false, reason: "current checklist and execution evidence required" }
      },
    )

    const verifyCheck = Effect.fn("Cvis.verifyCheck")(function* (input: {
      taskID: string
      checkID: string
      runID?: string
      sessionID: string
      verdict: "pass" | "fail"
      evidence?: Record<string, unknown>
    }) {
      const task = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      const acceptance = (task.acceptance ?? []) as { id: string; label: string; weight: number }[]
      if (!acceptance.some((item) => item.id === input.checkID)) {
        return yield* new InvalidTransitionError({
          entity: "check",
          id: input.checkID,
          from: input.taskID,
          to: "unknown-check",
        })
      }
      const verifier = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      const actor = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (
        !verifier ||
        !actor ||
        actor.role !== "verifier" ||
        actor.status === "paused" ||
        actor.project_id !== task.project_id ||
        verifier.project_id !== task.project_id
      ) {
        return yield* new InvalidTransitionError({
          entity: "check",
          id: input.checkID,
          from: input.sessionID,
          to: "independent verifier required",
        })
      }
      const runID = input.runID ?? task.active_run_id
      const run = runID
        ? yield* db.select().from(CvisTaskRunTable).where(eq(CvisTaskRunTable.id, runID)).get().pipe(Effect.orDie)
        : undefined
      if (
        !run ||
        task.status !== "verifying" ||
        run.status !== "verifying" ||
        task.active_run_id !== run.id ||
        run.revision !== task.revision ||
        run.attempt !== task.attempt ||
        run.session_id === input.sessionID
      ) {
        return yield* new InvalidTransitionError({
          entity: "check",
          id: input.checkID,
          from: runID ?? "",
          to: "current independent review required",
        })
      }
      if (input.verdict !== "pass" && input.verdict !== "fail")
        return yield* new InvalidTransitionError({
          entity: "check",
          id: input.checkID,
          from: input.verdict,
          to: "invalid verdict",
        })
      const submittedFiles = input.evidence?.files
      const reviewerTask = actor.task_id
        ? yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, actor.task_id)).get().pipe(Effect.orDie)
        : undefined
      if (reviewerTask?.scope?.review_task_id && reviewerTask.scope.review_task_id !== task.id)
        return yield* new InvalidTransitionError({
          entity: "check",
          id: input.checkID,
          from: input.sessionID,
          to: "task not assigned for review",
        })
      if (
        !Array.isArray(submittedFiles) ||
        !submittedFiles.length ||
        submittedFiles.length > 32 ||
        !submittedFiles.every((file) => typeof file === "string")
      ) {
        return yield* new InvalidTransitionError({
          entity: "check",
          id: input.checkID,
          from: "",
          to: "artifact files required",
        })
      }
      const worker = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(run.session_id)))
        .get()
        .pipe(Effect.orDie)
      if (!worker) return yield* new NotFoundError({ entity: "session", id: run.session_id })
      const root = canonicalPath(worker.directory)
      const receiptFiles: { path: string; sha256: string }[] = []
      for (const filename of submittedFiles as string[]) {
        const file = canonicalPath(path.resolve(root, filename))
        const reviewerRoot = canonicalPath(verifier.directory)
        const reviewerRoots = (
          reviewerTask?.scope?.read_paths?.length ? reviewerTask.scope.read_paths : [reviewerRoot]
        ).map((r) => canonicalPath(path.resolve(reviewerRoot, r)))
        if (!pathAllowed(file, [reviewerRoot]) || !pathAllowed(file, reviewerRoots))
          return yield* new InvalidTransitionError({
            entity: "check",
            id: input.checkID,
            from: filename,
            to: "artifact outside reviewer scope",
          })
        const roots = (
          task.scope?.read_paths?.length
            ? task.scope.read_paths
            : task.scope?.write_paths?.length
              ? task.scope.write_paths
              : [root]
        ).map((r) => canonicalPath(path.resolve(root, r)))
        if (!pathAllowed(file, [root]) || !pathAllowed(file, roots))
          return yield* new InvalidTransitionError({
            entity: "check",
            id: input.checkID,
            from: filename,
            to: "artifact outside scope",
          })
        const info = yield* fs.stat(file).pipe(Effect.option)
        if (info._tag === "None" || info.value.type !== "File" || info.value.size > 10 * 1024 * 1024)
          return yield* new InvalidTransitionError({
            entity: "check",
            id: input.checkID,
            from: filename,
            to: "artifact missing or too large",
          })
        const bytes = yield* fs.readFile(file).pipe(Effect.option)
        if (bytes._tag === "None")
          return yield* new InvalidTransitionError({
            entity: "check",
            id: input.checkID,
            from: filename,
            to: "artifact not found",
          })
        receiptFiles.push({ path: file, sha256: createHash("sha256").update(bytes.value).digest("hex") })
      }
      const receipt = {
        files: receiptFiles,
        method: "artifact_review",
        conclusion: typeof input.evidence?.conclusion === "string" ? input.evidence.conclusion : null,
        revision: task.revision,
        attempt: run.attempt,
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, task.id)).get()
            if (
              !current ||
              current.revision !== task.revision ||
              current.active_run_id !== run.id ||
              current.status !== "verifying"
            )
              return yield* new InvalidTransitionError({
                entity: "check",
                id: input.checkID,
                from: "stale",
                to: "task changed during review",
              })
            yield* tx
              .insert(CvisCheckTable)
              .values({
                id: newID("chk"),
                task_id: input.taskID,
                check_id: input.checkID,
                run_id: run.id,
                verifier_session: input.sessionID,
                verdict: input.verdict,
                evidence: receipt,
                revision: task.revision,
              })
              .onConflictDoUpdate({
                target: [CvisCheckTable.task_id, CvisCheckTable.check_id],
                set: {
                  run_id: run.id,
                  verifier_session: input.sessionID,
                  verdict: input.verdict,
                  evidence: receipt,
                  revision: task.revision,
                },
              })
              .run()
            yield* recordEvent(tx, {
              projectID: task.project_id,
              entity: "check",
              entityID: `${input.taskID}:${input.checkID}`,
              type: `check.${input.verdict}`,
              payload: { runID: input.runID ?? null },
            })
          }),
        )
        .pipe(Effect.orDie)
    })

    const taskProgress = Effect.fn("Cvis.taskProgress")(function* (input: { taskID: string }) {
      const task = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      const acceptance = (task.acceptance ?? []) as { id: string; label: string; weight: number }[]
      if (acceptance.length === 0) {
        return { percent: 0, passed: [], pending: [] }
      }
      if (task.role === "verifier" && task.scope?.review_task_id && task.status === "done") {
        const gate = yield* doneGate(task.id)
        return {
          percent: gate.ok ? 100 : 0,
          passed: gate.ok ? acceptance.map((item) => item.id) : [],
          pending: gate.ok ? [] : acceptance.map((item) => item.id),
        }
      }
      const checks = yield* db
        .select()
        .from(CvisCheckTable)
        .where(eq(CvisCheckTable.task_id, input.taskID))
        .all()
        .pipe(Effect.orDie)
      const passed = new Set(
        checks
          .filter(
            (c) =>
              c.verdict === "pass" &&
              c.revision === task.revision &&
              c.run_id === task.active_run_id &&
              c.evidence !== null,
          )
          .map((c) => c.check_id),
      )
      const progress = checklistProgress(acceptance, passed)
      if (task.status !== "done") progress.percent = Math.min(99, progress.percent)
      if (task.status === "done" && !(yield* doneGate(task.id)).ok) progress.percent = 0
      return progress
    })

    const goalProgress = Effect.fn("Cvis.goalProgress")(function* (input: { goalID: string }) {
      const goal = yield* db
        .select()
        .from(CvisProjectGoalTable)
        .where(eq(CvisProjectGoalTable.id, input.goalID))
        .get()
        .pipe(Effect.orDie)
      if (!goal) return yield* new NotFoundError({ entity: "goal", id: input.goalID })
      const tasks = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.goal_id, input.goalID))
        .all()
        .pipe(Effect.orDie)
      const visible = tasks
      const entries: { id: string; title: string; status: string; percent: number }[] = []
      for (const task of visible) {
        const progress = yield* taskProgress({ taskID: task.id })
        entries.push({ id: task.id, title: task.title, status: task.status, percent: progress.percent })
      }
      const total = visible.reduce((sum, task) => sum + task.weight, 0)
      const percent =
        total <= 0
          ? 0
          : Math.floor(
              entries.reduce(
                (sum, entry) => sum + entry.percent * (visible.find((task) => task.id === entry.id)?.weight ?? 0),
                0,
              ) / total,
            )
      return { percent, tasks: entries }
    })

    const reviseTask = Effect.fn("Cvis.reviseTask")(function* (input: {
      taskID: string
      title?: string
      description?: string
      scope?: { read_paths?: string[]; write_paths?: string[]; tools?: string[]; max_tokens?: number }
      acceptance?: { id: string; label: string; weight: number }[]
    }) {
      const task = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      if (["done", "cancelled"].includes(task.status)) {
        return yield* new InvalidTransitionError({ entity: "task", id: input.taskID, from: task.status, to: "revise" })
      }
      if (
        input.acceptance &&
        (!input.acceptance.length ||
          new Set(input.acceptance.map((item) => item.id)).size !== input.acceptance.length ||
          input.acceptance.some(
            (item) => !item.id?.trim() || !item.label?.trim() || !Number.isSafeInteger(item.weight) || item.weight <= 0,
          ))
      ) {
        return yield* new InvalidTransitionError({
          entity: "task",
          id: task.id,
          from: "acceptance",
          to: "valid weighted criteria required",
        })
      }
      if (["running", "verifying"].includes(task.status)) yield* pauseTask({ taskID: task.id, reason: "task revision" })
      const oldChecks = yield* db
        .select()
        .from(CvisCheckTable)
        .where(eq(CvisCheckTable.task_id, task.id))
        .all()
        .pipe(Effect.orDie)
      const snapshot = {
        title: task.title,
        description: task.description,
        scope: task.scope,
        acceptance: task.acceptance,
        revision: task.revision,
        checks: oldChecks,
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(CvisTaskTable)
              .set({
                title: input.title ?? task.title,
                description: input.description ?? task.description,
                scope: (input.scope as never) ?? task.scope,
                acceptance: (input.acceptance as never) ?? task.acceptance,
                revision: task.revision + 1,
                active_run_id: null,
                status: ["running", "verifying"].includes(task.status) ? "paused" : task.status,
              })
              .where(eq(CvisTaskTable.id, input.taskID))
              .run()
            yield* tx.delete(CvisCheckTable).where(eq(CvisCheckTable.task_id, task.id)).run()
            const reviews = yield* tx
              .select()
              .from(CvisTaskTable)
              .where(eq(CvisTaskTable.project_id, task.project_id))
              .all()
            for (const review of reviews) {
              if (
                review.role !== "verifier" ||
                review.weight !== 0 ||
                review.scope?.review_task_id !== task.id ||
                ["done", "cancelled"].includes(review.status)
              )
                continue
              yield* tx
                .update(CvisTaskTable)
                .set({ status: "cancelled", active_run_id: null, assigned_session: null })
                .where(eq(CvisTaskTable.id, review.id))
                .run()
              yield* tx
                .update(CvisTaskRunTable)
                .set({ status: "cancelled", error: "review superseded by task revision", time_finished: Date.now() })
                .where(
                  and(
                    eq(CvisTaskRunTable.task_id, review.id),
                    inArray(CvisTaskRunTable.status, ["pending", "running", "verifying"]),
                  ),
                )
                .run()
              yield* tx
                .update(CvisSessionBindingTable)
                .set({ status: "idle", task_id: null })
                .where(eq(CvisSessionBindingTable.task_id, review.id))
                .run()
              yield* recordEvent(tx, {
                projectID: task.project_id,
                entity: "task",
                entityID: review.id,
                type: "review.superseded",
                payload: { targetTaskID: task.id, revision: task.revision + 1 },
              })
            }
            yield* recordEvent(tx, {
              projectID: task.project_id,
              entity: "task",
              entityID: input.taskID,
              type: "task.revised",
              payload: { revision: task.revision + 1, previous: snapshot as never },
            })
          }),
        )
        .pipe(Effect.orDie)
      return { revision: task.revision + 1 }
    })

    const budget = Effect.fn("Cvis.budget")(function* (input: { goalID?: string; taskID?: string }) {
      if (input.taskID) {
        const task = yield* db
          .select()
          .from(CvisTaskTable)
          .where(eq(CvisTaskTable.id, input.taskID))
          .get()
          .pipe(Effect.orDie)
        if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
        const scope = (task.scope ?? {}) as { max_tokens?: number }
        return { used: yield* taskSpend(task.id), cap: scope.max_tokens ?? null }
      }
      const goal = yield* db
        .select()
        .from(CvisProjectGoalTable)
        .where(eq(CvisProjectGoalTable.id, input.goalID ?? ""))
        .get()
        .pipe(Effect.orDie)
      if (!goal) return yield* new NotFoundError({ entity: "goal", id: input.goalID ?? "" })
      return { used: yield* goalSpend(goal.id), cap: goal.budget_tokens }
    })

    const settleReview = Effect.fn("Cvis.settleReview")(function* (input: { taskID: string; sessionID: string }) {
      const job = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (!job || job.role !== "verifier" || job.status !== "verifying" || job.assigned_session !== input.sessionID)
        return yield* new InvalidTransitionError({
          entity: "review",
          id: input.taskID,
          from: "",
          to: "current verifier job required",
        })
      const targetID = job.scope?.review_task_id
      if (!targetID || targetID === job.id)
        return yield* new InvalidTransitionError({
          entity: "review",
          id: job.id,
          from: "",
          to: "review target missing",
        })
      const target = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, targetID))
        .get()
        .pipe(Effect.orDie)
      if (
        !target ||
        job.scope?.review_revision !== target.revision ||
        target.role === "verifier" ||
        target.project_id !== job.project_id ||
        target.goal_id !== job.goal_id
      )
        return yield* new InvalidTransitionError({
          entity: "review",
          id: job.id,
          from: targetID,
          to: "review target project/revision mismatch",
        })
      const gate = yield* doneGate(targetID)
      const checks = yield* db
        .select()
        .from(CvisCheckTable)
        .where(eq(CvisCheckTable.task_id, targetID))
        .all()
        .pipe(Effect.orDie)
      if (
        !gate.ok ||
        !checks.length ||
        checks.some(
          (check) =>
            check.verifier_session !== input.sessionID ||
            check.verdict !== "pass" ||
            check.revision !== target.revision,
        )
      ) {
        return yield* new InvalidTransitionError({
          entity: "review",
          id: job.id,
          from: "",
          to: gate.reason ?? "verification incomplete",
        })
      }
      if (target.status !== "done") yield* setTaskStatus({ id: targetID, status: "done" })
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(CvisTaskTable).set({ status: "done" }).where(eq(CvisTaskTable.id, job.id)).run()
            if (job.active_run_id)
              yield* tx
                .update(CvisTaskRunTable)
                .set({ status: "done", time_finished: Date.now() })
                .where(eq(CvisTaskRunTable.id, job.active_run_id))
                .run()
            yield* tx
              .update(CvisSessionBindingTable)
              .set({ status: "idle", task_id: null })
              .where(eq(CvisSessionBindingTable.task_id, job.id))
              .run()
            yield* recordEvent(tx, {
              projectID: job.project_id,
              entity: "task",
              entityID: job.id,
              type: "review.completed",
              payload: { targetTaskID: targetID, verifier: input.sessionID },
            })
          }),
        )
        .pipe(Effect.orDie)
    })

    const recover = Effect.fn("Cvis.recover")(function* (input: { projectID: string }) {
      const recovered: { taskID: string; runID: string }[] = []
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const tasks = yield* tx
              .select()
              .from(CvisTaskTable)
              .where(eq(CvisTaskTable.project_id, input.projectID))
              .all()
            for (const task of tasks) {
              if (!task.active_run_id || !["running", "verifying"].includes(task.status)) continue
              const run = yield* tx
                .select()
                .from(CvisTaskRunTable)
                .where(eq(CvisTaskRunTable.id, task.active_run_id))
                .get()
              if (!run || run.status === "verifying" || run.lease_expires === null || run.lease_expires > Date.now())
                continue
              yield* tx
                .update(CvisTaskRunTable)
                .set({
                  status: "failed",
                  error: "execution lease expired; checkpoint retained",
                  time_finished: Date.now(),
                })
                .where(eq(CvisTaskRunTable.id, run.id))
                .run()
              yield* tx
                .update(CvisTaskTable)
                .set({ status: "paused", active_run_id: null, assigned_session: null })
                .where(eq(CvisTaskTable.id, task.id))
                .run()
              yield* tx
                .update(CvisSessionBindingTable)
                .set({ status: "idle", task_id: null })
                .where(eq(CvisSessionBindingTable.task_id, task.id))
                .run()
              yield* recordEvent(tx, {
                projectID: task.project_id,
                entity: "run",
                entityID: run.id,
                type: "run.interrupted",
                payload: { taskID: task.id, attempt: run.attempt },
              })
              recovered.push({ taskID: task.id, runID: run.id })
            }
          }),
        )
        .pipe(Effect.orDie)
      return recovered
    })

    const listTemplates = Effect.fn("Cvis.listTemplates")(function* (input: { role?: string }) {
      const rows = yield* db
        .select({
          id: CvisPromptTemplateTable.id,
          name: CvisPromptTemplateTable.name,
          role: CvisPromptTemplateTable.role,
          version: CvisPromptTemplateTable.version,
        })
        .from(CvisPromptTemplateTable)
        .all()
        .pipe(Effect.orDie)
      const latest = new Map<string, (typeof rows)[number]>()
      for (const row of rows) {
        if (input.role != null && row.role != null && row.role !== input.role) continue
        const current = latest.get(row.name)
        if (!current || row.version > current.version) latest.set(row.name, row)
      }
      return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name))
    })

    const createTemplate = Effect.fn("Cvis.createTemplate")(function* (input: {
      name: string
      role?: string
      body: string
      inputs?: { name: string; required: boolean }[]
    }) {
      const trimmed = input.name.trim()
      if (trimmed.length === 0 || input.body.trim().length === 0) {
        return yield* new InvalidTransitionError({ entity: "template", id: input.name, from: "", to: "empty" })
      }
      const existing = yield* db
        .select({ version: CvisPromptTemplateTable.version })
        .from(CvisPromptTemplateTable)
        .where(eq(CvisPromptTemplateTable.name, trimmed))
        .all()
        .pipe(Effect.orDie)
      const version = existing.reduce((max, r) => Math.max(max, r.version), 0) + 1
      const id = newID("tmpl")
      yield* db
        .insert(CvisPromptTemplateTable)
        .values({
          id,
          name: trimmed,
          role: input.role ?? null,
          version,
          body: input.body,
          inputs: input.inputs ?? null,
        })
        .run()
        .pipe(Effect.orDie)
      return { id, version }
    })

    const renderTemplate = Effect.fn("Cvis.renderTemplate")(function* (input: {
      name: string
      vars: Record<string, string>
    }) {
      const rows = yield* db
        .select()
        .from(CvisPromptTemplateTable)
        .where(eq(CvisPromptTemplateTable.name, input.name))
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) return yield* new NotFoundError({ entity: "template", id: input.name })
      const template = rows.reduce((best, row) => (row.version > best.version ? row : best))
      const rendered = OrchestrationTemplates.renderTemplate(
        template.body,
        (template.inputs ?? []) as { name: string; required: boolean }[],
        input.vars,
      )
      if (!rendered.ok) {
        return yield* new InvalidTransitionError({
          entity: "template",
          id: input.name,
          from: "render",
          to: `missing: ${rendered.missing.join(",")}`,
        })
      }
      return { text: rendered.text, tokens: estimate(rendered.text) }
    })

    const contextPack = Effect.fn("Cvis.contextPack")(function* (input: { taskID: string }) {
      const task = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      const progress = yield* taskProgress({ taskID: input.taskID })
      const runs = yield* db
        .select()
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.task_id, input.taskID))
        .all()
        .pipe(Effect.orDie)
      const messages = yield* db
        .select()
        .from(CvisMessageTable)
        .where(eq(CvisMessageTable.task_id, input.taskID))
        .all()
        .pipe(Effect.orDie)
      const goal = task.goal_id
        ? yield* db
            .select()
            .from(CvisProjectGoalTable)
            .where(eq(CvisProjectGoalTable.id, task.goal_id))
            .get()
            .pipe(Effect.orDie)
        : null
      const pack = {
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          role: task.role,
          status: task.status,
          revision: task.revision,
          scope: task.scope,
          acceptance: task.acceptance,
          progress,
        },
        goal: goal ? { id: goal.id, title: goal.title, objective: goal.objective, status: goal.status } : null,
        runs: runs
          .sort((a, b) => b.attempt - a.attempt)
          .slice(0, 3)
          .map((run) => ({ attempt: run.attempt, status: run.status, tokens: run.tokens_used, error: run.error })),
        messages: messages
          .sort((a, b) => b.time_created - a.time_created)
          .slice(0, 10)
          .map((message) => ({ kind: message.kind, from: message.from_session, body: message.body })),
      }
      return { ...pack, tokens: estimate(JSON.stringify(pack)) }
    })

    const handoffBrief = Effect.fn("Cvis.handoffBrief")(function* (input: { sessionID: string }) {
      const binding = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!binding && !session) return yield* new NotFoundError({ entity: "session", id: input.sessionID })
      const brief: Record<string, unknown> = {
        sessionID: input.sessionID,
        title: session?.title ?? null,
        role: binding?.role ?? null,
        bindingStatus: binding?.status ?? null,
        task: null,
        openRuns: [],
        pendingInbox: 0,
        recentEvents: [],
      }
      if (binding?.task_id) {
        const pack = yield* contextPack({ taskID: binding.task_id })
        brief["task"] = pack.task
        brief["goal"] = pack.goal
      }
      const openRuns = yield* db
        .select({
          id: CvisTaskRunTable.id,
          status: CvisTaskRunTable.status,
          session_id: CvisTaskRunTable.session_id,
          result: CvisTaskRunTable.result,
        })
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.session_id, input.sessionID))
        .all()
        .pipe(Effect.orDie)
      brief["openRuns"] = openRuns.filter(
        (run) => run.status === "pending" || run.status === "running" || run.status === "verifying",
      )
      brief["promptStartID"] = openRuns.find((run) => run.status === "running")?.result?.prompt_start_id ?? null
      brief["permissionCeiling"] = binding?.permission_ceiling ?? null
      const inbox = yield* db
        .select({ id: CvisMessageTable.id })
        .from(CvisMessageTable)
        .where(eq(CvisMessageTable.to_session, input.sessionID))
        .all()
        .pipe(Effect.orDie)
      brief["pendingInbox"] = inbox.length
      if (binding) {
        const events = yield* db
          .select()
          .from(CvisEventTable)
          .where(eq(CvisEventTable.project_id, binding.project_id))
          .all()
          .pipe(Effect.orDie)
        brief["recentEvents"] = events
          .sort((a, b) => b.time_created - a.time_created)
          .slice(0, 10)
          .map((event) => ({
            type: event.type,
            entity: `${event.entity_kind}:${event.entity_id}`,
            time: event.time_created,
          }))
      }
      return brief
    })

    const reuseCheck = Effect.fn("Cvis.reuseCheck")(function* (input: { sessionID: string; taskID: string }) {
      const reasons: string[] = []
      const binding = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      const task = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      if (binding) {
        if (binding.status !== "idle") reasons.push(`binding is ${binding.status}`)
        if (binding.project_id !== task.project_id) reasons.push("different project")
        if (binding.role !== task.role) reasons.push(`role mismatch: ${binding.role} vs ${task.role}`)
        if (binding.task_id != null && binding.task_id !== input.taskID) reasons.push("unfinished previous task")
      } else {
        const session = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
          .get()
          .pipe(Effect.orDie)
        if (!session) return yield* new NotFoundError({ entity: "session", id: input.sessionID })
        if (session.project_id !== task.project_id) reasons.push("different project")
      }
      const open = yield* db
        .select({ status: CvisTaskRunTable.status })
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.session_id, input.sessionID))
        .all()
        .pipe(Effect.orDie)
      if (open.some((run) => run.status === "pending" || run.status === "running" || run.status === "verifying")) {
        reasons.push("session has open runs")
      }
      return { eligible: reasons.length === 0, reasons }
    })

    const cleanCandidates = Effect.fn("Cvis.cleanCandidates")(function* (input: {
      projectID: string
      idleDays: number
    }) {
      const cutoff = Date.now() - Math.max(0, input.idleDays) * 86_400_000
      const sessions = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.project_id, ProjectV2.ID.make(input.projectID)))
        .all()
        .pipe(Effect.orDie)
      const out: { id: string; title: string; reason: string; time: number }[] = []
      for (const session of sessions) {
        if (session.time_archived !== null || (yield* runState.isRunning(session.id))) continue
        if ((session.time_updated ?? 0) >= cutoff) continue
        const runs = yield* db
          .select()
          .from(CvisTaskRunTable)
          .where(eq(CvisTaskRunTable.session_id, session.id))
          .all()
          .pipe(Effect.orDie)
        if (runs.some((run) => ["pending", "running", "verifying"].includes(run.status))) continue
        const inbox = yield* db
          .select()
          .from(CvisMessageTable)
          .where(and(eq(CvisMessageTable.to_session, session.id), eq(CvisMessageTable.status, "sent")))
          .get()
          .pipe(Effect.orDie)
        if (inbox) continue
        const binding = yield* db
          .select()
          .from(CvisSessionBindingTable)
          .where(eq(CvisSessionBindingTable.session_id, session.id))
          .get()
          .pipe(Effect.orDie)
        if (!binding) {
          out.push({
            id: session.id,
            title: session.title,
            reason: "idle, never bound",
            time: session.time_updated ?? 0,
          })
          continue
        }
        if (binding.status === "idle" && binding.task_id == null) {
          if (binding.role === "manager") {
            const goals = yield* db
              .select()
              .from(CvisProjectGoalTable)
              .where(eq(CvisProjectGoalTable.project_id, input.projectID))
              .all()
              .pipe(Effect.orDie)
            if (goals.some((goal) => !["completed", "cancelled"].includes(goal.status))) continue
          }
          out.push({ id: session.id, title: session.title, reason: "idle, no task", time: session.time_updated ?? 0 })
        }
      }
      return out.sort((a, b) => a.time - b.time)
    })

    const archiveIdle = Effect.fn("Cvis.archiveIdle")(function* (input: { projectID: string; idleDays?: number }) {
      const candidates = yield* cleanCandidates({
        projectID: input.projectID,
        idleDays: Math.max(30, input.idleDays ?? 30),
      })
      const archived: string[] = []
      for (const candidate of candidates) {
        if (yield* runState.isRunning(SessionID.make(candidate.id))) continue
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const binding = yield* tx
                .select()
                .from(CvisSessionBindingTable)
                .where(eq(CvisSessionBindingTable.session_id, candidate.id))
                .get()
              if (binding && (binding.status !== "idle" || binding.task_id !== null)) return
              const runs = yield* tx
                .select()
                .from(CvisTaskRunTable)
                .where(eq(CvisTaskRunTable.session_id, candidate.id))
                .all()
              if (runs.some((run) => ["pending", "running", "verifying"].includes(run.status))) return
              yield* tx
                .update(SessionTable)
                .set({ time_archived: Date.now() })
                .where(eq(SessionTable.id, SessionID.make(candidate.id)))
                .run()
              yield* recordEvent(tx, {
                projectID: input.projectID,
                entity: "session",
                entityID: candidate.id,
                type: "session.archived",
              })
              archived.push(candidate.id)
            }),
          )
          .pipe(Effect.orDie)
      }
      return archived
    })

    const projectSnapshot = Effect.fn("Cvis.projectSnapshot")(function* (input: { projectID: string }) {
      const watermark = yield* db
        .select({ value: max(CvisEventTable.sequence) })
        .from(CvisEventTable)
        .where(eq(CvisEventTable.project_id, input.projectID))
        .get()
        .pipe(Effect.orDie)
      const goals = yield* db
        .select()
        .from(CvisProjectGoalTable)
        .where(eq(CvisProjectGoalTable.project_id, input.projectID))
        .all()
        .pipe(Effect.orDie)
      const goalEntries: {
        id: string
        title: string
        status: string
        percent: number
        used: number
        cap: number | null
      }[] = []
      for (const goal of goals) {
        const progress = yield* goalProgress({ goalID: goal.id })
        goalEntries.push({
          id: goal.id,
          title: goal.title,
          status: goal.status,
          percent: progress.percent,
          used: yield* goalSpend(goal.id),
          cap: goal.budget_tokens,
        })
      }
      const tasks = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.project_id, input.projectID))
        .all()
        .pipe(Effect.orDie)
      const columns = new Map<
        string,
        { id: string; title: string; role: string; percent: string | number; goalID: string | null }[]
      >()
      for (const task of tasks) {
        const progress = yield* taskProgress({ taskID: task.id })
        const list = columns.get(task.status) ?? []
        list.push({ id: task.id, title: task.title, role: task.role, percent: progress.percent, goalID: task.goal_id })
        columns.set(task.status, list)
      }
      const bindings = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.project_id, input.projectID))
        .all()
        .pipe(Effect.orDie)
      const latest = yield* db
        .select({ time: CvisEventTable.sequence })
        .from(CvisEventTable)
        .where(eq(CvisEventTable.project_id, input.projectID))
        .all()
        .pipe(Effect.orDie)
      return {
        eventCursor: watermark?.value ?? 0,
        goals: goalEntries,
        columns: [...columns.entries()].map(([status, list]) => ({
          status,
          tasks: list as { id: string; title: string; role: string; percent: number; goalID: string | null }[],
        })),
        bindings: bindings.map((b) => ({ session: b.session_id, role: b.role, status: b.status, task: b.task_id })),
      }
    })

    const taskDetail = Effect.fn("Cvis.taskDetail")(function* (input: { taskID: string }) {
      const task = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      const progress = yield* taskProgress({ taskID: input.taskID })
      const runs = yield* db
        .select()
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.task_id, input.taskID))
        .all()
        .pipe(Effect.orDie)
      const checks = yield* db
        .select()
        .from(CvisCheckTable)
        .where(eq(CvisCheckTable.task_id, input.taskID))
        .all()
        .pipe(Effect.orDie)
      const messages = yield* db
        .select()
        .from(CvisMessageTable)
        .where(eq(CvisMessageTable.task_id, input.taskID))
        .all()
        .pipe(Effect.orDie)
      const events = yield* db
        .select()
        .from(CvisEventTable)
        .where(eq(CvisEventTable.project_id, task.project_id))
        .all()
        .pipe(Effect.orDie)
      const goal = task.goal_id
        ? yield* db
            .select()
            .from(CvisProjectGoalTable)
            .where(eq(CvisProjectGoalTable.id, task.goal_id))
            .get()
            .pipe(Effect.orDie)
        : null
      return {
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          role: task.role,
          status: task.status,
          revision: task.revision,
          scope: task.scope,
          acceptance: task.acceptance,
          progress,
        },
        goal: goal ? { id: goal.id, title: goal.title, status: goal.status } : null,
        runs: runs
          .sort((a, b) => b.attempt - a.attempt)
          .map((run) => ({
            id: run.id,
            attempt: run.attempt,
            session: run.session_id,
            status: run.status,
            tokens: run.tokens_used,
            error: run.error,
          })),
        checks: checks.map((check) => ({
          check: check.check_id,
          verdict: check.verdict,
          verifier: check.verifier_session,
          run: check.run_id,
          revision: check.revision,
          evidence: check.evidence,
        })),
        messages: messages
          .sort((a, b) => a.time_created - b.time_created)
          .map((message) => ({
            id: message.id,
            kind: message.kind,
            from: message.from_session,
            status: message.status,
          })),
        events: events
          .filter((event) => event.entity_id === input.taskID || event.entity_id.startsWith(`${input.taskID}:`))
          .sort((a, b) => a.time_created - b.time_created)
          .map((event) => ({ type: event.type, time: event.time_created })),
      }
    })

    const bindSession = Effect.fn("Cvis.bindSession")(function* (input: {
      sessionID: string
      projectID: string
      role: Role
      taskID?: string
      managerSession?: string
    }) {
      if (!isRole(input.role)) {
        return yield* new InvalidTransitionError({ entity: "binding", id: input.sessionID, from: "", to: input.role })
      }
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!session) return yield* new NotFoundError({ entity: "session", id: input.sessionID })
      if (session.project_id !== input.projectID)
        return yield* new InvalidTransitionError({
          entity: "binding",
          id: input.sessionID,
          from: session.project_id,
          to: "cross-project binding",
        })
      if (input.taskID) {
        const task = yield* db
          .select()
          .from(CvisTaskTable)
          .where(eq(CvisTaskTable.id, input.taskID))
          .get()
          .pipe(Effect.orDie)
        if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
        if (task.project_id !== input.projectID || task.role !== input.role)
          return yield* new InvalidTransitionError({
            entity: "binding",
            id: input.sessionID,
            from: input.taskID,
            to: "role/project mismatch",
          })
      }
      // Reuse guard: a session committed to another task can only be rebound
      // once it is idle. Prevents task instructions leaking across work.
      const current = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (
        current &&
        (current.status !== "idle" || current.role !== input.role || current.project_id !== input.projectID)
      ) {
        return yield* new InvalidTransitionError({
          entity: "binding",
          id: input.sessionID,
          from: current.task_id ?? current.status,
          to: input.taskID ?? input.role,
        })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const observed = yield* tx
              .select()
              .from(CvisSessionBindingTable)
              .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
              .get()
            if (
              observed &&
              (observed.status !== "idle" || observed.role !== input.role || observed.project_id !== input.projectID)
            )
              return yield* new InvalidTransitionError({
                entity: "binding",
                id: input.sessionID,
                from: observed.status,
                to: "concurrent rebinding",
              })
            if (input.role === "manager") {
              const managers = yield* tx
                .select()
                .from(CvisSessionBindingTable)
                .where(eq(CvisSessionBindingTable.project_id, input.projectID))
                .all()
              if (managers.some((item) => item.role === "manager" && item.session_id !== input.sessionID))
                return yield* new InvalidTransitionError({
                  entity: "binding",
                  id: input.sessionID,
                  from: "",
                  to: "project already has a manager",
                })
            }
            yield* tx
              .insert(CvisSessionBindingTable)
              .values({
                session_id: input.sessionID,
                project_id: ProjectV2.ID.make(input.projectID),
                role: input.role,
                task_id: input.taskID ?? null,
                manager_session: input.managerSession ?? null,
                status: "idle",
                permission_ceiling: [...(current?.permission_ceiling ?? session.permission ?? [])],
              })
              .onConflictDoUpdate({
                target: CvisSessionBindingTable.session_id,
                set: {
                  role: input.role,
                  task_id: input.taskID ?? null,
                  manager_session: input.managerSession ?? null,
                },
              })
              .run()
            const ceiling = [...(current?.permission_ceiling ?? session.permission ?? [])]
            yield* tx
              .update(SessionTable)
              .set({ permission: toRuleset(effectiveRuleset({ role: input.role, projectRules: ceiling })) })
              .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
              .run()
            yield* recordEvent(tx, {
              projectID: input.projectID,
              entity: "binding",
              entityID: input.sessionID,
              type: "binding.updated",
              payload: { role: input.role, taskID: input.taskID ?? null },
            })
          }),
        )
        .pipe(Effect.orDie)
    })

    const setBindingStatus = Effect.fn("Cvis.setBindingStatus")(function* (input: {
      sessionID: string
      status: BindingStatus
    }) {
      const row = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "binding", id: input.sessionID })
      if (!canTransitionBinding(row.status as BindingStatus, input.status)) {
        return yield* new InvalidTransitionError({
          entity: "binding",
          id: input.sessionID,
          from: row.status,
          to: input.status,
        })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(CvisSessionBindingTable)
              .set({ status: input.status })
              .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
              .run()
            yield* recordEvent(tx, {
              projectID: row.project_id,
              entity: "binding",
              entityID: input.sessionID,
              type: `binding.${input.status}`,
            })
          }),
        )
        .pipe(Effect.orDie)
    })

    const sendMessage = Effect.fn("Cvis.sendMessage")(function* (input: {
      projectID: string
      taskID?: string
      runID?: string
      fromSession: string
      toSession?: string
      kind: MessageKind
      body?: Record<string, unknown>
      idempotencyKey?: string
    }) {
      if (!isMessageKind(input.kind)) {
        return yield* new InvalidTransitionError({ entity: "message", id: "new", from: "", to: input.kind })
      }
      const sender = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.fromSession)))
        .get()
        .pipe(Effect.orDie)
      const senderBinding = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.fromSession))
        .get()
        .pipe(Effect.orDie)
      if (
        !sender ||
        !senderBinding ||
        sender.project_id !== input.projectID ||
        senderBinding.project_id !== input.projectID ||
        senderBinding.status === "paused"
      ) {
        return yield* new InvalidTransitionError({
          entity: "message",
          id: "new",
          from: input.fromSession,
          to: "authenticated project sender required",
        })
      }
      if (["assign", "cancel"].includes(input.kind) && senderBinding.role !== "manager")
        return yield* new InvalidTransitionError({
          entity: "message",
          id: "new",
          from: senderBinding.role,
          to: "manager required",
        })
      if (input.toSession) {
        const target = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input.toSession)))
          .get()
          .pipe(Effect.orDie)
        if (!target || target.project_id !== input.projectID)
          return yield* new InvalidTransitionError({
            entity: "message",
            id: "new",
            from: input.toSession,
            to: "invalid recipient",
          })
      }
      if (input.taskID) {
        const task = yield* db
          .select()
          .from(CvisTaskTable)
          .where(eq(CvisTaskTable.id, input.taskID))
          .get()
          .pipe(Effect.orDie)
        if (!task || task.project_id !== input.projectID)
          return yield* new InvalidTransitionError({
            entity: "message",
            id: "new",
            from: input.taskID,
            to: "invalid task project",
          })
      }
      const id = newID("msg")
      const recordedID = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (input.idempotencyKey) {
              const prior = yield* tx
                .select()
                .from(CvisMessageTable)
                .where(
                  and(
                    eq(CvisMessageTable.project_id, input.projectID),
                    eq(CvisMessageTable.idempotency_key, input.idempotencyKey),
                  ),
                )
                .get()
              if (prior) {
                if (
                  prior.from_session !== input.fromSession ||
                  prior.to_session !== (input.toSession ?? null) ||
                  prior.task_id !== (input.taskID ?? null) ||
                  prior.kind !== input.kind ||
                  JSON.stringify(prior.body) !== JSON.stringify(input.body ?? null)
                )
                  return yield* new InvalidTransitionError({
                    entity: "message",
                    id: prior.id,
                    from: "idempotency key",
                    to: "payload mismatch",
                  })
                return prior.id
              }
            }
            const inserted = yield* tx
              .insert(CvisMessageTable)
              .values({
                id,
                project_id: ProjectV2.ID.make(input.projectID),
                task_id: input.taskID ?? null,
                run_id: input.runID ?? null,
                from_session: input.fromSession,
                to_session: input.toSession ?? null,
                kind: input.kind,
                body: input.body ?? null,
                status: "sent",
                idempotency_key: input.idempotencyKey ?? null,
              })
              .onConflictDoNothing()
              .returning({ id: CvisMessageTable.id })
              .all()
            if (!inserted.length) {
              const prior = input.idempotencyKey
                ? yield* tx
                    .select()
                    .from(CvisMessageTable)
                    .where(
                      and(
                        eq(CvisMessageTable.project_id, input.projectID),
                        eq(CvisMessageTable.idempotency_key, input.idempotencyKey),
                      ),
                    )
                    .get()
                : undefined
              if (!prior)
                return yield* new InvalidTransitionError({ entity: "message", id, from: "", to: "conflicting insert" })
              return prior.id
            }
            yield* recordEvent(tx, {
              projectID: input.projectID,
              entity: "message",
              entityID: id,
              type: `message.${input.kind}`,
              payload: { taskID: input.taskID ?? null },
            })
            return id
          }),
        )
        .pipe(Effect.orDie)
      return { id: recordedID }
    })

    const ackMessage = Effect.fn("Cvis.ackMessage")(function* (input: { id: string }) {
      const row = yield* db
        .select()
        .from(CvisMessageTable)
        .where(eq(CvisMessageTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "message", id: input.id })
      if (row.status === "acked") return
      if (row.status !== "sent") {
        return yield* new InvalidTransitionError({ entity: "message", id: input.id, from: row.status, to: "acked" })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(CvisMessageTable).set({ status: "acked" }).where(eq(CvisMessageTable.id, input.id)).run()
            yield* recordEvent(tx, {
              projectID: row.project_id,
              entity: "message",
              entityID: input.id,
              type: "message.acked",
            })
          }),
        )
        .pipe(Effect.orDie)
    })

    const buildRuleset = Effect.fn("Cvis.buildRuleset")(function* (input: {
      role: Role
      scope?: TaskScope
      projectRules?: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[]
    }) {
      return effectiveRuleset(input)
    })

    const checkScope = Effect.fn("Cvis.checkScope")(function* (input: {
      scope: TaskScope
      worktree?: string
      projectDenies?: string[]
    }) {
      return validateScope(input.scope, { worktree: input.worktree, projectDenies: input.projectDenies })
    })

    const resolveScope = Effect.fn("Cvis.resolveScope")(function* (input: { worktree: string; paths: string[] }) {
      const resolved: { original: string; resolved: string }[] = []
      for (const original of input.paths) {
        const joined = original.startsWith("/") ? original : `${input.worktree.replace(/\/+$/, "")}/${original}`
        // FSUtil falls back to the joined path when nothing exists there yet
        // (tasks routinely create new files); containment still applies.
        const real = yield* fs.resolve(joined)
        resolved.push({ original, resolved: real })
      }
      const checked = checkResolvedPaths(input.worktree, resolved)
      return { resolved, escapes: checked.escapes }
    })

    const listTasks = Effect.fn("Cvis.listTasks")(function* (input: { projectID: string; status?: TaskStatus }) {
      const cond =
        input.status == null
          ? eq(CvisTaskTable.project_id, input.projectID)
          : and(eq(CvisTaskTable.project_id, input.projectID), eq(CvisTaskTable.status, input.status))
      const rows = yield* db
        .select({
          id: CvisTaskTable.id,
          title: CvisTaskTable.title,
          role: CvisTaskTable.role,
          status: CvisTaskTable.status,
          attempt: CvisTaskTable.attempt,
          goalID: CvisTaskTable.goal_id,
        })
        .from(CvisTaskTable)
        .where(cond)
        .all()
        .pipe(Effect.orDie)
      return rows
    })

    const listEvents = Effect.fn("Cvis.listEvents")(function* (input: {
      projectID: string
      cursor?: number
      limit?: number
    }) {
      const cond =
        input.cursor == null
          ? eq(CvisEventTable.project_id, input.projectID)
          : and(eq(CvisEventTable.project_id, input.projectID), gt(CvisEventTable.sequence, input.cursor))
      const rows = yield* db
        .select()
        .from(CvisEventTable)
        .where(cond)
        .orderBy(CvisEventTable.sequence)
        .limit(Math.min(500, Math.max(1, input.limit ?? 100)))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        entity: row.entity_kind,
        entityID: row.entity_id,
        payload: row.payload as unknown,
        time: row.time_created,
        cursor: row.sequence,
      }))
    })

    return Service.of({
      buildRuleset,
      projectSnapshot,
      taskDetail,
      listTemplates,
      createTemplate,
      renderTemplate,
      contextPack,
      handoffBrief,
      reuseCheck,
      cleanCandidates,
      archiveIdle,
      verifyCheck,
      taskProgress,
      goalProgress,
      reviseTask,
      budget,
      settleReview,
      recover,
      claimTask,
      pauseTask,
      cancelTask,
      submitResult,
      inbox,
      setBindingStatus,
      checkScope,
      resolveScope,
      createGoal,
      setGoalStatus,
      createTask,
      setTaskStatus,
      listTasks,
      startRun,
      setRunStatus,
      bindSession,
      sendMessage,
      ackMessage,
      listEvents,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node, FSUtil.node, Session.node, SessionRunState.node],
})

export * as Orchestration from "./service"
