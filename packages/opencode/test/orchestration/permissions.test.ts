import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Permission } from "../../src/permission"
import { checkResolvedPaths, effectiveRuleset, mcpDenyRules, validateScope } from "../../src/orchestration/roles"

const decide = (
  rules: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[],
  permission: string,
  pattern: string,
) => Permission.evaluate(permission, pattern, rules as never).action

describe("effective ruleset enforcement", () => {
  test("implementer edits inside scope, denied outside", () => {
    const rules = effectiveRuleset({ role: "implementer", scope: { write_paths: ["src/memory"] } })
    expect(decide(rules, "edit", "src/memory/capture.ts")).toBe("allow")
    expect(decide(rules, "edit", "src/memory")).toBe("allow")
    expect(decide(rules, "edit", "src/other/x.ts")).toBe("deny")
    expect(decide(rules, "edit", "etc/passwd")).toBe("deny")
  })
  test("researcher stays read-only even with a write scope", () => {
    const rules = effectiveRuleset({ role: "researcher", scope: { write_paths: ["src/memory"], tools: ["bash"] } })
    expect(decide(rules, "edit", "src/memory/capture.ts")).toBe("deny")
    expect(decide(rules, "bash", "ls")).toBe("deny")
    expect(decide(rules, "read", "src/memory/capture.ts")).toBe("allow")
    expect(decide(rules, "webfetch", "https://example.com")).toBe("allow")
  })
  test("verifier cannot bypass read-only source through unrestricted shell", () => {
    const rules = effectiveRuleset({ role: "verifier", scope: { tools: ["bash"] } })
    expect(decide(rules, "bash", "bun test")).toBe("deny")
    expect(decide(rules, "bash", 'python3 -c \'open("src/a.ts","w").write("changed")\'')).toBe("deny")
    expect(decide(rules, "edit", "src/memory/capture.ts")).toBe("deny")
    expect(decide(rules, "task", "coder")).toBe("deny")
  })
  test("implementer without an explicit bash grant is denied, never left hanging on ask", () => {
    const rules = effectiveRuleset({ role: "implementer", scope: { write_paths: ["src"] } })
    expect(decide(rules, "bash", "ls")).toBe("deny")
  })
  test("outside-instance access is denied by default", () => {
    const rules = effectiveRuleset({ role: "implementer", scope: { write_paths: ["src"] } })
    expect(decide(rules, "external_directory", "/etc/*")).toBe("deny")
  })
  test("composed sets are decisive for scoped tools", () => {
    for (const role of ["implementer", "researcher", "verifier"] as const) {
      const rules = effectiveRuleset({ role, scope: { write_paths: ["src"], tools: ["bash"] } })
      for (const [permission, pattern] of [
        ["edit", "src/a.ts"],
        ["edit", "other/b.ts"],
        ["bash", "ls"],
        ["task", "coder"],
        ["todowrite", "*"],
        ["read", "src/a.ts"],
      ] as const) {
        expect(decide(rules, permission, pattern)).not.toBe("ask")
      }
    }
  })
  test("scope cannot widen role denies for non-edit tools", () => {
    const rules = effectiveRuleset({ role: "implementer", scope: { tools: ["task"] } })
    expect(decide(rules, "task", "coder")).toBe("deny")
  })
  test("project deny is not overridden by task scope", () => {
    const rules = effectiveRuleset({
      role: "implementer",
      projectRules: [{ permission: "edit", pattern: "src/private/*", action: "deny" }],
      scope: { write_paths: ["src"] },
    })
    expect(decide(rules, "edit", "src/private/key.ts")).toBe("deny")
  })
  test("generic tools grant cannot override file scope", () => {
    const rules = effectiveRuleset({
      role: "implementer",
      scope: { write_paths: ["src/allowed"], tools: ["edit", "write", "apply_patch"] },
    })
    expect(decide(rules, "edit", "src/forbidden.ts")).toBe("deny")
  })
  test("read paths restrict access", () => {
    const rules = effectiveRuleset({ role: "researcher", scope: { read_paths: ["src/public"] } })
    expect(decide(rules, "read", "src/public/data.ts")).toBe("allow")
    expect(decide(rules, "read", "src/private/data.ts")).toBe("deny")
  })
})

describe("scope validation", () => {
  test("rejects traversal, outside worktree, and project-deny overlap", () => {
    expect(validateScope({ write_paths: ["src/../../etc"] }, {})).toHaveLength(1)
    expect(validateScope({ write_paths: ["/other/x"] }, { worktree: "/repo" })).toHaveLength(1)
    expect(validateScope({ write_paths: ["/repo/src"] }, { worktree: "/repo" })).toHaveLength(0)
    expect(validateScope({ write_paths: ["src/secret"] }, { projectDenies: ["src/secret"] })).toHaveLength(1)
    expect(validateScope({ write_paths: ["src"] }, { projectDenies: ["src/secret"] })).toHaveLength(1)
    expect(validateScope({ write_paths: ["src/other"] }, { projectDenies: ["src/secret"] })).toHaveLength(0)
  })
})

describe("symlink escapes", () => {
  test("links resolving outside the worktree are flagged", () => {
    const base = mkdtempSync(join(tmpdir(), "cvis-scope-"))
    const outside = mkdtempSync(join(tmpdir(), "cvis-outside-"))
    const link = join(base, "leak")
    symlinkSync(outside, link)
    const target = join(base, "sub", "file.ts")
    mkdirSync(join(base, "sub"), { recursive: true })
    writeFileSync(target, "x")
    const resolved = [
      { original: "leak", resolved: realpathSync(link) },
      { original: "sub/file.ts", resolved: realpathSync(target) },
      { original: "missing.ts", resolved: null },
    ]
    const out = checkResolvedPaths(base, resolved)
    expect(out.escapes).toEqual(["leak"])
    expect(out.missing).toEqual(["missing.ts"])
  })
})

describe("mcp tool hiding", () => {
  test("deny rules hide listed MCP tools through visibleTools", () => {
    const tools = { github_get_issue: {}, read: {} }
    const rules = mcpDenyRules(["github_get_issue"], [])
    expect(Object.keys(Permission.visibleTools(tools, rules as never))).toEqual(["read"])
  })
  test("allowlisted MCP tools stay visible", () => {
    const tools = { github_get_issue: {}, slack_post: {} }
    const rules = mcpDenyRules(["github_get_issue", "slack_post"], ["slack_post"])
    expect(Object.keys(Permission.visibleTools(tools, rules as never))).toEqual(["slack_post"])
  })
  test("newly connected MCP tools stay denied", () => {
    const rules = mcpDenyRules(["known_read"], [])
    expect(Object.keys(Permission.visibleTools({ known_read: {}, unexpected_write: {} }, rules))).toEqual([])
  })
})
