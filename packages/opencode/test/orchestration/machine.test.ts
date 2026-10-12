import { describe, expect, test } from "bun:test"
import {
  canTransitionBinding,
  canTransitionGoal,
  canTransitionRun,
  canTransitionTask,
  isTerminalTask,
} from "../../src/orchestration/machine"
import { pathAllowed, roleRules } from "../../src/orchestration/roles"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"

describe("task lifecycle", () => {
  test("happy path draft->queued->running->verifying->done", () => {
    expect(canTransitionTask("draft", "queued")).toBe(true)
    expect(canTransitionTask("queued", "running")).toBe(true)
    expect(canTransitionTask("running", "verifying")).toBe(true)
    expect(canTransitionTask("verifying", "done")).toBe(true)
  })
  test("terminal states never leave", () => {
    expect(canTransitionTask("done", "queued")).toBe(false)
    expect(canTransitionTask("cancelled", "running")).toBe(false)
    expect(isTerminalTask("done")).toBe(true)
    expect(isTerminalTask("cancelled")).toBe(true)
    expect(isTerminalTask("failed")).toBe(false)
  })
  test("failure and repair loop back through queue", () => {
    expect(canTransitionTask("running", "failed")).toBe(true)
    expect(canTransitionTask("failed", "queued")).toBe(true)
    expect(canTransitionTask("verifying", "running")).toBe(true)
  })
  test("pause and block resume through queue, never straight to done", () => {
    expect(canTransitionTask("paused", "queued")).toBe(true)
    expect(canTransitionTask("blocked", "queued")).toBe(true)
    expect(canTransitionTask("paused", "done")).toBe(false)
    expect(canTransitionTask("running", "done")).toBe(false)
  })
})

describe("goal and run lifecycles", () => {
  test("goal completes only from active, budget pause is not completion", () => {
    expect(canTransitionGoal("active", "completed")).toBe(true)
    expect(canTransitionGoal("paused", "completed")).toBe(false)
    expect(canTransitionGoal("blocked", "completed")).toBe(false)
    expect(canTransitionGoal("planning", "completed")).toBe(false)
  })
  test("run results never overwrite: done and failed are terminal", () => {
    expect(canTransitionRun("verifying", "done")).toBe(true)
    expect(canTransitionRun("done", "verifying")).toBe(false)
    expect(canTransitionRun("failed", "running")).toBe(false)
  })
  test("binding tracks worker occupancy", () => {
    expect(canTransitionBinding("idle", "busy")).toBe(true)
    expect(canTransitionBinding("busy", "idle")).toBe(true)
    expect(canTransitionBinding("paused", "busy")).toBe(false)
  })
})

describe("role permissions", () => {
  test("researcher cannot edit, run shell, or spawn subagents", () => {
    const rules = roleRules("researcher")
    expect(rules).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(rules).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
  })
  test("verifier cannot edit source", () => {
    expect(roleRules("verifier")).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
  })
  test("subagent inherits parent denies and cannot escalate to task/todo", () => {
    const rules = deriveSubagentSessionPermission({
      parentSessionPermission: [
        { permission: "edit", pattern: "/secret/*", action: "deny" },
        { permission: "bash", pattern: "*", action: "allow" },
      ],
      subagent: { permission: [] } as never,
    })
    expect(rules).toContainEqual({ permission: "edit", pattern: "/secret/*", action: "deny" })
    expect(rules).toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
    expect(rules).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(rules.some((r) => r.permission === "bash" && r.action === "allow")).toBe(false)
  })
})

describe("task write scope", () => {
  test("allows files under scope roots only", () => {
    expect(pathAllowed("/repo/src/memory/capture.ts", ["/repo/src/memory"])).toBe(true)
    expect(pathAllowed("/repo/src/other/x.ts", ["/repo/src/memory"])).toBe(false)
    expect(pathAllowed("/repo/src/memory", ["/repo/src/memory"])).toBe(true)
  })
  test("rejects parent traversal outright", () => {
    expect(pathAllowed("/repo/src/memory/../../etc/passwd", ["/repo/src"])).toBe(false)
  })
})
