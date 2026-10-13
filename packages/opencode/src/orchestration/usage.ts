export interface TokenCounts {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface RunUsageInput {
  id: string
  tokens_used: number
  result?: Record<string, unknown> | null
}

export function sumTokens(tokens: TokenCounts | null | undefined): number {
  if (!tokens) return 0
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  )
}

export function runUsage(run: RunUsageInput, sessionTokens: TokenCounts | null | undefined): number {
  const baseline = run.result?.["usage_baseline"] as TokenCounts | null | undefined
  if (baseline) {
    const live = Math.max(0, sumTokens(sessionTokens) - sumTokens(baseline))
    return Math.max(run.tokens_used, live)
  }
  return run.tokens_used
}

export * as Usage from "./usage"
