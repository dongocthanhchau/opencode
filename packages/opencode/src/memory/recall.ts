import { desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Database as BunDatabase } from "bun:sqlite"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  MemoryFactTable,
  MemoryItemTable,
  MemoryRelationTable,
  MemoryTombstoneTable,
  MessageTable,
  PartTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
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
        query = texts.join("\n").slice(0, 2000)
        if (query.trim().length > 0) break
      }
      if (query.trim().length === 0) return undefined

      const keywords = keywordsOf(query)
        .map(ftsEscape)
        .filter((w) => w.length > 2)
        .slice(0, 5)
      if (keywords.length === 0) return undefined

      const ftsQuery = keywords.map((kw) => '"'+kw+'"').join(" OR ")
      const searchFts = (table: string) =>
        Effect.try({
          try: () => {
            const raw = new BunDatabase(Database.path(), { readonly: true })
            try {
              return raw.query(`SELECT "id" FROM "${table}" WHERE "${table}" MATCH ? LIMIT 200`).all(ftsQuery) as { id: string }[]
            } finally {
              raw.close()
            }
          },
          catch: () => new Error("fts failed"),
        }).pipe(Effect.orElseSucceed(() => [] as { id: string }[]))
      const [factHits, itemHits] = yield* Effect.all([searchFts("memory_fact_fts"), searchFts("memory_item_fts")], {
        concurrency: 2,
      })
      const prefiltered = [...new Set([...factHits, ...itemHits].map((r) => (r as unknown as { id: string }).id))]
      if (prefiltered.length === 0) return undefined

      const [factRows, itemRows] = yield* Effect.all([
        db.select().from(MemoryFactTable).where(inArray(MemoryFactTable.id, prefiltered)).all().pipe(Effect.orDie),
        db.select().from(MemoryItemTable).where(inArray(MemoryItemTable.id, prefiltered)).all().pipe(Effect.orDie),
      ])
      // B3: forgotten hashes must never recall, even for legacy rows that
      // predate the capture-time tombstone gate.
      const tombstoned = new Set(
        (
          yield* db
            .select({ hash: MemoryTombstoneTable.hash })
            .from(MemoryTombstoneTable)
            .where(
              session.project_id == null
                ? isNull(MemoryTombstoneTable.project_id)
                : eq(MemoryTombstoneTable.project_id, session.project_id),
            )
            .all()
            .pipe(Effect.orDie)
        ).map((r) => r.hash),
      )
      const candidates: {
        id: string
        project_id: string | null
        topic: string
        text: string
        trust: number
        time_created: number | null
        ttl_days: number | null
        embedding: number[] | null
        kind: string
      }[] = [
        ...factRows
          .filter((row) => !tombstoned.has(row.hash ?? ""))
          .map((row) => ({
            id: row.id,
            project_id: row.project_id,
            topic: row.topic ?? "",
            text: row.fact,
            trust: row.trust ?? 1,
            time_created: row.time_created,
            ttl_days: row.ttl_days,
            embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : null,
            kind: row.kind ?? "fact",
          })),
        ...itemRows
          .filter((row) => row.status !== "superseded" && row.status !== "deleted")
          .filter((row) => !tombstoned.has(row.hash ?? ""))
          .map((row) => ({
            id: row.id,
            project_id: row.project_id,
            topic: row.topic ?? "",
            text: row.claim,
            trust: row.trust ?? 1,
            time_created: row.time_created,
            ttl_days: row.ttl_days,
            embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : null,
            kind: row.kind ?? "fact",
          })),
      ]

      const now = Date.now()
      const queryEmbedding = yield* embed(query)
      const scored: { id: string; line: string; score: number }[] = []
      const scoredIDs = new Set<string>()
      for (const row of candidates) {
        if (row.project_id !== session.project_id) continue
        const ageDays = Math.max(0, (now - (row.time_created ?? now)) / 86_400_000)
        if (row.ttl_days != null && ageDays > row.ttl_days) continue
        const haystack = (row.topic + "\n" + row.text).toLowerCase()
        const hits = keywords.filter((kw) => haystack.includes(kw.toLowerCase())).length
        const cos = queryEmbedding && row.embedding ? cosine(queryEmbedding, row.embedding) : undefined
        if (hits === 0 && (cos === undefined || cos <= 0.6)) continue
        const decay = Math.exp(-ageDays / (row.ttl_days ?? 90))
        const score = (hits * 2 + (cos ?? 0)) * (row.trust ?? 1) * decay
        scored.push({
          id: row.id,
          line: "- [" + (row.topic || row.kind || "memory") + "] " + row.text.slice(0, 500),
          score,
        })
        scoredIDs.add(row.id)
      }
      // Phase 3c: boost scores of items connected via relation graph (1-hop).
      if (scored.length > 0 && itemRows.length > 0) {
        const scoredIDs = new Set(itemRows.filter((r) => r.status !== "superseded").map((r) => r.id))
        if (scoredIDs.size > 0) {
          const relations = yield* db
            .select()
            .from(MemoryRelationTable)
            .where(inArray(MemoryRelationTable.from_id, [...scoredIDs]))
            .all()
            .pipe(Effect.orDie)
          const boostTargets = new Map<string, number>()
          for (const rel of relations) {
            const boost = rel.relation === "supersedes" ? 0.3 : rel.relation === "related" ? 0.15 : 0
            if (boost > 0) boostTargets.set(rel.to_id, Math.max(boostTargets.get(rel.to_id) ?? 0, boost))
          }
          if (boostTargets.size > 0) {
            const boostedRows = yield* db
              .select()
              .from(MemoryItemTable)
              .where(inArray(MemoryItemTable.id, [...boostTargets.keys()]))
              .all()
              .pipe(Effect.orDie)
            for (const row of boostedRows) {
              if (row.status === "superseded" || row.status === "deleted" || row.project_id !== session.project_id) continue
              if (tombstoned.has(row.hash ?? "")) continue
              if (scoredIDs.has(row.id)) continue
              const ageDays = Math.max(0, (now - (row.time_created ?? now)) / 86_400_000)
              if (row.ttl_days != null && ageDays > row.ttl_days) continue
              const cos = queryEmbedding && Array.isArray(row.embedding) ? cosine(queryEmbedding, row.embedding as number[]) : undefined
              const decay = Math.exp(-ageDays / (row.ttl_days ?? 90))
              const base = (cos ?? 0) * (row.trust ?? 1) * decay
              const boost = boostTargets.get(row.id) ?? 0
              if (base + boost > 0.3) {
                scored.push({
                  id: row.id,
                  line: "- [" + (row.topic || row.kind || "memory") + "] " + row.claim.slice(0, 500),
                  score: base + boost,
                })
                scoredIDs.add(row.id)
              }
            }
          }
        }
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
      return "Related memories:\n" + picked.join("\n")
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
