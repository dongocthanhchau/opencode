import { Context, Effect, Layer } from "effect"
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
import type { Role, TaskScope } from "./roles"

export interface Interface {
  invoke: (input: {
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
      if (!actor || actor.status === "paused")
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
      const taskID = typeof args.taskID === "string" ? args.taskID : actor.task_id
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
        if (actor.role !== "verifier" || !taskID) return yield* Effect.fail(new Error("Verifier required"))
        if (args.verdict !== "pass" && args.verdict !== "fail")
          return yield* Effect.fail(new Error("Explicit pass/fail verdict required"))
        yield* orchestration.verifyCheck({
          taskID,
          checkID: field(args, "checkID"),
          sessionID: input.actor,
          verdict: args.verdict === "fail" ? "fail" : "pass",
          evidence: { files: args.files, conclusion: args.conclusion },
        })
        return { accepted: true }
      }
      if (input.operation === "message") {
        return yield* orchestration.sendMessage({
          projectID: actor.project_id,
          fromSession: input.actor,
          toSession: typeof args.toSession === "string" ? args.toSession : undefined,
          taskID: taskID ?? undefined,
          kind: field(args, "kind") as never,
          body:
            typeof args.body === "object" && args.body !== null ? (args.body as Record<string, unknown>) : undefined,
          idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined,
        })
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
        yield* orchestration.setGoalStatus({ id: goalID, status: field(args, "status") as never })
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
        return yield* orchestration.createTask({
          projectID: actor.project_id,
          goalID: typeof args.goalID === "string" ? args.goalID : undefined,
          title: field(args, "title"),
          description: typeof args.description === "string" ? args.description : undefined,
          role: field(args, "role") as Role,
          scope: args.scope as TaskScope | undefined,
          acceptance: args.acceptance as { id: string; label: string; weight: number }[] | undefined,
        })
      }
      if (!taskID) return yield* Effect.fail(new Error("Task required"))
      if (input.operation === "queue_task") yield* orchestration.setTaskStatus({ id: taskID, status: "queued" })
      else if (input.operation === "pause_task") yield* orchestration.pauseTask({ taskID })
      else if (input.operation === "cancel_task") yield* orchestration.cancelTask({ taskID })
      else if (input.operation === "complete_task") yield* orchestration.setTaskStatus({ id: taskID, status: "done" })
      else if (input.operation === "revise_task")
        return yield* orchestration.reviseTask({
          taskID,
          description: typeof args.description === "string" ? args.description : undefined,
          acceptance: args.acceptance as never,
        })
      else return yield* Effect.fail(new Error(`Unknown operation: ${input.operation}`))
      return { accepted: true }
    })
    return Service.of({ invoke })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, Orchestration.node] })
export * as OrchestrationControl from "./control"
