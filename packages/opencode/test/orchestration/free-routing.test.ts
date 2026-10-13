import { expect, test } from "bun:test"
import { routeCandidates, retryableRoute, cooldownDuration, safeToReroute, modelKey } from "../../src/provider/free-routing"
import type { RouteModel } from "../../src/provider/free-routing"

function model(providerID: string, id: string, price = 0, tools = true): RouteModel {
  return { providerID, id, status: "active", cost: { input: price, output: price, cache: { read: 0, write: 0 } }, capabilities: { toolcall: tools }, limit: { context: 100000 } } as RouteModel
}
const options = { attempted: new Set<string>(), estimatedInput: 1000, needsTools: true }

test("free OpenCode precedes LiteLLM then Cline regardless of input order", () => {
  const rows = [model("cline", "cline-free/x"), model("cvis-litellm", "x"), model("opencode", "new-free")]
  expect(routeCandidates(rows, options).map(modelKey)).toEqual(["opencode/new-free", "cvis-litellm/x", "cline/cline-free/x"])
})
test("catalog churn uses current names and excludes paid or unsupported models", () => {
  expect(routeCandidates([model("opencode", "paid", 1), model("opencode", "no-tools", 0, false), model("other", "free"), model("opencode", "new")], options).map(modelKey)).toEqual(["opencode/new"])
  expect(String(routeCandidates([model("opencode", "replacement")], options)[0].id)).toBe("replacement")
})
test("cooldowns expire and quota can cool the whole OpenCode provider", () => {
  const rows = [model("opencode", "x"), model("cvis-litellm", "x")]
  expect(String(routeCandidates(rows, { ...options, now: 100, cooldowns: new Map([["opencode/*", 200]]) })[0].providerID)).toBe("cvis-litellm")
  expect(String(routeCandidates(rows, { ...options, now: 201, cooldowns: new Map([["opencode/*", 200]]) })[0].providerID)).toBe("opencode")
})
test("bounded attempts reserve fallbacks after two free candidates fail", () => {
  const rows = [model("opencode", "c"), model("cvis-litellm", "x"), model("cline", "x")]
  const attempted = new Set(["opencode/a", "opencode/b"])
  expect(String(routeCandidates(rows, { ...options, attempted })[0].providerID)).toBe("cvis-litellm")
  attempted.add("cvis-litellm/x")
  expect(String(routeCandidates(rows, { ...options, attempted })[0].providerID)).toBe("cline")
  attempted.add("cline/x")
  expect(routeCandidates(rows, { ...options, attempted })).toEqual([])
})
test("policy denials and user aborts never trigger fallback", () => {
  for (const message of ["permission denied", "task scope invalid", "budget exhausted", "cancelled", "context length limit"])
    expect(retryableRoute({ name: "APIError", data: { statusCode: 500, message } })).toBe(false)
  expect(retryableRoute({ name: "MessageAbortedError", data: { message: "timeout" } })).toBe(false)
  expect(retryableRoute({ name: "APIError", data: { statusCode: 429 } })).toBe(true)
  expect(retryableRoute({ name: "APIError", data: { statusCode: 404 } })).toBe(true)
  expect(retryableRoute({ name: "APIError", data: { statusCode: 410, message: "Model exo-free has been deprecated." } })).toBe(true)
})
test("partial output or tool effects cannot be replayed through failover", () => {
  expect(safeToReroute([])).toBe(true)
  expect(safeToReroute([{ type: "text", text: "partial answer" }])).toBe(false)
  expect(safeToReroute([{ type: "tool", state: { status: "completed" } }])).toBe(false)
  expect(safeToReroute([{ type: "tool", state: { status: "pending" } }])).toBe(false)
})
test("retry-after is honored but bounded", () => {
  expect(cooldownDuration({ data: { responseHeaders: { "retry-after": "3600" } } }, 0)).toBe(3600000)
  expect(cooldownDuration({ data: { responseHeaders: { "retry-after": "9999999999" } } }, 0)).toBe(86400000)
})

test("unknown configured context is not treated as zero capacity", () => {
  const fallback = model("cline", "cline-free/mimo")
  fallback.limit.context = 0
  expect(routeCandidates([fallback], options)).toHaveLength(1)
  expect(routeCandidates([model("cvis-litellm", "auto-no-tool")], options)).toHaveLength(0)
})
