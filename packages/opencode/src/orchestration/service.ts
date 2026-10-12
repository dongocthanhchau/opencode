import { Context, Effect, Layer, Schema } from "effect"
import { and, eq, gt } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import {
  CvisEventTable,
  CvisMessageTable,
  CvisProjectGoalTable,
  CvisSessionBindingTable,
  CvisTaskRunTable,
  CvisTaskTable,
} from "@opencode-ai/core/orchestration/sql"
import {
  canTransitionGoal,
  canTransitionRun,
  canTransitionTask,
  GoalStatus,
  MessageKind,
  RunStatus,
  TaskStatus,
} from "./machine"
import { Role } from "./roles"

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
  readonly bindSession: (input: {
    sessionID: string
    projectID: string
    role: Role
    taskID?: string
    managerSession?: string
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

    const listEvents = Effect.fn("Cvis.listEvents")(function* (input: { projectID: string; cursor?: number; limit?: number }) {
      const cond =
        input.cursor == null
          ? eq(CvisEventTable.project_id, input.projectID)
          : and(eq(CvisEventTable.project_id, input.projectID), gt(CvisEventTable.time_created, input.cursor))
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
  deps: [Database.node],
})

export * as Orchestration from "./service"
