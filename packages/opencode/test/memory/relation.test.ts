import { describe, expect, test } from "bun:test"
import { classifyRelation, keywordsOf, polarityMatch, splitClaims } from "../../src/memory/capture"

describe("classifyRelation", () => {
  test("undefined cosine is unrelated", () => {
    expect(classifyRelation({ cosine: undefined, sameTopic: true, newClaim: "a", oldClaim: "b" })).toBe("unrelated")
  })
  test("low cosine is unrelated", () => {
    expect(classifyRelation({ cosine: 0.5, sameTopic: true, newClaim: "a", oldClaim: "a" })).toBe("unrelated")
    expect(classifyRelation({ cosine: 0.749, sameTopic: true, newClaim: "a", oldClaim: "a" })).toBe("unrelated")
  })
  test("mid cosine is related regardless of topic or polarity", () => {
    expect(
      classifyRelation({ cosine: 0.8, sameTopic: false, newClaim: "x is not ready", oldClaim: "x is ready" }),
    ).toBe("related")
    expect(classifyRelation({ cosine: 0.75, sameTopic: true, newClaim: "a", oldClaim: "b" })).toBe("related")
  })
  test("similarity does not establish replacement", () => {
    expect(
      classifyRelation({
        cosine: 0.95,
        sameTopic: true,
        newClaim: "The proxy listens on port 8010 and serves four models.",
        oldClaim: "The proxy listens on port 8010.",
      }),
    ).toBe("related")
  })
  test("only equivalent text on the same topic supersedes", () => {
    expect(
      classifyRelation({
        cosine: 0.95,
        sameTopic: true,
        newClaim: "The proxy listens on port 8010.",
        oldClaim: " The proxy listens  on port 8010. ",
      }),
    ).toBe("supersedes")
  })
  test("changed numeric values never supersede automatically", () => {
    expect(
      classifyRelation({
        cosine: 0.99,
        sameTopic: true,
        newClaim: "The proxy listens on port 8317.",
        oldClaim: "The proxy listens on port 8010.",
      }),
    ).toBe("related")
  })
  test("opposite active and inactive states are retained for review", () => {
    expect(
      classifyRelation({
        cosine: 0.99,
        sameTopic: true,
        newClaim: "The production proxy is inactive.",
        oldClaim: "The production proxy is active.",
      }),
    ).toBe("contradicts")
  })
  test("near-identical claims on different topics only link", () => {
    expect(
      classifyRelation({
        cosine: 0.95,
        sameTopic: false,
        newClaim: "The proxy listens on port 8010.",
        oldClaim: "The proxy listens on port 8010.",
      }),
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
  test("english contractions count as negation", () => {
    expect(
      classifyRelation({
        cosine: 0.95,
        sameTopic: true,
        newClaim: "The proxy isn't enabled for all client requests.",
        oldClaim: "The proxy is enabled for all client requests.",
      }),
    ).toBe("contradicts")
  })
  test("vietnamese negation blocks auto-supersede", () => {
    expect(polarityMatch("Proxy không hoạt động.", "Proxy đang hoạt động.")).toBe(false)
    expect(
      classifyRelation({
        cosine: 0.95,
        sameTopic: true,
        newClaim: "Proxy không hoạt động.",
        oldClaim: "Proxy đang hoạt động.",
      }),
    ).toBe("contradicts")
  })
  test("matching negation alone does not prove equivalence", () => {
    expect(
      classifyRelation({
        cosine: 0.95,
        sameTopic: true,
        newClaim: "The legacy port is no longer used by the proxy.",
        oldClaim: "The legacy port is not used by the proxy.",
      }),
    ).toBe("related")
  })
  test("vietnamese negation at a sentence boundary is recognized", () => {
    expect(polarityMatch("Không hoạt động.", "Đang hoạt động.")).toBe(false)
    expect(polarityMatch("Chưa hoạt động.", "Đang hoạt động.")).toBe(false)
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
  test("does not silently drop claims after the twelfth", () => {
    const text = Array.from({ length: 20 }, (_, i) => `- Claim number ${i} with enough padding words here`).join("\n")
    expect(splitClaims(text).length).toBe(20)
  })
})

describe("keywordsOf", () => {
  test("keeps vietnamese words", () => {
    expect(keywordsOf("điện trở có giá trị 220 ôm")).toContain("điện")
  })
})
