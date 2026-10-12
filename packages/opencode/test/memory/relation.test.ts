import { describe, expect, test } from "bun:test"
import { classifyRelation, splitClaims } from "../../src/memory/capture"

describe("classifyRelation", () => {
  test("undefined cosine is unrelated", () => {
    expect(classifyRelation({ cosine: undefined, sameTopic: true, newClaim: "a", oldClaim: "b" })).toBe("unrelated")
  })
  test("low cosine is unrelated", () => {
    expect(classifyRelation({ cosine: 0.5, sameTopic: true, newClaim: "a", oldClaim: "a" })).toBe("unrelated")
    expect(classifyRelation({ cosine: 0.749, sameTopic: true, newClaim: "a", oldClaim: "a" })).toBe("unrelated")
  })
  test("mid cosine is related regardless of topic or polarity", () => {
    expect(classifyRelation({ cosine: 0.8, sameTopic: false, newClaim: "x is not ready", oldClaim: "x is ready" })).toBe(
      "related",
    )
    expect(classifyRelation({ cosine: 0.75, sameTopic: true, newClaim: "a", oldClaim: "b" })).toBe("related")
  })
  test("near-identical agreeing claims on the same topic supersede", () => {
    expect(
      classifyRelation({
        cosine: 0.95,
        sameTopic: true,
        newClaim: "The proxy listens on port 8010 and serves four models.",
        oldClaim: "The proxy listens on port 8010.",
      }),
    ).toBe("supersedes")
  })
  test("near-identical claims on different topics only link", () => {
    expect(
      classifyRelation({ cosine: 0.95, sameTopic: false, newClaim: "The proxy listens on port 8010.", oldClaim: "The proxy listens on port 8010." }),
    ).toBe("related")
  })
  test("polarity mismatch is contradicts, never supersedes", () => {
    expect(
      classifyRelation({
        cosine: 0.95,
        sameTopic: true,
        newClaim: "The proxy is not enabled on port 8010.",
        oldClaim: "The proxy is enabled on port 8010.",
      }),
    ).toBe("contradicts")
    expect(
      classifyRelation({
        cosine: 0.95,
        sameTopic: true,
        newClaim: "The proxy is enabled on port 8010.",
        oldClaim: "The proxy is deprecated on port 8010.",
      }),
    ).toBe("contradicts")
  })
  test("matching negation on both sides still supersedes", () => {
    expect(
      classifyRelation({
        cosine: 0.95,
        sameTopic: true,
        newClaim: "The legacy port is no longer used by the proxy.",
        oldClaim: "The legacy port is not used by the proxy.",
      }),
    ).toBe("supersedes")
  })
})

describe("splitClaims", () => {
  test("splits bullet lists into separate claims", () => {
    const claims = splitClaims("- Alpha beta gamma delta epsilon\n- Zeta eta theta iota kappa lambda")
    expect(claims.length).toBe(2)
  })
  test("merges fragments shorter than the minimum into the previous chunk", () => {
    const claims = splitClaims("- Alpha beta gamma delta epsilon zeta\nhi")
    expect(claims.length).toBe(1)
    expect(claims[0]).toContain("hi")
  })
  test("caps the number of claims", () => {
    const text = Array.from({ length: 20 }, (_, i) => `- Claim number ${i} with enough padding words here`).join("\n")
    expect(splitClaims(text).length).toBe(12)
  })
})
