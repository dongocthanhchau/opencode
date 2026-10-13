import { Effect } from "effect"
import { and, eq, gte, lte, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import {
  CvisProjectGoalTable,
  CvisSessionBindingTable,
  CvisTaskRunTable,
  CvisTaskTable,
} from "@opencode-ai/core/orchestration/sql"
import { MessageID, SessionID } from "@/session/schema"
import { sumTokens } from "./usage"

export function createBudget(db: Database.Interface["db"]) {
  const reconcile = Effect.fn("Budget.reconcile")(function* (projectID: string) {
    const rows = yield* db
      .select({ run: CvisTaskRunTable })
      .from(CvisTaskRunTable)
      .innerJoin(CvisTaskTable, eq(CvisTaskTable.id, CvisTaskRunTable.task_id))
      .where(eq(CvisTaskTable.project_id, projectID))
      .all()
      .pipe(Effect.orDie)
    for (const { run } of rows) {
      const start = run.result?.prompt_start_id
      const end =
        run.time_finished ?? (typeof run.result?.usage_end_time === "number" ? run.result.usage_end_time : Date.now())
      const messages = yield* db
        .select()
        .from(MessageTable)
        .where(
          and(
            eq(MessageTable.session_id, SessionID.make(run.session_id)),
            typeof start === "string"
              ? gte(MessageTable.id, MessageID.make(start))
              : gte(MessageTable.time_created, run.time_started ?? run.time_created),
            lte(MessageTable.time_created, end),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const actual = messages.reduce(
        (total, message) =>
          total +
          (message.data.role === "assistant"
            ? sumTokens((message.data as unknown as { tokens?: Parameters<typeof sumTokens>[0] }).tokens)
            : 0),
        0,
      )
      if (actual > run.tokens_used)
        yield* db
          .update(CvisTaskRunTable)
          .set({ tokens_used: sql`max(${CvisTaskRunTable.tokens_used}, ${actual})` })
          .where(eq(CvisTaskRunTable.id, run.id))
          .run()
          .pipe(Effect.orDie)
    }
  })

  const spend = Effect.fn("Budget.spend")(function* (opts: {
    taskID?: string
    goalID?: string
    includeReservations?: boolean
    excludeRunID?: string
  }) {
    if (!opts.taskID && !opts.goalID) throw new Error("A task or goal is required for budget accounting")
    const rows = yield* db
      .select({ run: CvisTaskRunTable })
      .from(CvisTaskRunTable)
      .innerJoin(CvisTaskTable, eq(CvisTaskTable.id, CvisTaskRunTable.task_id))
      .where(opts.goalID ? eq(CvisTaskTable.goal_id, opts.goalID) : eq(CvisTaskRunTable.task_id, opts.taskID!))
      .all()
      .pipe(Effect.orDie)
    let used = rows.reduce((total, { run }) => total + run.tokens_used, 0)
    if (opts.goalID) {
      const goal = yield* db
        .select()
        .from(CvisProjectGoalTable)
        .where(eq(CvisProjectGoalTable.id, opts.goalID))
        .get()
        .pipe(Effect.orDie)
      if (typeof goal?.metadata?.manager_session_id === "string" && typeof goal.metadata.activated_at === "number") {
        const messages = yield* db
          .select()
          .from(MessageTable)
          .where(
            and(
              eq(MessageTable.session_id, SessionID.make(goal.metadata.manager_session_id)),
              gte(MessageTable.time_created, goal.metadata.activated_at),
              ...(typeof goal.metadata.completed_at === "number"
                ? [lte(MessageTable.time_created, goal.metadata.completed_at)]
                : []),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        used += messages.reduce(
          (total, message) =>
            total +
            (message.data.role === "assistant"
              ? sumTokens((message.data as unknown as { tokens?: Parameters<typeof sumTokens>[0] }).tokens)
              : 0),
          0,
        )
      }
    }
    if (opts.includeReservations)
      for (const { run } of rows) {
        if (
          run.id === opts.excludeRunID ||
          run.result?.usage_finalized ||
          !["pending", "running", "verifying"].includes(run.status)
        )
          continue
        const value = run.result?.reservation
        if (!value || typeof value !== "object") continue
        const reservation = value as { inputEstimate?: unknown; reservedOutput?: unknown }
        if (
          typeof reservation.inputEstimate === "number" &&
          Number.isFinite(reservation.inputEstimate) &&
          reservation.inputEstimate >= 0
        )
          used += reservation.inputEstimate
        if (
          typeof reservation.reservedOutput === "number" &&
          Number.isFinite(reservation.reservedOutput) &&
          reservation.reservedOutput >= 0
        )
          used += reservation.reservedOutput
      }
    return used
  })

  const prepareTurn = Effect.fn("Budget.prepareTurn")(function* (opts: {
    sessionID: string
    inputTokensEstimate: number
    requestedOutputTokens?: number
    requestID: string
  }) {
    if (!Number.isSafeInteger(opts.inputTokensEstimate) || opts.inputTokensEstimate < 0 || !opts.requestID)
      throw new Error("Invalid turn input estimate or request ID")
    const requested = opts.requestedOutputTokens ?? 4096
    if (!Number.isSafeInteger(requested) || requested <= 0) throw new Error("Invalid requested output limit")
    return yield* db
      .transaction(
        () =>
          Effect.gen(function* () {
            const binding = yield* db
              .select()
              .from(CvisSessionBindingTable)
              .where(eq(CvisSessionBindingTable.session_id, opts.sessionID))
              .get()
            if (!binding) return undefined
            const session = yield* db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, SessionID.make(opts.sessionID)))
              .get()
            if (
              !session ||
              session.time_archived !== null ||
              session.project_id !== binding.project_id ||
              binding.status === "paused"
            )
              throw new Error("Invalid managed session")
            if (!binding.task_id) {
              if (binding.role !== "manager") throw new Error("Worker has no assigned task")
              const goals = yield* db
                .select()
                .from(CvisProjectGoalTable)
                .where(
                  and(
                    eq(CvisProjectGoalTable.project_id, binding.project_id),
                    eq(CvisProjectGoalTable.status, "active"),
                  ),
                )
                .all()
              const focus =
                typeof session.metadata?.cvis_goal_id === "string"
                  ? goals.find((goal) => goal.id === session.metadata?.cvis_goal_id)
                  : goals.length === 1
                    ? goals[0]
                    : undefined
              if (!focus) {
                if (goals.length > 1) throw new Error("Manager must select cvis_goal_id focus for budget admission")
                return undefined
              }
              yield* reconcile(binding.project_id)
              const used = yield* spend({ goalID: focus.id, includeReservations: true })
              const output = Math.floor(
                Math.min(requested, 4096, (focus.budget_tokens ?? Infinity) - used - opts.inputTokensEstimate),
              )
              if (output <= 0) throw new Error("Manager goal budget exhausted for upcoming turn")
              return output
            }
            const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, binding.task_id)).get()
            if (
              !session ||
              session.time_archived !== null ||
              binding.status !== "busy" ||
              !task ||
              task.status !== "running" ||
              task.project_id !== binding.project_id ||
              session.project_id !== task.project_id ||
              binding.role !== task.role ||
              !task.active_run_id
            )
              throw new Error("Invalid managed turn binding")
            const run = yield* db
              .select()
              .from(CvisTaskRunTable)
              .where(eq(CvisTaskRunTable.id, task.active_run_id))
              .get()
            if (
              !run ||
              run.session_id !== opts.sessionID ||
              run.task_id !== task.id ||
              !["pending", "running"].includes(run.status) ||
              run.revision !== task.revision ||
              run.attempt !== task.attempt
            )
              throw new Error("Stale execution attempt")
            const goal = task.goal_id
              ? yield* db.select().from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, task.goal_id)).get()
              : undefined
            if (task.goal_id && (!goal || goal.status !== "active" || goal.project_id !== task.project_id))
              throw new Error("Goal is not active")
            yield* reconcile(task.project_id)
            const taskUsed = yield* spend({ taskID: task.id, includeReservations: true, excludeRunID: run.id })
            const goalUsed = goal
              ? yield* spend({ goalID: goal.id, includeReservations: true, excludeRunID: run.id })
              : 0
            const remaining = Math.min(
              (task.scope?.max_tokens ?? Infinity) - taskUsed,
              (goal?.budget_tokens ?? Infinity) - goalUsed,
            )
            const output = Math.floor(Math.min(requested, 4096, remaining - opts.inputTokensEstimate))
            if (output <= 0) throw new Error("Budget exhausted for upcoming provider turn")
            yield* db
              .update(CvisTaskRunTable)
              .set({
                result: {
                  ...run.result,
                  reservation: {
                    requestID: opts.requestID,
                    inputEstimate: opts.inputTokensEstimate,
                    reservedOutput: output,
                    time: Date.now(),
                  },
                },
              })
              .where(eq(CvisTaskRunTable.id, run.id))
              .run()
            return output
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })
  return { reconcile, spend, prepareTurn }
}
