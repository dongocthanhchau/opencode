import { describe, expect, test } from "bun:test"
import { checklistProgress } from "../../src/orchestration/machine"

const items = [
  { id: "cause", label: "Root cause found", weight: 20 },
  { id: "fix", label: "Fix implemented", weight: 50 },
  { id: "verify", label: "Verification passed", weight: 30 },
]

describe("checklistProgress", () => {
  test("empty acceptance yields zero without dividing", () => {
    expect(checklistProgress([], new Set(["x"]))).toEqual({ percent: 0, passed: [], pending: [] })
  })
  test("weights decide percent, agent claims do not", () => {
    expect(checklistProgress(items, new Set(["cause"]))).toEqual({ percent: 20, passed: ["cause"], pending: ["fix", "verify"] })
    expect(checklistProgress(items, new Set(["cause", "fix"])).percent).toBe(70)
    expect(checklistProgress(items, new Set(["cause", "fix", "verify"])).percent).toBe(100)
  })
  test("unknown check IDs never count", () => {
    expect(checklistProgress(items, new Set(["nope"]))).toEqual({ percent: 0, passed: [], pending: ["cause", "fix", "verify"] })
  })
  test("removed checklist items drop out after revision", () => {
    const revised = items.filter((item) => item.id !== "cause")
    expect(checklistProgress(revised, new Set(["cause", "fix"]))).toEqual({ percent: 62, passed: ["fix"], pending: ["verify"] })
  })
  test("re-verified items count once", () => {
    expect(checklistProgress(items, ["fix", "fix"]).percent).toBe(50)
  })
})
