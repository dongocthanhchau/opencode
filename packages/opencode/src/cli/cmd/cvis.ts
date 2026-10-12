import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { CliError, effectCmd } from "../effect-cmd"
import { UI } from "../ui"
import { Orchestration } from "@/orchestration/service"

export const CvisCommand = cmd({
  command: "cvis",
  describe: "manage CVIS orchestration state (goals, tasks, runs, bindings, messages, events)",
  builder: (yargs: Argv) =>
    yargs
      .command(CvisGoalCreateCommand)
      .command(CvisGoalStatusCommand)
      .command(CvisTaskCreateCommand)
      .command(CvisTaskStatusCommand)
      .command(CvisTaskListCommand)
      .command(CvisRunStartCommand)
      .command(CvisRunStatusCommand)
      .command(CvisBindingSetCommand)
      .command(CvisMessageSendCommand)
      .command(CvisMessageAckCommand)
      .command(CvisEventsCommand)
      .demandCommand(),
  async handler() {},
})

function domainError(cause: unknown): CliError {
  const message =
    cause !== null && typeof cause === "object" && "message" in cause && typeof cause.message === "string"
      ? cause.message
      : String(cause)
  return new CliError({ message })
}

const projectOption = (yargs: Argv) =>
  yargs.option("project", { describe: "project ID", type: "string", demandOption: true })

export const CvisGoalCreateCommand = effectCmd({
  command: "goal-create",
  describe: "create a project goal",
  instance: false,
  builder: (yargs) =>
    projectOption(yargs)
      .option("title", { type: "string", demandOption: true })
      .option("objective", { type: "string", demandOption: true })
      .option("budget", { type: "number" }),
  handler: Effect.fn("Cli.cvis.goalCreate")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* svc
      .createGoal({ projectID: args.project as string, title: args.title as string, objective: args.objective as string, budgetTokens: args.budget as number | undefined })
      .pipe(Effect.mapError(domainError))
    UI.println(out.id)
  }),
})

export const CvisGoalStatusCommand = effectCmd({
  command: "goal-status <id> <status>",
  describe: "transition a project goal",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("status", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.goalStatus")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* svc
      .setGoalStatus({ id: args.id as string, status: args.status as never })
      .pipe(Effect.mapError(domainError))
    UI.println("ok")
  }),
})

export const CvisTaskCreateCommand = effectCmd({
  command: "task-create",
  describe: "create a task",
  instance: false,
  builder: (yargs) =>
    projectOption(yargs)
      .option("title", { type: "string", demandOption: true })
      .option("role", { type: "string", demandOption: true })
      .option("goal", { type: "string" })
      .option("description", { type: "string" })
      .option("dep", { type: "string" }),
  handler: Effect.fn("Cli.cvis.taskCreate")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* svc
      .createTask({
        projectID: args.project as string,
        goalID: (args.goal as string | undefined) ?? undefined,
        dependencies: args.dep ? (args.dep as string).split(",").map((s) => s.trim()).filter((s) => s.length > 0) : undefined,
        title: args.title as string,
        description: (args.description as string | undefined) ?? undefined,
        role: args.role as never,
      })
      .pipe(Effect.mapError(domainError))
    UI.println(out.id)
  }),
})

export const CvisTaskStatusCommand = effectCmd({
  command: "task-status <id> <status>",
  describe: "transition a task",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("status", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.taskStatus")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* svc
      .setTaskStatus({ id: args.id as string, status: args.status as never })
      .pipe(Effect.mapError(domainError))
    UI.println("ok")
  }),
})

export const CvisTaskListCommand = effectCmd({
  command: "task-list",
  describe: "list tasks for kanban/task views (reads durable state)",
  instance: false,
  builder: (yargs) => projectOption(yargs).option("status", { type: "string" }),
  handler: Effect.fn("Cli.cvis.taskList")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* svc
      .listTasks({ projectID: args.project as string, status: args.status as never })
      .pipe(Effect.mapError(domainError))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisRunStartCommand = effectCmd({
  command: "run-start <task> <session>",
  describe: "start a task run",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("task", { type: "string", demandOption: true })
      .positional("session", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.runStart")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* svc
      .startRun({ taskID: args.task as string, sessionID: args.session as string })
      .pipe(Effect.mapError(domainError))
    UI.println(`${out.id} attempt=${out.attempt}`)
  }),
})

export const CvisRunStatusCommand = effectCmd({
  command: "run-status <id> <status>",
  describe: "transition a task run",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("status", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.runStatus")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* svc
      .setRunStatus({ id: args.id as string, status: args.status as never })
      .pipe(Effect.mapError(domainError))
    UI.println("ok")
  }),
})

export const CvisBindingSetCommand = effectCmd({
  command: "binding-set <session> <role>",
  describe: "bind a session to a role",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("session", { type: "string", demandOption: true })
      .positional("role", { type: "string", demandOption: true })
      .option("project", { type: "string", demandOption: true })
      .option("task", { type: "string" }),
  handler: Effect.fn("Cli.cvis.bindingSet")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* svc
      .bindSession({
        sessionID: args.session as string,
        projectID: args.project as string,
        role: args.role as never,
        taskID: (args.task as string | undefined) ?? undefined,
      })
      .pipe(Effect.mapError(domainError))
    UI.println("ok")
  }),
})

export const CvisMessageSendCommand = effectCmd({
  command: "message-send",
  describe: "send an orchestration message",
  instance: false,
  builder: (yargs) =>
    projectOption(yargs)
      .option("from", { type: "string", demandOption: true })
      .option("kind", { type: "string", demandOption: true })
      .option("to", { type: "string" })
      .option("task", { type: "string" })
      .option("body", { type: "string" }),
  handler: Effect.fn("Cli.cvis.messageSend")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* svc
      .sendMessage({
        projectID: args.project as string,
        fromSession: args.from as string,
        toSession: (args.to as string | undefined) ?? undefined,
        taskID: (args.task as string | undefined) ?? undefined,
        kind: args.kind as never,
        body: args.body ? (JSON.parse(args.body as string) as Record<string, unknown>) : undefined,
      })
      .pipe(Effect.mapError(domainError))
    UI.println(out.id)
  }),
})

export const CvisMessageAckCommand = effectCmd({
  command: "message-ack <id>",
  describe: "acknowledge a message",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.messageAck")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* svc.ackMessage({ id: args.id as string }).pipe(Effect.mapError(domainError))
    UI.println("ok")
  }),
})

export const CvisEventsCommand = effectCmd({
  command: "events",
  describe: "list orchestration events for a project (cursor stream for UI)",
  instance: false,
  builder: (yargs) => projectOption(yargs).option("cursor", { type: "number" }).option("limit", { type: "number" }),
  handler: Effect.fn("Cli.cvis.events")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* svc
      .listEvents({
        projectID: args.project as string,
        cursor: (args.cursor as number | undefined) ?? undefined,
        limit: (args.limit as number | undefined) ?? undefined,
      })
      .pipe(Effect.mapError(domainError))
    UI.println(JSON.stringify(out))
  }),
})
