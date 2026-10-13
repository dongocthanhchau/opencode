import { Effect, Schema } from "effect"
import { Tool } from "@/tool/tool"
import { OrchestrationControl } from "./control"

const Parameters = Schema.Struct({
  operation: Schema.Literals([
    "create_task",
    "queue_task",
    "pause_task",
    "cancel_task",
    "complete_task",
    "revise_task",
    "goal_status",
    "verify",
    "snapshot",
    "events",
    "task_detail",
    "context",
    "message",
    "inbox",
    "ack",
  ]),
  arguments: Schema.Struct({
    taskID: Schema.optional(Schema.String),
    goalID: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    role: Schema.optional(Schema.Literals(["manager", "researcher", "implementer", "verifier", "maintenance"])),
    scope: Schema.optional(
      Schema.Struct({
        read_paths: Schema.optional(Schema.Array(Schema.String)),
        write_paths: Schema.optional(Schema.Array(Schema.String)),
        tools: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
    acceptance: Schema.optional(
      Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, weight: Schema.Number })),
    ),
    checkID: Schema.optional(Schema.String),
    verdict: Schema.optional(Schema.Literals(["pass", "fail"])),
    files: Schema.optional(Schema.Array(Schema.String)),
    conclusion: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    cursor: Schema.optional(Schema.Number),
    messageID: Schema.optional(Schema.String),
    toSession: Schema.optional(Schema.String),
    kind: Schema.optional(Schema.String),
    body: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    idempotencyKey: Schema.optional(Schema.String),
  }),
})

export const ControlTool = Tool.define(
  "cvis_control",
  Effect.gen(function* () {
    const control = yield* OrchestrationControl.Service
    return {
      description:
        'Control managed project tasks. Use ONLY the documented operation names, never wrap another tool call inside arguments. Example create_task: {"operation":"create_task","arguments":{"title":"Fix issue","description":"Exact task requirements","role":"implementer","goalID":"goal_id","scope":{"read_paths":["src"],"write_paths":["src"],"tools":[]},"acceptance":[{"id":"test","label":"Actual acceptance requirement","weight":100}]}}. Then queue_task with arguments.taskID. Manager may revise_task with taskID/description, pause_task, cancel_task, complete_task, goal_status with goalID/status. Verifier: verify with taskID/checkID/verdict/files/conclusion. Use actual file paths, no fabricated evidence. Reads: snapshot, events, task_detail, context, inbox. Actor identity is enforced from the session. write/read/bash are separate tools, NEVER cvis_control operations.',
      parameters: Parameters,
      execute: (args: typeof Parameters.Type, ctx: Tool.Context) =>
        control.invoke({ actor: ctx.sessionID, operation: args.operation, args: args.arguments }).pipe(
          Effect.map((result) => ({ title: args.operation, output: JSON.stringify(result), metadata: {} })),
          Effect.orDie,
        ),
    }
  }),
)

function action(id: string, operation: string, parameters: Schema.Decoder<unknown>, description: string) {
  return Tool.define(
    id,
    Effect.gen(function* () {
      const control = yield* OrchestrationControl.Service
      return {
        description,
        parameters,
        execute: (args: unknown, ctx: Tool.Context) =>
          control.invoke({ actor: ctx.sessionID, operation, args: args as Record<string, unknown> }).pipe(
            Effect.map((result) => ({ title: operation, output: JSON.stringify(result), metadata: {} })),
            Effect.orDie,
          ),
      }
    }),
  )
}

export const ControlActions = [
  action(
    "cvis_create_task",
    "create_task",
    Schema.Struct({
      title: Schema.String,
      description: Schema.String,
      role: Schema.Literals(["implementer", "researcher", "verifier", "maintenance"]),
      goalID: Schema.String,
      scope: Schema.Struct({
        read_paths: Schema.Array(Schema.String),
        write_paths: Schema.Array(Schema.String),
        tools: Schema.Array(Schema.String),
      }),
      acceptance: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, weight: Schema.Number })),
    }),
    "Manager: create a task with exact requirements, scope and acceptance. Supply fields directly; do not nest arguments or task. Returns task ID.",
  ),
  action(
    "cvis_queue_task",
    "queue_task",
    Schema.Struct({ taskID: Schema.String }),
    "Manager: queue this task for a worker.",
  ),
  action(
    "cvis_task_detail",
    "task_detail",
    Schema.Struct({ taskID: Schema.String }),
    "Read the exact task scope, acceptance check IDs and current execution/evidence.",
  ),
  action(
    "cvis_verify",
    "verify",
    Schema.Struct({
      taskID: Schema.String,
      checkID: Schema.String,
      verdict: Schema.Literals(["pass", "fail"]),
      files: Schema.Array(Schema.String),
      conclusion: Schema.String,
    }),
    "Independent verifier: record PASS/FAIL for one acceptance check. Read the actual files first. Supply real artifact paths; runtime hashes them. Never invent test execution.",
  ),
  action(
    "cvis_revise_task",
    "revise_task",
    Schema.Struct({ taskID: Schema.String, description: Schema.String }),
    "Manager: revise requirements after a failed review. Stops old execution and invalidates old verification. Preserve scope/checklist.",
  ),
  action("cvis_snapshot", "snapshot", Schema.Struct({}), "Read project task statuses, verified progress and budgets."),
  action(
    "cvis_goal_status",
    "goal_status",
    Schema.Struct({
      goalID: Schema.String,
      status: Schema.Literals(["active", "paused", "blocked", "completed", "cancelled"]),
    }),
    "Manager: update goal state. Completed is accepted only after all required work has current evidence.",
  ),
]
