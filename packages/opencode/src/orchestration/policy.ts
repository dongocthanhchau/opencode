import { Context, Effect, Layer, Schema } from "effect"
import { eq, inArray } from "drizzle-orm"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import {
  CvisProjectGoalTable,
  CvisSessionBindingTable,
  CvisTaskTable,
  CvisTaskRunTable,
} from "@opencode-ai/core/orchestration/sql"
import { SessionID } from "@/session/schema"
import { canonicalPath, ceilingAllows, effectiveRuleset, pathAllowed } from "./roles"
import type { Role, TaskScope } from "./roles"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

export class Denied extends Schema.TaggedErrorClass<Denied>()("CvisPolicyDenied", { reason: Schema.String }) {
  override get message() {
    return this.reason
  }
}

export interface Interface {
  authorize: (input: { sessionID: string; tool: string; args: Record<string, unknown> }) => Effect.Effect<void, Denied>
  catalog: (input: { sessionID: string; tools: string[] }) => Effect.Effect<string[]>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/CvisPolicy") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const authorize = Effect.fn("CvisPolicy.authorize")(function* (input: {
      sessionID: string
      tool: string
      args: Record<string, unknown>
    }) {
      const binding = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!binding) return
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!session || session.project_id !== binding.project_id)
        return yield* new Denied({ reason: "Invalid project/session binding" })
      if (binding.status === "paused") return yield* new Denied({ reason: "Session is paused" })
      const project = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, session.project_id))
        .get()
        .pipe(Effect.orDie)
      if (!project) return yield* new Denied({ reason: "Project missing" })
      const task = binding.task_id
        ? yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, binding.task_id)).get().pipe(Effect.orDie)
        : undefined
      if (
        binding.role !== "manager" &&
        (!task || task.project_id !== binding.project_id || task.role !== binding.role)
      ) {
        return yield* new Denied({ reason: "Worker has no valid assigned task" })
      }
      if (task) {
        if (!["running", "verifying"].includes(task.status))
          return yield* new Denied({ reason: `Task is ${task.status}` })
        if (task.goal_id) {
          const goal = yield* db
            .select()
            .from(CvisProjectGoalTable)
            .where(eq(CvisProjectGoalTable.id, task.goal_id))
            .get()
            .pipe(Effect.orDie)
          if (!goal || goal.status !== "active") return yield* new Denied({ reason: "Project goal is not active" })
          if (goal.budget_tokens !== null) {
            const siblings = yield* db
              .select({ id: CvisTaskTable.id })
              .from(CvisTaskTable)
              .where(eq(CvisTaskTable.goal_id, goal.id))
              .all()
              .pipe(Effect.orDie)
            const runs = siblings.length
              ? yield* db
                  .select()
                  .from(CvisTaskRunTable)
                  .where(
                    inArray(
                      CvisTaskRunTable.task_id,
                      siblings.map((item) => item.id),
                    ),
                  )
                  .all()
                  .pipe(Effect.orDie)
              : []
            if (runs.reduce((sum, run) => sum + run.tokens_used, 0) >= goal.budget_tokens)
              return yield* new Denied({ reason: "Project goal token budget exhausted" })
          }
        }
        if (task.scope?.max_tokens !== undefined) {
          const runs = yield* db
            .select()
            .from(CvisTaskRunTable)
            .where(eq(CvisTaskRunTable.task_id, task.id))
            .all()
            .pipe(Effect.orDie)
          if (runs.reduce((sum, run) => sum + run.tokens_used, 0) >= task.scope.max_tokens)
            return yield* new Denied({ reason: "Task token budget exhausted" })
        }
        if (task.active_run_id) {
          const run = yield* db
            .select()
            .from(CvisTaskRunTable)
            .where(eq(CvisTaskRunTable.id, task.active_run_id))
            .get()
            .pipe(Effect.orDie)
          if (
            !run ||
            run.session_id !== input.sessionID ||
            run.revision !== task.revision ||
            !["pending", "running", "verifying"].includes(run.status)
          ) {
            return yield* new Denied({ reason: "Execution attempt is stale or closed" })
          }
        }
      }
      if (task?.status === "verifying" && binding.role !== "verifier" && input.tool !== "cvis_control")
        return yield* new Denied({ reason: "Worker output is locked during verification" })
      if (input.tool === "__turn__") return
      if (["bash", "shell", "code_mode", "code-mode", "task"].includes(input.tool)) {
        return yield* new Denied({
          reason: "Unrestricted execution is not granted to managed sessions; use controlled orchestration operations",
        })
      }
      if (
        [
          "cvis_control",
          "cvis_create_task",
          "cvis_queue_task",
          "cvis_task_detail",
          "cvis_verify",
          "cvis_revise_task",
          "cvis_snapshot",
          "cvis_goal_status",
        ].includes(input.tool)
      )
        return
      const scope = (task?.scope ?? {}) as TaskScope
      const permission = ["edit", "write", "apply_patch"].includes(input.tool) ? "edit" : input.tool
      const rules = effectiveRuleset({
        role: binding.role as Role,
        scope,
        projectRules: binding.permission_ceiling ?? [],
      })
      const root = canonicalPath(session.directory)
      const targetArgs = input.args
      const targets: string[] = []
      if (typeof targetArgs.filePath === "string") targets.push(targetArgs.filePath)
      if (typeof targetArgs.path === "string" && ["glob", "grep"].includes(input.tool)) targets.push(targetArgs.path)
      if (input.tool === "apply_patch") {
        if (typeof targetArgs.patchText !== "string") return yield* new Denied({ reason: "Patch content missing" })
        for (const match of targetArgs.patchText.matchAll(
          /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
        ))
          targets.push(match[1])
        if (!targets.length) return yield* new Denied({ reason: "Patch has no validated file targets" })
      }
      if (["read", "edit", "lsp"].includes(permission) && !targets.length)
        return yield* new Denied({ reason: "File target missing" })
      if (["glob", "grep"].includes(input.tool) && !targets.length) targets.push(root)
      for (const target of targets) {
        const full = canonicalPath(path.resolve(root, target))
        if (!pathAllowed(full, [root])) return yield* new Denied({ reason: `Path escapes project: ${target}` })
        const allowed =
          permission === "edit" ? (scope.write_paths ?? []) : scope.read_paths?.length ? scope.read_paths : [root]
        const roots = allowed.map((r) => canonicalPath(path.resolve(root, r)))
        if (!pathAllowed(full, roots)) return yield* new Denied({ reason: `Path outside task scope: ${target}` })
        const relative = path.relative(root, full).replaceAll("\\", "/")
        if (!ceilingAllows(binding.permission_ceiling ?? [], permission, relative))
          return yield* new Denied({ reason: "Project permission ceiling denies path" })
      }
      const patterns = targets.length
        ? targets.map((target) => path.relative(root, canonicalPath(path.resolve(root, target))).replaceAll("\\", "/"))
        : typeof input.args.url === "string"
          ? [input.args.url]
          : ["*"]
      if (["glob", "grep", "lsp"].includes(permission) && targets.length) return
      for (const pattern of patterns) {
        const rule = rules.findLast(
          (r) => Wildcard.match(permission, r.permission) && Wildcard.match(pattern, r.pattern),
        )
        if (!rule || rule.action !== "allow")
          return yield* new Denied({ reason: `Role/task denies tool: ${input.tool}` })
        if (!ceilingAllows(binding.permission_ceiling ?? [], permission, pattern))
          return yield* new Denied({ reason: "Project permission ceiling denies tool" })
      }
    })
    const catalog = Effect.fn("CvisPolicy.catalog")(function* (input: { sessionID: string; tools: string[] }) {
      const binding = yield* db
        .select()
        .from(CvisSessionBindingTable)
        .where(eq(CvisSessionBindingTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!binding) return input.tools
      const task = binding.task_id
        ? yield* db.select().from(CvisTaskTable).where(eq(CvisTaskTable.id, binding.task_id)).get().pipe(Effect.orDie)
        : undefined
      const allowed = new Set(["read", "glob", "grep", "cvis_task_detail", "cvis_snapshot"])
      if (binding.role === "manager")
        for (const name of [
          "cvis_create_task",
          "cvis_queue_task",
          "cvis_revise_task",
          "cvis_goal_status",
          "cvis_control",
        ])
          allowed.add(name)
      if (binding.role === "verifier") allowed.add("cvis_verify")
      if (["implementer", "maintenance"].includes(binding.role) && task?.scope?.write_paths?.length)
        for (const name of ["edit", "write", "apply_patch"]) allowed.add(name)
      if (binding.role === "researcher") for (const name of ["webfetch", "websearch"]) allowed.add(name)
      return input.tools.filter((name) => allowed.has(name))
    })
    return Service.of({ authorize, catalog })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
export * as OrchestrationPolicy from "./policy"
