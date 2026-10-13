import { Context, Effect, Layer, Schema } from "effect"
import { and, eq, gte } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Session } from "@/session/session"
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
import { Role, checkResolvedPaths, effectiveRuleset, scopesOverlap, toRuleset, validateScope } from "./roles"
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
  readonly setGoalStatus: (input: { id: string; status: GoalStatus; reason?: string }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
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
  readonly setTaskStatus: (input: { id: string; status: TaskStatus }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly startRun: (input: { taskID: string; sessionID: string }) => Effect.Effect<{ id: string; attempt: number }, NotFoundError>
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
  readonly pauseTask: (input: { taskID: string; reason?: string }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly cancelTask: (input: { taskID: string; reason?: string }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
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
  readonly taskProgress: (input: { taskID: string }) => Effect.Effect<
    { percent: number; passed: string[]; pending: string[] },
    NotFoundError
  >
  readonly goalProgress: (input: { goalID: string }) => Effect.Effect<
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
  readonly listTemplates: (input: { role?: string }) => Effect.Effect<
    { id: string; name: string; role: string | null; version: number }[]
  >
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
  readonly projectSnapshot: (input: { projectID: string }) => Effect.Effect<{
    eventCursor: number
    goals: { id: string; title: string; status: string; percent: number; used: number; cap: number | null }[]
    columns: { status: string; tasks: { id: string; title: string; role: string; percent: number; goalID: string | null }[] }[]
    bindings: { session: string; role: string; status: string; task: string | null }[]
  }, NotFoundError>
  readonly taskDetail: (input: { taskID: string }) => Effect.Effect<Record<string, unknown>, NotFoundError>
  readonly bindSession: (input: {
    sessionID: string
    projectID: string
    role: Role
    taskID?: string
    managerSession?: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly setBindingStatus: (input: { sessionID: string; status: BindingStatus }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
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
  readonly listTasks: (input: { projectID: string; status?: TaskStatus }) => Effect.Effect<
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
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function isRole(role: string): role is Role {
  return (["manager", "researcher", "implementer", "verifier", "maintenance"] as readonly string[]).includes(role)
}

function isMessageKind(kind: string): kind is MessageKind {
  return (["assign", "progress", "question", "blocked", "result", "review", "cancel", "ack"] as readonly string[]).includes(
    kind,
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service
    const sessions = yield* Session.Service

    const recordEvent = Effect.fn("Cvis.recordEvent")(function* (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
      input: { projectID: string; entity: string; entityID: string; type: string; payload?: Record<string, unknown> },
    ) {
      yield* tx
        .insert(CvisEventTable)
        .values({
          id: newID("evt"),
          project_id: ProjectV2.ID.make(input.projectID),
          entity_kind: input.entity,
          entity_id: input.entityID,
          type: input.type,
          payload: input.payload ?? null,
        })
        .run()
    })

    const createGoal = Effect.fn("Cvis.createGoal")(function* (input: { projectID: string; title: string; objective: string; budgetTokens?: number }) {
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

    const setGoalStatus = Effect.fn("Cvis.setGoalStatus")(function* (input: { id: string; status: GoalStatus; reason?: string }) {
      const row = yield* db.select().from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, input.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "goal", id: input.id })
      if (!canTransitionGoal(row.status as GoalStatus, input.status)) {
        return yield* new InvalidTransitionError({ entity: "goal", id: input.id, from: row.status, to: input.status })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(CvisProjectGoalTable).set({ status: input.status }).where(eq(CvisProjectGoalTable.id, input.id)).run()
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
      if (input.goalID) {
        const goal = yield* db.select({ id: CvisProjectGoalTable.id }).from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, input.goalID)).get().pipe(Effect.orDie)
        if (!goal) return yield* new NotFoundError({ entity: "goal", id: input.goalID })
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
          return yield* new InvalidTransitionError({ entity: "task", id: "new", from: dep, to: "cross-project-dependency" })
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
                acceptance: input.acceptance ?? null,
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
      if (input.status === "done") {
        const gate = yield* doneGate(row.id)
        if (!gate.ok) {
          return yield* new InvalidTransitionError({ entity: "task", id: input.id, from: row.status, to: `done(${gate.reason})` })
        }
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(CvisTaskTable).set({ status: input.status }).where(eq(CvisTaskTable.id, input.id)).run()
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
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      const prior = yield* db
        .select({ attempt: CvisTaskRunTable.attempt })
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.task_id, input.taskID))
        .all()
        .pipe(Effect.orDie)
      const attempt = prior.reduce((max, r) => Math.max(max, r.attempt), 0) + 1
      const id = newID("run")
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(CvisTaskRunTable)
              .values({ id, task_id: input.taskID, session_id: input.sessionID, attempt, status: "pending" })
              .run()
            yield* recordEvent(tx, {
              projectID: task.project_id,
              entity: "run",
              entityID: id,
              type: "run.started",
              payload: { taskID: input.taskID, attempt },
            })
          }),
        )
        .pipe(Effect.orDie)
      return { id, attempt }
    })

    const setRunStatus = Effect.fn("Cvis.setRunStatus")(function* (input: {
      id: string
      status: RunStatus
      tokensUsed?: number
      result?: Record<string, unknown>
      error?: string
    }) {
      const row = yield* db.select().from(CvisTaskRunTable).where(eq(CvisTaskRunTable.id, input.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "run", id: input.id })
      if (!canTransitionRun(row.status as RunStatus, input.status)) {
        return yield* new InvalidTransitionError({ entity: "run", id: input.id, from: row.status, to: input.status })
      }
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, row.task_id)).get().pipe(Effect.orDie)
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
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      if (task.status !== "queued") {
        return yield* new InvalidTransitionError({ entity: "task", id: input.taskID, from: task.status, to: "running" })
      }
      if (task.goal_id) {
        const goal = yield* db.select().from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, task.goal_id)).get().pipe(Effect.orDie)
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
        return yield* new ConflictError({ entity: "task", id: input.taskID, reason: "session belongs to another project" })
      }
      const scope = (task.scope ?? {}) as TaskScope
      const scopeErrors = validateScope(scope, { worktree: sinfo.directory, projectDenies: input.projectDenies })
      if (scopeErrors.length > 0) {
        return yield* new ConflictError({ entity: "task", id: input.taskID, reason: scopeErrors.join("; ") })
      }
      for (const dep of task.dependencies ?? []) {
        const depRow = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, dep)).get().pipe(Effect.orDie)
        if (!depRow || depRow.status !== "done") {
          return yield* new ConflictError({ entity: "task", id: input.taskID, reason: `dependency not done: ${dep}` })
        }
      }
      const active = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.project_id, task.project_id)).all().pipe(Effect.orDie)
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
      if (current?.task_id != null && current.task_id !== input.taskID && current.status !== "idle") {
        return yield* new InvalidTransitionError({ entity: "binding", id: input.sessionID, from: current.task_id, to: input.taskID })
      }
      // Enforce first: a committed claim must never leave a worker running
      // without its narrowed ruleset, while a failed claim leaves the
      // session untouched rather than over-restricted.
      const ruleset = toRuleset(effectiveRuleset({ role: task.role as Role, scope }))
      yield* sessions.setPermission({ sessionID: SessionID.make(input.sessionID), permission: ruleset })
      const existing = ((sinfo.metadata ?? {}) as Record<string, unknown>) ?? {}
      const cvis = { role: task.role, taskID: input.taskID, projectID: task.project_id }
      yield* sessions.setMetadata({
        sessionID: SessionID.make(input.sessionID),
        metadata: { ...existing, cvis } as typeof existing,
      })
      const outcome = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const fresh = yield* tx.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get()
            if (!fresh || fresh.status !== "queued") {
              return yield* new InvalidTransitionError({
                entity: "task",
                id: input.taskID,
                from: fresh?.status ?? "missing",
                to: "running",
              })
            }
            yield* tx.update(CvisTaskTable).set({ status: "running" }).where(eq(CvisTaskTable.id, input.taskID)).run()
            const prior = yield* tx
              .select({ attempt: CvisTaskRunTable.attempt })
              .from(CvisTaskRunTable)
              .where(eq(CvisTaskRunTable.task_id, input.taskID))
              .all()
            const attempt = prior.reduce((max, r) => Math.max(max, r.attempt), 0) + 1
            const runID = newID("run")
            yield* tx
              .insert(CvisTaskRunTable)
              .values({ id: runID, task_id: input.taskID, session_id: input.sessionID, attempt, status: "pending" })
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
              })
              .onConflictDoUpdate({
                target: CvisSessionBindingTable.session_id,
                set: { role: task.role, task_id: input.taskID, status: "busy" },
              })
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
      const row = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      if (!canTransitionTask(row.status as TaskStatus, "paused")) {
        return yield* new InvalidTransitionError({ entity: "task", id: input.taskID, from: row.status, to: "paused" })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(CvisTaskTable).set({ status: "paused" }).where(eq(CvisTaskTable.id, input.taskID)).run()
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
    })

    const cancelTask = Effect.fn("Cvis.cancelTask")(function* (input: { taskID: string; reason?: string }) {
      const row = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      if (!canTransitionTask(row.status as TaskStatus, "cancelled")) {
        return yield* new InvalidTransitionError({ entity: "task", id: input.taskID, from: row.status, to: "cancelled" })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(CvisTaskTable).set({ status: "cancelled" }).where(eq(CvisTaskTable.id, input.taskID)).run()
            const open = yield* db
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
    })

    const submitResult = Effect.fn("Cvis.submitResult")(function* (input: {
      runID: string
      result?: Record<string, unknown>
      tokensUsed?: number
      error?: string
    }) {
      const row = yield* db.select().from(CvisTaskRunTable).where(eq(CvisTaskRunTable.id, input.runID)).get().pipe(Effect.orDie)
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
        const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, row.task_id)).get().pipe(Effect.orDie)
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
        return yield* new ConflictError({ entity: "run", id: input.runID, reason: `stale attempt ${row.attempt}, latest is ${maxAttempt}` })
      }
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, row.task_id)).get().pipe(Effect.orDie)
      if (!task || task.status !== "running") {
        return yield* new ConflictError({ entity: "run", id: input.runID, reason: "task is no longer running" })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
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
      return sum
    })

    const doneGate = Effect.fn("Cvis.doneGate")(function* (taskID: string) {
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, taskID)).get().pipe(Effect.orDie)
      if (!task) return { ok: false, reason: "missing task" }
      const acceptance = (task.acceptance ?? []) as { id: string; label: string; weight: number }[]
      if (acceptance.length > 0) {
        const checks = yield* db
          .select()
          .from(CvisCheckTable)
          .where(eq(CvisCheckTable.task_id, taskID))
          .all()
          .pipe(Effect.orDie)
        const passed = new Set(checks.filter((c) => c.verdict === "pass").map((c) => c.check_id))
        const missing = acceptance.filter((item) => !passed.has(item.id)).map((item) => item.id)
        if (missing.length > 0) return { ok: false, reason: `unchecked: ${missing.join(",")}` }
        return { ok: true }
      }
      const finished = yield* db
        .select({ status: CvisTaskRunTable.status })
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.task_id, taskID))
        .all()
        .pipe(Effect.orDie)
      if (!finished.some((r) => r.status === "done")) return { ok: false, reason: "no verified run" }
      return { ok: true }
    })

    const verifyCheck = Effect.fn("Cvis.verifyCheck")(function* (input: {
      taskID: string
      checkID: string
      runID?: string
      sessionID: string
      verdict: "pass" | "fail"
      evidence?: Record<string, unknown>
    }) {
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      const acceptance = (task.acceptance ?? []) as { id: string; label: string; weight: number }[]
      if (!acceptance.some((item) => item.id === input.checkID)) {
        return yield* new InvalidTransitionError({ entity: "check", id: input.checkID, from: input.taskID, to: "unknown-check" })
      }
      if (input.runID) {
        const run = yield* db.select().from(CvisTaskRunTable).where(eq(CvisTaskRunTable.id, input.runID)).get().pipe(Effect.orDie)
        if (!run || run.task_id !== input.taskID) {
          return yield* new NotFoundError({ entity: "run", id: input.runID ?? "" })
        }
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(CvisCheckTable)
              .values({
                id: newID("chk"),
                task_id: input.taskID,
                check_id: input.checkID,
                run_id: input.runID ?? null,
                verifier_session: input.sessionID,
                verdict: input.verdict,
                evidence: input.evidence ?? null,
              })
              .onConflictDoUpdate({
                target: [CvisCheckTable.task_id, CvisCheckTable.check_id],
                set: {
                  run_id: input.runID ?? null,
                  verifier_session: input.sessionID,
                  verdict: input.verdict,
                  evidence: input.evidence ?? null,
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
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      const acceptance = (task.acceptance ?? []) as { id: string; label: string; weight: number }[]
      if (acceptance.length === 0) {
        const statusPercent: Record<string, number> = {
          draft: 0,
          queued: 0,
          running: 50,
          verifying: 80,
          blocked: 0,
          paused: 0,
          failed: 0,
          cancelled: 0,
          done: 100,
        }
        return { percent: statusPercent[task.status] ?? 0, passed: [], pending: [] }
      }
      const checks = yield* db
        .select()
        .from(CvisCheckTable)
        .where(eq(CvisCheckTable.task_id, input.taskID))
        .all()
        .pipe(Effect.orDie)
      const passed = new Set(checks.filter((c) => c.verdict === "pass").map((c) => c.check_id))
      return checklistProgress(acceptance, passed)
    })

    const goalProgress = Effect.fn("Cvis.goalProgress")(function* (input: { goalID: string }) {
      const goal = yield* db.select().from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, input.goalID)).get().pipe(Effect.orDie)
      if (!goal) return yield* new NotFoundError({ entity: "goal", id: input.goalID })
      const tasks = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.goal_id, input.goalID))
        .all()
        .pipe(Effect.orDie)
      const visible = tasks.filter((t) => t.status !== "cancelled")
      const entries: { id: string; title: string; status: string; percent: number }[] = []
      for (const task of visible) {
        const progress = yield* taskProgress({ taskID: task.id })
        entries.push({ id: task.id, title: task.title, status: task.status, percent: progress.percent })
      }
      const percent = entries.length === 0 ? 0 : Math.floor(entries.reduce((sum, e) => sum + e.percent, 0) / entries.length)
      return { percent, tasks: entries }
    })

    const reviseTask = Effect.fn("Cvis.reviseTask")(function* (input: {
      taskID: string
      title?: string
      description?: string
      scope?: { read_paths?: string[]; write_paths?: string[]; tools?: string[]; max_tokens?: number }
      acceptance?: { id: string; label: string; weight: number }[]
    }) {
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      if (task.status === "done" || task.status === "cancelled") {
        return yield* new InvalidTransitionError({ entity: "task", id: input.taskID, from: task.status, to: "revise" })
      }
      const snapshot = {
        title: task.title,
        description: task.description,
        scope: task.scope,
        acceptance: task.acceptance,
        revision: task.revision,
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
              })
              .where(eq(CvisTaskTable.id, input.taskID))
              .run()
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
        const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
        if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
        const scope = (task.scope ?? {}) as { max_tokens?: number }
        return { used: yield* taskSpend(task.id), cap: scope.max_tokens ?? null }
      }
      const goal = yield* db.select().from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, input.goalID ?? "")).get().pipe(Effect.orDie)
      if (!goal) return yield* new NotFoundError({ entity: "goal", id: input.goalID ?? "" })
      return { used: yield* goalSpend(goal.id), cap: goal.budget_tokens }
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
        .values({ id, name: trimmed, role: input.role ?? null, version, body: input.body, inputs: input.inputs ?? null })
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
      const rendered = OrchestrationTemplates.renderTemplate(template.body, (template.inputs ?? []) as { name: string; required: boolean }[], input.vars)
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
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
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
        ? yield* db.select().from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, task.goal_id)).get().pipe(Effect.orDie)
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
      const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, SessionID.make(input.sessionID))).get().pipe(Effect.orDie)
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
        .select({ id: CvisTaskRunTable.id, status: CvisTaskRunTable.status, session_id: CvisTaskRunTable.session_id })
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.session_id, input.sessionID))
        .all()
        .pipe(Effect.orDie)
      brief["openRuns"] = openRuns.filter((run) => run.status === "pending" || run.status === "running" || run.status === "verifying")
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
          .map((event) => ({ type: event.type, entity: `${event.entity_kind}:${event.entity_id}`, time: event.time_created }))
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
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      if (binding) {
        if (binding.status !== "idle") reasons.push(`binding is ${binding.status}`)
        if (binding.project_id !== task.project_id) reasons.push("different project")
        if (binding.role !== task.role) reasons.push(`role mismatch: ${binding.role} vs ${task.role}`)
        if (binding.task_id != null && binding.task_id !== input.taskID) reasons.push("unfinished previous task")
      } else {
        const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, SessionID.make(input.sessionID))).get().pipe(Effect.orDie)
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

    const cleanCandidates = Effect.fn("Cvis.cleanCandidates")(function* (input: { projectID: string; idleDays: number }) {
      const cutoff = Date.now() - Math.max(0, input.idleDays) * 86_400_000
      const sessions = yield* db.select().from(SessionTable).where(eq(SessionTable.project_id, ProjectV2.ID.make(input.projectID))).all().pipe(Effect.orDie)
      const out: { id: string; title: string; reason: string; time: number }[] = []
      for (const session of sessions) {
        if ((session.time_updated ?? 0) >= cutoff) continue
        const binding = yield* db
          .select()
          .from(CvisSessionBindingTable)
          .where(eq(CvisSessionBindingTable.session_id, session.id))
          .get()
          .pipe(Effect.orDie)
        if (!binding) {
          out.push({ id: session.id, title: session.title, reason: "idle, never bound", time: session.time_updated ?? 0 })
          continue
        }
        if (binding.status === "idle" && binding.task_id == null) {
          out.push({ id: session.id, title: session.title, reason: "idle, no task", time: session.time_updated ?? 0 })
        }
      }
      return out.sort((a, b) => a.time - b.time)
    })

    const projectSnapshot = Effect.fn("Cvis.projectSnapshot")(function* (input: { projectID: string }) {
      const goals = yield* db
        .select()
        .from(CvisProjectGoalTable)
        .where(eq(CvisProjectGoalTable.project_id, input.projectID))
        .all()
        .pipe(Effect.orDie)
      const goalEntries: { id: string; title: string; status: string; percent: number; used: number; cap: number | null }[] = []
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
      const columns = new Map<string, { id: string; title: string; role: string; percent: string | number; goalID: string | null }[]>()
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
        .select({ time: CvisEventTable.time_created })
        .from(CvisEventTable)
        .where(eq(CvisEventTable.project_id, input.projectID))
        .all()
        .pipe(Effect.orDie)
      return {
        eventCursor: latest.reduce((max, r) => Math.max(max, r.time), 0),
        goals: goalEntries,
        columns: [...columns.entries()].map(([status, list]) => ({
          status,
          tasks: list as { id: string; title: string; role: string; percent: number; goalID: string | null }[],
        })),
        bindings: bindings.map((b) => ({ session: b.session_id, role: b.role, status: b.status, task: b.task_id })),
      }
    })

    const taskDetail = Effect.fn("Cvis.taskDetail")(function* (input: { taskID: string }) {
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
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
        ? yield* db.select().from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, task.goal_id)).get().pipe(Effect.orDie)
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
        })),
        messages: messages
          .sort((a, b) => a.time_created - b.time_created)
          .map((message) => ({ id: message.id, kind: message.kind, from: message.from_session, status: message.status })),
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
      if (input.taskID) {
        const task = yield* db.select({ id: CvisTaskTable.id }).from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
        if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
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
        current?.task_id != null &&
        input.taskID != null &&
        current.task_id !== input.taskID &&
        current.status !== "idle"
      ) {
        return yield* new InvalidTransitionError({
          entity: "binding",
          id: input.sessionID,
          from: current.task_id,
          to: input.taskID,
        })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(CvisSessionBindingTable)
              .values({
                session_id: input.sessionID,
                project_id: ProjectV2.ID.make(input.projectID),
                role: input.role,
                task_id: input.taskID ?? null,
                manager_session: input.managerSession ?? null,
                status: "idle",
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
        return yield* new InvalidTransitionError({ entity: "binding", id: input.sessionID, from: row.status, to: input.status })
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
      const id = newID("msg")
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
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
              .run()
            yield* recordEvent(tx, {
              projectID: input.projectID,
              entity: "message",
              entityID: id,
              type: `message.${input.kind}`,
              payload: { taskID: input.taskID ?? null },
            })
          }),
        )
        .pipe(Effect.orDie)
      return { id }
    })

    const ackMessage = Effect.fn("Cvis.ackMessage")(function* (input: { id: string }) {
      const row = yield* db.select().from(CvisMessageTable).where(eq(CvisMessageTable.id, input.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "message", id: input.id })
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

    // Cursor is inclusive (>=): reconnecting clients refetch from their last
    // seen timestamp and dedupe by event id, so same-millisecond batches are
    // never skipped. Clients must tolerate boundary duplicates.
    const listEvents = Effect.fn("Cvis.listEvents")(function* (input: { projectID: string; cursor?: number; limit?: number }) {
      const cond =
        input.cursor == null
          ? eq(CvisEventTable.project_id, input.projectID)
          : and(eq(CvisEventTable.project_id, input.projectID), gte(CvisEventTable.time_created, input.cursor))
      const rows = yield* db
        .select()
        .from(CvisEventTable)
        .where(cond)
        .orderBy(CvisEventTable.time_created, CvisEventTable.id)
        .limit(input.limit ?? 100)
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        entity: row.entity_kind,
        entityID: row.entity_id,
        payload: row.payload as unknown,
        time: row.time_created,
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
      verifyCheck,
      taskProgress,
      goalProgress,
      reviseTask,
      budget,
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
  deps: [Database.node, FSUtil.node, Session.node],
})

export * as Orchestration from "./service"
