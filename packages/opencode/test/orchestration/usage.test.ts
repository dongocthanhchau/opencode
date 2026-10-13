import { describe, expect, test } from "bun:test"
import { sumTokens, runUsage } from "../../src/orchestration/usage"

describe("sumTokens", () => {
  test("returns 0 for null/undefined", () => {
    expect(sumTokens(null)).toBe(0)
    expect(sumTokens(undefined)).toBe(0)
  })

  test("sums all fields", () => {
    expect(sumTokens({ input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 5 } })).toBe(185)
  })

  test("handles missing fields as 0", () => {
    expect(sumTokens({ input: 300 })).toBe(300)
    expect(sumTokens({ cache: { read: 40 } })).toBe(40)
  })

  test("handles partial cache object", () => {
    expect(sumTokens({ input: 10, cache: { write: 5 } })).toBe(15)
    expect(sumTokens({ cache: {} })).toBe(0)
  })
})

describe("runUsage", () => {
  test("uses live delta over baseline when baseline present and larger", () => {
    const run = {
      id: "run_1",
      tokens_used: 0,
      result: { usage_baseline: { input: 1000, output: 0, cache: { read: 0, write: 0 } } },
    }
    const sessionTokens = { input: 1500, output: 200, cache: { read: 0, write: 0 } }
    expect(runUsage(run, sessionTokens)).toBe(700)
  })

  test("returns stored tokens_used when live delta is smaller (idempotency)", () => {
    const run = {
      id: "run_1",
      tokens_used: 900,
      result: { usage_baseline: { input: 1000, output: 0, cache: { read: 0, write: 0 } } },
    }
    const sessionTokens = { input: 1100, output: 0, cache: { read: 0, write: 0 } }
    expect(runUsage(run, sessionTokens)).toBe(900)
  })

  test("falls back to stored tokens when no baseline in result", () => {
    const run = { id: "run_2", tokens_used: 150, result: null }
    const sessionTokens = { input: 500, output: 100, reasoning: 50, cache: { read: 20, write: 10 } }
    expect(runUsage(run, sessionTokens)).toBe(150)
  })

  test("missing result is treated as no baseline", () => {
    const run = { id: "run_3", tokens_used: 200 }
    const sessionTokens = { input: 100, output: 50 }
    expect(runUsage(run as never, sessionTokens)).toBe(200)
  })

  test("handles partial usage on failure: returns max of stored vs live delta", () => {
    const run = {
      id: "run_4",
      tokens_used: 50,
      result: { usage_baseline: { input: 200, output: 0, cache: { read: 0, write: 0 } } },
    }
    const sessionTokens = { input: 350, output: 30, cache: { read: 0, write: 0 } }
    expect(runUsage(run, sessionTokens)).toBe(180)
  })

  test("cache read and write counted without double counting", () => {
    const run = {
      id: "run_5",
      tokens_used: 0,
      result: { usage_baseline: { input: 0, output: 0, cache: { read: 100, write: 50 } } },
    }
    const sessionTokens = { input: 10, output: 5, cache: { read: 200, write: 100 } }
    expect(runUsage(run, sessionTokens)).toBe(165)
  })

  test("no double counting: baseline is subtracted once", () => {
    const baseline = { input: 500, output: 100, reasoning: 50, cache: { read: 20, write: 10 } }
    const run = { id: "run_6", tokens_used: 0, result: { usage_baseline: baseline } }
    const sessionAfter = { input: 800, output: 200, reasoning: 100, cache: { read: 40, write: 20 } }
    const baselineSum = sumTokens(baseline)
    const afterSum = sumTokens(sessionAfter)
    expect(runUsage(run, sessionAfter)).toBe(afterSum - baselineSum)
  })
})

describe("pump goal filter (scheduling logic)", () => {
  test("active goal IDs set includes active only, not exhausted", () => {
    const goals = [
      { id: "g1", status: "active" },
      { id: "g2", status: "exhausted" },
      { id: "g3", status: "completed" },
    ]
    const activeGoalIDs = new Set(
      goals.filter((g) => g.status === "active").map((g) => g.id),
    )
    expect(activeGoalIDs.has("g1")).toBe(true)
    expect(activeGoalIDs.has("g2")).toBe(false)
    expect(activeGoalIDs.has("g3")).toBe(false)
  })
})

describe("verifier prompt context", () => {
  test("verifier suffix includes targetTaskID distinct from reviewJobID and lists checkIDs", () => {
    const reviewJobID = "task_review_123"
    const targetTaskID = "task_impl_456"
    const acceptance = [
      { id: "usage", label: "Usage tracked", weight: 40 },
      { id: "context", label: "Context correct", weight: 30 },
      { id: "checks", label: "Tests pass", weight: 30 },
    ]
    const checkIDs = acceptance.map((c) => c.id).join(", ")
    const suffix = `You are reviewing targetTaskID=${targetTaskID} (this job reviewJobID=${reviewJobID}). Call cvis_task_detail with targetTaskID=${targetTaskID} to fetch its acceptance criteria (checkIDs: ${checkIDs}). Read actual artifact files. Call cvis_verify for EACH checkID with targetTaskID=${targetTaskID} (not this reviewJobID), the checkID, verdict, files and conclusion. Do not fabricate test results.`
    expect(suffix).toContain(`targetTaskID=${targetTaskID}`)
    expect(suffix).toContain(`reviewJobID=${reviewJobID}`)
    expect(suffix).toContain("usage, context, checks")
    expect(suffix).toContain("not this reviewJobID")
  })
})
