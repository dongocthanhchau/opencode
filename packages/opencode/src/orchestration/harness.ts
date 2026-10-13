import { Cause, Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CvisSessionBindingTable, CvisTaskRunTable, CvisTaskTable } from "@opencode-ai/core/orchestration/sql"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"
import { Orchestration } from "./service"
import { estimate } from "@/util/token"

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
            const rendered = yield* orchestration.renderTemplate({
              name:
                task.role === "verifier"
                  ? "verify"
                  : task.role === "researcher"
                    ? "research"
                    : task.role === "manager"
                      ? "plan"
                      : "implement",
              vars: {
                goal: task.description || task.title,
                requirements: task.description || task.title,
                topic: task.title,
                objective: task.description || task.title,
                acceptance: JSON.stringify(task.acceptance),
                scope: JSON.stringify(task.scope),
                constraints: JSON.stringify(task.scope),
              },
            })
            const text = `${rendered.text}\n\nAssignment: ${task.id}, revision ${task.revision}. Full authoritative goal, scope, acceptance and checkpoint are supplied in system context.\n\n${task.scope?.review_task_id ? `You are reviewing task ${task.scope.review_task_id}. Call cvis_task_detail with taskID. Read actual files with read. Call cvis_verify for EACH acceptance checkID with taskID, checkID, verdict, files and conclusion directly. Do not nest fields under arguments. Do not report test execution unless a real test result is available.` : "Perform the task using permitted read/edit/write tools. cvis tools coordinate tasks, they do not write source. Report actual changed files and outcomes."}`
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
              .pipe(Effect.timeout("3 minutes"), Effect.exit)
            const execution = yield* db
              .select({ status: CvisTaskRunTable.status })
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
            const output = response.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
            if (response.info.role !== "assistant" || response.info.error) {
              yield* orchestration.setRunStatus({
                id: claim.runID,
                status: "failed",
                error: JSON.stringify(response.info),
              })
              return { runID: claim.runID, status: "failed", text: output }
            }
            const latest = yield* sessions.get(session.id)
            const totals = (tokens: Session.Info["tokens"]) =>
              (tokens?.input ?? 0) +
              (tokens?.output ?? 0) +
              (tokens?.reasoning ?? 0) +
              (tokens?.cache.read ?? 0) +
              (tokens?.cache.write ?? 0)
            const used = Math.max(0, totals(latest.tokens) - totals(session.tokens))
            yield* orchestration.submitResult({
              runID: claim.runID,
              tokensUsed: used,
              result: {
                text: output,
                prompt_start_id: messageID,
                prompt_tokens_estimate: estimate(text),
                repeated_context_baseline_estimate: baseline,
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
      const binding = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, manager.id))
        .get()
        .pipe(Effect.orDie)
      if (
        !binding ||
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
            const task = tasks
              .filter((t) => t.status === "queued")
              .sort((a, b) => b.priority - a.priority || a.time_created - b.time_created)[0]
            if (!task) break
            const pool = yield* db
              .select()
              .from(CvisSessionBindingTable)
              .where(eq(CvisSessionBindingTable.project_id, manager.projectID))
              .all()
              .pipe(Effect.orDie)
            const available = pool.find(
              (worker) => worker.role === task.role && worker.status === "idle" && !worker.task_id,
            )
            const worker = available
              ? yield* sessions.get(SessionID.make(available.session_id))
              : yield* sessions.create({
                  parentID: manager.id,
                  title: `CVIS ${task.role}: ${task.title}`,
                  agent: task.role === "verifier" ? "plan" : "build",
                  permission: binding.permission_ceiling ?? [],
                  metadata: { cvis: { role: task.role, manager: manager.id } },
                })
            if (!available)
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
                description: `Independently inspect actual artifacts for task ${task.id}. Read its acceptance criteria. Record pass/fail for each criterion using cvis_control verify with actual file paths. Do not fabricate test results.`,
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
