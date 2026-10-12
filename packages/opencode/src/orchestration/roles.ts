import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

export const Role = ["manager", "researcher", "implementer", "verifier", "maintenance"] as const
export type Role = (typeof Role)[number]

type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

// Base rulesets per role. These combine with project grants and per-task
// scope at session creation; the runtime always evaluates
// project ∩ role ∩ task, so a role can never widen a project grant.
export function roleRules(role: Role): Rule[] {
  switch (role) {
    case "manager":
      return [
        { permission: "task", pattern: "*", action: "allow" },
        { permission: "todowrite", pattern: "*", action: "allow" },
      ]
    case "researcher":
      return [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "todowrite", pattern: "*", action: "deny" },
        { permission: "webfetch", pattern: "*", action: "allow" },
        { permission: "websearch", pattern: "*", action: "allow" },
      ]
    case "implementer":
      return [
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "todowrite", pattern: "*", action: "deny" },
      ]
    case "verifier":
      return [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "todowrite", pattern: "*", action: "deny" },
      ]
    case "maintenance":
      return [
        { permission: "edit", pattern: "*", action: "ask" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "todowrite", pattern: "*", action: "deny" },
      ]
  }
}

// Pure path containment for task write scopes. Rejects `..` outright;
// symlink resolution needs the filesystem and happens at enforcement time.
export function pathAllowed(path: string, writePaths: string[]): boolean {
  if (path.includes("..")) return false
  const normalized = path.startsWith("/") ? path : `/${path}`
  return writePaths.some((root) => {
    const base = root.startsWith("/") ? root : `/${root}`
    return normalized === base || normalized.startsWith(base.endsWith("/") ? base : `${base}/`)
  })
}

export function toRuleset(rules: Rule[]): PermissionV1.Ruleset {
  return rules as PermissionV1.Ruleset
}

export const READ_TOOLS = ["read", "glob", "grep"] as const

export interface TaskScope {
  read_paths?: string[]
  write_paths?: string[]
  tools?: string[]
  max_tokens?: number
  allow_outside?: boolean
}

function deniesTool(rules: Rule[], tool: string): boolean {
  return rules.some((rule) => rule.permission === tool && rule.pattern === "*" && rule.action === "deny")
}

// Scope may only narrow a role, never widen it: edit and tool allows from
// the task scope are emitted only when the role itself does not deny them.
export function effectiveRuleset(input: { projectRules?: Rule[]; role: Role; scope?: TaskScope }): Rule[] {
  const scope = input.scope ?? {}
  const base = roleRules(input.role)
  const roleEditDenies = base.filter((rule) => rule.permission === "edit" && rule.action === "deny")
  const roleRest = base.filter((rule) => !(rule.permission === "edit" && rule.action === "deny"))
  const rules: Rule[] = [...(input.projectRules ?? []), ...roleRest]
  const scoped = (scope.write_paths ?? []).length > 0
  if (scoped || input.role === "implementer" || input.role === "maintenance") {
    rules.push({ permission: "edit", pattern: "*", action: "deny" })
  }
  if (roleEditDenies.length === 0) {
    for (const root of scope.write_paths ?? []) {
      const rel = root.replace(/\/+$/, "")
      rules.push({ permission: "edit", pattern: rel, action: "allow" })
      rules.push({ permission: "edit", pattern: `${rel}/*`, action: "allow" })
    }
  }
  for (const tool of scope.tools ?? []) {
    if (deniesTool(base, tool)) continue
    rules.push({ permission: tool, pattern: "*", action: "allow" })
  }
  for (const tool of READ_TOOLS) {
    if (deniesTool(base, tool)) continue
    rules.push({ permission: tool, pattern: "*", action: "allow" })
  }
  if (!deniesTool(base, "bash")) {
    const allowBash = (scope.tools ?? []).includes("bash")
    rules.push({ permission: "bash", pattern: "*", action: allowBash ? "allow" : "deny" })
  }
  rules.push(...roleEditDenies)
  if (!scope.allow_outside) {
    rules.push({ permission: "external_directory", pattern: "*", action: "deny" })
  }
  return rules
}

// Explicit deny rules for every connected MCP tool except the allowlist.
// MCP tools have no ask gate, so hiding via disabled()/visibleTools is the
// enforcement mechanism; unknown future tools stay visible and must be
// vetted at claim time.
export function mcpDenyRules(toolIDs: string[], allowed: string[]): Rule[] {
  const keep = new Set(allowed)
  return toolIDs
    .filter((id) => !keep.has(id))
    .map((id) => ({ permission: id, pattern: "*", action: "deny" as const }))
}

// Pure claim-time validation: rejects escapes and overlaps with project
// denies before any session is bound. Symlink targets need the filesystem
// and are checked by resolveScopePaths.
export function validateScope(
  scope: TaskScope,
  input: { worktree?: string; projectDenies?: string[] },
): string[] {
  const errors: string[] = []
  const roots = [...(scope.write_paths ?? []), ...(scope.read_paths ?? [])]
  for (const root of roots) {
    if (!root || root.trim().length === 0) {
      errors.push("empty scope path")
      continue
    }
    if (root.split("/").includes("..")) {
      errors.push(`scope escapes with ..: ${root}`)
      continue
    }
    if (input.worktree && root.startsWith("/")) {
      const base = input.worktree.replace(/\/+$/, "")
      if (root !== base && !root.startsWith(`${base}/`)) {
        errors.push(`scope outside worktree: ${root}`)
      }
    }
  }
  for (const deny of input.projectDenies ?? []) {
    const clean = deny.replace(/\/+$/, "")
    for (const root of roots) {
      const rel = root.replace(/\/+$/, "")
      if (rel === clean || rel.startsWith(`${clean}/`) || clean.startsWith(`${rel}/`)) {
        errors.push(`scope overlaps project deny: ${root} vs ${deny}`)
      }
    }
  }
  return errors
}

// Pure half of symlink enforcement: given already-resolved absolute paths,
// report entries outside the worktree. Callers resolve with realpath first
// (service method resolveScopePaths) so symlinks cannot smuggle paths out.
export function checkResolvedPaths(
  worktree: string,
  resolved: { original: string; resolved: string | null }[],
): { escapes: string[]; missing: string[] } {
  const base = worktree.replace(/\/+$/, "")
  const escapes: string[] = []
  const missing: string[] = []
  for (const entry of resolved) {
    if (entry.resolved == null) {
      missing.push(entry.original)
      continue
    }
    if (entry.resolved !== base && !entry.resolved.startsWith(`${base}/`)) {
      escapes.push(entry.original)
    }
  }
  return { escapes, missing }
}

export * as OrchestrationRoles from "./roles"
