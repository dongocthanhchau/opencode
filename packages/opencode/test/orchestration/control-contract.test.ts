import { describe, it, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { TaskScopeSchema } from "@/orchestration/control-tool"
import { serviceErrorMessage } from "@/orchestration/control"

describe("orchestration contract", () => {
  it("TaskScopeSchema preserves max_tokens and validates positive finite integer", () => {
    const decoded = Schema.decodeSync(TaskScopeSchema)({
      max_tokens: 1500,
      commands: ["npm test"],
      review_task_id: "task_123",
      review_revision: 2,
    })
    expect(decoded.max_tokens).toBe(1500)
    expect(decoded.review_revision).toBe(2)

    expect(() => Schema.decodeSync(TaskScopeSchema)({ max_tokens: 0 })).toThrow()
    expect(() => Schema.decodeSync(TaskScopeSchema)({ max_tokens: -5 })).toThrow()
    expect(() => Schema.decodeSync(TaskScopeSchema)({ review_revision: 0 })).toThrow()
  })

  it("serviceErrorMessage formats errors correctly", () => {
    const err = new Error("simple error")
    expect(serviceErrorMessage(err)).toBe("simple error")
    const tagged = { _tag: "ErrTag", entity: "goal", id: "1", reason: "bad" }
    expect(serviceErrorMessage(tagged)).toBe("ErrTag entity:goal id:1 reason:bad")
  })
})
