import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { realpathSync } from "node:fs"
import path from "node:path"

export const Role = ["manager", "researcher", "implementer", "verifier", "maintenance"] as const
export type Role = (typeof Role)[number]
export type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }
export const READ_TOOLS = ["read", "glob", "grep"] as const

export interface TaskScope {
  read_paths?: string[]
  write_paths?: string[]
  tools?: string[]
  commands?: string[]
  max_tokens?: number
  allow_outside?: boolean
  review_task_id?: string
  review_revision?: number
}

export function roleRules(role: Role): Rule[] {
  if (!Role.includes(role)) throw new Error(`Unknown session role: ${role}`)
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...READ_TOOLS.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "skill", pattern: "*", action: "allow" },
    { permission: "cvis_control", pattern: "*", action: "allow" },
    ...[
      "cvis_create_task",
      "cvis_queue_task",
      "cvis_task_detail",
      "cvis_verify",
      "cvis_revise_task",
      "cvis_snapshot",
      "cvis_goal_status",
    ].map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    ...(role === "researcher"
      ? ["webfetch", "websearch"].map((permission) => ({ permission, pattern: "*", action: "allow" as const }))
      : []),
    ...(role === "manager"
      ? ["task", "todowrite"].map((permission) => ({ permission, pattern: "*", action: "allow" as const }))
      : []),
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    ...(role !== "manager"
      ? ["task", "todowrite"].map((permission) => ({ permission, pattern: "*", action: "deny" as const }))
      : []),
  ]
}

function rootsRules(permission: string, roots: string[]): Rule[] {
  return roots.flatMap((root) => {
    const base = root.replace(/\/+$/, "") || "/"
    return [base, `${base}/*`].map((pattern) => ({ permission, pattern, action: "allow" as const }))
  })
}

export function effectiveRuleset(input: { projectRules?: Rule[]; role: Role; scope?: TaskScope }): Rule[] {
  const scope = input.scope ?? {}
  const base = roleRules(input.role)
  const rules: Rule[] = [...base]
  if (scope.read_paths?.length) {
    rules.push({ permission: "read", pattern: "*", action: "deny" }, ...rootsRules("read", scope.read_paths))
  }
  if (input.role === "implementer" || input.role === "maintenance") {
    rules.push(...rootsRules("edit", scope.write_paths ?? []))
  }
  rules.push({ permission: "external_directory", pattern: "*", action: "deny" })
  rules.push(...(input.projectRules ?? []).filter((rule) => rule.action === "deny"))
  return rules
}

export function ceilingAllows(rules: Rule[], permission: string, pattern: string): boolean {
  const matches = rules.filter(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  if (matches.some((rule) => rule.action === "deny")) return false
  if (!rules.some((rule) => rule.action === "allow")) return true
  return matches.some((rule) => rule.action === "allow")
}

export function toRuleset(rules: Rule[]): PermissionV1.Ruleset {
  return rules
}

export function pathAllowed(target: string, roots: string[]): boolean {
  if (target.split(/[\\/]/).includes("..")) return false
  const normalized = path.resolve("/", target)
  return roots.some((root) => {
    const base = path.resolve("/", root)
    return normalized === base || normalized.startsWith(base === "/" ? "/" : `${base}/`)
  })
}

export function canonicalPath(target: string): string {
  let current = path.resolve(target)
  const suffix: string[] = []
  for (;;) {
    try {
      return path.join(realpathSync(current), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}

export function validateScope(scope: TaskScope, input: { worktree?: string; projectDenies?: string[] }): string[] {
  const errors: string[] = []
  for (const root of [...(scope.write_paths ?? []), ...(scope.read_paths ?? [])]) {
    if (!root.trim()) {
      errors.push("empty scope path")
      continue
    }
    if (root.split(/[\\/]/).includes("..")) {
      errors.push(`scope escapes with ..: ${root}`)
      continue
    }
    if (input.worktree && path.isAbsolute(root) && !pathAllowed(root, [input.worktree]))
      errors.push(`scope outside worktree: ${root}`)
    for (const deny of input.projectDenies ?? []) {
      if (pathAllowed(root, [deny]) || pathAllowed(deny, [root]))
        errors.push(`scope overlaps project deny: ${root} vs ${deny}`)
    }
  }
  if (scope.allow_outside) errors.push("task scope cannot grant outside-project access")
  return errors
}

export function scopesOverlap(a: TaskScope, b: TaskScope): boolean {
  return (a.write_paths ?? []).some((x) =>
    (b.write_paths ?? []).some((y) => pathAllowed(x, [y]) || pathAllowed(y, [x])),
  )
}

export function checkResolvedPaths(
  worktree: string,
  resolved: { original: string; resolved: string | null }[],
): { escapes: string[]; missing: string[] } {
  return {
    escapes: resolved
      .filter((entry) => entry.resolved !== null && !pathAllowed(entry.resolved, [worktree]))
      .map((entry) => entry.original),
    missing: resolved.filter((entry) => entry.resolved === null).map((entry) => entry.original),
  }
}

export function mcpDenyRules(toolIDs: string[], allowed: string[]): Rule[] {
  const known = new Set(toolIDs)
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...READ_TOOLS.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    ...allowed
      .filter((id) => known.has(id))
      .map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
  ]
}

export * as OrchestrationRoles from "./roles"
