import { Context, Effect, Layer, Schema, Cause } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  CvisMessageTable,
  CvisProjectGoalTable,
  CvisSessionBindingTable,
  CvisTaskTable,
} from "@opencode-ai/core/orchestration/sql"
import { Orchestration } from "./service"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@/session/schema"
import type { Role, TaskScope } from "./roles"

export interface Interface {
  invoke: (input: {
    actor: string
    operation: string
    args: Record<string, unknown>
  }) => Effect.Effect<unknown, unknown>
  invokeOperator: (input: {
    actor: string
    operation: string
    args: Record<string, unknown>
  }) => Effect.Effect<unknown, unknown>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/CvisControl") {}

function field(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Required field: ${name}`)
  return value
}

function serviceErrorMessage(err: unknown): string {
  const cause = Cause.isCause(err) ? Cause.squash(err) : err
  if (cause && typeof cause === "object") {
    const e = cause as Record<string, unknown>
    const parts: string[] = []
    if (typeof e._tag === "string") parts.push(e._tag)
    if (typeof e.entity === "string") parts.push(`entity:${e.entity}`)
    if (typeof e.id === "string") parts.push(`id:${e.id}`)
    if (typeof e.from === "string") parts.push(`from:${e.from}`)
    if (typeof e.to === "string") parts.push(`to:${e.to}`)
    if (typeof e.reason === "string") parts.push(`reason:${e.reason}`)
    if (parts.length > 0) return parts.join(" ")
    if (cause instanceof Error) return cause.message
  }
  return String(cause)
}
export { serviceErrorMessage }

const GoalBudgetInput = Schema.Struct({
  goalID: Schema.String,
  budgetTokens: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  expectedBudget: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  reason: Schema.String.check(Schema.isMinLength(1)),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const orchestration = yield* Orchestration.Service
    const invoke = Effect.fn("CvisControl.invoke")(function* (input: {
      actor: string
      operation: string
      args: Record<string, unknown>
    }) {
      const actor = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.actor))
        .get()
        .pipe(Effect.orDie)
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.actor)))
        .get()
        .pipe(Effect.orDie)
      if (
        !actor ||
        actor.status === "paused" ||
        !session ||
        session.time_archived !== null ||
        session.project_id !== actor.project_id
      )
        return yield* Effect.fail(new Error("Authenticated session binding required"))
      const args = input.args
      if (input.operation === "archive_idle") {
        if (actor.role !== "manager" && actor.role !== "maintenance")
          return yield* Effect.fail(new Error("Maintenance capability required"))
        return yield* orchestration.archiveIdle({
          projectID: actor.project_id,
          idleDays: typeof args.days === "number" ? args.days : undefined,
        })
      }
      if (input.operation === "inbox")
        return yield* orchestration.inbox({ sessionID: input.actor, projectID: actor.project_id })
      if (input.operation === "ack") {
        const messageID = field(args, "messageID")
        const message = yield* db
          .select()
          .from(CvisMessageTable)
          .where(eq(CvisMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        if (
          !message ||
          message.project_id !== actor.project_id ||
          (message.to_session !== null && message.to_session !== input.actor)
        )
          return yield* Effect.fail(new Error("Message not addressed to actor"))
        yield* orchestration.ackMessage({ id: messageID })
        return { acknowledged: true }
      }
      const taskID =
        typeof args.taskID === "string" ? args.taskID : input.operation === "verify" ? undefined : actor.task_id
      if (taskID) {
        const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, taskID)).get().pipe(Effect.orDie)
        if (!task || task.project_id !== actor.project_id)
          return yield* Effect.fail(new Error("Task outside actor project"))
      }
      if (["snapshot", "events", "task_detail", "context"].includes(input.operation)) {
        if (input.operation === "snapshot") return yield* orchestration.projectSnapshot({ projectID: actor.project_id })
        if (input.operation === "events")
          return yield* orchestration.listEvents({
            projectID: actor.project_id,
            cursor: typeof args.cursor === "number" ? args.cursor : undefined,
          })
        if (!taskID) return yield* Effect.fail(new Error("Task required"))
        if (actor.role !== "manager" && actor.task_id !== taskID && actor.role !== "verifier")
          return yield* Effect.fail(new Error("Task not assigned to actor"))
        if (input.operation === "context") return yield* orchestration.contextPack({ taskID })
        return yield* orchestration.taskDetail({ taskID })
      }
      if (input.operation === "verify") {
        if (actor.role !== "verifier") return yield* Effect.fail(new Error("Verifier role required"))
        const checkID = field(args, "checkID")
        let resolvedTaskID = taskID

        if (!resolvedTaskID && actor.task_id) {
          const reviewerJob = yield* db
            .select()
            .from(CvisTaskTable)
            .where(eq(CvisTaskTable.id, actor.task_id))
            .get()
            .pipe(Effect.orDie)
          if (reviewerJob?.scope?.review_task_id) resolvedTaskID = reviewerJob.scope.review_task_id
        }

        if (!resolvedTaskID) return yield* Effect.fail(new Error("Verifier required: taskID or assigned review scope"))

        const reviewerJob = actor.task_id
          ? yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, actor.task_id)).get().pipe(Effect.orDie)
          : undefined
        const authoritativeTargetID = reviewerJob?.scope?.review_task_id
        if (authoritativeTargetID && authoritativeTargetID !== resolvedTaskID) {
          return yield* Effect.fail(
            new Error(
              `Wrong review target: supplied ${resolvedTaskID}, authoritative target is ${authoritativeTargetID}`,
            ),
          )
        }

        const targetTask = yield* db
          .select()
          .from(CvisTaskTable)
          .where(eq(CvisTaskTable.id, resolvedTaskID))
          .get()
          .pipe(Effect.orDie)
        if (!targetTask || targetTask.project_id !== actor.project_id)
          return yield* Effect.fail(new Error(`Task not found in project: ${resolvedTaskID}`))

        const acceptance = (targetTask.acceptance ?? []) as { id: string; label: string; weight: number }[]
        const allowedCheckIDs = acceptance.map((item) => item.id)
        if (!allowedCheckIDs.includes(checkID)) {
          return yield* Effect.fail(
            new Error(
              `Unknown checkID: ${checkID}. Allowed check IDs for task ${resolvedTaskID}: [${allowedCheckIDs.join(", ")}]`,
            ),
          )
        }

        const currentRevision = targetTask.revision
        if (
          reviewerJob?.scope?.review_revision !== undefined &&
          reviewerJob.scope.review_revision !== currentRevision
        ) {
          return yield* Effect.fail(
            new Error(
              `Review revision mismatch: assigned revision ${reviewerJob.scope.review_revision}, task is at revision ${currentRevision}`,
            ),
          )
        }

        if (args.verdict !== "pass" && args.verdict !== "fail")
          return yield* Effect.fail(new Error("Explicit pass/fail verdict required"))
        yield* orchestration
          .verifyCheck({
            taskID: resolvedTaskID,
            checkID,
            sessionID: input.actor,
            verdict: args.verdict === "fail" ? "fail" : "pass",
            evidence: { files: args.files, conclusion: args.conclusion },
          })
          .pipe(
            Effect.catchCause((cause) => {
              const err = cause as unknown
              return Effect.fail(new Error(serviceErrorMessage(err)))
            }),
          )
        return { accepted: true }
      }
      if (input.operation === "message") {
        return yield* orchestration
          .sendMessage({
            projectID: actor.project_id,
            fromSession: input.actor,
            toSession: typeof args.toSession === "string" ? args.toSession : undefined,
            taskID: taskID ?? undefined,
            kind: field(args, "kind") as never,
            body:
              typeof args.body === "object" && args.body !== null ? (args.body as Record<string, unknown>) : undefined,
            idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined,
          })
          .pipe(
            Effect.catchCause((cause) => {
              const err = cause as unknown
              return Effect.fail(new Error(serviceErrorMessage(err)))
            }),
          )
      }
      if (actor.role !== "manager") return yield* Effect.fail(new Error("Manager capability required"))
      if (input.operation === "goal_status") {
        const goalID = field(args, "goalID")
        const goal = yield* db
          .select()
          .from(CvisProjectGoalTable)
          .where(eq(CvisProjectGoalTable.id, goalID))
          .get()
          .pipe(Effect.orDie)
        if (!goal || goal.project_id !== actor.project_id)
          return yield* Effect.fail(new Error("Goal outside actor project"))
        yield* orchestration.setGoalStatus({ id: goalID, status: field(args, "status") as never }).pipe(
          Effect.catchCause((cause) => {
            const err = cause as unknown
            return Effect.fail(new Error(serviceErrorMessage(err)))
          }),
        )
        return { accepted: true }
      }
      if (input.operation === "create_task") {
        if (
          typeof args.description !== "string" ||
          !args.description.trim() ||
          typeof args.scope !== "object" ||
          args.scope === null ||
          !Array.isArray(args.acceptance) ||
          !args.acceptance.length
        ) {
          return yield* Effect.fail(
            new Error(
              "create_task requires flat arguments: title, description, role, goalID, scope {read_paths,write_paths,tools}, acceptance [{id,label,weight}]. Do not nest these under task.",
            ),
          )
        }
        return yield* orchestration
          .createTask({
            projectID: actor.project_id,
            goalID: typeof args.goalID === "string" ? args.goalID : undefined,
            title: field(args, "title"),
            description: typeof args.description === "string" ? args.description : undefined,
            role: field(args, "role") as Role,
            scope: args.scope as TaskScope | undefined,
            acceptance: args.acceptance as { id: string; label: string; weight: number }[] | undefined,
          })
          .pipe(
            Effect.catchCause((cause) => {
              const err = cause as unknown
              return Effect.fail(new Error(serviceErrorMessage(err)))
            }),
          )
      }
      if (!taskID) return yield* Effect.fail(new Error("Task required"))
      if (input.operation === "queue_task")
        yield* orchestration.setTaskStatus({ id: taskID, status: "queued" }).pipe(
          Effect.catchCause((cause) => {
            const err = cause as unknown
            return Effect.fail(new Error(serviceErrorMessage(err)))
          }),
        )
      else if (input.operation === "pause_task")
        yield* orchestration.pauseTask({ taskID }).pipe(
          Effect.catchCause((cause) => {
            const err = cause as unknown
            return Effect.fail(new Error(serviceErrorMessage(err)))
          }),
        )
      else if (input.operation === "cancel_task")
        yield* orchestration.cancelTask({ taskID }).pipe(
          Effect.catchCause((cause) => {
            const err = cause as unknown
            return Effect.fail(new Error(serviceErrorMessage(err)))
          }),
        )
      else if (input.operation === "complete_task")
        yield* orchestration.setTaskStatus({ id: taskID, status: "done" }).pipe(
          Effect.catchCause((cause) => {
            const err = cause as unknown
            return Effect.fail(new Error(serviceErrorMessage(err)))
          }),
        )
      else if (input.operation === "revise_task")
        return yield* orchestration
          .reviseTask({
            taskID,
            description: typeof args.description === "string" ? args.description : undefined,
            acceptance: args.acceptance as never,
          })
          .pipe(
            Effect.catchCause((cause) => {
              const err = cause as unknown
              return Effect.fail(new Error(serviceErrorMessage(err)))
            }),
          )
      else return yield* Effect.fail(new Error(`Unknown operation: ${input.operation}`))
      return { accepted: true }
    })

    const invokeOperator = Effect.fn("CvisControl.invokeOperator")(function* (input: {
      actor: string
      operation: string
      args: Record<string, unknown>
    }) {
      if (input.operation === "task_budget") {
        const taskID = field(input.args, "taskID")
        const reason = field(input.args, "reason")
        const maxTokens = input.args.maxTokens
        const expected = input.args.expectedMaxTokens
        if (
          typeof maxTokens !== "number" ||
          !Number.isSafeInteger(maxTokens) ||
          maxTokens <= 0 ||
          (expected !== null && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected <= 0))
        )
          return yield* Effect.fail(new Error("Positive integer maxTokens and explicit expectedMaxTokens required"))
        yield* orchestration.updateTaskBudget({
          taskID,
          maxTokens,
          expectedMaxTokens: expected as number | null,
          reason,
          actorSessionID: input.actor,
        })
        return { accepted: true, taskID, maxTokens }
      }
      if (input.operation === "goal_budget") {
        const decoded = yield* Schema.decodeUnknownEffect(GoalBudgetInput)(input.args).pipe(
          Effect.mapError((err) => new Error(`goal_budget: invalid input: ${String(err)}`)),
        )
        const goal = yield* db
          .select()
          .from(CvisProjectGoalTable)
          .where(eq(CvisProjectGoalTable.id, decoded.goalID))
          .get()
          .pipe(Effect.orDie)
        if (!goal) return yield* Effect.fail(new Error(`goal_budget: entity:goal id:${decoded.goalID} not found`))
        if (decoded.expectedBudget !== null && goal.budget_tokens !== decoded.expectedBudget) {
          return yield* Effect.fail(
            new Error(
              `goal_budget: CAS mismatch entity:goal id:${decoded.goalID} from:${goal.budget_tokens} to:${decoded.budgetTokens} reason:expectedBudget does not match`,
            ),
          )
        }
        yield* orchestration.updateGoalBudget({
          goalID: decoded.goalID,
          budgetTokens: decoded.budgetTokens,
          expectedBudget: decoded.expectedBudget,
          reason: decoded.reason,
          actorSessionID: input.actor,
        })
        return { accepted: true, goalID: decoded.goalID, budgetTokens: decoded.budgetTokens }
      }
      return yield* Effect.fail(new Error(`Unknown operator operation: ${input.operation}`))
    })

    return Service.of({ invoke, invokeOperator })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, Orchestration.node] })
export * as OrchestrationControl from "./control"
