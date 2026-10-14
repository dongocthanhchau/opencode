import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Orchestration } from "../../src/orchestration/service"
import { probeTransport, validateMcpSpec } from "../../src/orchestration/mcp-probe"

const root = mkdtempSync(path.join(tmpdir(), "cvis-probe-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()
const DESC = "A fetch MCP server for retrieving web content in tasks."

type CapSvc = {
  proposeCapability: (input: {
    projectID: string
    kind: string
    name: string
    description: string
    installPayload?: Record<string, unknown>
    actorSessionID: string
  }) => Effect.Effect<{ id: string; version: number }, any>
  setCapabilityStatus: (input: { id: string; status: string; actorSessionID: string }) => Effect.Effect<{ id: string; status: string }, any>
  probeMcpCapability: (input: { id: string; actorSessionID: string; timeoutMs?: number }) => Effect.Effect<{ ok: boolean }, any>
}

function withSvc<R>(fn: (svc: CapSvc) => Effect.Effect<R, unknown, any>) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* fn(svc)
    }),
  )
}

function failSvc(fn: (svc: CapSvc) => Effect.Effect<unknown, unknown, any>) {
  return runtime.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        return yield* fn(svc)
      }),
    ),
  )
}

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('mp-p',${root},'[]',${NOW},${NOW})`)
      for (const [sid, role, tid] of [["ses_mm", "manager", "t_mm"], ["ses_mw", "implementer", "t_mw"]] as [string, string, string][]) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'mp-p',${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES(${tid},'mp-p',${tid},${role},'running',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},'mp-p',${role},${tid},'busy',${NOW},${NOW})`,
        )
      }
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("in-memory handshake lists real tools", async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const server = new Server({ name: "probe-target", version: "9" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "p", inputSchema: { type: "object" } }],
  }))
  await server.connect(serverT)
  const out = await runtime.runPromise(probeTransport(clientT, { timeoutMs: 5000 }))
  expect(out).toMatchObject({ ok: true, tools: ["ping"], server: { name: "probe-target", version: "9" } })
  await server.close()
})

test("dead transports report failure instead of throwing", async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await serverT.close()
  const out = await runtime.runPromise(probeTransport(clientT, { timeoutMs: 2000 }))
  expect(out.ok).toBe(false)
})

test("spec validation rejects shell and bad urls", () => {
  expect(validateMcpSpec({ transport: "stdio", command: ["npx", "-y", "x; rm -rf /"] }).ok).toBe(false)
  expect(validateMcpSpec({ transport: "stdio" }).ok).toBe(false)
  expect(validateMcpSpec({ transport: "http", url: "ftp://x" }).ok).toBe(false)
  expect(validateMcpSpec({ transport: "http", url: "https://example.com/mcp" }).ok).toBe(true)
  expect(validateMcpSpec({ transport: "stdio", command: ["uvx", "mcp-server-fetch"] }).ok).toBe(true)
})

test("only canary mcp capabilities with valid specs can be probed", async () => {
  const cap = await withSvc((svc) =>
    svc.proposeCapability({ projectID: "mp-p", kind: "mcp", name: "fetch", description: DESC, installPayload: { transport: "stdio", command: ["uvx", "mcp-server-fetch"] }, actorSessionID: "ses_mw" }),
  )
  const r1 = await failSvc((svc) => svc.probeMcpCapability({ id: cap.id, actorSessionID: "ses_mw" }))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  await withSvc((svc) => svc.setCapabilityStatus({ id: cap.id, status: "canary", actorSessionID: "ses_mm" }))
  const bad = await withSvc((svc) =>
    svc.proposeCapability({ projectID: "mp-p", kind: "mcp", name: "broken", description: DESC, installPayload: { transport: "stdio" }, actorSessionID: "ses_mw" }),
  )
  await withSvc((svc) => svc.setCapabilityStatus({ id: bad.id, status: "canary", actorSessionID: "ses_mm" }))
  const r2 = await failSvc((svc) => svc.probeMcpCapability({ id: bad.id, actorSessionID: "ses_mw" }))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
  const tool = await withSvc((svc) =>
    svc.proposeCapability({ projectID: "mp-p", kind: "tool", name: "t", description: DESC, actorSessionID: "ses_mw" }),
  )
  await withSvc((svc) => svc.setCapabilityStatus({ id: tool.id, status: "canary", actorSessionID: "ses_mm" }))
  const r3 = await failSvc((svc) => svc.probeMcpCapability({ id: tool.id, actorSessionID: "ses_mw" }))
  expect(r3).toMatchObject({ _tag: "CvisInvalidTransition" })
})
