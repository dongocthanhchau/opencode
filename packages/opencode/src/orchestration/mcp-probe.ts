import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { Effect } from "effect"

export interface McpProbeSpec {
  transport: "stdio" | "http"
  command?: string[]
  url?: string
  headers?: Record<string, string>
}

export type ProbeResult =
  | { ok: true; tools: string[]; server: { name: string; version: string } }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function cleanStrings(value: unknown, max: number, eachMax: number): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return undefined
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > eachMax) return undefined
    out.push(entry)
  }
  return out
}

// Strict spec validation. Never logs or returns env/headers values;
// only shape errors leave this function.
export function validateMcpSpec(raw: unknown): { ok: true; spec: McpProbeSpec } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "spec must be an object" }
  if (raw.transport === "stdio") {
    const command = cleanStrings(raw.command, 8, 256)
    if (!command) return { ok: false, reason: "stdio spec needs command[1..8] of short strings" }
    if (command.some((part) => /[\s;&|$`\\]/.test(part)))
      return { ok: false, reason: "command parts must not contain shell characters" }
    return { ok: true, spec: { transport: "stdio", command } }
  }
  if (raw.transport === "http") {
    if (typeof raw.url !== "string") return { ok: false, reason: "http spec needs a url string" }
    let parsed: URL
    try {
      parsed = new URL(raw.url)
    } catch {
      return { ok: false, reason: "http spec url is invalid" }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return { ok: false, reason: "http spec url must be http(s)" }
    if (isRecord(raw.headers)) {
      for (const [key, value] of Object.entries(raw.headers)) {
        if (typeof value !== "string" || value.length > 4096) return { ok: false, reason: "header values must be short strings" }
        if (key.length === 0 || key.length > 128) return { ok: false, reason: "header names must be short strings" }
      }
    }
    return { ok: true, spec: { transport: "http", url: parsed.toString() } }
  }
  return { ok: false, reason: 'transport must be "stdio" or "http"' }
}

export function transportForSpec(spec: McpProbeSpec): Transport {
  if (spec.transport === "stdio") {
    const [command, ...args] = spec.command ?? []
    return new StdioClientTransport({ command, args, stderr: "pipe" })
  }
  return new StreamableHTTPClientTransport(new URL(spec.url ?? ""))
}

// Runs the real MCP handshake (initialize + tools/list) against any
// transport and always closes it. Failures become data, never throws.
export const probeTransport = Effect.fn("McpProbe.probeTransport")(function* (
  transport: Transport,
  input: { timeoutMs: number },
) {
  const outcome = yield* Effect.tryPromise({
    try: async (): Promise<ProbeResult> => {
      const client = new Client({ name: "cvis-probe", version: "1" }, { capabilities: {} })
      try {
        await client.connect(transport)
        const listed = await client.listTools()
        const server = client.getServerVersion() ?? { name: "unknown", version: "unknown" }
        return {
          ok: true as const,
          tools: listed.tools.map((tool) => tool.name).slice(0, 100),
          server: { name: server.name, version: server.version },
        }
      } finally {
        await client.close().catch(() => {})
      }
    },
    catch: (cause) => new Error(cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.timeout(input.timeoutMs),
    Effect.exit,
  )
  if (outcome._tag === "Failure") return { ok: false as const, error: "probe timed out" }
  return outcome.value
})

export * as McpProbe from "./mcp-probe"
