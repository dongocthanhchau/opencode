import { Cause, Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CvisProjectGoalTable, CvisSessionBindingTable, CvisTaskRunTable, CvisTaskTable } from "@opencode-ai/core/orchestration/sql"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"
import { Orchestration } from "./service"
import { estimate } from "@/util/token"
import { runUsage } from "./usage"

export interface Interface {
  execute: (input: {
    taskID: string
    sessionID: string
  }) => Effect.Effect<{ runID: string; status: string; text: string }, unknown>
  pump: (input: {
    managerSessionID: string
  }) => Effect.Effect<{ taskID: string; runID: string; status: string; text: string }[], unknown>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/CvisHarness") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const instances = yield* InstanceStore.Service
    const orchestration = yield* Orchestration.Service
    const rawTimeoutMs = parseInt(process.env["CVIS_EXECUTION_TIMEOUT_MS"] ?? "", 10)
    const executionTimeoutMs = isNaN(rawTimeoutMs) ? 180_000 : Math.min(900_000, Math.max(1_000, rawTimeoutMs))

    const finalizeUsage = Effect.fn("CvisHarness.finalizeUsage")(function* (runID: string, sessionID: string) {
      const run = yield* db
        .select()
        .from(CvisTaskRunTable)
        .where(eq(CvisTaskRunTable.id, runID))
        .get()
        .pipe(Effect.orDie)
      if (!run) return
      const latest = yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.orDie)
      const used = runUsage(run, latest.tokens)
      const existingResult = (run.result as Record<string, unknown> | null) ?? {}
      yield* db
        .update(CvisTaskRunTable)
        .set({
          tokens_used: used,
          result: {
            ...existingResult,
            usage_finalized: true,
            usage_end_time: Date.now(),
          },
        })
        .where(eq(CvisTaskRunTable.id, runID))
        .run()
        .pipe(Effect.orDie)
    })

    const execute = Effect.fn("CvisHarness.execute")(function* (input: { taskID: string; sessionID: string }) {
      const session = yield* sessions.get(SessionID.make(input.sessionID))
      return yield* instances.provide(
        { directory: session.directory },
        Effect.scoped(
          Effect.gen(function* () {
            const claim = yield* orchestration.claimTask(input)
            yield* orchestration.setRunStatus({ id: claim.runID, status: "running" })
            const task = yield* db
              .select()
              .from(CvisTaskTable)
              .where(eq(CvisTaskTable.id, input.taskID))
              .get()
              .pipe(Effect.orDie)
            if (!task) return yield* Effect.fail(new Error("Claimed task missing"))
            const pack = yield* orchestration.contextPack({ taskID: task.id })
            const templateName =
              task.role === "verifier"
                ? "verify"
                : task.role === "researcher"
                  ? "research"
                  : task.role === "manager"
                    ? "plan"
                    : "implement"
            const rendered = yield* orchestration.renderTemplate({
              name: templateName,
              // Canary rollout bucket: the same task always renders the
              // same version, and the used version lands in run.result
              // so templateMetrics can compare stable vs canary.
              bucketKey: task.id,
              vars: {
                goal: task.title,
                requirements: "Use the authoritative CVIS system context.",
                topic: task.title,
                objective: task.title,
                acceptance: "Use the authoritative acceptance checklist in CVIS system context.",
                scope: "Use the runtime-enforced scope in CVIS system context.",
                constraints: "Use the runtime-enforced constraints in CVIS system context.",
              },
            })
            const isVerifier = task.role === "verifier" && task.scope?.review_task_id
            const targetTaskID = isVerifier ? task.scope!.review_task_id : null
            const targetTask = targetTaskID
              ? yield* db
                  .select()
                  .from(CvisTaskTable)
                  .where(eq(CvisTaskTable.id, targetTaskID))
                  .get()
                  .pipe(Effect.orDie)
              : null
            const checkIDs = (targetTask?.acceptance ?? task.acceptance ?? []).map((c) => c.id).join(", ")
            const verifierSuffix = isVerifier
              ? `You are reviewing targetTaskID=${targetTaskID} (this job reviewJobID=${task.id}). Call cvis_task_detail with targetTaskID=${targetTaskID} to fetch its acceptance criteria (checkIDs: ${checkIDs}). Read actual artifact files. Call cvis_verify for EACH checkID with targetTaskID=${targetTaskID} (not this reviewJobID), the checkID, verdict, files and conclusion. Do not fabricate test results.`
              : "Perform the task using permitted read/edit/write tools. cvis tools coordinate tasks, they do not write source. Report actual changed files and outcomes."
            const text = `${rendered.text}\n\nAssignment: ${task.id}, revision ${task.revision}. Follow the CURRENT TASK DESCRIPTION exactly, including phase restrictions and instructions not to edit. The overall goal and acceptance checklist do not authorize skipping phases or widening the current assignment. Full authoritative requirements, scope and checkpoint are supplied in system context.\n\n${verifierSuffix}`
            const messageID = MessageID.ascending()
            const baseline = estimate(`${rendered.text}\n${JSON.stringify(pack)}\n${JSON.stringify(pack)}`)
            yield* db
              .update(CvisTaskRunTable)
              .set({
                result: {
                  prompt_start_id: messageID,
                  prompt_tokens_estimate: estimate(text),
                  repeated_context_baseline_estimate: baseline,
                  usage_baseline: session.tokens,
                  template: { name: templateName, version: rendered.version, status: rendered.status },
                },
              })
              .where(eq(CvisTaskRunTable.id, claim.runID))
              .run()
              .pipe(Effect.orDie)
            const heartbeat = Effect.repeat(
              Effect.sleep("20 seconds").pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    db
                      .update(CvisTaskRunTable)
                      .set({ lease_expires: Date.now() + 120_000 })
                      .where(eq(CvisTaskRunTable.id, claim.runID))
                      .run()
                      .pipe(Effect.orDie),
                  ),
                ),
              ),
              { while: () => true },
            )
            yield* heartbeat.pipe(Effect.forkScoped)
            const outcome = yield* prompt
              .prompt({
                sessionID: session.id,
                messageID,
                agent: task.role === "verifier" ? "plan" : "build",
                parts: [{ type: "text", text }],
              })
              .pipe(
                Effect.timeout(executionTimeoutMs),
                Effect.exit,
                Effect.ensuring(
                  finalizeUsage(claim.runID, input.sessionID).pipe(
                    Effect.uninterruptible,
                    Effect.catchCause((cause) => Effect.logError("CVIS usage finalization failed", { runID: claim.runID, error: Cause.pretty(cause) })),
                  ),
                ),
              )
            const execution = yield* db
              .select({ status: CvisTaskRunTable.status, result: CvisTaskRunTable.result })
              .from(CvisTaskRunTable)
              .where(eq(CvisTaskRunTable.id, claim.runID))
              .get()
              .pipe(Effect.orDie)
            if (execution?.status === "cancelled" || execution?.status === "failed")
              return {
                runID: claim.runID,
                status: execution.status,
                text: "Execution interrupted; late output was not applied",
              }
            if (outcome._tag === "Failure") {
              yield* orchestration
                .setRunStatus({ id: claim.runID, status: "failed", error: Cause.pretty(outcome.cause) })
                .pipe(Effect.catchCause(() => Effect.void))
              return { runID: claim.runID, status: "failed", text: Cause.pretty(outcome.cause) }
            }
            const response = outcome.value
            const verifiedReceipts = task.role === "verifier" && task.scope?.review_task_id && (yield* orchestration.reviewReady({ sessionID: input.sessionID }))
            const output = response.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n") || (verifiedReceipts ? "Backend receipt summary: all current acceptance checks passed independent artifact verification" : "")
            if (!output.trim() && response.info.role === "assistant" && !response.info.error) {
              yield* orchestration.setRunStatus({ id: claim.runID, status: "failed", error: "Provider returned an empty delivery" })
              return { runID: claim.runID, status: "failed", text: "Provider returned an empty delivery; no verified completion was recorded" }
            }
            if (response.info.role !== "assistant" || response.info.error) {
              yield* orchestration.setRunStatus({
                id: claim.runID,
                status: "failed",
                error: JSON.stringify(response.info),
              })
              return { runID: claim.runID, status: "failed", text: output }
            }
            const latest = yield* sessions.get(session.id)
            const runRow = yield* db
              .select()
              .from(CvisTaskRunTable)
              .where(eq(CvisTaskRunTable.id, claim.runID))
              .get()
              .pipe(Effect.orDie)
            const used = runRow ? runUsage(runRow, latest.tokens) : 0
            yield* orchestration.submitResult({
              runID: claim.runID,
              tokensUsed: used,
              result: {
                text: output,
                prompt_start_id: messageID,
                prompt_tokens_estimate: estimate(text),
                repeated_context_baseline_estimate: baseline,
                usage_baseline: session.tokens,
                usage_finalized: true,
                usage_end_time: Date.now(),
              },
            })
            if (task.role === "verifier" && task.scope?.review_task_id) {
              const settlement = yield* orchestration.settleReview(input).pipe(Effect.exit)
              if (settlement._tag === "Failure") {
                yield* orchestration.setRunStatus({
                  id: claim.runID,
                  status: "failed",
                  error: Cause.pretty(settlement.cause),
                })
                return { runID: claim.runID, status: "failed", text: output }
              }
              return { runID: claim.runID, status: "done", text: output }
            }
            return { runID: claim.runID, status: "verifying", text: output }
          }),
        ),
      )
    })
    const pump = Effect.fn("CvisHarness.pump")(function* (input: { managerSessionID: string }) {
      const manager = yield* sessions.get(SessionID.make(input.managerSessionID))
      const managerRow = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, manager.id))
        .get()
        .pipe(Effect.orDie)
      const binding = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, manager.id))
        .get()
        .pipe(Effect.orDie)
      if (
        !binding ||
        !managerRow ||
        managerRow.time_archived !== null ||
        binding.role !== "manager" ||
        binding.status !== "idle" ||
        binding.project_id !== manager.projectID
      )
        return yield* Effect.fail(new Error("Idle project manager required"))
      const outcomes: { taskID: string; runID: string; status: string; text: string }[] = []
      return yield* instances.provide(
        { directory: manager.directory },
        Effect.gen(function* () {
          for (let step = 0; step < 10; step++) {
            const tasks = yield* db
              .select()
              .from(CvisTaskTable)
              .where(eq(CvisTaskTable.project_id, manager.projectID))
              .all()
              .pipe(Effect.orDie)
            const goals = yield* db
              .select()
              .from(CvisProjectGoalTable)
              .where(eq(CvisProjectGoalTable.project_id, manager.projectID))
              .all()
              .pipe(Effect.orDie)
            const activeGoalIDs = new Set(
              goals.filter((g) => g.status === "active").map((g) => g.id),
            )
            const task = tasks
              .filter((t) => t.status === "queued" && (!t.goal_id || activeGoalIDs.has(t.goal_id)))
              .sort((a, b) => b.priority - a.priority || a.time_created - a.time_created)[0]
            if (!task) break
            const worker = yield* sessions.create({
              parentID: manager.id,
              title: `CVIS ${task.role}: ${task.title}`,
              agent: task.role === "verifier" ? "plan" : "build",
              permission: binding.permission_ceiling ?? [],
              metadata: { cvis: { role: task.role, manager: manager.id } },
            })
            yield* orchestration.bindSession({
              sessionID: worker.id,
              projectID: manager.projectID,
              role: task.role as never,
              managerSession: manager.id,
            })
            yield* orchestration.sendMessage({
              projectID: manager.projectID,
              fromSession: manager.id,
              toSession: worker.id,
              taskID: task.id,
              kind: "assign",
              body: { taskID: task.id, revision: task.revision },
              idempotencyKey: `assign:${task.id}:${task.revision}:${task.attempt + 1}`,
            })
            const result = yield* execute({ taskID: task.id, sessionID: worker.id })
            yield* orchestration.sendMessage({
              projectID: manager.projectID,
              fromSession: worker.id,
              toSession: manager.id,
              taskID: task.id,
              runID: result.runID,
              kind: "result",
              body: { status: result.status, text: result.text },
              idempotencyKey: `result:${result.runID}`,
            })
            outcomes.push({ taskID: task.id, ...result })
            if (result.status === "failed") break
            if (result.status === "verifying" && task.role !== "verifier") {
              const review = yield* orchestration.createTask({
                projectID: task.project_id,
                goalID: task.goal_id ?? undefined,
                title: `Review: ${task.title}`,
                role: "verifier",
                description: `Independently inspect actual artifacts for task ${task.id}. Acceptance checkIDs: ${(task.acceptance ?? []).map((c) => c.id).join(", ")}. Call cvis_task_detail with targetTaskID=${task.id} to fetch current criteria. Call cvis_verify for EACH checkID with targetTaskID, checkID, verdict, files and conclusion. Do not fabricate test results.`,
                scope: {
                  read_paths: task.scope?.read_paths?.length ? task.scope.read_paths : task.scope?.write_paths,
                  review_task_id: task.id,
                  review_revision: task.revision,
                } as never,
              })
              yield* db
                .update(CvisTaskTable)
                .set({ weight: 0 })
                .where(eq(CvisTaskTable.id, review.id))
                .run()
                .pipe(Effect.orDie)
              yield* orchestration.setTaskStatus({ id: review.id, status: "queued" })
            }
          }
          return outcomes
        }),
      )
    })
    return Service.of({ execute, pump })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Session.node, SessionPrompt.node, InstanceStore.node, Orchestration.node],
})
export * as OrchestrationHarness from "./harness"
