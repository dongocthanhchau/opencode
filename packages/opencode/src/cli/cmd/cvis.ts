import type { Argv } from "yargs"
import { Cause, Effect } from "effect"
import { eq } from "drizzle-orm"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Orchestration } from "@/orchestration/service"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MemoryFactTable, MemoryItemTable } from "@opencode-ai/core/session/sql"

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
      .command(CvisBudgetExtendCommand)
      .command(CvisTemplateCreateCommand)
      .command(CvisTemplateListCommand)
      .command(CvisTemplateStatusCommand)
      .command(CvisTemplateRolloutCommand)
      .command(CvisTemplateMetricsCommand)
      .command(CvisTemplateRenderCommand)
      .command(CvisContextPackCommand)
      .command(CvisHandoffCommand)
      .command(CvisReuseCheckCommand)
      .command(CvisCleanPreviewCommand)
      .command(CvisSnapshotCommand)
      .command(CvisTaskDetailCommand)
      .command(CvisMessageSendCommand)
      .command(CvisMessageAckCommand)
      .command(CvisEventsCommand)
      .command(CvisRulesetCommand)
      .command(CvisScopeCheckCommand)
      .command(CvisScopeResolveCommand)
      .command(CvisManagedRegisterCommand)
      .command(CvisManagedGetCommand)
      .command(CvisManagedListCommand)
      .command(CvisManagedLinkCommand)
      .command(CvisManagedStatusCommand)
      .command(CvisManagedMetadataCommand)
      .command(CvisPluginInstallCommand)
      .command(CvisPluginImportSkillCommand)
      .command(CvisPluginExportSkillCommand)
      .command(CvisScheduleRegisterCommand)
      .command(CvisScheduleListCommand)
      .command(CvisScheduleTickCommand)
      .command(CvisScheduleCompleteCommand)
      .command(CvisScheduleEnableCommand)
      .command(CvisManagedDoctorCommand)
      .command(CvisTaskSweepCommand)
      .command(CvisExecCommand)
      .command(CvisTaskRemindCommand)
      .command(CvisTaskReportCommand)
      .command(CvisTaskEventsCommand)
      .command(CvisSessionSpawnCommand)
      .command(CvisCapProposeCommand)
      .command(CvisCapStatusCommand)
      .command(CvisCapListCommand)
      .command(CvisMcpProbeCommand)
      .command(CvisHarnessAnalyzeCommand)
      .command(CvisHarnessApplyCommand)
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
      .option("dep", { type: "string" })
      .option("acceptance", { type: "string", describe: "checklist as JSON [{id,label,weight}]" }),
  handler: Effect.fn("Cli.cvis.taskCreate")(function* (args) {
    const svc = yield* Orchestration.Service
    let acceptance: { id: string; label: string; weight: number }[] | undefined
    if (typeof args.acceptance === "string") {
      try {
        acceptance = JSON.parse(args.acceptance) as { id: string; label: string; weight: number }[]
      } catch {
        return yield* fail("acceptance must be JSON")
      }
    }
    const out = yield* run(svc
      .createTask({
        projectID: args.project as string,
        goalID: (args.goal as string | undefined) ?? undefined,
        dependencies: args.dep ? (args.dep as string).split(",").map((s) => s.trim()).filter((s) => s.length > 0) : undefined,
        title: args.title as string,
        description: (args.description as string | undefined) ?? undefined,
        acceptance,
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

export const CvisBudgetExtendCommand = effectCmd({
  command: "budget-extend <kind> <id>",
  describe: "step up a goal/task budget cap when work is live (files approval inbox past the ceiling)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("kind", { type: "string", demandOption: true, choices: ["goal", "task"] })
      .positional("id", { type: "string", demandOption: true })
      .option("session", { type: "string", demandOption: true, describe: "bound participant requesting" }),
  handler: Effect.fn("Cli.cvis.budgetExtend")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.requestBudgetExtension({
        kind: args.kind as "goal" | "task",
        id: args.id as string,
        actorSessionID: args.session as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTemplateCreateCommand = effectCmd({
  command: "template-create <name>",
  describe: "create a versioned prompt template",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("role", { type: "string" })
      .option("body", { type: "string", demandOption: true })
      .option("inputs", { type: "string", describe: "inputs as JSON" })
      .option("status", { type: "string", describe: "stable or canary (default stable)" }),
  handler: Effect.fn("Cli.cvis.templateCreate")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.createTemplate({
        name: args.name as string,
        role: (args.role as string | undefined) ?? undefined,
        body: args.body as string,
        inputs: args.inputs ? (JSON.parse(args.inputs as string) as { name: string; required: boolean }[]) : undefined,
        status: (args.status as string | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTemplateListCommand = effectCmd({
  command: "template-list",
  describe: "list prompt templates (latest version per name)",
  instance: false,
  builder: (yargs) => yargs.option("role", { type: "string" }),
  handler: Effect.fn("Cli.cvis.templateList")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc.listTemplates({ role: (args.role as string | undefined) ?? undefined }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTemplateStatusCommand = effectCmd({
  command: "template-status <name> <version> <status>",
  describe: "promote a canary (stable), retire a version, or send back to canary",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .positional("version", { type: "number", demandOption: true })
      .positional("status", { type: "string", demandOption: true, choices: ["stable", "canary", "retired"] })
      .option("session", { type: "string", demandOption: true, describe: "manager approving" }),
  handler: Effect.fn("Cli.cvis.templateStatus")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.setTemplateStatus({
        name: args.name as string,
        version: args.version as number,
        status: args.status as string,
        actorSessionID: args.session as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTemplateRolloutCommand = effectCmd({
  command: "template-rollout <name> <version>",
  describe: "set the rollout percent (0-100) of a canary template version",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .positional("version", { type: "number", demandOption: true })
      .option("pct", { type: "number", demandOption: true })
      .option("session", { type: "string", demandOption: true, describe: "manager approving" }),
  handler: Effect.fn("Cli.cvis.templateRollout")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.setTemplateRollout({
        name: args.name as string,
        version: args.version as number,
        pct: args.pct as number,
        actorSessionID: args.session as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTemplateMetricsCommand = effectCmd({
  command: "template-metrics <name>",
  describe: "per-version runs, pass rate, and avg tokens for a template",
  instance: false,
  builder: (yargs) => yargs.positional("name", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.templateMetrics")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc.templateMetrics({ name: args.name as string }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTemplateRenderCommand = effectCmd({
  command: "template-render <name>",
  describe: "render a prompt template with variables",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("var", { type: "string", array: true, describe: "name=value pairs" }),
  handler: Effect.fn("Cli.cvis.templateRender")(function* (args) {
    const svc = yield* Orchestration.Service
    const vars: Record<string, string> = {}
    for (const pair of (args.var as string[] | undefined) ?? []) {
      const at = pair.indexOf("=")
      if (at > 0) vars[pair.slice(0, at)] = pair.slice(at + 1)
    }
    const out = yield* run(svc.renderTemplate({ name: args.name as string, vars }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisContextPackCommand = effectCmd({
  command: "context-pack <task>",
  describe: "assemble goal, task, runs, and messages for prompt injection",
  instance: false,
  builder: (yargs) => yargs.positional("task", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.contextPack")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc.contextPack({ taskID: args.task as string }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisHandoffCommand = effectCmd({
  command: "handoff <session>",
  describe: "compact brief for continuing work in another session",
  instance: false,
  builder: (yargs) => yargs.positional("session", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.handoff")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc.handoffBrief({ sessionID: args.session as string }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisReuseCheckCommand = effectCmd({
  command: "reuse-check",
  describe: "check whether a session can take a task without contamination",
  instance: false,
  builder: (yargs) =>
    yargs.option("session", { type: "string", demandOption: true }).option("task", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.reuseCheck")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc.reuseCheck({ sessionID: args.session as string, taskID: args.task as string }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisCleanPreviewCommand = effectCmd({
  command: "clean-preview",
  describe: "list idle unbound sessions older than a cutoff (no deletion)",
  instance: false,
  builder: (yargs) =>
    projectOption(yargs).option("days", { type: "number", default: 30 }),
  handler: Effect.fn("Cli.cvis.cleanPreview")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.cleanCandidates({ projectID: args.project as string, idleDays: (args.days as number | undefined) ?? 30 }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisSnapshotCommand = effectCmd({
  command: "snapshot",
  describe: "project overview for kanban: goals, status columns, bindings, event cursor",
  instance: false,
  builder: (yargs) => projectOption(yargs),
  handler: Effect.fn("Cli.cvis.snapshot")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc.projectSnapshot({ projectID: args.project as string }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTaskDetailCommand = effectCmd({
  command: "task-detail <id>",
  describe: "full task detail: progress, runs, checks, messages, events",
  instance: false,
  builder: (yargs) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.taskDetail")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(svc.taskDetail({ taskID: args.id as string }))
    UI.println(JSON.stringify(out))
  }),
})

export const CvisManagedRegisterCommand = effectCmd({
  command: "managed-register <slug>",
  describe: "register a stable managed project identity (idempotent on slug)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("slug", { type: "string", demandOption: true })
      .option("type", { type: "string" })
      .option("owner", { type: "string" })
      .option("mission", { type: "string" }),
  handler: Effect.fn("Cli.cvis.managedRegister")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.registerManagedProject({
        slug: args.slug as string,
        type: (args.type as string | undefined) ?? undefined,
        owner: (args.owner as string | undefined) ?? undefined,
        mission: (args.mission as string | undefined) ?? undefined,
      }),
    )
    UI.println(out.id)
  }),
})

export const CvisManagedGetCommand = effectCmd({
  command: "managed-get",
  describe: "show a managed project by id or slug",
  instance: false,
  builder: (yargs) => yargs.option("id", { type: "string" }).option("slug", { type: "string" }),
  handler: Effect.fn("Cli.cvis.managedGet")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.getManagedProject({
        id: (args.id as string | undefined) ?? undefined,
        slug: (args.slug as string | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisManagedListCommand = effectCmd({
  command: "managed-list",
  describe: "list managed projects, optionally filtered by status",
  instance: false,
  builder: (yargs) => yargs.option("status", { type: "string" }),
  handler: Effect.fn("Cli.cvis.managedList")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.listManagedProjects({ status: (args.status as string | undefined) ?? undefined }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisManagedLinkCommand = effectCmd({
  command: "managed-link <id> <native>",
  describe: "link a managed project to a native project row (one native per managed identity)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("native", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.managedLink")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* run(svc.linkManagedProject({ id: args.id as string, nativeProjectID: args.native as string }))
    UI.println("ok")
  }),
})

export const CvisManagedStatusCommand = effectCmd({
  command: "managed-status <id> <status>",
  describe: "transition a managed project through planning/ready/active/paused/completed/archived",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("status", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.managedStatus")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* run(svc.setManagedProjectStatus({ id: args.id as string, status: args.status as string }))
    UI.println("ok")
  }),
})

export const CvisManagedMetadataCommand = effectCmd({
  command: "managed-metadata",
  describe: "merge metadata on a managed project (manager of the linked project only)",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("id", { type: "string" })
      .option("slug", { type: "string" })
      .option("metadata", { type: "string", demandOption: true, describe: "merge object as JSON" })
      .option("session", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.managedMetadata")(function* (args) {
    const svc = yield* Orchestration.Service
    let metadata: Record<string, unknown>
    try {
      metadata = JSON.parse(args.metadata as string) as Record<string, unknown>
    } catch {
      return yield* fail("metadata must be JSON")
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return yield* fail("metadata must be a JSON object")
    const out = yield* run(
      svc.setManagedMetadata({
        id: (args.id as string | undefined) ?? undefined,
        slug: (args.slug as string | undefined) ?? undefined,
        metadata,
        actorSessionID: args.session as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisPluginInstallCommand = effectCmd({
  command: "plugin-install",
  describe: "validate a plugin manifest and route it to the registry/template flows",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("project", { type: "string", demandOption: true })
      .option("manifest", { type: "string", demandOption: true, describe: "manifest as JSON" })
      .option("session", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.pluginInstall")(function* (args) {
    const svc = yield* Orchestration.Service
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(args.manifest as string) as Record<string, unknown>
    } catch {
      return yield* fail("manifest must be JSON")
    }
    const out = yield* run(
      svc.installPlugin({
        projectID: args.project as string,
        manifest,
        actorSessionID: args.session as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisPluginImportSkillCommand = effectCmd({
  command: "plugin-import-skill",
  describe: "import a SKILL.md directory (agentskills.io) as a proposed skill",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("project", { type: "string", demandOption: true })
      .option("dir", { type: "string", demandOption: true, describe: "directory inside the project worktree" })
      .option("session", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.pluginImportSkill")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.importSkillDir({
        projectID: args.project as string,
        dir: args.dir as string,
        actorSessionID: args.session as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisPluginExportSkillCommand = effectCmd({
  command: "plugin-export-skill <id>",
  describe: "export an active skill capability to SKILL.md (manager only, no overwrite)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("dir", { type: "string", demandOption: true, describe: "directory inside the project worktree" })
      .option("session", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.pluginExportSkill")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.exportSkill({
        id: args.id as string,
        dir: args.dir as string,
        actorSessionID: args.session as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisScheduleRegisterCommand = effectCmd({
  command: "schedule-register <managed> <name>",
  describe: "register a durable schedule on a managed project (idempotent on name)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("managed", { type: "string", demandOption: true })
      .positional("name", { type: "string", demandOption: true })
      .option("kind", { type: "string" })
      .option("interval", { type: "number", describe: "repeat interval in seconds" })
      .option("payload", { type: "string", describe: "payload as JSON" }),
  handler: Effect.fn("Cli.cvis.scheduleRegister")(function* (args) {
    const svc = yield* Orchestration.Service
    let payload: Record<string, unknown> | undefined
    if (typeof args.payload === "string") {
      try {
        payload = JSON.parse(args.payload) as Record<string, unknown>
      } catch {
        return yield* fail("payload must be JSON")
      }
    }
    const out = yield* run(
      svc.registerSchedule({
        managedProjectID: args.managed as string,
        name: args.name as string,
        kind: (args.kind as string | undefined) ?? undefined,
        payload,
        intervalSeconds: (args.interval as number | undefined) ?? undefined,
      }),
    )
    UI.println(out.id)
  }),
})

export const CvisScheduleListCommand = effectCmd({
  command: "schedule-list",
  describe: "list durable schedules, optionally for one managed project",
  instance: false,
  builder: (yargs) => yargs.option("managed", { type: "string" }),
  handler: Effect.fn("Cli.cvis.scheduleList")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.listSchedules({ managedProjectID: (args.managed as string | undefined) ?? undefined }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisScheduleTickCommand = effectCmd({
  command: "schedule-tick",
  describe: "claim the oldest due schedule for an owner (single winner per lease)",
  instance: false,
  builder: (yargs) =>
    yargs.option("owner", { type: "string", demandOption: true }).option("lease", { type: "number", describe: "lease in milliseconds" }),
  handler: Effect.fn("Cli.cvis.scheduleTick")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.claimDueSchedule({
        owner: args.owner as string,
        leaseMs: (args.lease as number | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out ?? null))
  }),
})

export const CvisScheduleCompleteCommand = effectCmd({
  command: "schedule-complete <id>",
  describe: "record a claimed schedule run as ok or failed and release its lease",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("owner", { type: "string", demandOption: true })
      .option("status", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.scheduleComplete")(function* (args) {
    const svc = yield* Orchestration.Service
    yield* run(
      svc.completeScheduleRun({
        id: args.id as string,
        owner: args.owner as string,
        status: args.status as string,
      }),
    )
    UI.println("ok")
  }),
})

export const CvisScheduleEnableCommand = effectCmd({
  command: "schedule-enable <id> <on>",
  describe: "enable (on=true) or disable (on=false) a schedule",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("on", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.scheduleEnable")(function* (args) {
    const svc = yield* Orchestration.Service
    const on = args.on as string
    if (on !== "true" && on !== "false") return yield* fail("on must be true or false")
    yield* run(svc.setScheduleEnabled({ id: args.id as string, enabled: on === "true" }))
    UI.println("ok")
  }),
})

export const CvisManagedDoctorCommand = effectCmd({
  command: "managed-doctor",
  describe: "read-only admission check for a managed project: identity, native link, manager, goals, schedules, memory",
  instance: false,
  builder: (yargs) => yargs.option("id", { type: "string" }).option("slug", { type: "string" }),
  handler: Effect.fn("Cli.cvis.managedDoctor")(function* (args) {
    const svc = yield* Orchestration.Service
    const { db } = yield* Database.Service
    const managed = yield* run(
      svc.getManagedProject({
        id: (args.id as string | undefined) ?? undefined,
        slug: (args.slug as string | undefined) ?? undefined,
      }),
    )
    const issues: string[] = []
    const nativeID = managed.native_project_id
    if (!nativeID) issues.push("native-unlinked")
    let goals: { status: string }[] = []
    let bindings: { role: string; status: string }[] = []
    if (nativeID) {
      const native = yield* db
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, ProjectV2.ID.make(nativeID)))
        .get()
        .pipe(Effect.orDie)
      if (!native) {
        issues.push("native-missing")
      } else {
        const snapshot = yield* run(svc.projectSnapshot({ projectID: nativeID }))
        goals = (snapshot.goals ?? []) as { status: string }[]
        bindings = (snapshot.bindings ?? []) as { role: string; status: string }[]
      }
    }
    if (nativeID && !bindings.some((b) => b.role === "manager")) issues.push("no-manager-binding")
    if (nativeID && !goals.some((g) => g.status === "active")) issues.push("no-active-goal")
    const schedules = (yield* run(svc.listSchedules({}))) as {
      managed_project_id: string
      consecutive_failures: number
      lease_expires: number | null
      last_run_at: number | null
    }[]
    const own = schedules.filter((s) => s.managed_project_id === managed.id)
    if (own.some((s) => s.consecutive_failures > 0)) issues.push("schedule-failing")
    if (own.some((s) => s.lease_expires != null && s.lease_expires <= Date.now())) issues.push("schedule-lease-stale")
    let facts = 0
    let items = 0
    if (nativeID) {
      const factRows = yield* db
        .select({ id: MemoryFactTable.id })
        .from(MemoryFactTable)
        .where(eq(MemoryFactTable.project_id, ProjectV2.ID.make(nativeID)))
        .all()
        .pipe(Effect.orDie)
      const itemRows = yield* db
        .select({ id: MemoryItemTable.id })
        .from(MemoryItemTable)
        .where(eq(MemoryItemTable.project_id, ProjectV2.ID.make(nativeID)))
        .all()
        .pipe(Effect.orDie)
      facts = factRows.length
      items = itemRows.length
    }
    UI.println(
      JSON.stringify({
        managed: { id: managed.id, slug: managed.slug, type: managed.type, status: managed.status, native_project_id: nativeID },
        goals: { total: goals.length, active: goals.filter((g) => g.status === "active").length },
        bindings: { total: bindings.length, manager: bindings.some((b) => b.role === "manager") },
        schedules: { total: own.length, failing: own.filter((s) => s.consecutive_failures > 0).length },
        memory: { facts, items },
        issues,
      }),
    )
  }),
})

export const CvisTaskSweepCommand = effectCmd({
  command: "task-sweep",
  describe: "pause running tasks whose worker session is archived, missing, or never assigned",
  instance: false,
  builder: (yargs) => yargs.option("project", { type: "string" }),
  handler: Effect.fn("Cli.cvis.taskSweep")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.sweepOrphanedTasks({ projectID: (args.project as string | undefined) ?? undefined }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisExecCommand = effectCmd({
  command: "exec <task>",
  describe: "run exactly one task-allowlisted command for a bound worker session and print its receipt",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("task", { type: "string", demandOption: true })
      .option("session", { type: "string", demandOption: true })
      .option("command", { type: "string", demandOption: true })
      .option("timeout-ms", { type: "number" }),
  handler: Effect.fn("Cli.cvis.exec")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.runCheckCommand({
        taskID: args.task as string,
        sessionID: args.session as string,
        command: args.command as string,
        timeoutMs: (args["timeout-ms"] as number | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTaskRemindCommand = effectCmd({
  command: "task-remind <task>",
  describe: "record a reminder event on any open task (participant or project manager)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("task", { type: "string", demandOption: true })
      .option("session", { type: "string", demandOption: true })
      .option("note", { type: "string" }),
  handler: Effect.fn("Cli.cvis.taskRemind")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.remindTask({
        taskID: args.task as string,
        sessionID: args.session as string,
        note: (args.note as string | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTaskReportCommand = effectCmd({
  command: "task-report <task>",
  describe: "record a progress report event from the bound worker of a running task",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("task", { type: "string", demandOption: true })
      .option("session", { type: "string", demandOption: true })
      .option("text", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.cvis.taskReport")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.reportTask({
        taskID: args.task as string,
        sessionID: args.session as string,
        text: args.text as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisTaskEventsCommand = effectCmd({
  command: "task-events <task>",
  describe: "list reminder/report (and other) events for one task, oldest first",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("task", { type: "string", demandOption: true })
      .option("session", { type: "string", demandOption: true })
      .option("limit", { type: "number" }),
  handler: Effect.fn("Cli.cvis.taskEvents")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.listTaskEvents({
        taskID: args.task as string,
        sessionID: args.session as string,
        limit: (args.limit as number | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisSessionSpawnCommand = effectCmd({
  command: "session-spawn",
  describe: "spawn a worker session inside a project worktree (manager only, live-session cap enforced)",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("project", { type: "string", demandOption: true })
      .option("actor", { type: "string", demandOption: true, describe: "manager session spawning" })
      .option("role", { type: "string" })
      .option("task", { type: "string" })
      .option("directory", { type: "string", describe: "subdir inside the project worktree" })
      .option("title", { type: "string" }),
  handler: Effect.fn("Cli.cvis.sessionSpawn")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.spawnSession({
        projectID: args.project as string,
        actorSessionID: args.actor as string,
        role: (args.role as "manager" | "researcher" | "implementer" | "verifier" | "maintenance" | undefined) ?? undefined,
        taskID: (args.task as string | undefined) ?? undefined,
        directory: (args.directory as string | undefined) ?? undefined,
        title: (args.title as string | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisCapProposeCommand = effectCmd({
  command: "cap-propose",
  describe: "propose a tool/skill/MCP capability for a project (any bound participant)",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("project", { type: "string", demandOption: true })
      .option("kind", { type: "string", demandOption: true, choices: ["tool", "skill", "mcp"] })
      .option("name", { type: "string", demandOption: true })
      .option("description", { type: "string", demandOption: true })
      .option("source", { type: "string" })
      .option("payload", { type: "string", describe: "install payload as JSON" })
      .option("reason", { type: "string" })
      .option("session", { type: "string", demandOption: true, describe: "proposing session" }),
  handler: Effect.fn("Cli.cvis.capPropose")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.proposeCapability({
        projectID: args.project as string,
        kind: args.kind as string,
        name: args.name as string,
        description: args.description as string,
        source: (args.source as string | undefined) ?? undefined,
        installPayload: args.payload ? (JSON.parse(args.payload as string) as Record<string, unknown>) : undefined,
        reason: (args.reason as string | undefined) ?? undefined,
        actorSessionID: args.session as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisCapStatusCommand = effectCmd({
  command: "cap-status <id> <status>",
  describe: "move a capability proposed->canary->active->deprecated (manager only)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("status", { type: "string", demandOption: true, choices: ["canary", "active", "deprecated"] })
      .option("session", { type: "string", demandOption: true, describe: "manager approving" }),
  handler: Effect.fn("Cli.cvis.capStatus")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.setCapabilityStatus({
        id: args.id as string,
        status: args.status as string,
        actorSessionID: args.session as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisCapListCommand = effectCmd({
  command: "cap-list",
  describe: "list capabilities of a project, optionally filtered",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("project", { type: "string", demandOption: true })
      .option("kind", { type: "string" })
      .option("status", { type: "string" }),
  handler: Effect.fn("Cli.cvis.capList")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.listCapabilities({
        projectID: args.project as string,
        kind: (args.kind as string | undefined) ?? undefined,
        status: (args.status as string | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisMcpProbeCommand = effectCmd({
  command: "mcp-probe <id>",
  describe: "live MCP handshake for a canary capability (records capability.probed)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("session", { type: "string", demandOption: true, describe: "bound participant probing" })
      .option("timeout-ms", { type: "number" }),
  handler: Effect.fn("Cli.cvis.mcpProbe")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.probeMcpCapability({
        id: args.id as string,
        actorSessionID: args.session as string,
        timeoutMs: (args["timeout-ms"] as number | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisHarnessAnalyzeCommand = effectCmd({
  command: "harness-analyze",
  describe: "analyze execution traces and file machine-checkable findings",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("project", { type: "string", demandOption: true })
      .option("session", { type: "string", demandOption: true })
      .option("window-ms", { type: "number" })
      .option("stall-ms", { type: "number" }),
  handler: Effect.fn("Cli.cvis.harnessAnalyze")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.analyzeTraces({
        projectID: args.project as string,
        actorSessionID: args.session as string,
        windowMs: (args["window-ms"] as number | undefined) ?? undefined,
        stallMs: (args["stall-ms"] as number | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const CvisHarnessApplyCommand = effectCmd({
  command: "harness-apply <event>",
  describe: "approve (and execute) or reject a harness finding (manager only)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("event", { type: "string", demandOption: true })
      .option("session", { type: "string", demandOption: true })
      .option("reject", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.cvis.harnessApply")(function* (args) {
    const svc = yield* Orchestration.Service
    const out = yield* run(
      svc.applyFinding({
        findingEventID: args.event as string,
        actorSessionID: args.session as string,
        approve: !(args.reject as boolean),
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})
