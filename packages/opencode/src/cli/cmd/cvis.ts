import type { Argv } from "yargs"
import { Cause, Effect } from "effect"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
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
      .command(CvisBindingStatusCommand)
      .command(CvisTaskClaimCommand)
      .command(CvisTaskPauseCommand)
      .command(CvisTaskCancelCommand)
      .command(CvisRunSubmitCommand)
      .command(CvisInboxCommand)
      .command(CvisCheckVerifyCommand)
      .command(CvisTaskProgressCommand)
      .command(CvisGoalProgressCommand)
      .command(CvisTaskReviseCommand)
      .command(CvisBudgetCommand)
      .command(CvisMessageSendCommand)
      .command(CvisMessageAckCommand)
      .command(CvisEventsCommand)
      .command(CvisRulesetCommand)
      .command(CvisScopeCheckCommand)
      .command(CvisScopeResolveCommand)
      .demandCommand(),
  async handler() {},
})

// Run a service effect, turning any failure into a printed CliError.
// (Piping mapError here swallows output on this Effect version; the
// exit+fail path below is verified to print and exit non-zero.)
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function prettyCause(cause: unknown): string {
  const failure = Cause.squash(cause as never)
  if (isRecord(failure) && typeof failure._tag === "string") {
    if (failure._tag === "CvisNotFound") return `${String(failure["entity"])} not found: ${String(failure["id"])}`
    if (failure._tag === "CvisInvalidTransition") {
      return `invalid ${String(failure["entity"])} transition ${String(failure["id"])}: ${String(failure["from"])} -> ${String(failure["to"])}`
    }
    if (failure._tag === "CvisConflict") {
      return `conflict ${String(failure["entity"])} ${String(failure["id"])}: ${String(failure["reason"])}`
    }
  }
  return Cause.pretty(cause as never)
}

function run<A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, CliError> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (exit._tag === "Failure") {
      return yield* fail(`cvis failed: ${prettyCause(exit.cause)}`)
    }
    return exit.value
  }) as Effect.Effect<A, CliError>
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
    const out = yield* run(svc
      .createGoal({ projectID: args.project as string, title: args.title as string, objective: args.objective as string, budgetTokens: args.budget as number | undefined }))
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
    yield* run(svc
      .setGoalStatus({ id: args.id as string, status: args.status as never }))
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
    const out = yield* run(svc
      .createTask({
        projectID: args.project as string,
        goalID: (args.goal as string | undefined) ?? undefined,
        dependencies: args.dep ? (args.dep as string).split(",").map((s) => s.trim()).filter((s) => s.length > 0) : undefined,
        title: args.title as string,
        description: (args.description as string | undefined) ?? undefined,
        role: args.role as never,
}))
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
    yield* run(svc
      .setTaskStatus({ id: args.id as string, status: args.status as never }))
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
    const out = yield* run(svc
      .listTasks({ projectID: args.project as string, status: args.status as never }))
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
    const out = yield* run(svc
      .startRun({ taskID: args.task as string, sessionID: args.session as string }))
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
    yield* run(svc
      .setRunStatus({ id: args.id as string, status: args.status as never }))
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
    yield* run(svc
      .bindSession({
        sessionID: args.session as string,
        projectID: args.project as string,
        role: args.role as never,
        taskID: (args.task as string | undefined) ?? undefined,
}))
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
    const out = yield* run(svc
      .sendMessage({
        projectID: args.project as string,
        fromSession: args.from as string,
        toSession: (args.to as string | undefined) ?? undefined,
        taskID: (args.task as string | undefined) ?? undefined,
        kind: args.kind as never,
        body: args.body ? (JSON.parse(args.body as string) as Record<string, unknown>) : undefined,
}))
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
    yield* run(svc.ackMessage({ id: args.id as string }))
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
    const out = yield* run(svc
      .listEvents({
        projectID: args.project as string,
        cursor: (args.cursor as number | undefined) ?? undefined,
        limit: (args.limit as number | undefined) ?? undefined,
}))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisRulesetCommand = effectCmd({
  command: "ruleset <role>",
  describe: "compute the effective session ruleset for a role and task scope",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("role", { type: "string", demandOption: true })
      .option("scope", { type: "string", describe: "task scope as JSON" })
      .option("project-rules", { type: "string", describe: "project grant ruleset as JSON" }),
  handler: Effect.fn("Cli.cvis.ruleset")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc
      .buildRuleset({
        role: args.role as never,
        scope: args.scope ? (JSON.parse(args.scope as string) as never) : undefined,
        projectRules: args["project-rules"] ? (JSON.parse(args["project-rules"] as string) as never) : undefined,
}))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisScopeCheckCommand = effectCmd({
  command: "scope-check",
  describe: "validate a task scope against worktree and project denies",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("scope", { type: "string", demandOption: true, describe: "task scope as JSON" })
      .option("worktree", { type: "string" })
      .option("denies", { type: "string", describe: "project deny paths as JSON array" }),
  handler: Effect.fn("Cli.cvis.scopeCheck")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc
      .checkScope({
        scope: JSON.parse(args.scope as string) as never,
        worktree: (args.worktree as string | undefined) ?? undefined,
        projectDenies: args.denies ? (JSON.parse(args.denies as string) as string[]) : undefined,
}))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisScopeResolveCommand = effectCmd({
  command: "scope-resolve",
  describe: "resolve scope paths through symlinks and report escapes",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("worktree", { type: "string", demandOption: true })
      .option("path", { type: "string", array: true, demandOption: true }),
  handler: Effect.fn("Cli.cvis.scopeResolve")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc
      .resolveScope({ worktree: args.worktree as string, paths: args.path as string[] }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisBindingStatusCommand = effectCmd({
  command: "binding-status <session> <status>",
  describe: "transition a session binding (idle/busy/paused)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("session", { type: "string", demandOption: true })
      .positional("status", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.bindingStatus")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* run(svc
      .setBindingStatus({ sessionID: args.session as string, status: args.status as never }))
    UI.println("ok")
  }),
})

export const CvisTaskClaimCommand = effectCmd({
  command: "task-claim <task> <session>",
  describe: "claim a queued task for a session (validates deps, scope, conflicts)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("task", { type: "string", demandOption: true })
      .positional("session", { type: "string", demandOption: true })
      .option("denies", { type: "string", describe: "project deny paths as JSON array" }),
  handler: Effect.fn("Cli.cvis.taskClaim")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc
      .claimTask({
        taskID: args.task as string,
        sessionID: args.session as string,
        projectDenies: args.denies ? (JSON.parse(args.denies as string) as string[]) : undefined,
}))
    UI.println(`${out.runID} attempt=${out.attempt}`)
  }),
})

export const CvisTaskPauseCommand = effectCmd({
  command: "task-pause <id>",
  describe: "pause a task and cancel its active run",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.taskPause")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* run(svc.pauseTask({ taskID: args.id as string }))
    UI.println("ok")
  }),
})

export const CvisTaskCancelCommand = effectCmd({
  command: "task-cancel <id>",
  describe: "cancel a task and its active run",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.taskCancel")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* run(svc.cancelTask({ taskID: args.id as string }))
    UI.println("ok")
  }),
})

export const CvisRunSubmitCommand = effectCmd({
  command: "run-submit <id>",
  describe: "submit a run result for verification (late results rejected)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("result", { type: "string", describe: "result as JSON" })
      .option("tokens", { type: "number" }),
  handler: Effect.fn("Cli.cvis.runSubmit")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* run(svc
      .submitResult({
        runID: args.id as string,
        result: args.result ? (JSON.parse(args.result as string) as Record<string, unknown>) : undefined,
        tokensUsed: (args.tokens as number | undefined) ?? undefined,
}))
    UI.println("ok")
  }),
})

export const CvisInboxCommand = effectCmd({
  command: "inbox",
  describe: "list unacked messages for a session",
  instance: false,
  builder: (yargs) =>
    yargs.option("session", { type: "string", demandOption: true }).option("project", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.inbox")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc
      .inbox({ sessionID: args.session as string, projectID: args.project as string }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisCheckVerifyCommand = effectCmd({
  command: "check-verify <task> <check>",
  describe: "record a verifier verdict for a checklist item",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("task", { type: "string", demandOption: true })
      .positional("check", { type: "string", demandOption: true })
      .option("run", { type: "string" })
      .option("session", { type: "string", demandOption: true })
      .option("verdict", { type: "string", default: "pass" })
      .option("evidence", { type: "string", describe: "evidence as JSON" }),
  handler: Effect.fn("Cli.cvis.checkVerify")(function* (args) {
    const svc = yield* Orchestration.Service
    const verdict = args.verdict as string
    if (verdict !== "pass" && verdict !== "fail") {
      return yield* fail(`verdict must be pass or fail, got: ${verdict}`)
    }
    yield* run(
      svc.verifyCheck({
        taskID: args.task as string,
        checkID: args.check as string,
        runID: (args.run as string | undefined) ?? undefined,
        sessionID: args.session as string,
        verdict,
        evidence: args.evidence ? (JSON.parse(args.evidence as string) as Record<string, unknown>) : undefined,
      }),
    )
    UI.println("ok")
  }),
})

export const CvisTaskProgressCommand = effectCmd({
  command: "task-progress <id>",
  describe: "show verified checklist progress for a task",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.taskProgress")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc.taskProgress({ taskID: args.id as string }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisGoalProgressCommand = effectCmd({
  command: "goal-progress <id>",
  describe: "show aggregated progress for a project goal",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.goalProgress")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc.goalProgress({ goalID: args.id as string }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTaskReviseCommand = effectCmd({
  command: "task-revise <id>",
  describe: "revise a task (bumps revision, snapshots previous plan)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("title", { type: "string" })
      .option("description", { type: "string" })
      .option("acceptance", { type: "string", describe: "checklist as JSON" }),
  handler: Effect.fn("Cli.cvis.taskRevise")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.reviseTask({
        taskID: args.id as string,
        title: (args.title as string | undefined) ?? undefined,
        description: (args.description as string | undefined) ?? undefined,
        acceptance: args.acceptance
          ? (JSON.parse(args.acceptance as string) as { id: string; label: string; weight: number }[])
          : undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisBudgetCommand = effectCmd({
  command: "budget",
  describe: "show token spend vs cap for a goal or task",
  instance: false,
  builder: (yargs) => yargs.option("goal", { type: "string" }).option("task", { type: "string" }),
  handler: Effect.fn("Cli.cvis.budget")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.budget({
        goalID: (args.goal as string | undefined) ?? undefined,
        taskID: (args.task as string | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})
