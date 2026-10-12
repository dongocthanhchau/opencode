import { desc, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Database as BunDatabase } from "bun:sqlite"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MemoryFactTable, MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MemoryFactFtsTable } from "@opencode-ai/core/session/fts"
import { SessionID } from "../session/schema"
import { embed, keywordsOf } from "./capture"

const MAX_CHARS = 6000
const MAX_FACTS = 5
const FTS_LIMIT = 200

export interface Interface {
  readonly recall: (input: { sessionID: SessionID }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryRecall") {}

export function cosine(a: number[], b: number[]): number | undefined {
  if (a.length === 0 || a.length !== b.length) return undefined
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return undefined
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function ftsEscape(word: string): string {
  return word.replace(/[^a-z0-9-_]/gi, "").slice(0, 40)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const inner = Effect.fn("MemoryRecall.recall")(function* (input: { sessionID: SessionID }) {
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return undefined

      const recent = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, input.sessionID))
        .orderBy(desc(MessageTable.time_created))
        .all()
        .pipe(Effect.orDie)
      let query = ""
      for (const m of recent.slice(0, 10)) {
        let data: Record<string, unknown>
        try {
          data = (typeof m.data === "string" ? JSON.parse(m.data) : m.data) as Record<string, unknown>
        } catch {
          continue
        }
        if (data.role !== "user") continue
        const parts = yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.message_id, m.id))
          .all()
          .pipe(Effect.orDie)
        const texts: string[] = []
        for (const part of parts) {
          try {
            const pdata = (typeof part.data === "string" ? JSON.parse(part.data) : part.data) as Record<
              string,
              unknown
            >
            if (pdata.type === "text" && typeof pdata.text === "string") texts.push(pdata.text)
          } catch {
            continue
          }
        }
        query = texts.join("?n").slice(0, 2000)
        if (query.trim().length > 0) break
      }
      if (query.trim().length === 0) return undefined

      const keywords = keywordsOf(query)
        .map(ftsEscape)
        .filter((w) => w.length > 2)
        .slice(0, 5)
      if (keywords.length === 0) return undefined

      const ftsQuery = keywords.map((kw) => '"'+kw+'"').join(" OR ")
      const ftsRows = yield* Effect.try({
        try: () => {
          const raw = new BunDatabase(Database.path(), { readonly: true })
          try {
            return raw.query('SELECT "id" FROM "memory_fact_fts" WHERE "memory_fact_fts" MATCH ? LIMIT 200').all(ftsQuery) as { id: string }[]
          } finally {
            raw.close()
          }
        },
        catch: () => new Error('fts failed'),
      }).pipe(Effect.orElseSucceed(() => [] as { id: string }[]))
      const prefiltered = [...new Set(ftsRows.map((r) => (r as unknown as { id: string }).id))]
      if (prefiltered.length === 0) return undefined

      const candidates = yield* db
        .select()
        .from(MemoryFactTable)
        .where(inArray(MemoryFactTable.id, prefiltered))
        .all()
        .pipe(Effect.orDie)

      const now = Date.now()
      const queryEmbedding = yield* embed(query)
      const scored: { line: string; score: number }[] = []
      for (const row of candidates) {
        if (row.project_id !== session.project_id) continue
        const ageDays = Math.max(0, (now - (row.time_created ?? now)) / 86_400_000)
        if (row.ttl_days != null && ageDays > row.ttl_days) continue
        const haystack = ((row.topic ?? "") + "?n" + row.fact).toLowerCase()
        const hits = keywords.filter((kw) => haystack.includes(kw.toLowerCase())).length
        const cos =
          queryEmbedding && Array.isArray(row.embedding) ? cosine(queryEmbedding, row.embedding as number[]) : undefined
        if (hits === 0 && (cos === undefined || cos <= 0.6)) continue
        const decay = Math.exp(-ageDays / (row.ttl_days ?? 90))
        const score = (hits * 2 + (cos ?? 0)) * (row.trust ?? 1) * decay
        scored.push({
          line: "- [" + (row.topic || row.kind || "memory") + "] " + row.fact.slice(0, 500),
          score,
        })
      }
      scored.sort((a, b) => b.score - a.score)

      const picked: string[] = []
      let chars = 0
      for (const s of scored) {
        if (picked.length >= MAX_FACTS) break
        if (chars + s.line.length > MAX_CHARS) break
        picked.push(s.line)
        chars += s.line.length
      }
      if (picked.length === 0) return undefined
      yield* Effect.logInfo("memory recalled", { count: picked.length })
      return "Related memories:?n" + picked.join("?n")
    })

    const recall = (input: { sessionID: SessionID }) =>
      inner(input).pipe(Effect.orElseSucceed(() => undefined))

    return Service.of({ recall })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node],
})

export * as MemoryRecall from "./recall"
