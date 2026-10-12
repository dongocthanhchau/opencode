import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { and, asc, eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MemoryFactTable, MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Filesystem } from "@/util/filesystem"
import { SessionID } from "../session/schema"

const MIN_FACT_LEN = 100
const BANNED = [/reply exactly/i, /sync-ok/i, /activation ok/i, /test probe/i, /^ok\.?$/i]

const embedURL = () => process.env.OPENCODE_MEMORY_EMBED_URL ?? "http://127.0.0.1:11434"
const embedModel = () => process.env.OPENCODE_MEMORY_EMBED_MODEL ?? "qwen3-embedding:0.6b"
const storeRoot = () => process.env.OPENCODE_MEMORY_VAULT ?? path.join(os.homedir(), "vault")

export interface Interface {
  readonly capture: (input: { sessionID: SessionID }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryCapture") {}

function gated(text: string): boolean {
  if (text.trim().length < MIN_FACT_LEN) return false
  return !BANNED.some((re) => re.test(text))
}

export function keywordsOf(text: string): string[] {
  const seen = new Set<string>()
  for (const word of text.toLowerCase().split(/[^a-z0-9-_]+/)) {
    if (word.length > 3 && !seen.has(word)) seen.add(word)
    if (seen.size >= 8) break
  }
  return [...seen]
}

export const embed = Effect.fn("MemoryCapture.embed")(function* (text: string) {
  const res = yield* Effect.tryPromise({
    try: () =>
      fetch(`${embedURL()}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: embedModel(), input: text.slice(0, 2000) }),
        signal: AbortSignal.timeout(30_000),
      }),
    catch: () => new Error("embed request failed"),
  }).pipe(Effect.option)
  if (res._tag === "None") return undefined
  const json = (yield* Effect.tryPromise({
    try: () => res.value.json() as Promise<{ embeddings?: number[][] }>,
    catch: () => new Error("embed parse failed"),
  }).pipe(Effect.option))
  if (json._tag === "None") return undefined
  return json.value.embeddings?.[0]
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const capture = Effect.fn("MemoryCapture.capture")(function* (input: { sessionID: SessionID }) {
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return

      const messages = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, input.sessionID)).all()
        .pipe(Effect.orDie)
      const summaryIDs = messages
        .map((m) => {
          try {
            return { id: m.id, data: (typeof m.data === "string" ? JSON.parse(m.data) : m.data) as Record<string, unknown> }
          } catch {
            return undefined
          }
        })
        .filter((m) => m !== undefined)
        .filter((m) => (m.data.role === "assistant" || m.data.role === undefined) && m.data.summary === true)
        .map((m) => m.id)
      if (summaryIDs.length === 0) return

      const texts: string[] = []
      for (const messageID of summaryIDs) {
        const parts = yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.message_id, messageID))
          .orderBy(asc(PartTable.time_created))
          .all()
          .pipe(Effect.orDie)
        for (const part of parts) {
          try {
            const data = (typeof part.data === "string" ? JSON.parse(part.data) : part.data) as Record<string, unknown>
            if (data.type === "text" && typeof data.text === "string") texts.push(data.text)
          } catch {
            continue
          }
        }
      }
      const fact = texts.join("\n\n").trim()
      if (!gated(fact)) return

      const hash = createHash("sha256").update(fact).digest("hex")
      // Dedup is scoped per project: identical facts may coexist in different projects.
      const projectID = session.project_id
      const existing = yield* db
        .select({ id: MemoryFactTable.id })
        .from(MemoryFactTable)
        .where(
          projectID == null
            ? and(eq(MemoryFactTable.hash, hash), isNull(MemoryFactTable.project_id))
            : and(eq(MemoryFactTable.hash, hash), eq(MemoryFactTable.project_id, projectID)),
        )
        .all()
        .pipe(Effect.orDie)
      if (existing.length > 0) return

      const embedding = yield* embed(fact)
      const project = path.basename(session.directory).replace(/[^a-z0-9-_]/gi, "-").slice(0, 60) || "global"
      const day = new Date().toISOString().slice(0, 10).replaceAll("-", "")
      const notePath = path.join(
        storeRoot(),
        "projects",
        project,
        `memory-${day}-${input.sessionID.slice(-8)}-${hash.slice(0, 8)}.md`,
      )
      const topic = (session.title || project).slice(0, 80)
      const note = [
        "---",
        `id: ${hash.slice(0, 16)}`,
        `date: ${new Date().toISOString().slice(0, 10)}`,
        `session: ${input.sessionID}`,
        `topic: ${topic.replaceAll("\n", " ")}`,
        `hash: ${hash}`,
        "---",
        "",
        `# Memory: ${topic}`,
        "",
        fact,
        "",
        `Related session: [[${input.sessionID}]]`,
        "",
      ].join("\n")
      const vaultOk = yield* Effect.tryPromise({
        try: () => Filesystem.write(notePath, note),
        catch: () => new Error("vault Abramowitz/offers failed"),
      }).pipe(
        Effect.as(true),
        Effect.catch((err) =>
          Effect.logWarning("memory vault Abramowitz/offers failed, storing DB-only", {
            path: notePath,
            error: err,
          }).pipe(Effect.as(false)),
        ),
      )

      yield* db
        .insert(MemoryFactTable)
        .values({
          id: `mem_${Date.now().toString(36)}_${hash.slice(0, 8)}`,
          session_id: input.sessionID,
          project_id: session.project_id,
          fact,
          topic,
          keywords: keywordsOf(fact),
          embedding: embedding ?? null,
          vault_path: vaultOk ? notePath : null,
          kind: "fact",
          source: "session",
          trust: 1.0,
          fetched_at: Date.now(),
          hash,
        })
        .run()
        .pipe(Effect.orDie)
    })

    return Service.of({ capture })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node],
})

export * as MemoryCapture from "./capture"
