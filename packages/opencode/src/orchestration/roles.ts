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
      ]
    case "implementer":
      return [{ permission: "task", pattern: "*", action: "deny" }]
    case "verifier":
      return [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
      ]
    case "maintenance":
      return [
        { permission: "edit", pattern: "*", action: "ask" },
        { permission: "task", pattern: "*", action: "deny" },
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

export * as OrchestrationRoles from "./roles"
