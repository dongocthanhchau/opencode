import { describe, expect, test } from "bun:test"
import { renderTemplate } from "../../src/orchestration/templates"

describe("renderTemplate", () => {
  test("substitutes provided vars", () => {
    const out = renderTemplate("Do {{task}} in {{scope}}.", [{ name: "task", required: true }], {
      task: "fix login",
      scope: "src/auth",
    })
    expect(out).toEqual({ ok: true, text: "Do fix login in src/auth." })
  })
  test("missing required input fails closed with names", () => {
    expect(renderTemplate("Do {{task}}.", [{ name: "task", required: true }], {})).toEqual({
      ok: false,
      missing: ["task"],
    })
    expect(renderTemplate("Do {{task}}.", [{ name: "task", required: true }], { task: "  " })).toEqual({
      ok: false,
      missing: ["task"],
    })
  })
  test("optional inputs may be absent", () => {
    expect(
      renderTemplate("A {{x}}.", [{ name: "x", required: false }], {}),
    ).toEqual({ ok: true, text: "A {{x}}." })
  })
  test("original request text is preserved verbatim", () => {
    const request = "Fix login, but keep legacy OAuthv1 flow intact!"
    const out = renderTemplate("Request: {{request}}", [{ name: "request", required: true }], { request })
    expect(out).toEqual({ ok: true, text: `Request: ${request}` })
  })
})
