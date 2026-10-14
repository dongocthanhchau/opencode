import { Cause, Context, Effect, Layer, Schema } from "effect"
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, max, or } from "drizzle-orm"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createBudget } from "./budget"
import { parsePluginManifest, parseSkillFile, renderSkillFile } from "./plugin-manifest"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { MessageTable as SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "../session/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  CvisCapabilityTable,
  CvisCheckTable,
  CvisEventTable,
  CvisManagedProjectTable,
  CvisPromptTemplateTable,
  CvisMessageTable,
  CvisProjectGoalTable,
  CvisScheduleTable,
  CvisSessionBindingTable,
  CvisTaskRunTable,
  CvisTaskTable,
  ManagedProjectStatus,
  ManagedProjectType,
} from "@opencode-ai/core/orchestration/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
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
import { probeTransport, transportForSpec, validateMcpSpec } from "./mcp-probe"
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
    scope?: TaskScope
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
  readonly sweepOrphanedTasks: (input: {
    projectID?: string
  }) => Effect.Effect<{ paused: string[] }>
  readonly runCheckCommand: (input: {
    taskID: string
    sessionID: string
    command: string
    timeoutMs?: number
  }) => Effect.Effect<
    { command: string; exitCode: number; output: string; truncated: boolean; durationMs: number },
    NotFoundError | InvalidTransitionError | ConflictError
  >
  // Reminder/report flows ride on task events: no cron, no new tables.
  // Reminders target any open task (even unassigned); reports come from
  // the bound worker while the task is actively worked.
  readonly remindTask: (input: {
    taskID: string
    sessionID: string
    note?: string
  }) => Effect.Effect<{ taskID: string; status: string }, NotFoundError | InvalidTransitionError | ConflictError>
  readonly reportTask: (input: {
    taskID: string
    sessionID: string
    text: string
  }) => Effect.Effect<{ taskID: string; status: string }, NotFoundError | InvalidTransitionError | ConflictError>
  readonly listTaskEvents: (input: {
    taskID: string
    sessionID: string
    limit?: number
  }) => Effect.Effect<{ id: string; type: string; payload: unknown; time: number }[], NotFoundError | InvalidTransitionError>
  // Self-spawn: a project manager grows worker/verifier sessions inside the
  // project worktree without operator shell access. Spawning is a manager
  // power, directories cannot escape the worktree, and a per-project cap on
  // live sessions prevents fork bombs.
  readonly spawnSession: (input: {
    projectID: string
    actorSessionID: string
    role?: Role
    taskID?: string
    directory?: string
    title?: string
  }) => Effect.Effect<{ sessionID: string; bound: boolean }, NotFoundError | InvalidTransitionError | ConflictError>
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
    scope?: TaskScope
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
  }) => Effect.Effect<{ id: string; name: string; role: string | null; version: number; status: string }[]>
  readonly createTemplate: (input: {
    name: string
    role?: string
    body: string
    inputs?: { name: string; required: boolean }[]
    status?: string
  }) => Effect.Effect<{ id: string; version: number }, InvalidTransitionError>
  readonly renderTemplate: (input: {
    name: string
    vars: Record<string, string>
    version?: number
    bucketKey?: string
  }) => Effect.Effect<{ text: string; tokens: number; version: number; status: string }, NotFoundError | InvalidTransitionError>
  readonly setTemplateStatus: (input: {
    name: string
    version: number
    status: string
    actorSessionID: string
  }) => Effect.Effect<{ name: string; version: number; status: string }, NotFoundError | InvalidTransitionError>
  readonly setTemplateRollout: (input: {
    name: string
    version: number
    pct: number
    actorSessionID: string
  }) => Effect.Effect<{ name: string; version: number; pct: number }, NotFoundError | InvalidTransitionError>
  readonly templateMetrics: (input: {
    name: string
  }) => Effect.Effect<{ version: number; status: string; runs: number; checks: number; passRate: number | null; avgTokens: number | null }[], NotFoundError>
  readonly importPromptLibrary: (input: {
    projectID: string
    dir: string
    actorSessionID: string
  }) => Effect.Effect<{ imported: { name: string; version: number }[]; skipped: { file: string; reason: string }[] }, NotFoundError | InvalidTransitionError>
  readonly distillSkills: (input: {
    projectID: string
    actorSessionID: string
    minRepeats?: number
  }) => Effect.Effect<{ role: string; count: number; path: string }[], NotFoundError | InvalidTransitionError>
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
  readonly updateGoalBudget: (input: {
    goalID: string
    budgetTokens: number
    expectedBudget: number | null
    reason: string
    actorSessionID: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError | ConflictError>
  readonly updateTaskBudget: (input: { taskID: string; maxTokens: number; expectedMaxTokens: number | null; reason: string; actorSessionID: string }) => Effect.Effect<void, NotFoundError | InvalidTransitionError | ConflictError>
  // Budget auto-extend: a bound participant whose task is nearly done but
  // out of tokens gets stepped cap increases without operator round-trips,
  // up to a configured ceiling. Past the ceiling (or an approval cap) the
  // call files an inbox approval question to a project manager instead of
  // spending, and records every outcome as an event.
  readonly requestBudgetExtension: (input: {
    kind: "goal" | "task"
    id: string
    actorSessionID: string
    maxStaleMs?: number
  }) => Effect.Effect<{ extended: boolean; oldCap: number | null; newCap: number | null; stepsUsed: number }, NotFoundError | InvalidTransitionError | ConflictError>
  // Capability registry: agents propose tools/skills/MCP servers with a
  // mandatory description; versions flow proposed -> canary -> active ->
  // deprecated with manager approval. Approving a version retires older
  // active ones so rollback stays available.
  readonly proposeCapability: (input: {
    projectID: string
    kind: string
    name: string
    description: string
    source?: string
    installPayload?: Record<string, unknown>
    reason?: string
    actorSessionID: string
  }) => Effect.Effect<{ id: string; version: number }, NotFoundError | InvalidTransitionError | ConflictError>
  readonly setCapabilityStatus: (input: {
    id: string
    status: string
    actorSessionID: string
  }) => Effect.Effect<{ id: string; status: string }, NotFoundError | InvalidTransitionError | ConflictError>
  readonly listCapabilities: (input: {
    projectID: string
    kind?: string
    status?: string
  }) => Effect.Effect<{ id: string; kind: string; name: string; version: number; description: string; status: string }[]>
  // Live MCP handshake for canary capabilities: runs the real protocol
  // against the registered spec and records the outcome as an event.
  // Trial code never runs without manager canary approval.
  readonly probeMcpCapability: (input: {
    id: string
    actorSessionID: string
    timeoutMs?: number
  }) => Effect.Effect<{ ok: boolean }, NotFoundError | InvalidTransitionError>
  // Plugin manifest surface (item 8): validated install/import/export
  // riding the capability registry and template canary flows, plus a
  // proper managed-metadata merge to retire direct DB writes.
  readonly installPlugin: (input: {
    projectID: string
    manifest: Record<string, unknown>
    actorSessionID: string
  }) => Effect.Effect<{ kind: string; id: string; version: number }, NotFoundError | InvalidTransitionError | ConflictError>
  readonly importSkillDir: (input: {
    projectID: string
    dir: string
    actorSessionID: string
  }) => Effect.Effect<{ id: string; version: number; name: string }, NotFoundError | InvalidTransitionError | ConflictError>
  readonly exportSkill: (input: {
    id: string
    dir: string
    actorSessionID: string
  }) => Effect.Effect<{ id: string; path: string }, NotFoundError | InvalidTransitionError | ConflictError>
  readonly setManagedMetadata: (input: {
    id?: string
    slug?: string
    metadata: Record<string, unknown>
    actorSessionID: string
  }) => Effect.Effect<{ id: string; metadata: Record<string, unknown> }, NotFoundError | InvalidTransitionError>
  // Harness analyzer + hooks: read execution traces (runs, events, spend)
  // and file machine-checkable findings as events. A manager approves and
  // applies them; approved actions execute through the normal flows
  // (review tasks, pause, budget extension) so every self-adjustment is
  // auditable and reversible.
  readonly analyzeTraces: (input: {
    projectID: string
    actorSessionID: string
    windowMs?: number
    stallMs?: number
  }) => Effect.Effect<{ eventID: string; kind: string; entityID: string; action: string }[], NotFoundError | InvalidTransitionError>
  readonly applyFinding: (input: {
    findingEventID: string
    actorSessionID: string
    approve?: boolean
  }) => Effect.Effect<{ finding: string; action: string; approved: boolean }, NotFoundError | InvalidTransitionError | ConflictError>
  readonly reviewReady: (input: { sessionID: string }) => Effect.Effect<boolean>
  readonly registerManagedProject: (input: {
    slug: string
    type?: string
    owner?: string
    mission?: string
    metadata?: Record<string, unknown>
  }) => Effect.Effect<{ id: string }, InvalidTransitionError>
  readonly getManagedProject: (input: {
    id?: string
    slug?: string
  }) => Effect.Effect<typeof CvisManagedProjectTable.$inferSelect, NotFoundError | InvalidTransitionError>
  readonly listManagedProjects: (input: {
    status?: string
  }) => Effect.Effect<(typeof CvisManagedProjectTable.$inferSelect)[], InvalidTransitionError>
  readonly linkManagedProject: (input: {
    id: string
    nativeProjectID: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError | ConflictError>
  readonly setManagedProjectStatus: (input: {
    id: string
    status: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError>
  readonly registerSchedule: (input: {
    managedProjectID: string
    name: string
    kind?: string
    payload?: Record<string, unknown>
    intervalSeconds?: number
    nextDueAt?: number
  }) => Effect.Effect<{ id: string }, NotFoundError | InvalidTransitionError>
  readonly getSchedule: (input: {
    id: string
  }) => Effect.Effect<typeof CvisScheduleTable.$inferSelect, NotFoundError>
  readonly listSchedules: (input: {
    managedProjectID?: string
  }) => Effect.Effect<(typeof CvisScheduleTable.$inferSelect)[]>
  readonly setScheduleEnabled: (input: {
    id: string
    enabled: boolean
  }) => Effect.Effect<void, NotFoundError>
  readonly claimDueSchedule: (input: {
    owner: string
    leaseMs?: number
    now?: number
  }) => Effect.Effect<typeof CvisScheduleTable.$inferSelect | undefined, InvalidTransitionError>
  readonly completeScheduleRun: (input: {
    id: string
    owner: string
    status: string
  }) => Effect.Effect<void, NotFoundError | InvalidTransitionError | ConflictError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CvisOrchestration") {}

function newID(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function isRole(role: string): role is Role {
  return (["manager", "researcher", "implementer", "verifier", "maintenance"] as readonly string[]).includes(role)
}

export function currentGoalTasks<T extends Pick<typeof CvisTaskTable.$inferSelect, "id" | "role" | "project_id" | "goal_id" | "revision" | "scope"> & { status?: string }>(tasks: T[]): T[] {
  return tasks.filter((task) => !(task.role === "verifier" && task.scope?.review_task_id && typeof task.scope.review_revision === "number" &&
    tasks.some((target) => target.id === task.scope?.review_task_id && target.project_id === task.project_id && target.goal_id === task.goal_id &&
      (target.revision > (task.scope?.review_revision ?? Infinity) || (["failed", "cancelled"].includes(task.status ?? "") && target.status === "done" && tasks.some((review) => review.id !== task.id && review.role === "verifier" && review.status === "done" && review.project_id === task.project_id && review.goal_id === task.goal_id && review.scope?.review_task_id === target.id && review.scope.review_revision === target.revision))))))
}

function isMessageKind(kind: string): kind is MessageKind {
  return (
    ["assign", "progress", "question", "blocked", "result", "review", "cancel", "ack"] as readonly string[]
  ).includes(kind)
}

// Cross-project write arbitration: two running tasks in different native
// projects may still resolve to the same real directory (nested checkouts,
// shared repos). Compare canonical absolute write roots resolved against
// each task's own root instead of raw relative scope strings.
export function findWriteClash(input: {
  taskID: string
  scope: TaskScope
  root: string
  others: Pick<
    typeof CvisTaskTable.$inferSelect,
    "id" | "project_id" | "status" | "scope" | "assigned_session"
  >[]
  rootOf: (other: { project_id: string; assigned_session: string | null }) => string | null
}): { id: string; project_id: string } | undefined {
  const mine: TaskScope = {
    ...input.scope,
    write_paths: (input.scope.write_paths ?? []).map((r) => canonicalPath(path.resolve(input.root, r))),
  }
  for (const other of input.others) {
    if (other.id === input.taskID) continue
    if (other.status !== "running" && other.status !== "verifying") continue
    const otherRoot = input.rootOf(other)
    if (!otherRoot) continue
    const otherScope = (other.scope ?? {}) as TaskScope
    const theirs: TaskScope = {
      ...otherScope,
      write_paths: (otherScope.write_paths ?? []).map((r) => canonicalPath(path.resolve(otherRoot, r))),
    }
    if (scopesOverlap(mine, theirs)) return { id: other.id, project_id: other.project_id }
  }
  return undefined
}

const EXEC_OUTPUT_CAP = 65536

function runAllowlistedCommand(input: {
  cwd: string
  command: string
  timeoutMs: number
}): Effect.Effect<{ exitCode: number; output: string; truncated: boolean; durationMs: number }> {
  const started = Date.now()
  const finish = (exitCode: number, output: string) => {
    const truncated = output.length > EXEC_OUTPUT_CAP
    return { exitCode, output: truncated ? output.slice(0, EXEC_OUTPUT_CAP) : output, truncated, durationMs: Date.now() - started }
  }
  return Effect.tryPromise({
    try: () =>
      promisify(execFile)("/bin/sh", ["-c", input.command], {
        cwd: input.cwd,
        timeout: input.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }).then(
        (out) => finish(0, `${out.stdout ?? ""}${out.stderr ?? ""}`),
        (err: { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean }) =>
          finish(
            err.killed ? 124 : typeof err.code === "number" ? err.code : 127,
            `${typeof err.stdout === "string" ? err.stdout : ""}${typeof err.stderr === "string" ? err.stderr : ""}`,
          ),
      ),
    catch: (err) => new Error(`check executor failed: ${err instanceof Error ? err.message : String(err)}`),
  }).pipe(
    Effect.catch(() => Effect.succeed(finish(127, "check executor unavailable"))),
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const budgetLedger = createBudget(db)
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
        const required = currentGoalTasks(tasks)
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
      scope?: TaskScope
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
                weight: input.role === "verifier" && (input.scope as { review_task_id?: string } | undefined)?.review_task_id ? 0 : 1,
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
      const sessionRow = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sinfo.id))
        .get()
        .pipe(Effect.orDie)
      if (!sessionRow || sessionRow.time_archived !== null)
        return yield* new ConflictError({
          entity: "session",
          id: input.sessionID,
          reason: "session is archived; explicitly unarchive before claiming",
        })
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
      const running = yield* db
        .select()
        .from(CvisTaskTable)
        .where(inArray(CvisTaskTable.status, ["running", "verifying"]))
        .all()
        .pipe(Effect.orDie)
      const sessionDirs = yield* db
        .select({ id: SessionTable.id, directory: SessionTable.directory })
        .from(SessionTable)
        .all()
        .pipe(Effect.orDie)
      const projectRoots = yield* db
        .select({ id: ProjectTable.id, worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .all()
        .pipe(Effect.orDie)
      const clash = findWriteClash({
        taskID: input.taskID,
        scope,
        root,
        others: running,
        rootOf: (other) => {
          if (other.assigned_session) {
            const hit = sessionDirs.find((s) => String(s.id) === other.assigned_session)
            if (hit) return hit.directory
          }
          return projectRoots.find((p) => String(p.id) === other.project_id)?.worktree ?? null
        },
      })
      if (clash) {
        return yield* new ConflictError({
          entity: "task",
          id: input.taskID,
          reason: `write scope overlaps running task ${clash.id} in project ${clash.project_id}`,
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
            const claimant = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sinfo.id)).get()
            if (!claimant || claimant.time_archived !== null)
              return yield* new ConflictError({ entity: "session", id: input.sessionID, reason: "session is archived" })
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
              .where(inArray(CvisTaskTable.status, ["running", "verifying"]))
              .all()
            const txSessions = yield* tx
              .select({ id: SessionTable.id, directory: SessionTable.directory })
              .from(SessionTable)
              .all()
            const txProjects = yield* tx
              .select({ id: ProjectTable.id, worktree: ProjectTable.worktree })
              .from(ProjectTable)
              .all()
            const txClash = findWriteClash({
              taskID: task.id,
              scope,
              root,
              others: activeTasks,
              rootOf: (other) => {
                if (other.assigned_session) {
                  const hit = txSessions.find((s) => String(s.id) === other.assigned_session)
                  if (hit) return hit.directory
                }
                return txProjects.find((p) => String(p.id) === other.project_id)?.worktree ?? null
              },
            })
            if (txClash) {
              return yield* new ConflictError({ entity: "task", id: task.id, reason: `overlapping active write scope with task ${txClash.id} in project ${txClash.project_id}` })
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

    // Manager failure handling: a running/verifying task whose worker
    // session is archived, missing, or never assigned can never complete.
    // Pause it (releasing bindings, cancelling open runs) so a manager can
    // revise and requeue instead of watching a stuck task.
    const sweepOrphanedTasks = Effect.fn("Cvis.sweepOrphanedTasks")(function* (input: { projectID?: string }) {
      const tasks = yield* db
        .select()
        .from(CvisTaskTable)
        .where(
          input.projectID !== undefined
            ? and(eq(CvisTaskTable.project_id, input.projectID), inArray(CvisTaskTable.status, ["running", "verifying"]))
            : inArray(CvisTaskTable.status, ["running", "verifying"]),
        )
        .all()
        .pipe(Effect.orDie)
      const paused: string[] = []
      for (const task of tasks) {
        if (task.assigned_session) {
          const worker = yield* db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionID.make(task.assigned_session)))
            .get()
            .pipe(Effect.orDie)
          if (worker && worker.time_archived == null) continue
        }
        const outcome = yield* pauseTask({ taskID: task.id, reason: "worker session gone" }).pipe(Effect.exit)
        if (outcome._tag === "Success") paused.push(task.id)
      }
      return { paused }
    })

    // Independent check executor: runs exactly one manager-allowlisted
    // command string for a bound implementer/verifier session. The model
    // cannot alter the string (exact match only), execution is confined to
    // the session directory with a timeout and output cap, and every run
    // returns a receipt instead of throwing on nonzero exits.
    const runCheckCommand = Effect.fn("Cvis.runCheckCommand")(function* (input: {
      taskID: string
      sessionID: string
      command: string
      timeoutMs?: number
    }) {
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      const actor = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!actor || (actor.role !== "implementer" && actor.role !== "verifier") || actor.task_id !== task.id)
        return yield* new InvalidTransitionError({ entity: "check", id: input.taskID, from: input.sessionID, to: "bound implementer or verifier required" })
      const runner = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!runner || runner.time_archived !== null || runner.project_id !== task.project_id || actor.project_id !== task.project_id)
        return yield* new InvalidTransitionError({ entity: "check", id: input.taskID, from: input.sessionID, to: "active project session required" })
      if (task.status !== "running" && task.status !== "verifying")
        return yield* new InvalidTransitionError({ entity: "task", id: task.id, from: task.status, to: "task is not running" })
      if (task.goal_id) {
        const goal = yield* db
          .select()
          .from(CvisProjectGoalTable)
          .where(eq(CvisProjectGoalTable.id, task.goal_id))
          .get()
          .pipe(Effect.orDie)
        if (!goal || goal.status !== "active")
          return yield* new ConflictError({ entity: "goal", id: task.goal_id, reason: "goal is not active" })
      }
      const allowlist = ((task.scope ?? {}) as TaskScope).commands ?? []
      if (!allowlist.includes(input.command))
        return yield* new InvalidTransitionError({ entity: "check", id: input.taskID, from: input.command, to: "command not in task allowlist" })
      const timeoutMs = input.timeoutMs ?? 120_000
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000)
        return yield* new InvalidTransitionError({ entity: "check", id: input.taskID, from: String(input.timeoutMs), to: "timeout must be 100..600000 ms" })
      const receipt = yield* runAllowlistedCommand({ cwd: runner.directory, command: input.command, timeoutMs })
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* recordEvent(tx, {
              projectID: task.project_id,
              entity: "check",
              entityID: `${task.id}:exec`,
              type: "check.executed",
              payload: { command: input.command, exitCode: receipt.exitCode, truncated: receipt.truncated, durationMs: receipt.durationMs, sessionID: input.sessionID },
            })
          }),
        )
        .pipe(Effect.orDie)
      return { ...receipt, command: input.command }
    })

    const OPEN_TASK_STATUS = ["draft", "queued", "running", "verifying", "blocked", "paused"]

    const loadTaskContext = Effect.fn("Cvis.loadTaskContext")(function* (input: { taskID: string; sessionID: string }) {
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get().pipe(Effect.orDie)
      if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
      const actor = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!actor)
        return yield* new InvalidTransitionError({ entity: "task", id: input.taskID, from: input.sessionID, to: "bound session required" })
      const runner = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!runner || runner.time_archived !== null || runner.project_id !== task.project_id || actor.project_id !== task.project_id)
        return yield* new InvalidTransitionError({ entity: "task", id: input.taskID, from: input.sessionID, to: "active project session required" })
      return { task, actor }
    })

    const requireActiveGoal = Effect.fn("Cvis.requireActiveGoal")(function* (task: { goal_id: string | null; id: string }) {
      if (!task.goal_id) return
      const goal = yield* db
        .select()
        .from(CvisProjectGoalTable)
        .where(eq(CvisProjectGoalTable.id, task.goal_id))
        .get()
        .pipe(Effect.orDie)
      if (!goal || goal.status !== "active")
        return yield* new ConflictError({ entity: "goal", id: task.goal_id, reason: "goal is not active" })
    })

    const remindTask = Effect.fn("Cvis.remindTask")(function* (input: { taskID: string; sessionID: string; note?: string }) {
      const { task, actor } = yield* loadTaskContext(input)
      if (!OPEN_TASK_STATUS.includes(task.status as (typeof OPEN_TASK_STATUS)[number]))
        return yield* new InvalidTransitionError({ entity: "task", id: task.id, from: task.status, to: "task is closed" })
      yield* requireActiveGoal(task)
      // Either a participant of this task or a manager of the project
      // (which covers open tasks with no worker assigned yet).
      if (actor.task_id !== task.id && !(actor.role === "manager" && actor.project_id === task.project_id))
        return yield* new InvalidTransitionError({ entity: "task", id: task.id, from: input.sessionID, to: "bound participant or project manager required" })
      const note = input.note?.trim().slice(0, 2000) || null
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* recordEvent(tx, {
              projectID: task.project_id,
              entity: "task",
              entityID: task.id,
              type: "task.reminded",
              payload: { note, by: input.sessionID, status: task.status },
            })
          }),
        )
        .pipe(Effect.orDie)
      return { taskID: task.id, status: task.status }
    })

    const reportTask = Effect.fn("Cvis.reportTask")(function* (input: { taskID: string; sessionID: string; text: string }) {
      const { task, actor } = yield* loadTaskContext(input)
      if (task.status !== "running" && task.status !== "verifying")
        return yield* new InvalidTransitionError({ entity: "task", id: task.id, from: task.status, to: "running or verifying required" })
      yield* requireActiveGoal(task)
      if (actor.task_id !== task.id)
        return yield* new InvalidTransitionError({ entity: "task", id: task.id, from: input.sessionID, to: "bound worker required" })
      const text = input.text.trim()
      if (text.length === 0 || text.length > 4000)
        return yield* new InvalidTransitionError({ entity: "task", id: task.id, from: `${text.length} chars`, to: "report text must be 1..4000 characters" })
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* recordEvent(tx, {
              projectID: task.project_id,
              entity: "task",
              entityID: task.id,
              type: "task.reported",
              payload: { text, by: input.sessionID, status: task.status },
            })
          }),
        )
        .pipe(Effect.orDie)
      return { taskID: task.id, status: task.status }
    })

    const listTaskEvents = Effect.fn("Cvis.listTaskEvents")(function* (input: { taskID: string; sessionID: string; limit?: number }) {
      const { task } = yield* loadTaskContext(input)
      const limit = input.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        return yield* new InvalidTransitionError({ entity: "task", id: task.id, from: String(input.limit), to: "limit must be 1..200" })
      const rows = yield* db
        .select()
        .from(CvisEventTable)
        .where(and(eq(CvisEventTable.entity_kind, "task"), eq(CvisEventTable.entity_id, task.id)))
        .orderBy(CvisEventTable.sequence)
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ id: row.id, type: row.type, payload: row.payload as unknown, time: row.time_created }))
    })

    const MAX_LIVE_SESSIONS_PER_PROJECT = 20

    const spawnSession = Effect.fn("Cvis.spawnSession")(function* (input: {
      projectID: string
      actorSessionID: string
      role?: Role
      taskID?: string
      directory?: string
      title?: string
    }) {
      const project = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, ProjectV2.ID.make(input.projectID)))
        .get()
        .pipe(Effect.orDie)
      if (!project) return yield* new NotFoundError({ entity: "project", id: input.projectID })
      const actor = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.actorSessionID))
        .get()
        .pipe(Effect.orDie)
      if (!actor || actor.role !== "manager" || actor.project_id !== input.projectID)
        return yield* new InvalidTransitionError({ entity: "session", id: input.actorSessionID, from: actor?.role ?? "unbound", to: "project manager required" })
      const actorSession = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.actorSessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!actorSession || actorSession.time_archived !== null || actorSession.project_id !== input.projectID)
        return yield* new InvalidTransitionError({ entity: "session", id: input.actorSessionID, from: input.actorSessionID, to: "active project session required" })
      if (input.role !== undefined && !isRole(input.role))
        return yield* new InvalidTransitionError({ entity: "binding", id: input.actorSessionID, from: "", to: String(input.role) })
      const worktree = canonicalPath(project.worktree)
      const directory = input.directory ? canonicalPath(path.resolve(worktree, input.directory)) : worktree
      if (!pathAllowed(directory, [worktree]))
        return yield* new InvalidTransitionError({ entity: "session", id: input.projectID, from: input.directory ?? "", to: "directory escapes project worktree" })
      const live = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(and(eq(SessionTable.project_id, ProjectV2.ID.make(input.projectID)), isNull(SessionTable.time_archived)))
        .all()
        .pipe(Effect.orDie)
      if (live.length >= MAX_LIVE_SESSIONS_PER_PROJECT)
        return yield* new ConflictError({ entity: "project", id: input.projectID, reason: `live session cap reached (${MAX_LIVE_SESSIONS_PER_PROJECT})` })
      const sessionID = newID("ses")
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(SessionTable)
              .values({
                id: SessionID.make(sessionID),
                project_id: ProjectV2.ID.make(input.projectID),
                slug: `spawn-${sessionID.slice(-8)}`,
                directory,
                title: (input.title ?? "spawned worker").slice(0, 120),
                version: InstallationVersion,
              })
              .run()
            yield* recordEvent(tx, {
              projectID: input.projectID,
              entity: "session",
              entityID: sessionID,
              type: "session.spawned",
              payload: { by: input.actorSessionID, role: input.role ?? null, taskID: input.taskID ?? null },
            })
          }),
        )
        .pipe(Effect.orDie)
      if (input.role !== undefined || input.taskID !== undefined) {
        yield* bindSession({
          sessionID,
          projectID: input.projectID,
          role: (input.role ?? "implementer") as Role,
          taskID: input.taskID,
        })
        return { sessionID, bound: true }
      }
      return { sessionID, bound: false }
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
      const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, taskID)).get().pipe(Effect.orDie)
      if (task) yield* budgetLedger.reconcile(task.project_id)
      return yield* budgetLedger.spend({ taskID })
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
        verifier.time_archived !== null ||
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
        const artifactRoots = [...(task.scope?.read_paths ?? []), ...(task.scope?.write_paths ?? [])]
        const roots = (artifactRoots.length ? artifactRoots : [root]).map((r) => canonicalPath(path.resolve(root, r)))
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
            const reviewer = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, verifier.id)).get()
            if (!reviewer || reviewer.time_archived !== null)
              return yield* new InvalidTransitionError({
                entity: "check",
                id: input.checkID,
                from: "archived",
                to: "verifier is no longer active",
              })
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
      const visible = currentGoalTasks(tasks)
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
      scope?: TaskScope
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
                review.scope?.review_task_id !== task.id ||
                ["done", "cancelled"].includes(review.status)
              )
                continue
              yield* tx
                .update(CvisTaskTable)
                .set({ status: "cancelled", active_run_id: null, assigned_session: null, weight: 0 })
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
          status: CvisPromptTemplateTable.status,
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
      status?: string
    }) {
      const trimmed = input.name.trim()
      if (trimmed.length === 0 || input.body.trim().length === 0) {
        return yield* new InvalidTransitionError({ entity: "template", id: input.name, from: "", to: "empty" })
      }
      const status = input.status ?? "stable"
      if (status !== "stable" && status !== "canary") {
        return yield* new InvalidTransitionError({ entity: "template", id: trimmed, from: "", to: "status must be stable or canary" })
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
          status,
          canary_pct: 0,
        })
        .run()
        .pipe(Effect.orDie)
      return { id, version }
    })

    const renderTemplate = Effect.fn("Cvis.renderTemplate")(function* (input: {
      name: string
      vars: Record<string, string>
      version?: number
      bucketKey?: string
    }) {
      const rows = yield* db
        .select()
        .from(CvisPromptTemplateTable)
        .where(eq(CvisPromptTemplateTable.name, input.name))
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) return yield* new NotFoundError({ entity: "template", id: input.name })
      let template: (typeof rows)[number] | undefined
      if (input.version !== undefined) {
        template = rows.find((row) => row.version === input.version)
        if (!template) return yield* new NotFoundError({ entity: "template", id: `${input.name}@${input.version}` })
        if (template.status === "retired")
          return yield* new InvalidTransitionError({ entity: "template", id: `${input.name}@${input.version}`, from: "retired", to: "retired versions are not served" })
      } else {
        // Stable serves production. A canary version takes a deterministic
        // rollout bucket so the same task always sees the same prompt.
        const stable = rows.filter((row) => row.status === "stable").reduce((best, row) => (!best || row.version > best.version ? row : best), undefined as (typeof rows)[number] | undefined)
        if (!stable) return yield* new NotFoundError({ entity: "template", id: `${input.name}@stable` })
        template = stable
        if (input.bucketKey !== undefined) {
          const canary = rows.filter((row) => row.status === "canary" && (row.canary_pct ?? 0) > 0).reduce((best, row) => (!best || row.version > best.version ? row : best), undefined as (typeof rows)[number] | undefined)
          if (canary) {
            const bucket = createHash("sha256").update(`${input.name}\n${input.bucketKey}`).digest()[0] % 100
            if (bucket < Math.min(100, canary.canary_pct ?? 0)) template = canary
          }
        }
      }
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
      return { text: rendered.text, tokens: estimate(rendered.text), version: template.version, status: template.status }
    })

    const requireTemplateManager = Effect.fn("Cvis.requireTemplateManager")(function* (actorSessionID: string) {
      const actor = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, actorSessionID))
        .get()
        .pipe(Effect.orDie)
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(actorSessionID)))
        .get()
        .pipe(Effect.orDie)
      // Templates are global infrastructure: any active manager binding
      // qualifies, regardless of project.
      if (!actor || actor.role !== "manager" || actor.status === "paused" || !session || session.time_archived !== null)
        return yield* new InvalidTransitionError({ entity: "template", id: actorSessionID, from: actor?.role ?? "unbound", to: "active manager required" })
    })

    const setTemplateStatus = Effect.fn("Cvis.setTemplateStatus")(function* (input: {
      name: string
      version: number
      status: string
      actorSessionID: string
    }) {
      if (input.status !== "stable" && input.status !== "canary" && input.status !== "retired")
        return yield* new InvalidTransitionError({ entity: "template", id: input.name, from: "", to: "status must be stable, canary, or retired" })
      yield* requireTemplateManager(input.actorSessionID)
      const row = yield* db
        .select()
        .from(CvisPromptTemplateTable)
        .where(and(eq(CvisPromptTemplateTable.name, input.name), eq(CvisPromptTemplateTable.version, input.version)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "template", id: `${input.name}@${input.version}` })
      if (input.status === "retired" && row.status === "stable") {
        const siblings = yield* db
          .select()
          .from(CvisPromptTemplateTable)
          .where(and(eq(CvisPromptTemplateTable.name, input.name), eq(CvisPromptTemplateTable.status, "stable")))
          .all()
          .pipe(Effect.orDie)
        if (siblings.length <= 1)
          return yield* new InvalidTransitionError({ entity: "template", id: input.name, from: "stable", to: "at least one stable version must remain" })
      }
      yield* db
        .update(CvisPromptTemplateTable)
        .set({ status: input.status, canary_pct: input.status === "canary" ? row.canary_pct : 0 })
        .where(eq(CvisPromptTemplateTable.id, row.id))
        .run()
        .pipe(Effect.orDie)
      return { name: input.name, version: input.version, status: input.status }
    })

    const setTemplateRollout = Effect.fn("Cvis.setTemplateRollout")(function* (input: {
      name: string
      version: number
      pct: number
      actorSessionID: string
    }) {
      if (!Number.isInteger(input.pct) || input.pct < 0 || input.pct > 100)
        return yield* new InvalidTransitionError({ entity: "template", id: input.name, from: String(input.pct), to: "pct must be 0..100" })
      yield* requireTemplateManager(input.actorSessionID)
      const row = yield* db
        .select()
        .from(CvisPromptTemplateTable)
        .where(and(eq(CvisPromptTemplateTable.name, input.name), eq(CvisPromptTemplateTable.version, input.version)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "template", id: `${input.name}@${input.version}` })
      if (row.status !== "canary")
        return yield* new InvalidTransitionError({ entity: "template", id: input.name, from: row.status, to: "only canary versions take a rollout" })
      yield* db
        .update(CvisPromptTemplateTable)
        .set({ canary_pct: input.pct })
        .where(eq(CvisPromptTemplateTable.id, row.id))
        .run()
        .pipe(Effect.orDie)
      return { name: input.name, version: input.version, pct: input.pct }
    })

    const templateMetrics = Effect.fn("Cvis.templateMetrics")(function* (input: { name: string }) {
      const versions = yield* db
        .select()
        .from(CvisPromptTemplateTable)
        .where(eq(CvisPromptTemplateTable.name, input.name))
        .all()
        .pipe(Effect.orDie)
      if (versions.length === 0) return yield* new NotFoundError({ entity: "template", id: input.name })
      const runs = yield* db.select().from(CvisTaskRunTable).all().pipe(Effect.orDie)
      const out: { version: number; status: string; runs: number; checks: number; passRate: number | null; avgTokens: number | null }[] = []
      for (const v of versions) {
        const used = runs.filter((run) => {
          const tpl = (run.result as { template?: { name?: unknown; version?: unknown } } | null)?.template
          return tpl?.name === input.name && tpl?.version === v.version
        })
        const checks = used.length
          ? yield* db
              .select()
              .from(CvisCheckTable)
              .where(inArray(CvisCheckTable.run_id, used.map((run) => run.id)))
              .all()
              .pipe(Effect.orDie)
          : []
        const passed = checks.filter((c) => c.verdict === "pass").length
        const tokens = used.map((run) => run.tokens_used ?? 0)
        out.push({
          version: v.version,
          status: v.status,
          runs: used.length,
          checks: checks.length,
          passRate: checks.length ? passed / checks.length : null,
          avgTokens: used.length ? tokens.reduce((a, b) => a + b, 0) / used.length : null,
        })
      }
      return out.sort((a, b) => a.version - b.version)
    })

    // Offline prompt library: operator-curated *.json files land as
    // canary template versions ready for canary evaluation. Library
    // files never go live directly; promote/rollback stays manual.
    const importPromptLibrary = Effect.fn("Cvis.importPromptLibrary")(function* (input: {
      projectID: string
      dir: string
      actorSessionID: string
    }) {
      yield* requireTemplateManager(input.actorSessionID)
      const project = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, ProjectV2.ID.make(input.projectID)))
        .get()
        .pipe(Effect.orDie)
      if (!project) return yield* new NotFoundError({ entity: "project", id: input.projectID })
      const worktree = canonicalPath(project.worktree)
      const dir = canonicalPath(path.resolve(worktree, input.dir))
      if (!pathAllowed(dir, [worktree]))
        return yield* new InvalidTransitionError({ entity: "template", id: input.dir, from: input.dir, to: "directory escapes project worktree" })
      const entries = yield* Effect.tryPromise({
        try: () => readdir(dir),
        catch: () => new NotFoundError({ entity: "template", id: input.dir }),
      })
      const files = entries.filter((name) => name.endsWith(".json")).sort().slice(0, 50)
      const imported: { name: string; version: number }[] = []
      const skipped: { file: string; reason: string }[] = []
      for (const file of files) {
        const raw = yield* Effect.tryPromise({
          try: () => readFile(path.join(dir, file), "utf8"),
          catch: () => new Error("unreadable"),
        }).pipe(Effect.option)
        if (raw._tag === "None" || raw.value.length > 32768) {
          skipped.push({ file, reason: raw._tag === "None" ? "unreadable" : "too large" })
          continue
        }
        const text = raw.value
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          skipped.push({ file, reason: "invalid JSON" })
          continue
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          skipped.push({ file, reason: "not an object" })
          continue
        }
        const rec = parsed as Record<string, unknown>
        const outcome = yield* Effect.exit(
          createTemplate({
            name: typeof rec.name === "string" ? rec.name : file.replace(/\.json$/, ""),
            role: typeof rec.role === "string" ? rec.role : undefined,
            body: typeof rec.body === "string" ? rec.body : "",
            inputs: Array.isArray(rec.inputs) ? (rec.inputs as { name: string; required: boolean }[]) : undefined,
            status: "canary",
          }),
        )
        if (outcome._tag === "Failure") {
          skipped.push({ file, reason: "rejected by template validation" })
          continue
        }
        imported.push({ name: typeof rec.name === "string" ? rec.name : file.replace(/\.json$/, ""), version: outcome.value.version })
      }
      return { imported, skipped }
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
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!session) return yield* new NotFoundError({ entity: "session", id: input.sessionID })
      if (session.time_archived !== null) reasons.push("session is archived")
      if (yield* runState.isRunning(session.id)) reasons.push("session is executing")
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
      if (session.project_id !== task.project_id) reasons.push("different project")
      if (binding) {
        if (binding.status !== "idle") reasons.push(`binding is ${binding.status}`)
        if (binding.project_id !== task.project_id) reasons.push("different project")
        if (binding.role !== task.role) reasons.push(`role mismatch: ${binding.role} vs ${task.role}`)
        if (binding.task_id != null && binding.task_id !== input.taskID) reasons.push("unfinished previous task")
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
      if (session.time_archived !== null)
        return yield* new InvalidTransitionError({
          entity: "binding",
          id: input.sessionID,
          from: "archived",
          to: "explicit unarchive required",
        })
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
            const activeSession = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()
            if (!activeSession || activeSession.time_archived !== null)
              return yield* new InvalidTransitionError({
                entity: "binding",
                id: input.sessionID,
                from: "archived",
                to: "binding",
              })
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
              for (const manager of managers.filter(
                (item) => item.role === "manager" && item.session_id !== input.sessionID,
              )) {
                const oldSession = yield* tx
                  .select()
                  .from(SessionTable)
                  .where(eq(SessionTable.id, SessionID.make(manager.session_id)))
                  .get()
                const runs = yield* tx
                  .select()
                  .from(CvisTaskRunTable)
                  .where(eq(CvisTaskRunTable.session_id, manager.session_id))
                  .all()
                if (
                  !oldSession ||
                  oldSession.time_archived === null ||
                  manager.task_id !== null ||
                  !["idle", "paused"].includes(manager.status) ||
                  runs.some((run) => ["pending", "running", "verifying"].includes(run.status)) ||
                  (yield* runState.isRunning(SessionID.make(manager.session_id)))
                )
                  return yield* new InvalidTransitionError({
                    entity: "binding",
                    id: input.sessionID,
                    from: "",
                    to: "project already has an active manager",
                  })
                yield* tx
                  .delete(CvisSessionBindingTable)
                  .where(eq(CvisSessionBindingTable.session_id, manager.session_id))
                  .run()
                yield* tx
                  .update(CvisSessionBindingTable)
                  .set({ manager_session: input.sessionID })
                  .where(
                    and(
                      eq(CvisSessionBindingTable.project_id, input.projectID),
                      eq(CvisSessionBindingTable.manager_session, manager.session_id),
                    ),
                  )
                  .run()
                yield* recordEvent(tx, {
                  projectID: input.projectID,
                  entity: "binding",
                  entityID: manager.session_id,
                  type: "manager.replaced",
                  payload: { replacementSessionID: input.sessionID },
                })
              }
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
        sender.time_archived !== null ||
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

    const updateGoalBudget = Effect.fn("Cvis.updateGoalBudget")(function* (input: {
      goalID: string
      budgetTokens: number
      expectedBudget: number | null
      reason: string
      actorSessionID: string
    }) {
      if (!Number.isInteger(input.budgetTokens) || input.budgetTokens <= 0 || !Number.isFinite(input.budgetTokens)) {
        return yield* new InvalidTransitionError({
          entity: "goal",
          id: input.goalID,
          from: "budgetTokens",
          to: "must be a positive finite integer",
        })
      }
      const trimmedReason = input.reason.trim()
      if (!trimmedReason) {
        return yield* new InvalidTransitionError({
          entity: "goal",
          id: input.goalID,
          from: "reason",
          to: "must be non-empty",
        })
      }
      const actorSession = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.actorSessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!actorSession) return yield* new NotFoundError({ entity: "session", id: input.actorSessionID })
      if (actorSession.time_archived !== null) {
        return yield* new InvalidTransitionError({
          entity: "session",
          id: input.actorSessionID,
          from: "archived",
          to: "operator not allowed",
        })
      }
      const actorBinding = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.actorSessionID))
        .get()
        .pipe(Effect.orDie)
      if (
        !actorBinding ||
        actorBinding.role !== "manager" ||
        (actorBinding.status !== "idle" && actorBinding.status !== "active")
      ) {
        return yield* new InvalidTransitionError({
          entity: "binding",
          id: input.actorSessionID,
          from: actorBinding?.status ?? "unbound",
          to: "active or idle manager required",
        })
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const goal = yield* tx
              .select()
              .from(CvisProjectGoalTable)
              .where(eq(CvisProjectGoalTable.id, input.goalID))
              .get()
            if (!goal) return yield* new NotFoundError({ entity: "goal", id: input.goalID })
            if (goal.project_id !== actorBinding.project_id) {
              return yield* new ConflictError({
                entity: "goal",
                id: input.goalID,
                reason: "actor session belongs to a different project",
              })
            }
            const current = goal.budget_tokens ?? null
            if (current !== input.expectedBudget) {
              return yield* new ConflictError({
                entity: "goal",
                id: input.goalID,
                reason: `CAS mismatch: expected ${input.expectedBudget} but current cap is ${current}`,
              })
            }
            yield* tx
              .update(CvisProjectGoalTable)
              .set({ budget_tokens: input.budgetTokens })
              .where(eq(CvisProjectGoalTable.id, input.goalID))
              .run()
            yield* recordEvent(tx, {
              projectID: goal.project_id,
              entity: "goal",
              entityID: input.goalID,
              type: "goal.budget.updated",
              payload: {
                old_cap: current,
                new_cap: input.budgetTokens,
                reason: trimmedReason,
                actor: input.actorSessionID,
              },
            })
          }),
        )
        .pipe(Effect.orDie)
    })

    const updateTaskBudget = Effect.fn("Cvis.updateTaskBudget")(function* (input: { taskID: string; maxTokens: number; expectedMaxTokens: number | null; reason: string; actorSessionID: string }) {
      if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0 || !input.reason.trim())
        return yield* new InvalidTransitionError({ entity: "task", id: input.taskID, from: "budget", to: "positive integer and reason required" })
      yield* db.transaction((tx) => Effect.gen(function* () {
        const task = yield* tx.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.taskID)).get()
        if (!task) return yield* new NotFoundError({ entity: "task", id: input.taskID })
        const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, SessionID.make(input.actorSessionID))).get()
        const actor = yield* tx.select().from(CvisSessionBindingTable).where(eq(CvisSessionBindingTable.session_id, input.actorSessionID)).get()
        if (!session || session.time_archived !== null || !actor || actor.role !== "manager" || actor.status !== "idle" || actor.project_id !== task.project_id || session.project_id !== task.project_id)
          return yield* new ConflictError({ entity: "task", id: task.id, reason: "same-project idle manager required" })
        const old = task.scope?.max_tokens ?? null
        if (old !== input.expectedMaxTokens) return yield* new ConflictError({ entity: "task", id: task.id, reason: "budget CAS mismatch" })
        yield* tx.update(CvisTaskTable).set({ scope: { ...task.scope, max_tokens: input.maxTokens } }).where(eq(CvisTaskTable.id, task.id)).run()
        yield* recordEvent(tx, { projectID: task.project_id, entity: "task", entityID: task.id, type: "task.budget.updated", payload: { oldMaxTokens: old, newMaxTokens: input.maxTokens, reason: input.reason.trim(), actor: input.actorSessionID } })
      }), { behavior: "immediate" }).pipe(Effect.orDie)
    })

    const AUTO_EXTEND_DEFAULTS = { step_pct: 25, max_steps: 3, approval_above: null as number | null }

    const readAutoExtend = (raw: unknown) => {
      const cfg = { ...AUTO_EXTEND_DEFAULTS }
      if (raw && typeof raw === "object") {
        const rec = raw as Record<string, unknown>
        if (typeof rec.step_pct === "number" && Number.isFinite(rec.step_pct) && rec.step_pct > 0 && rec.step_pct <= 400) cfg.step_pct = rec.step_pct
        if (typeof rec.max_steps === "number" && Number.isInteger(rec.max_steps) && rec.max_steps >= 0) cfg.max_steps = rec.max_steps
        if (typeof rec.approval_above === "number" && Number.isFinite(rec.approval_above) && rec.approval_above > 0) cfg.approval_above = rec.approval_above
      }
      return cfg
    }

    const requestBudgetExtension = Effect.fn("Cvis.requestBudgetExtension")(function* (input: {
      kind: "goal" | "task"
      id: string
      actorSessionID: string
      maxStaleMs?: number
    }) {
      if (input.kind !== "goal" && input.kind !== "task")
        return yield* new InvalidTransitionError({ entity: "budget", id: input.id, from: String(input.kind), to: "kind must be goal or task" })
      const actor = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.actorSessionID))
        .get()
        .pipe(Effect.orDie)
      const actorSession = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.actorSessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!actor || !actorSession || actorSession.time_archived !== null)
        return yield* new InvalidTransitionError({ entity: "budget", id: input.id, from: input.actorSessionID, to: "bound active session required" })
      const entityKind = input.kind
      let projectID: string
      let current: number | null
      let cfg: { step_pct: number; max_steps: number; approval_above: number | null }
      if (entityKind === "goal") {
        const goal = yield* db.select().from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, input.id)).get().pipe(Effect.orDie)
        if (!goal) return yield* new NotFoundError({ entity: "goal", id: input.id })
        if (goal.status !== "active")
          return yield* new InvalidTransitionError({ entity: "goal", id: goal.id, from: goal.status, to: "goal is not active" })
        if (goal.budget_tokens === null)
          return yield* new InvalidTransitionError({ entity: "goal", id: goal.id, from: "no cap", to: "set a budget cap first" })
        if (goal.project_id !== actor.project_id)
          return yield* new ConflictError({ entity: "goal", id: goal.id, reason: "actor belongs to a different project" })
        projectID = goal.project_id
        current = goal.budget_tokens
        cfg = readAutoExtend((goal.metadata as Record<string, unknown> | null)?.auto_extend)
      } else {
        const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.id)).get().pipe(Effect.orDie)
        if (!task) return yield* new NotFoundError({ entity: "task", id: input.id })
        if (task.status !== "running" && task.status !== "verifying")
          return yield* new InvalidTransitionError({ entity: "task", id: task.id, from: task.status, to: "running or verifying required" })
        const cap = task.scope?.max_tokens ?? null
        if (cap === null)
          return yield* new InvalidTransitionError({ entity: "task", id: task.id, from: "no cap", to: "set a task budget first" })
        if (task.project_id !== actor.project_id)
          return yield* new ConflictError({ entity: "task", id: task.id, reason: "actor belongs to a different project" })
        if (task.goal_id) {
          const goal = yield* db.select().from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, task.goal_id)).get().pipe(Effect.orDie)
          if (!goal || goal.status !== "active")
            return yield* new ConflictError({ entity: "goal", id: task.goal_id, reason: "goal is not active" })
        }
        projectID = task.project_id
        current = cap
        cfg = readAutoExtend((task.scope as Record<string, unknown> | null)?.auto_extend)
      }
      // Anti-abuse: only work with proof of recent life extends.
      const maxStaleMs = input.maxStaleMs ?? 1_800_000
      const latest = yield* db
        .select({ time: CvisEventTable.time_created })
        .from(CvisEventTable)
        .where(and(eq(CvisEventTable.entity_kind, entityKind), eq(CvisEventTable.entity_id, input.id)))
        .orderBy(desc(CvisEventTable.sequence))
        .limit(1)
        .all()
        .pipe(Effect.orDie)
      if (latest.length === 0 || Date.now() - (latest[0].time ?? 0) > maxStaleMs)
        return yield* new InvalidTransitionError({ entity: entityKind, id: input.id, from: "stale", to: "recent progress required for auto-extend" })
      const extensions = yield* db
        .select({ id: CvisEventTable.id })
        .from(CvisEventTable)
        .where(and(eq(CvisEventTable.entity_kind, entityKind), eq(CvisEventTable.entity_id, input.id), eq(CvisEventTable.type, "budget.extended")))
        .all()
        .pipe(Effect.orDie)
      const stepsUsed = extensions.length
      const spent = entityKind === "goal"
        ? yield* budgetLedger.spend({ goalID: input.id })
        : yield* budgetLedger.spend({ taskID: input.id })
      const proposed = Math.floor(current * (1 + cfg.step_pct / 100))
      if (stepsUsed >= cfg.max_steps || (cfg.approval_above !== null && proposed > cfg.approval_above)) {
        const managers = yield* db
          .select()
          .from(CvisSessionBindingTable)
          .where(and(eq(CvisSessionBindingTable.project_id, projectID), eq(CvisSessionBindingTable.role, "manager")))
          .all()
          .pipe(Effect.orDie)
        const managerSession = managers.find((m) => m.status === "busy" || m.status === "idle")?.session_id
        if (!managerSession)
          return yield* new ConflictError({ entity: entityKind, id: input.id, reason: "extension ceiling reached and no manager available for approval" })
        const key = `budget-approval-${entityKind}-${input.id}-${stepsUsed}`
        const asked = yield* db
          .select({ id: CvisMessageTable.id })
          .from(CvisMessageTable)
          .where(eq(CvisMessageTable.idempotency_key, key))
          .all()
          .pipe(Effect.orDie)
        if (asked.length === 0) {
          yield* sendMessage({
            projectID,
            taskID: entityKind === "task" ? input.id : undefined,
            fromSession: input.actorSessionID,
            toSession: managerSession,
            kind: "question",
            body: { kind: "budget-approval", entity: entityKind, id: input.id, spent, currentCap: current, proposedCap: proposed, stepsUsed },
            idempotencyKey: key,
          })
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* recordEvent(tx, { projectID, entity: entityKind, entityID: input.id, type: "budget.extension_requested", payload: { spent, currentCap: current, proposedCap: proposed, stepsUsed, to: managerSession } })
              }),
            )
            .pipe(Effect.orDie)
        }
        return yield* new ConflictError({ entity: entityKind, id: input.id, reason: `extension ceiling reached, approval requested from ${managerSession}` })
      }
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (entityKind === "goal") {
              const goal = yield* tx.select().from(CvisProjectGoalTable).where(eq(CvisProjectGoalTable.id, input.id)).get()
              if (!goal) return yield* new NotFoundError({ entity: "goal", id: input.id })
              if (goal.budget_tokens !== current)
                return yield* new ConflictError({ entity: "goal", id: input.id, reason: "budget CAS mismatch, retry the extension" })
              yield* tx.update(CvisProjectGoalTable).set({ budget_tokens: proposed }).where(eq(CvisProjectGoalTable.id, input.id)).run()
            } else {
              const task = yield* tx.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, input.id)).get()
              if (!task) return yield* new NotFoundError({ entity: "task", id: input.id })
              if ((task.scope?.max_tokens ?? null) !== current)
                return yield* new ConflictError({ entity: "task", id: input.id, reason: "budget CAS mismatch, retry the extension" })
              yield* tx.update(CvisTaskTable).set({ scope: { ...task.scope, max_tokens: proposed } }).where(eq(CvisTaskTable.id, task.id)).run()
            }
            yield* recordEvent(tx, { projectID, entity: entityKind, entityID: input.id, type: "budget.extended", payload: { oldCap: current, newCap: proposed, spent, stepsUsed: stepsUsed + 1, actor: input.actorSessionID } })
            return { extended: true as const, oldCap: current, newCap: proposed, stepsUsed: stepsUsed + 1 }
          }),
        )
        .pipe(Effect.orDie)
      return result
    })

    const CAPABILITY_KINDS = ["tool", "skill", "mcp"] as const
    const CAPABILITY_FLOW: Record<string, string[]> = {
      proposed: ["canary", "deprecated"],
      canary: ["active", "deprecated"],
      active: ["deprecated"],
      deprecated: [],
    }

    const requireProjectParticipant = Effect.fn("Cvis.requireProjectParticipant")(function* (input: {
      projectID: string
      actorSessionID: string
      managerOnly: boolean
    }) {
      const project = yield* db
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, ProjectV2.ID.make(input.projectID)))
        .get()
        .pipe(Effect.orDie)
      if (!project) return yield* new NotFoundError({ entity: "project", id: input.projectID })
      const actor = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.actorSessionID))
        .get()
        .pipe(Effect.orDie)
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.actorSessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!actor || !session || session.time_archived !== null || actor.project_id !== input.projectID || actor.status === "paused")
        return yield* new InvalidTransitionError({ entity: "capability", id: input.projectID, from: input.actorSessionID, to: "bound active participant required" })
      if (input.managerOnly && actor.role !== "manager")
        return yield* new InvalidTransitionError({ entity: "capability", id: input.projectID, from: actor.role, to: "manager required" })
    })

    const proposeCapability = Effect.fn("Cvis.proposeCapability")(function* (input: {
      projectID: string
      kind: string
      name: string
      description: string
      source?: string
      installPayload?: Record<string, unknown>
      reason?: string
      actorSessionID: string
    }) {
      if (!(CAPABILITY_KINDS as readonly string[]).includes(input.kind))
        return yield* new InvalidTransitionError({ entity: "capability", id: input.name, from: "", to: "kind must be tool, skill, or mcp" })
      const name = input.name.trim().slice(0, 80)
      if (name.length === 0)
        return yield* new InvalidTransitionError({ entity: "capability", id: input.name, from: "", to: "name required" })
      const description = input.description.trim()
      if (description.length < 10 || description.length > 2000)
        return yield* new InvalidTransitionError({ entity: "capability", id: name, from: `${description.length} chars`, to: "description must be 10..2000 characters" })
      yield* requireProjectParticipant({ projectID: input.projectID, actorSessionID: input.actorSessionID, managerOnly: false })
      const existing = yield* db
        .select({ version: CvisCapabilityTable.version })
        .from(CvisCapabilityTable)
        .where(
          and(
            eq(CvisCapabilityTable.project_id, ProjectV2.ID.make(input.projectID)),
            eq(CvisCapabilityTable.kind, input.kind),
            eq(CvisCapabilityTable.name, name),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const version = existing.reduce((max, r) => Math.max(max, r.version), 0) + 1
      const id = newID("cap")
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(CvisCapabilityTable)
              .values({
                id,
                kind: input.kind,
                name,
                version,
                description,
                source: input.source ?? null,
                install_payload: input.installPayload ?? null,
                status: "proposed",
                project_id: ProjectV2.ID.make(input.projectID),
                proposed_by: input.actorSessionID,
                reason: input.reason?.trim().slice(0, 500) ?? null,
              })
              .run()
            yield* recordEvent(tx, { projectID: input.projectID, entity: "capability", entityID: id, type: "capability.proposed", payload: { kind: input.kind, name, version, by: input.actorSessionID } })
          }),
        )
        .pipe(Effect.orDie)
      return { id, version }
    })

    const setCapabilityStatus = Effect.fn("Cvis.setCapabilityStatus")(function* (input: {
      id: string
      status: string
      actorSessionID: string
    }) {
      const row = yield* db.select().from(CvisCapabilityTable).where(eq(CvisCapabilityTable.id, input.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "capability", id: input.id })
      yield* requireProjectParticipant({ projectID: row.project_id, actorSessionID: input.actorSessionID, managerOnly: true })
      const allowed = CAPABILITY_FLOW[row.status] ?? []
      if (!allowed.includes(input.status))
        return yield* new InvalidTransitionError({ entity: "capability", id: row.id, from: row.status, to: `${input.status} (allowed: ${allowed.join(",") || "none"})` })
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(CvisCapabilityTable).set({ status: input.status }).where(eq(CvisCapabilityTable.id, row.id)).run()
            if (input.status === "active") {
              // Approving retires older active siblings so rollback is
              // one status flip away and only one version serves.
              const siblings = yield* tx
                .select()
                .from(CvisCapabilityTable)
                .where(
                  and(
                    eq(CvisCapabilityTable.project_id, row.project_id),
                    eq(CvisCapabilityTable.kind, row.kind),
                    eq(CvisCapabilityTable.name, row.name),
                    eq(CvisCapabilityTable.status, "active"),
                  ),
                )
                .all()
              for (const sib of siblings) {
                if (sib.id === row.id) continue
                yield* tx.update(CvisCapabilityTable).set({ status: "deprecated" }).where(eq(CvisCapabilityTable.id, sib.id)).run()
              }
            }
            yield* recordEvent(tx, { projectID: row.project_id, entity: "capability", entityID: row.id, type: `capability.${input.status}`, payload: { kind: row.kind, name: row.name, version: row.version, by: input.actorSessionID } })
          }),
        )
        .pipe(Effect.orDie)
      return { id: row.id, status: input.status }
    })

    const listCapabilities = Effect.fn("Cvis.listCapabilities")(function* (input: {
      projectID: string
      kind?: string
      status?: string
    }) {
      const conds = [eq(CvisCapabilityTable.project_id, ProjectV2.ID.make(input.projectID))]
      if (input.kind !== undefined) conds.push(eq(CvisCapabilityTable.kind, input.kind))
      if (input.status !== undefined) conds.push(eq(CvisCapabilityTable.status, input.status))
      const rows = yield* db
        .select({
          id: CvisCapabilityTable.id,
          kind: CvisCapabilityTable.kind,
          name: CvisCapabilityTable.name,
          version: CvisCapabilityTable.version,
          description: CvisCapabilityTable.description,
          status: CvisCapabilityTable.status,
        })
        .from(CvisCapabilityTable)
        .where(and(...conds))
        .orderBy(CvisCapabilityTable.kind, CvisCapabilityTable.name, CvisCapabilityTable.version)
        .all()
        .pipe(Effect.orDie)
      return rows
    })

    const probeMcpCapability = Effect.fn("Cvis.probeMcpCapability")(function* (input: {
      id: string
      actorSessionID: string
      timeoutMs?: number
    }) {
      const row = yield* db.select().from(CvisCapabilityTable).where(eq(CvisCapabilityTable.id, input.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "capability", id: input.id })
      if (row.kind !== "mcp")
        return yield* new InvalidTransitionError({ entity: "capability", id: row.id, from: row.kind, to: "only mcp capabilities can be probed" })
      if (row.status !== "canary")
        return yield* new InvalidTransitionError({ entity: "capability", id: row.id, from: row.status, to: "only canary capabilities may run trial code" })
      yield* requireProjectParticipant({ projectID: row.project_id, actorSessionID: input.actorSessionID, managerOnly: false })
      const checked = validateMcpSpec(row.install_payload)
      if (!checked.ok)
        return yield* new InvalidTransitionError({ entity: "capability", id: row.id, from: "spec", to: checked.reason })
      const timeoutMs = input.timeoutMs ?? 30_000
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000)
        return yield* new InvalidTransitionError({ entity: "capability", id: row.id, from: String(input.timeoutMs), to: "timeout must be 1000..120000 ms" })
      const result = yield* probeTransport(transportForSpec(checked.spec), { timeoutMs })
      // Never persist the spec or headers: only the outcome and tool names.
      const payload = result.ok
        ? { ok: true as const, tools: result.tools, server: result.server, by: input.actorSessionID }
        : { ok: false as const, error: result.error.slice(0, 500), by: input.actorSessionID }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* recordEvent(tx, { projectID: row.project_id, entity: "capability", entityID: row.id, type: "capability.probed", payload })
          }),
        )
        .pipe(Effect.orDie)
      return payload
    })

    const installPlugin = Effect.fn("Cvis.installPlugin")(function* (input: {
      projectID: string
      manifest: Record<string, unknown>
      actorSessionID: string
    }) {
      const parsed = parsePluginManifest(input.manifest)
      if (!parsed.ok)
        return yield* new InvalidTransitionError({ entity: "plugin", id: "", from: "manifest", to: parsed.reason })
      const manifest = parsed.manifest
      if (manifest.kind === "hook")
        return yield* new InvalidTransitionError({ entity: "plugin", id: manifest.name, from: "hook", to: "hook kind is reserved until a hook runtime exists" })
      if (manifest.kind === "template") {
        // Template plugins ride the canary lifecycle from item 2.
        const created = yield* createTemplate({
          name: manifest.name,
          body: manifest.body ?? "",
          inputs: [],
          status: "canary",
        })
        return { kind: "template", id: created.id, version: created.version }
      }
      const proposed = yield* proposeCapability({
        projectID: input.projectID,
        kind: manifest.kind,
        name: manifest.name,
        description: manifest.description,
        source: manifest.source,
        installPayload: { manifest, entry: manifest.entry ?? null },
        reason: `plugin install v${manifest.version}`,
        actorSessionID: input.actorSessionID,
      })
      return { kind: manifest.kind, id: proposed.id, version: proposed.version }
    })

    const importSkillDir = Effect.fn("Cvis.importSkillDir")(function* (input: {
      projectID: string
      dir: string
      actorSessionID: string
    }) {
      yield* requireProjectParticipant({ projectID: input.projectID, actorSessionID: input.actorSessionID, managerOnly: false })
      const project = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, ProjectV2.ID.make(input.projectID)))
        .get()
        .pipe(Effect.orDie)
      if (!project) return yield* new NotFoundError({ entity: "project", id: input.projectID })
      const worktree = canonicalPath(project.worktree)
      const dir = canonicalPath(path.resolve(worktree, input.dir))
      if (!pathAllowed(dir, [worktree]))
        return yield* new InvalidTransitionError({ entity: "plugin", id: input.dir, from: input.dir, to: "directory escapes project worktree" })
      const text = yield* Effect.tryPromise({
        try: () => readFile(path.join(dir, "SKILL.md"), "utf8"),
        catch: () => new NotFoundError({ entity: "plugin", id: input.dir }),
      })
      const parsed = parseSkillFile(text)
      if (!parsed.ok)
        return yield* new InvalidTransitionError({ entity: "plugin", id: input.dir, from: "SKILL.md", to: parsed.reason })
      const proposed = yield* proposeCapability({
        projectID: input.projectID,
        kind: "skill",
        name: parsed.name,
        description: parsed.description,
        source: `dir:${dir}`,
        installPayload: { entry: path.join(dir, "SKILL.md"), procedure: parsed.body.slice(0, 8000) },
        reason: "skill dir import",
        actorSessionID: input.actorSessionID,
      })
      return { id: proposed.id, version: proposed.version, name: parsed.name }
    })

    const exportSkill = Effect.fn("Cvis.exportSkill")(function* (input: {
      id: string
      dir: string
      actorSessionID: string
    }) {
      const row = yield* db.select().from(CvisCapabilityTable).where(eq(CvisCapabilityTable.id, input.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "capability", id: input.id })
      if (row.kind !== "skill")
        return yield* new InvalidTransitionError({ entity: "capability", id: row.id, from: row.kind, to: "only skills export to SKILL.md" })
      if (row.status !== "active")
        return yield* new InvalidTransitionError({ entity: "capability", id: row.id, from: row.status, to: "only active skills can be exported" })
      yield* requireProjectParticipant({ projectID: row.project_id, actorSessionID: input.actorSessionID, managerOnly: true })
      const project = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, ProjectV2.ID.make(row.project_id)))
        .get()
        .pipe(Effect.orDie)
      if (!project) return yield* new NotFoundError({ entity: "project", id: row.project_id })
      const worktree = canonicalPath(project.worktree)
      const dir = canonicalPath(path.resolve(worktree, input.dir))
      if (!pathAllowed(dir, [worktree]))
        return yield* new InvalidTransitionError({ entity: "capability", id: row.id, from: input.dir, to: "directory escapes project worktree" })
      const payload = (row.install_payload ?? {}) as Record<string, unknown>
      const body = typeof payload.procedure === "string" && payload.procedure.length > 0 ? payload.procedure : row.description
      const text = renderSkillFile({ name: row.name, description: row.description, body })
      const target = path.join(dir, "SKILL.md")
      const outcome = yield* Effect.exit(
        Effect.tryPromise({
          try: async () => {
            await mkdir(dir, { recursive: true })
            await writeFile(target, text, { flag: "wx" })
          },
          catch: (cause) => cause,
        }),
      )
      if (outcome._tag === "Failure") {
        const code = (Cause.squash(outcome.cause) as { code?: unknown } | null)?.code
        if (code === "EEXIST")
          return yield* new ConflictError({ entity: "capability", id: row.id, reason: "SKILL.md already exists, refusing overwrite" })
        return yield* new InvalidTransitionError({ entity: "capability", id: row.id, from: target, to: "write failed" })
      }
      return { id: row.id, path: target }
    })

    const setManagedMetadata = Effect.fn("Cvis.setManagedMetadata")(function* (input: {
      id?: string
      slug?: string
      metadata: Record<string, unknown>
      actorSessionID: string
    }) {
      const managed = yield* getManagedProject({ id: input.id, slug: input.slug })
      if (!managed.native_project_id)
        return yield* new InvalidTransitionError({ entity: "managed-project", id: managed.id, from: "", to: "native project not linked" })
      const actor = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.actorSessionID))
        .get()
        .pipe(Effect.orDie)
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.actorSessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!actor || actor.role !== "manager" || actor.project_id !== managed.native_project_id || !session || session.time_archived !== null)
        return yield* new InvalidTransitionError({ entity: "managed-project", id: managed.id, from: input.actorSessionID, to: "manager of the linked project required" })
      const merged = { ...((managed.metadata ?? {}) as Record<string, unknown>), ...input.metadata }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.update(CvisManagedProjectTable).set({ metadata: merged }).where(eq(CvisManagedProjectTable.id, managed.id)).run()
            yield* recordEvent(tx, { projectID: managed.native_project_id as string, entity: "managed-project", entityID: managed.id, type: "managed.metadata.updated", payload: { keys: Object.keys(input.metadata), by: input.actorSessionID } })
          }),
        )
        .pipe(Effect.orDie)
      return { id: managed.id, metadata: merged }
    })

    const analyzeTraces = Effect.fn("Cvis.analyzeTraces")(function* (input: {
      projectID: string
      actorSessionID: string
      windowMs?: number
      stallMs?: number
    }) {
      yield* requireProjectParticipant({ projectID: input.projectID, actorSessionID: input.actorSessionID, managerOnly: false })
      const windowMs = input.windowMs ?? 86_400_000
      if (!Number.isSafeInteger(windowMs) || windowMs < 60_000 || windowMs > 604_800_000)
        return yield* new InvalidTransitionError({ entity: "harness", id: input.projectID, from: String(input.windowMs), to: "window must be 60000..604800000 ms" })
      const stallMs = input.stallMs ?? 7_200_000
      if (!Number.isSafeInteger(stallMs) || stallMs < 60_000 || stallMs > 604_800_000)
        return yield* new InvalidTransitionError({ entity: "harness", id: input.projectID, from: String(input.stallMs), to: "stall threshold must be 60000..604800000 ms" })
      const now = Date.now()
      const tasks = yield* db
        .select()
        .from(CvisTaskTable)
        .where(eq(CvisTaskTable.project_id, ProjectV2.ID.make(input.projectID)))
        .all()
        .pipe(Effect.orDie)
      const taskIDs = tasks.map((t) => t.id)
      const runs = taskIDs.length
        ? yield* db.select().from(CvisTaskRunTable).where(inArray(CvisTaskRunTable.task_id, taskIDs)).all().pipe(Effect.orDie)
        : []
      const events = yield* db
        .select()
        .from(CvisEventTable)
        .where(and(eq(CvisEventTable.project_id, ProjectV2.ID.make(input.projectID)), gte(CvisEventTable.time_created, now - windowMs)))
        .orderBy(desc(CvisEventTable.sequence))
        .limit(5000)
        .all()
        .pipe(Effect.orDie)
      const decided = new Set(
        events
          .filter((e) => e.type === "harness.decision")
          .map((e) => ((e.payload ?? {}) as Record<string, unknown>).finding)
          .filter((f): f is string => typeof f === "string"),
      )
      const openFinding = (entityID: string, kind: string) =>
        events.some(
          (e) =>
            e.type === "harness.finding" &&
            e.entity_id === entityID &&
            ((e.payload ?? {}) as Record<string, unknown>).kind === kind &&
            !decided.has(e.id),
        )
      const lastEventAt = new Map<string, number>()
      for (const e of events) {
        if (!lastEventAt.has(e.entity_id)) lastEventAt.set(e.entity_id, e.time_created ?? 0)
      }
      type Finding = { kind: string; entityKind: string; entityID: string; action: string; evidence: Record<string, unknown> }
      const findings: Finding[] = []
      for (const task of tasks) {
        if (task.status === "done" || task.status === "cancelled") continue
        const taskRuns = runs
          .filter((r) => r.task_id === task.id)
          .sort((a, b) => b.attempt - a.attempt || (b.time_created ?? 0) - (a.time_created ?? 0))
        if (taskRuns.length >= 2 && taskRuns[0].status === "failed" && taskRuns[1].status === "failed") {
          if (!openFinding(task.id, "fail-streak"))
            findings.push({ kind: "fail-streak", entityKind: "task", entityID: task.id, action: "attach-verifier", evidence: { failedAttempts: [taskRuns[0].attempt, taskRuns[1].attempt] } })
        }
        if ((task.status === "running" || task.status === "verifying") && (now - (lastEventAt.get(task.id) ?? 0) > stallMs)) {
          if (!openFinding(task.id, "stalled"))
            findings.push({ kind: "stalled", entityKind: "task", entityID: task.id, action: "pause-stalled", evidence: { idleMs: now - (lastEventAt.get(task.id) ?? 0) } })
        }
        const cap = task.scope?.max_tokens ?? null
        if (cap !== null) {
          const spent = yield* budgetLedger.spend({ taskID: task.id })
          if (spent >= 0.8 * cap && !openFinding(task.id, "budget-hot"))
            findings.push({ kind: "budget-hot", entityKind: "task", entityID: task.id, action: "request-budget", evidence: { spent, cap } })
        }
      }
      const goals = yield* db
        .select()
        .from(CvisProjectGoalTable)
        .where(and(eq(CvisProjectGoalTable.project_id, ProjectV2.ID.make(input.projectID)), eq(CvisProjectGoalTable.status, "active")))
        .all()
        .pipe(Effect.orDie)
      for (const goal of goals) {
        if (goal.budget_tokens === null) continue
        const spent = yield* budgetLedger.spend({ goalID: goal.id })
        if (spent >= 0.8 * goal.budget_tokens && !openFinding(goal.id, "budget-hot"))
          findings.push({ kind: "budget-hot", entityKind: "goal", entityID: goal.id, action: "request-budget", evidence: { spent, cap: goal.budget_tokens } })
      }
      const out: { eventID: string; kind: string; entityID: string; action: string }[] = []
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            for (const f of findings) {
              const eventID = newID("evt")
              yield* recordEvent(tx, { projectID: input.projectID, entity: f.entityKind, entityID: f.entityID, type: "harness.finding", payload: { kind: f.kind, action: f.action, evidence: f.evidence, status: "proposed", by: input.actorSessionID } })
              const created = yield* tx
                .select({ id: CvisEventTable.id })
                .from(CvisEventTable)
                .where(and(eq(CvisEventTable.entity_id, f.entityID), eq(CvisEventTable.type, "harness.finding")))
                .orderBy(desc(CvisEventTable.sequence))
                .limit(1)
                .all()
              out.push({ eventID: created[0]?.id ?? eventID, kind: f.kind, entityID: f.entityID, action: f.action })
            }
          }),
        )
        .pipe(Effect.orDie)
      return out
    })

    const applyFinding = Effect.fn("Cvis.applyFinding")(function* (input: {
      findingEventID: string
      actorSessionID: string
      approve?: boolean
    }) {
      const finding = yield* db.select().from(CvisEventTable).where(eq(CvisEventTable.id, input.findingEventID)).get().pipe(Effect.orDie)
      if (!finding || finding.type !== "harness.finding")
        return yield* new NotFoundError({ entity: "finding", id: input.findingEventID })
      const payload = (finding.payload ?? {}) as Record<string, unknown>
      if (payload.status !== "proposed")
        return yield* new ConflictError({ entity: "finding", id: finding.id, reason: "finding already decided" })
      const prior = yield* db.select().from(CvisEventTable).where(eq(CvisEventTable.type, "harness.decision")).all().pipe(Effect.orDie)
      if (prior.some((e) => ((e.payload ?? {}) as Record<string, unknown>).finding === finding.id))
        return yield* new ConflictError({ entity: "finding", id: finding.id, reason: "finding already decided" })
      yield* requireProjectParticipant({ projectID: finding.project_id, actorSessionID: input.actorSessionID, managerOnly: true })
      const approve = input.approve ?? true
      let result: Record<string, unknown> = {}
      if (approve) {
        const action = String(payload.action ?? "")
        const entityID = finding.entity_id
        if (action === "attach-verifier") {
          const task = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, entityID)).get().pipe(Effect.orDie)
          if (!task) return yield* new NotFoundError({ entity: "task", id: entityID })
          if (task.status === "done" || task.status === "cancelled")
            return yield* new InvalidTransitionError({ entity: "task", id: task.id, from: task.status, to: "task already closed" })
          const review = yield* createTask({
            projectID: task.project_id,
            goalID: task.goal_id ?? undefined,
            title: `Review ${task.title}`.slice(0, 120),
            role: "verifier",
            scope: { review_task_id: task.id, review_revision: task.revision },
          })
          const spawned = yield* spawnSession({ projectID: task.project_id, actorSessionID: input.actorSessionID, role: "verifier", taskID: review.id, title: `hook verifier for ${task.id.slice(0, 8)}` })
          result = { reviewTask: review.id, session: spawned.sessionID }
        } else if (action === "pause-stalled") {
          yield* pauseTask({ taskID: entityID, reason: "harness hook: stalled with no recent events" })
          result = { paused: entityID }
        } else if (action === "request-budget") {
          const kind = finding.entity_kind === "goal" ? ("goal" as const) : ("task" as const)
          const extended = yield* requestBudgetExtension({ kind, id: entityID, actorSessionID: input.actorSessionID })
          result = { extended }
        } else {
          return yield* new InvalidTransitionError({ entity: "finding", id: finding.id, from: action, to: "unknown hook action" })
        }
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* recordEvent(tx, { projectID: finding.project_id, entity: finding.entity_kind, entityID: finding.entity_id, type: "harness.decision", payload: { finding: finding.id, approved: approve, action: String(payload.action ?? ""), result, by: input.actorSessionID } })
          }),
        )
        .pipe(Effect.orDie)
      return { finding: finding.id, action: String(payload.action ?? ""), approved: approve }
    })

    // Skill distill pipeline (item 7, automatic half): observe done tasks
    // grouped by role; groups at/above threshold get a DRAFT SKILL.md in
    // the worktree plus a skill.distilled event and a manager inbox
    // question. The write-approval gate stays: nothing enters the
    // allowlist without explicit manager promotion.
    const distillSkills = Effect.fn("Cvis.distillSkills")(function* (input: {
      projectID: string
      actorSessionID: string
      minRepeats?: number
    }) {
      yield* requireProjectParticipant({ projectID: input.projectID, actorSessionID: input.actorSessionID, managerOnly: false })
      const minRepeats = input.minRepeats ?? 3
      if (!Number.isSafeInteger(minRepeats) || minRepeats < 2 || minRepeats > 10)
        return yield* new InvalidTransitionError({ entity: "skill", id: input.projectID, from: String(input.minRepeats), to: "minRepeats must be 2..10" })
      const project = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, ProjectV2.ID.make(input.projectID)))
        .get()
        .pipe(Effect.orDie)
      if (!project) return yield* new NotFoundError({ entity: "project", id: input.projectID })
      const done = yield* db
        .select()
        .from(CvisTaskTable)
        .where(and(eq(CvisTaskTable.project_id, ProjectV2.ID.make(input.projectID)), eq(CvisTaskTable.status, "done")))
        .all()
        .pipe(Effect.orDie)
      const groups = new Map<string, typeof done>()
      for (const task of done) {
        const list = groups.get(task.role) ?? []
        list.push(task)
        groups.set(task.role, list)
      }
      const distilled = yield* db
        .select()
        .from(CvisEventTable)
        .where(and(eq(CvisEventTable.project_id, ProjectV2.ID.make(input.projectID)), eq(CvisEventTable.type, "skill.distilled")))
        .all()
        .pipe(Effect.orDie)
      const haveDraft = new Set(
        distilled.map((e) => String(((e.payload ?? {}) as Record<string, unknown>).role ?? "")),
      )
      const worktree = canonicalPath(project.worktree)
      const drafts: { role: string; count: number; path: string }[] = []
      for (const [role, tasks] of groups) {
        if (tasks.length < minRepeats || haveDraft.has(role)) continue
        const runs = tasks.length
          ? yield* db
              .select()
              .from(CvisTaskRunTable)
              .where(inArray(CvisTaskRunTable.task_id, tasks.map((t) => t.id)))
              .all()
              .pipe(Effect.orDie)
          : []
        const tokens = runs.map((r) => r.tokens_used ?? 0)
        const avgTokens = tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : null
        const dirName = `auto-${role}-${tasks.length}x`
        const dir = path.join(worktree, ".cvis", "skills", dirName)
        const skillName = `${role}-flow`
        const body = [
          `# ${skillName}`,
          ``,
          `DRAFT distilled from ${tasks.length} completed ${role} tasks. Manager review required before allowlist promotion.`,
          ``,
          `## Observed pattern`,
          ``,
          ...tasks.slice(0, 10).map((t) => `- ${t.title}`),
          ``,
          `## Stats`,
          ``,
          `- completions: ${tasks.length}`,
          `- runs: ${runs.length}`,
          `- avg tokens/run: ${avgTokens ?? "unknown"}`,
          ``,
          `## Procedure (refine me)`,
          ``,
          `1. Claim a ${role} task in this project.`,
          `2. Follow the acceptance checklist, verify each item with evidence.`,
          `3. Report progress; submit the run for verification.`,
          ``,
        ].join("\n")
        const text = renderSkillFile({
          name: skillName,
          description: `Distilled ${role} workflow from ${tasks.length} completed tasks in this project. DRAFT pending manager review.`,
          body,
        })
        const target = path.join(dir, "SKILL.md")
        const written = yield* Effect.exit(
          Effect.tryPromise({
            try: async () => {
              await mkdir(dir, { recursive: true })
              await writeFile(target, text, { flag: "wx" })
            },
            catch: (cause) => cause,
          }),
        )
        if (written._tag === "Failure") continue
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* recordEvent(tx, { projectID: input.projectID, entity: "project", entityID: input.projectID, type: "skill.distilled", payload: { role, count: tasks.length, runs: runs.length, avgTokens, path: target, by: input.actorSessionID } })
            }),
          )
          .pipe(Effect.orDie)
        const managers = yield* db
          .select()
          .from(CvisSessionBindingTable)
          .where(and(eq(CvisSessionBindingTable.project_id, ProjectV2.ID.make(input.projectID)), eq(CvisSessionBindingTable.role, "manager")))
          .all()
          .pipe(Effect.orDie)
        const managerSession = managers.find((m) => m.status === "busy" || m.status === "idle")?.session_id
        if (managerSession) {
          yield* sendMessage({
            projectID: input.projectID,
            fromSession: input.actorSessionID,
            toSession: managerSession,
            kind: "question",
            body: { kind: "skill-approval", role, count: tasks.length, path: target },
            idempotencyKey: `skill-distill-${input.projectID}-${role}`,
          }).pipe(Effect.orElseSucceed(() => undefined))
        }
        drafts.push({ role, count: tasks.length, path: target })
      }
      return drafts
    })

    const reviewReady = Effect.fn("Cvis.reviewReady")(function* (input: { sessionID: string }) {
      const actor = yield* db.select().from(CvisSessionBindingTable).where(eq(CvisSessionBindingTable.session_id, input.sessionID)).get().pipe(Effect.orDie)
      if (!actor || actor.role !== "verifier" || !actor.task_id || actor.status !== "busy") return false
      const job = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, actor.task_id)).get().pipe(Effect.orDie)
      if (!job?.scope?.review_task_id || job.status !== "running") return false
      const target = yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, job.scope.review_task_id)).get().pipe(Effect.orDie)
      if (!target || target.project_id !== job.project_id || target.goal_id !== job.goal_id || target.revision !== job.scope.review_revision) return false
      const gate = yield* doneGate(target.id)
      if (!gate.ok) return false
      const checks = yield* db.select().from(CvisCheckTable).where(eq(CvisCheckTable.task_id, target.id)).all().pipe(Effect.orDie)
      return checks.length > 0 && checks.every((check) => check.verifier_session === input.sessionID && check.verdict === "pass" && check.revision === target.revision && check.run_id === target.active_run_id)
    })

    const managedTransitions: Record<string, string[]> = {
      planning: ["ready", "archived"],
      ready: ["active", "archived"],
      active: ["paused", "completed", "archived"],
      paused: ["active", "archived"],
      completed: [],
      archived: [],
    }

    const registerManagedProject = Effect.fn("Cvis.registerManagedProject")(function* (input: {
      slug: string
      type?: string
      owner?: string
      mission?: string
      metadata?: Record<string, unknown>
    }) {
      if (!/^[a-z][a-z0-9-]{1,47}$/.test(input.slug))
        return yield* new InvalidTransitionError({ entity: "managed-project", id: input.slug, from: "", to: "slug must match [a-z][a-z0-9-]{1,47}" })
      const type = input.type ?? "work"
      if (!(ManagedProjectType as readonly string[]).includes(type))
        return yield* new InvalidTransitionError({ entity: "managed-project", id: input.slug, from: "", to: `unknown type: ${type}` })
      const existing = yield* db
        .select()
        .from(CvisManagedProjectTable)
        .where(eq(CvisManagedProjectTable.slug, input.slug))
        .get()
        .pipe(Effect.orDie)
      if (existing) return { id: existing.id }
      const id = newID("mp")
      yield* db
        .insert(CvisManagedProjectTable)
        .values({
          id,
          slug: input.slug,
          type,
          owner: input.owner ?? "",
          mission: input.mission ?? "",
          status: "planning",
          metadata: input.metadata ?? null,
        })
        .run()
        .pipe(Effect.orDie)
      return { id }
    })

    const getManagedProject = Effect.fn("Cvis.getManagedProject")(function* (input: { id?: string; slug?: string }) {
      const row = yield* (input.id
        ? db.select().from(CvisManagedProjectTable).where(eq(CvisManagedProjectTable.id, input.id)).get()
        : input.slug
          ? db.select().from(CvisManagedProjectTable).where(eq(CvisManagedProjectTable.slug, input.slug)).get()
          : Effect.succeed(undefined)).pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "managed-project", id: input.id ?? input.slug ?? "" })
      return row
    })

    const listManagedProjects = Effect.fn("Cvis.listManagedProjects")(function* (input: { status?: string }) {
      if (input.status !== undefined && !(ManagedProjectStatus as readonly string[]).includes(input.status))
        return yield* new InvalidTransitionError({ entity: "managed-project", id: "", from: "", to: `unknown status: ${input.status}` })
      if (input.status === undefined) return yield* db.select().from(CvisManagedProjectTable).all().pipe(Effect.orDie)
      return yield* db
        .select()
        .from(CvisManagedProjectTable)
        .where(eq(CvisManagedProjectTable.status, input.status))
        .all()
        .pipe(Effect.orDie)
    })

    const linkManagedProject = Effect.fn("Cvis.linkManagedProject")(function* (input: { id: string; nativeProjectID: string }) {
      const managed = yield* db
        .select()
        .from(CvisManagedProjectTable)
        .where(eq(CvisManagedProjectTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (!managed) return yield* new NotFoundError({ entity: "managed-project", id: input.id })
      const native = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, ProjectV2.ID.make(input.nativeProjectID)))
        .get()
        .pipe(Effect.orDie)
      if (!native)
        return yield* new InvalidTransitionError({ entity: "managed-project", id: input.id, from: "", to: "native project not found" })
      if (managed.native_project_id === input.nativeProjectID) return
      const occupant = yield* db
        .select()
        .from(CvisManagedProjectTable)
        .where(eq(CvisManagedProjectTable.native_project_id, input.nativeProjectID))
        .get()
        .pipe(Effect.orDie)
      if (occupant)
        return yield* new ConflictError({ entity: "managed-project", id: input.id, reason: `native project already linked to ${occupant.slug}` })
      yield* db
        .update(CvisManagedProjectTable)
        .set({ native_project_id: input.nativeProjectID })
        .where(eq(CvisManagedProjectTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
    })

    const setManagedProjectStatus = Effect.fn("Cvis.setManagedProjectStatus")(function* (input: { id: string; status: string }) {
      if (!(ManagedProjectStatus as readonly string[]).includes(input.status))
        return yield* new InvalidTransitionError({ entity: "managed-project", id: input.id, from: "", to: `unknown status: ${input.status}` })
      const managed = yield* db
        .select()
        .from(CvisManagedProjectTable)
        .where(eq(CvisManagedProjectTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (!managed) return yield* new NotFoundError({ entity: "managed-project", id: input.id })
      if (!(managedTransitions[managed.status] ?? []).includes(input.status))
        return yield* new InvalidTransitionError({ entity: "managed-project", id: input.id, from: managed.status, to: input.status })
      yield* db
        .update(CvisManagedProjectTable)
        .set({ status: input.status })
        .where(eq(CvisManagedProjectTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
    })

    const registerSchedule = Effect.fn("Cvis.registerSchedule")(function* (input: {
      managedProjectID: string
      name: string
      kind?: string
      payload?: Record<string, unknown>
      intervalSeconds?: number
      nextDueAt?: number
    }) {
      const managed = yield* db
        .select()
        .from(CvisManagedProjectTable)
        .where(eq(CvisManagedProjectTable.id, input.managedProjectID))
        .get()
        .pipe(Effect.orDie)
      if (!managed) return yield* new NotFoundError({ entity: "managed-project", id: input.managedProjectID })
      if (!/^[a-z][a-z0-9-]{1,79}$/.test(input.name))
        return yield* new InvalidTransitionError({ entity: "schedule", id: input.name, from: "", to: "name must match [a-z][a-z0-9-]{1,79}" })
      if (
        input.intervalSeconds !== undefined &&
        (!Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds <= 0)
      )
        return yield* new InvalidTransitionError({ entity: "schedule", id: input.name, from: "", to: "interval must be a positive integer number of seconds" })
      const existing = yield* db
        .select()
        .from(CvisScheduleTable)
        .where(
          and(
            eq(CvisScheduleTable.managed_project_id, input.managedProjectID),
            eq(CvisScheduleTable.name, input.name),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (existing) return { id: existing.id }
      const id = newID("sch")
      yield* db
        .insert(CvisScheduleTable)
        .values({
          id,
          managed_project_id: input.managedProjectID,
          name: input.name,
          kind: input.kind?.trim() ? input.kind.trim().slice(0, 40) : "health",
          payload: input.payload ?? null,
          interval_seconds: input.intervalSeconds ?? null,
          next_due_at: input.nextDueAt ?? Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return { id }
    })

    const getSchedule = Effect.fn("Cvis.getSchedule")(function* (input: { id: string }) {
      const row = yield* db.select().from(CvisScheduleTable).where(eq(CvisScheduleTable.id, input.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "schedule", id: input.id })
      return row
    })

    const listSchedules = Effect.fn("Cvis.listSchedules")(function* (input: { managedProjectID?: string }) {
      if (input.managedProjectID === undefined)
        return yield* db.select().from(CvisScheduleTable).all().pipe(Effect.orDie)
      return yield* db
        .select()
        .from(CvisScheduleTable)
        .where(eq(CvisScheduleTable.managed_project_id, input.managedProjectID))
        .all()
        .pipe(Effect.orDie)
    })

    const setScheduleEnabled = Effect.fn("Cvis.setScheduleEnabled")(function* (input: { id: string; enabled: boolean }) {
      const row = yield* db.select().from(CvisScheduleTable).where(eq(CvisScheduleTable.id, input.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ entity: "schedule", id: input.id })
      yield* db
        .update(CvisScheduleTable)
        .set({ enabled: input.enabled ? 1 : 0 })
        .where(eq(CvisScheduleTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
    })

    const claimDueSchedule = Effect.fn("Cvis.claimDueSchedule")(function* (input: { owner: string; leaseMs?: number; now?: number }) {
      if (!input.owner.trim())
        return yield* new InvalidTransitionError({ entity: "schedule", id: "", from: "", to: "owner required" })
      const now = input.now ?? Date.now()
      const leaseMs = input.leaseMs ?? 300_000
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0)
        return yield* new InvalidTransitionError({ entity: "schedule", id: "", from: "", to: "lease must be a positive integer number of milliseconds" })
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const due = yield* tx
              .select()
              .from(CvisScheduleTable)
              .where(and(eq(CvisScheduleTable.enabled, 1), lte(CvisScheduleTable.next_due_at, now)))
              .orderBy(asc(CvisScheduleTable.next_due_at), asc(CvisScheduleTable.id))
              .all()
            const candidate = due.find((row) => row.lease_expires == null || row.lease_expires <= now)
            if (!candidate) return undefined
            const claimed = yield* tx
              .update(CvisScheduleTable)
              .set({ lease_owner: input.owner, lease_expires: now + leaseMs })
              .where(
                and(
                  eq(CvisScheduleTable.id, candidate.id),
                  or(isNull(CvisScheduleTable.lease_expires), lte(CvisScheduleTable.lease_expires, now)),
                  eq(CvisScheduleTable.enabled, 1),
                ),
              )
              .returning()
              .all()
            return claimed[0]
          }),
        )
        .pipe(Effect.orDie)
    })

    const completeScheduleRun = Effect.fn("Cvis.completeScheduleRun")(function* (input: { id: string; owner: string; status: string }) {
      if (input.status !== "ok" && input.status !== "failed")
        return yield* new InvalidTransitionError({ entity: "schedule", id: input.id, from: "", to: "status must be ok or failed" })
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx.select().from(CvisScheduleTable).where(eq(CvisScheduleTable.id, input.id)).get()
            if (!row) return yield* new NotFoundError({ entity: "schedule", id: input.id })
            if (row.lease_owner == null || row.lease_owner !== input.owner)
              return yield* new ConflictError({ entity: "schedule", id: input.id, reason: "lease held by another owner or not claimed" })
            const now = Date.now()
            yield* tx
              .update(CvisScheduleTable)
              .set({
                lease_owner: null,
                lease_expires: null,
                last_status: input.status,
                last_run_at: now,
                consecutive_failures: input.status === "failed" ? row.consecutive_failures + 1 : 0,
                next_due_at: row.interval_seconds != null ? now + row.interval_seconds : row.next_due_at,
                enabled: row.interval_seconds != null ? row.enabled : 0,
              })
              .where(eq(CvisScheduleTable.id, input.id))
              .run()
          }),
        )
        .pipe(Effect.orDie)
    })

    return Service.of({
      buildRuleset,
      projectSnapshot,
      taskDetail,
      listTemplates,
      createTemplate,
      renderTemplate,
      setTemplateStatus,
      setTemplateRollout,
      templateMetrics,
      importPromptLibrary,
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
      sweepOrphanedTasks,
      runCheckCommand,
      remindTask,
      reportTask,
      listTaskEvents,
      spawnSession,
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
      updateGoalBudget,
      updateTaskBudget,
      requestBudgetExtension,
      proposeCapability,
      setCapabilityStatus,
      listCapabilities,
      probeMcpCapability,
      installPlugin,
      importSkillDir,
      exportSkill,
      setManagedMetadata,
      analyzeTraces,
      applyFinding,
      distillSkills,
      reviewReady,
      registerManagedProject,
      getManagedProject,
      listManagedProjects,
      linkManagedProject,
      setManagedProjectStatus,
      registerSchedule,
      getSchedule,
      listSchedules,
      setScheduleEnabled,
      claimDueSchedule,
      completeScheduleRun,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node, FSUtil.node, Session.node, SessionRunState.node],
})

export * as Orchestration from "./service"
