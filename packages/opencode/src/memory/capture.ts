import { createHash, randomUUID } from "node:crypto"
import { rename, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import {
  MemoryArchiveTable,
  MemoryEvidenceTable,
  MemoryFactTable,
  MemoryItemTable,
  MemoryJobTable,
  MemoryRelationTable,
  MemorySourceTable,
  MemoryTombstoneTable,
  MessageTable,
  PartTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { cosine } from "./recall"
import { Filesystem } from "@/util/filesystem"
import { SessionID } from "../session/schema"

const MIN_FACT_LEN = 100
const BANNED = [/reply exactly/i, /sync-ok/i, /activation ok/i, /test probe/i, /^ok\.?$/i]

const embedURL = () => process.env.OPENCODE_MEMORY_EMBED_URL ?? "http://127.0.0.1:11434"
const embedModel = () => process.env.OPENCODE_MEMORY_EMBED_MODEL ?? "qwen3-embedding:0.6b"
const storeRoot = () => process.env.OPENCODE_MEMORY_VAULT ?? path.join(os.homedir(), "vault")

export interface Interface {
  readonly capture: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly enqueueCaptureJob: (input: { sessionID: SessionID }) => Effect.Effect<{ id: string; deduped: boolean }, JobNotFound>
  readonly claimCaptureJob: (input: {
    owner: string
  }) => Effect.Effect<typeof MemoryJobTable.$inferSelect | undefined, JobConflict>
  readonly completeCaptureJob: (input: {
    id: string
    owner: string
    status: string
    error?: string
  }) => Effect.Effect<void, JobNotFound | JobConflict>
  readonly requeueCaptureJob: (input: {
    id: string
    maxAttempts?: number
  }) => Effect.Effect<void, JobNotFound | JobConflict>
  readonly releaseStaleJobs: (input: {
    olderThanMs: number
  }) => Effect.Effect<{ released: number }, JobConflict>
  readonly listCaptureJobs: (input: {
    status?: string
  }) => Effect.Effect<(typeof MemoryJobTable.$inferSelect)[]>
  readonly runCaptureJobOnce: (input: {
    owner: string
  }) => Effect.Effect<{ ran: boolean; id?: string; status?: string }, JobConflict>
  // Tiered memory: explicit global memories plus promotion of
  // session-scoped captures up to project visibility.
  readonly remember: (input: {
    scope: "user" | "system"
    text: string
    topic?: string
  }) => Effect.Effect<{ factID: string; itemID: string; deduped: boolean }, ScopeError>
  readonly setScope: (input: {
    id: string
    scope: "session" | "project"
    sessionID: SessionID
  }) => Effect.Effect<{ id: string; scope: string }, ScopeError>
  // Self-revision: correct or refine one claim (archives the old version
  // with a tombstone so recall never resurrects it and rollback stays
  // possible), plus periodic project rewrites that merge duplicates and
  // flag past-TTL items stale for operator review.
  readonly reviseMemory: (input: {
    id: string
    sessionID: SessionID
    text: string
  }) => Effect.Effect<{ oldID: string; itemID: string; deduped: boolean }, ScopeError>
  readonly rewriteProject: (input: {
    projectID: string | null
    sessionID: SessionID
  }) => Effect.Effect<{ merged: number; archived: number; stale: string[] }, ScopeError>
}

export class ScopeError extends Schema.TaggedErrorClass<ScopeError>()("MemoryScopeError", {
  id: Schema.String,
  reason: Schema.String,
}) {}

export class JobNotFound extends Schema.TaggedErrorClass<JobNotFound>()("MemoryJobNotFound", {
  id: Schema.String,
}) {}

export class JobConflict extends Schema.TaggedErrorClass<JobConflict>()("MemoryJobConflict", {
  id: Schema.String,
  reason: Schema.String,
}) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryCapture") {}

function gated(text: string): boolean {
  if (text.trim().length < MIN_FACT_LEN) return false
  return !BANNED.some((re) => re.test(text))
}

const MIN_CLAIM_LEN = 20

const NEGATION =
  /(?<![\p{L}\p{N}_])(not|never|no longer|deprecated|removed|instead|however|but|wrong|incorrect|obsolete|replaced|disabled|inactive|không|chưa|chẳng|chả|đừng|chớ|cấm)(?![\p{L}\p{N}_])|n't\b/iu

export function polarityMatch(a: string, b: string): boolean {
  return NEGATION.test(a) === NEGATION.test(b)
}

export type RelationVerdict = "supersedes" | "contradicts" | "related" | "unrelated"

export function classifyRelation(input: {
  cosine: number | undefined
  sameTopic: boolean
  newClaim: string
  oldClaim: string
}): RelationVerdict {
  const cos = input.cosine
  if (cos === undefined) return "unrelated"
  if (cos >= 0.9) {
    const polarity = polarityMatch(input.newClaim, input.oldClaim)
    if (
      input.sameTopic &&
      input.newClaim.normalize("NFKC").trim().replace(/\s+/g, " ") ===
        input.oldClaim.normalize("NFKC").trim().replace(/\s+/g, " ")
    )
      return "supersedes"
    return polarity ? "related" : "contradicts"
  }
  if (cos >= 0.75) return "related"
  return "unrelated"
}

export function splitClaims(text: string): string[] {
  const chunks: string[] = []
  let current: string[] = []
  const flush = () => {
    const chunk = current.join("\n").trim()
    current = []
    if (chunk.length === 0) return
    if (chunk.length >= MIN_CLAIM_LEN) chunks.push(chunk)
    else if (chunks.length > 0) chunks[chunks.length - 1] += "\n" + chunk
    else chunks.push(chunk)
  }
  for (const line of text.split("\n")) {
    if (/^(#{1,4}\s+|[-*]\s+|\d+\.\s+)/.test(line) && current.join("\n").trim().length >= MIN_CLAIM_LEN) flush()
    current.push(line)
  }
  flush()
  return chunks
}

export function keywordsOf(text: string): string[] {
  const seen = new Set<string>()
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    if (word.length > 3 && !seen.has(word)) seen.add(word)
    if (seen.size >= 8) break
  }
  return [...seen]
}

function sqliteBusy(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 10) return false
  const detail = error as { code?: unknown; message?: unknown; cause?: unknown; reason?: unknown }
  return (
    detail.code === "SQLITE_BUSY" ||
    detail.code === "SQLITE_BUSY_SNAPSHOT" ||
    detail.code === "SQLITE_LOCKED" ||
    (typeof detail.message === "string" && /database (?:is )?(?:locked|busy)/i.test(detail.message)) ||
    sqliteBusy(detail.cause, depth + 1) ||
    sqliteBusy(detail.reason, depth + 1)
  )
}

function retryBusy<A, E, R>(effect: Effect.Effect<A, E, R>, remaining = 4): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.catchCause((cause) => {
      if (remaining === 0 || !sqliteBusy(Cause.squash(cause))) return Effect.failCause(cause)
      return Effect.sleep((5 - remaining) * 100).pipe(Effect.andThen(retryBusy(effect, remaining - 1)))
    }),
  )
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
  const json = yield* Effect.tryPromise({
    try: () => res.value.json() as Promise<{ embeddings?: number[][] }>,
    catch: () => new Error("embed parse failed"),
  }).pipe(Effect.option)
  if (json._tag === "None") return undefined
  return json.value.embeddings?.[0]
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    // Shared retirement path: snapshot the old claim into the archive,
    // tombstone its hash so recall never resurrects it, then mark it
    // superseded. Used by capture auto-merge, explicit revise, and the
    // periodic rewrite alike so all three stay rollback-capable.
    const supersedeItemTx = Effect.fn("MemoryCapture.supersedeItem")(function* (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
      old: typeof MemoryItemTable.$inferSelect,
      input: { by: string; reason: string },
    ) {
      const now = Date.now()
      yield* tx
        .insert(MemoryArchiveTable)
        .values({
          id: `marc_${now.toString(36)}_${old.id.slice(-6)}`,
          date: new Date(now).toISOString().slice(0, 10),
          session_id: SessionID.make(input.by),
          project_id: old.project_id,
          payload: {
            kind: "item-superseded",
            reason: input.reason,
            item: {
              id: old.id,
              claim: old.claim,
              topic: old.topic,
              scope: old.scope,
              version: old.version,
              trust: old.trust,
              session_id: old.session_id,
              hash: old.hash,
            },
          },
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* tx
        .insert(MemoryTombstoneTable)
        .values({ id: `mtomb_${now.toString(36)}_${old.hash.slice(0, 8)}`, hash: old.hash, project_id: old.project_id, time_created: now, time_updated: now })
        .onConflictDoNothing()
        .run()
      yield* tx.update(MemoryItemTable).set({ status: "superseded" }).where(eq(MemoryItemTable.id, old.id)).run()
    })

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
        .where(eq(MessageTable.session_id, input.sessionID))
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const summaryIDs = messages
        .map((m) => {
          try {
            return {
              id: m.id,
              data: (typeof m.data === "string" ? JSON.parse(m.data) : m.data) as Record<string, unknown>,
            }
          } catch {
            return undefined
          }
        })
        .filter((m) => m !== undefined)
        .filter((m) => (m.data.role === "assistant" || m.data.role === undefined) && m.data.summary === true)
        .slice(0, 1)
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
      const projectID = session.project_id
      const tombstones = yield* db
        .select({ hash: MemoryTombstoneTable.hash })
        .from(MemoryTombstoneTable)
        .where(
          projectID == null ? isNull(MemoryTombstoneTable.project_id) : eq(MemoryTombstoneTable.project_id, projectID),
        )
        .all()
        .pipe(Effect.orDie)
      const forgottenHashes = new Set(tombstones.map((row) => row.hash))
      const raw = texts.join("\n\n").trim()
      if (forgottenHashes.has(createHash("sha256").update(raw).digest("hex"))) return
      const fact = splitClaims(raw)
        .filter((claim) => !forgottenHashes.has(createHash("sha256").update(`${projectID}\n${claim}`).digest("hex")))
        .join("\n")
      if (!gated(fact)) return

      const hash = createHash("sha256").update(fact).digest("hex")
      // Dedup is scoped per project: identical facts may coexist in different projects.
      // No early return when the fact already exists: a previous capture may
      // have committed the fact but stopped before the items, so keep going
      // and let the write transaction backfill what is missing.
      const forgotten = yield* db
        .select({ id: MemoryTombstoneTable.id })
        .from(MemoryTombstoneTable)
        .where(
          projectID == null
            ? and(eq(MemoryTombstoneTable.hash, hash), isNull(MemoryTombstoneTable.project_id))
            : and(eq(MemoryTombstoneTable.hash, hash), eq(MemoryTombstoneTable.project_id, projectID)),
        )
        .all()
        .pipe(Effect.orDie)
      if (forgotten.length > 0) return

      const embedding = yield* embed(fact)
      const project = projectID.replace(/[^a-z0-9-_]/gi, "-") || "global"
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
        `project: ${projectID}`,
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

      // B2: prepare everything fallible (network embeds) before the write
      // transaction so the commit phase is a single atomic unit. A failed
      // capture writes nothing, so a retry re-runs cleanly instead of hitting
      // the legacy dedup early-return with items missing.
      const preparedClaims: { claim: string; claimHash: string; claimEmbedding: number[] | undefined }[] = []
      const embeddingRepairs: { id: string; embedding: number[] }[] = []
      for (const claim of splitClaims(fact)) {
        if (claim.trim().length < MIN_CLAIM_LEN) continue
        if (BANNED.some((re) => re.test(claim))) continue
        const claimHash = createHash("sha256").update(`${session.project_id}\n${claim}`).digest("hex")
        const claimTombstoned = yield* db
          .select({ id: MemoryTombstoneTable.id })
          .from(MemoryTombstoneTable)
          .where(
            projectID == null
              ? and(eq(MemoryTombstoneTable.hash, claimHash), isNull(MemoryTombstoneTable.project_id))
              : and(eq(MemoryTombstoneTable.hash, claimHash), eq(MemoryTombstoneTable.project_id, projectID)),
          )
          .all()
          .pipe(Effect.orDie)
        if (claimTombstoned.length > 0) continue
        const dupItem = yield* db
          .select({ id: MemoryItemTable.id, embedding: MemoryItemTable.embedding })
          .from(MemoryItemTable)
          .where(
            projectID == null
              ? and(eq(MemoryItemTable.hash, claimHash), isNull(MemoryItemTable.project_id))
              : and(eq(MemoryItemTable.hash, claimHash), eq(MemoryItemTable.project_id, projectID)),
          )
          .all()
          .pipe(Effect.orDie)
        if (dupItem.length > 0) {
          // Backfill the embedding once the provider is reachable again.
          if (!Array.isArray(dupItem[0].embedding) || (dupItem[0].embedding as number[]).length === 0) {
            const repairEmbedding = yield* embed(claim)
            if (repairEmbedding) embeddingRepairs.push({ id: dupItem[0].id, embedding: repairEmbedding })
          }
          continue
        }
        const claimEmbedding = yield* embed(claim)
        preparedClaims.push({ claim, claimHash, claimEmbedding })
      }

      // Phase 2: split the summary into atomic claims stored as memory items.
      const sourceID = `msrc_${input.sessionID}`
      const commit = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const currentTombstones = yield* tx
                .select({ hash: MemoryTombstoneTable.hash })
                .from(MemoryTombstoneTable)
                .where(
                  projectID == null
                    ? isNull(MemoryTombstoneTable.project_id)
                    : eq(MemoryTombstoneTable.project_id, projectID),
                )
                .all()
              const currentHashes = new Set(currentTombstones.map((row) => row.hash))
              if (
                currentHashes.has(hash) ||
                splitClaims(fact).some((claim) =>
                  currentHashes.has(createHash("sha256").update(`${projectID}\n${claim}`).digest("hex")),
                )
              )
                return false
              // Re-check inside the transaction: a concurrent or retried capture
              // may have committed while we were preparing.
              const factExists = yield* tx
                .select({ id: MemoryFactTable.id })
                .from(MemoryFactTable)
                .where(
                  projectID == null
                    ? and(eq(MemoryFactTable.hash, hash), isNull(MemoryFactTable.project_id))
                    : and(eq(MemoryFactTable.hash, hash), eq(MemoryFactTable.project_id, projectID)),
                )
                .all()
              if (factExists.length === 0) {
                yield* tx
                  .insert(MemoryFactTable)
                  .values({
                    id: `mem_${Date.now().toString(36)}_${hash.slice(0, 8)}`,
                    session_id: input.sessionID,
                    project_id: session.project_id,
                    fact,
                    topic,
                    keywords: keywordsOf(fact),
                    embedding: embedding ?? null,
                    vault_path: null,
                    kind: "fact",
                    source: "session",
                    // Fresh captures stay visible to the originating session
                    // only; promotion to project is an explicit act below.
                    scope: "session",
                    trust: 1.0,
                    fetched_at: Date.now(),
                    hash,
                  })
                  .onConflictDoNothing()
                  .run()
              }

              const sourceRow = yield* tx
                .select({ id: MemorySourceTable.id })
                .from(MemorySourceTable)
                .where(eq(MemorySourceTable.id, sourceID))
                .all()
              if (sourceRow.length === 0) {
                yield* tx
                  .insert(MemorySourceTable)
                  .values({ id: sourceID, kind: "session", ref: input.sessionID, trust: 1.0 })
                  .onConflictDoNothing()
                  .run()
              }

              for (const prepared of preparedClaims) {
                const dupInside = yield* tx
                  .select({ id: MemoryItemTable.id })
                  .from(MemoryItemTable)
                  .where(
                    projectID == null
                      ? and(eq(MemoryItemTable.hash, prepared.claimHash), isNull(MemoryItemTable.project_id))
                      : and(eq(MemoryItemTable.hash, prepared.claimHash), eq(MemoryItemTable.project_id, projectID)),
                  )
                  .all()
                if (dupInside.length > 0) continue
                const newItemID = `mit_${Date.now().toString(36)}_${prepared.claimHash.slice(0, 8)}`
                // Idempotent under concurrent writers: when another capture
                // commits the same claim first, skip its relations/evidence
                // instead of failing on the unique index or linking a row
                // this transaction did not create.
                const inserted = yield* tx
                  .insert(MemoryItemTable)
                  .values({
                    id: newItemID,
                    project_id: session.project_id,
                    kind: "fact",
                    scope: "session",
                    status: "active",
                    claim: prepared.claim,
                    topic,
                    keywords: keywordsOf(prepared.claim),
                    embedding: prepared.claimEmbedding ?? null,
                    trust: 1.0,
                    version: 1,
                    source_id: sourceID,
                    session_id: input.sessionID,
                    vault_path: null,
                    hash: prepared.claimHash,
                    fetched_at: Date.now(),
                  })
                  .onConflictDoNothing()
                  .returning({ id: MemoryItemTable.id })
                  .all()
                if (inserted.length === 0) continue

                // Phase 3a: detect relations with existing items in the same project.
                if (prepared.claimEmbedding && session.project_id) {
                  const similar = yield* tx
                    .select()
                    .from(MemoryItemTable)
                    .where(
                      and(
                        eq(MemoryItemTable.project_id, session.project_id),
                        ne(MemoryItemTable.id, newItemID),
                        eq(MemoryItemTable.status, "active"),
                      ),
                    )
                    .all()
                  for (const old of similar) {
                    if (!Array.isArray(old.embedding) || (old.embedding as number[]).length === 0) continue
                    const cos = cosine(prepared.claimEmbedding, old.embedding as number[])
                    const verdict = classifyRelation({
                      cosine: cos,
                      sameTopic: (old.topic ?? "") === topic,
                      newClaim: prepared.claim,
                      oldClaim: old.claim,
                    })
                    if (verdict === "supersedes") {
                      yield* supersedeItemTx(tx, old, { by: input.sessionID, reason: "capture-merge" })
                    }
                    if (verdict !== "unrelated") {
                      // Contradictions and drift link for review; both claims
                      // stay active instead of auto-resolving.
                      yield* tx
                        .insert(MemoryRelationTable)
                        .values({
                          id: `mrel_${Date.now().toString(36)}_${old.id.slice(-6)}_${newItemID.slice(-6)}`,
                          from_id: newItemID,
                          to_id: old.id,
                          relation: verdict,
                        })
                        .onConflictDoNothing()
                        .run()
                    }
                  }
                }

                // Phase 3b: evidence provenance — link item back to the source session.
                yield* tx
                  .insert(MemoryEvidenceTable)
                  .values({
                    id: `mev_${Date.now().toString(36)}_${prepared.claimHash.slice(0, 8)}`,
                    item_id: newItemID,
                    kind: "session",
                    ref: input.sessionID,
                    content: fact.slice(0, 2000),
                  })
                  .run()
              }

              for (const repair of embeddingRepairs) {
                yield* tx
                  .update(MemoryItemTable)
                  .set({ embedding: repair.embedding })
                  .where(eq(MemoryItemTable.id, repair.id))
                  .run()
              }
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(retryBusy, Effect.exit)
      if (commit._tag === "Failure") {
        return yield* Effect.failCause(commit.cause).pipe(Effect.orDie)
      }
      if (!commit.value) return
      const vaultOk = yield* Effect.tryPromise({
        try: async () => {
          const temporary = `${notePath}.${randomUUID()}.tmp`
          try {
            await Filesystem.write(temporary, note)
            await rename(temporary, notePath)
          } finally {
            await unlink(temporary).catch(() => {})
          }
        },
        catch: () => new Error("vault write failed"),
      }).pipe(
        Effect.as(true),
        Effect.catch((err) =>
          Effect.logWarning("memory vault write failed, storing DB-only", { path: notePath, error: err }).pipe(
            Effect.as(false),
          ),
        ),
      )
      if (!vaultOk) return
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(MemoryFactTable)
                .set({ vault_path: notePath })
                .where(
                  projectID == null
                    ? and(eq(MemoryFactTable.hash, hash), isNull(MemoryFactTable.project_id))
                    : and(eq(MemoryFactTable.hash, hash), eq(MemoryFactTable.project_id, projectID)),
                )
                .run()
              yield* tx
                .update(MemoryItemTable)
                .set({ vault_path: notePath })
                .where(
                  and(
                    eq(MemoryItemTable.session_id, input.sessionID),
                    inArray(
                      MemoryItemTable.hash,
                      splitClaims(fact).map((claim) =>
                        createHash("sha256").update(`${projectID}\n${claim}`).digest("hex"),
                      ),
                    ),
                  ),
                )
                .run()
            }),
          { behavior: "immediate" },
        )
        .pipe(retryBusy, Effect.orDie)
    })

    // Durable capture jobs: explicit enqueue/claim/complete with attempt
    // accounting, so a crashed or interrupted capture can be retried and
    // observed instead of silently lost by the fire-and-forget hook.
    const enqueueCaptureJob = Effect.fn("MemoryCapture.enqueueCaptureJob")(function* (input: { sessionID: SessionID }) {
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return yield* new JobNotFound({ id: String(input.sessionID) })
      const open = yield* db
        .select()
        .from(MemoryJobTable)
        .where(and(eq(MemoryJobTable.kind, "capture"), inArray(MemoryJobTable.status, ["pending", "running"])))
        .all()
        .pipe(Effect.orDie)
      const existing = open.find(
        (job) => (job.payload as { session_id?: unknown } | null)?.session_id === input.sessionID,
      )
      if (existing) return { id: existing.id, deduped: true }
      const id = `mjob_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
      yield* db
        .insert(MemoryJobTable)
        .values({ id, kind: "capture", status: "pending", payload: { session_id: input.sessionID }, attempts: 0 })
        .run()
        .pipe(Effect.orDie)
      return { id, deduped: false }
    })

    const claimCaptureJob = Effect.fn("MemoryCapture.claimCaptureJob")(function* (input: { owner: string }) {
      if (!input.owner.trim()) return yield* new JobConflict({ id: "", reason: "owner required" })
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const due = yield* tx
              .select()
              .from(MemoryJobTable)
              .where(and(eq(MemoryJobTable.kind, "capture"), eq(MemoryJobTable.status, "pending")))
              .orderBy(asc(MemoryJobTable.time_created), asc(MemoryJobTable.id))
              .all()
            const candidate = due[0]
            if (!candidate) return undefined
            const claimed = yield* tx
              .update(MemoryJobTable)
              .set({
                status: "running",
                attempts: candidate.attempts + 1,
                payload: { ...((candidate.payload ?? {}) as Record<string, unknown>), owner: input.owner, claimed_at: Date.now() },
                time_updated: Date.now(),
              })
              .where(and(eq(MemoryJobTable.id, candidate.id), eq(MemoryJobTable.status, "pending")))
              .returning()
              .all()
            return claimed[0]
          }),
        )
        .pipe(Effect.orDie)
    })

    const completeCaptureJob = Effect.fn("MemoryCapture.completeCaptureJob")(function* (input: {
      id: string
      owner: string
      status: string
      error?: string
    }) {
      if (input.status !== "done" && input.status !== "failed")
        return yield* new JobConflict({ id: input.id, reason: "status must be done or failed" })
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx.select().from(MemoryJobTable).where(eq(MemoryJobTable.id, input.id)).get()
            if (!row) return yield* new JobNotFound({ id: input.id })
            if ((row.payload as { owner?: unknown } | null)?.owner !== input.owner)
              return yield* new JobConflict({ id: input.id, reason: "lease held by another owner or not claimed" })
            yield* tx
              .update(MemoryJobTable)
              .set({
                status: input.status,
                payload: {
                  ...((row.payload ?? {}) as Record<string, unknown>),
                  ...(input.error ? { error: input.error } : {}),
                  finished_at: Date.now(),
                },
                time_updated: Date.now(),
              })
              .where(eq(MemoryJobTable.id, input.id))
              .run()
          }),
        )
        .pipe(Effect.orDie)
    })

    const requeueCaptureJob = Effect.fn("MemoryCapture.requeueCaptureJob")(function* (input: { id: string; maxAttempts?: number }) {
      const max = input.maxAttempts ?? 3
      if (!Number.isSafeInteger(max) || max <= 0)
        return yield* new JobConflict({ id: input.id, reason: "maxAttempts must be a positive integer" })
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx.select().from(MemoryJobTable).where(eq(MemoryJobTable.id, input.id)).get()
            if (!row) return yield* new JobNotFound({ id: input.id })
            if (row.status !== "failed")
              return yield* new JobConflict({ id: input.id, reason: "only failed jobs can be requeued" })
            if (row.attempts >= max)
              return yield* new JobConflict({ id: input.id, reason: "attempt budget exhausted" })
            yield* tx
              .update(MemoryJobTable)
              .set({
                status: "pending",
                payload: { session_id: (row.payload as { session_id?: unknown } | null)?.session_id ?? null },
                time_updated: Date.now(),
              })
              .where(eq(MemoryJobTable.id, input.id))
              .run()
          }),
        )
        .pipe(Effect.orDie)
    })

    const releaseStaleJobs = Effect.fn("MemoryCapture.releaseStaleJobs")(function* (input: { olderThanMs: number }) {
      if (!Number.isSafeInteger(input.olderThanMs) || input.olderThanMs <= 0)
        return yield* new JobConflict({ id: "", reason: "olderThanMs must be a positive integer" })
      const cutoff = Date.now() - input.olderThanMs
      const stale = yield* db
        .select()
        .from(MemoryJobTable)
        .where(and(eq(MemoryJobTable.kind, "capture"), eq(MemoryJobTable.status, "running")))
        .all()
        .pipe(Effect.orDie)
      let released = 0
      for (const row of stale.filter((job) => (job.time_updated ?? 0) < cutoff)) {
        yield* db
          .update(MemoryJobTable)
          .set({
            status: "pending",
            payload: { session_id: (row.payload as { session_id?: unknown } | null)?.session_id ?? null },
            time_updated: Date.now(),
          })
          .where(and(eq(MemoryJobTable.id, row.id), eq(MemoryJobTable.status, "running")))
          .run()
          .pipe(Effect.orDie)
        released += 1
      }
      return { released }
    })

    const listCaptureJobs = Effect.fn("MemoryCapture.listCaptureJobs")(function* (input: { status?: string }) {
      if (input.status === undefined)
        return yield* db.select().from(MemoryJobTable).where(eq(MemoryJobTable.kind, "capture")).all().pipe(Effect.orDie)
      return yield* db
        .select()
        .from(MemoryJobTable)
        .where(and(eq(MemoryJobTable.kind, "capture"), eq(MemoryJobTable.status, input.status)))
        .all()
        .pipe(Effect.orDie)
    })

    const runCaptureJobOnce = Effect.fn("MemoryCapture.runCaptureJobOnce")(function* (input: { owner: string }) {
      const claimed = yield* claimCaptureJob(input)
      if (!claimed) return { ran: false as const }
      const sessionID = (claimed.payload as { session_id?: unknown } | null)?.session_id
      if (typeof sessionID !== "string" || !sessionID) {
        yield* completeCaptureJob({ id: claimed.id, owner: input.owner, status: "failed", error: "job has no session" })
        return { ran: true as const, id: claimed.id, status: "failed" }
      }
      const outcome = yield* capture({ sessionID: SessionID.make(sessionID) }).pipe(Effect.exit)
      if (outcome._tag === "Failure") {
        yield* completeCaptureJob({ id: claimed.id, owner: input.owner, status: "failed", error: Cause.pretty(outcome.cause).slice(0, 500) })
        return { ran: true as const, id: claimed.id, status: "failed" }
      }
      yield* completeCaptureJob({ id: claimed.id, owner: input.owner, status: "done" })
      return { ran: true as const, id: claimed.id, status: "done" }
    })

    const remember = Effect.fn("MemoryCapture.remember")(function* (input: {
      scope: "user" | "system"
      text: string
      topic?: string
    }) {
      const text = input.text.trim()
      if (input.scope !== "user" && input.scope !== "system")
        return yield* new ScopeError({ id: "", reason: "scope must be user or system" })
      if (text.length < MIN_CLAIM_LEN)
        return yield* new ScopeError({ id: "", reason: `text must be at least ${MIN_CLAIM_LEN} characters` })
      if (BANNED.some((re) => re.test(text))) return yield* new ScopeError({ id: "", reason: "text is banned" })
      const topic = (input.topic ?? "global").slice(0, 80)
      const hash = createHash("sha256").update(`${input.scope}\n${text}`).digest("hex")
      const existing = yield* db
        .select({ id: MemoryItemTable.id })
        .from(MemoryItemTable)
        .where(and(eq(MemoryItemTable.hash, hash), isNull(MemoryItemTable.project_id)))
        .all()
        .pipe(Effect.orDie)
      if (existing.length > 0) {
        const factRow = yield* db
          .select({ id: MemoryFactTable.id })
          .from(MemoryFactTable)
          .where(and(eq(MemoryFactTable.hash, hash), isNull(MemoryFactTable.project_id)))
          .get()
          .pipe(Effect.orDie)
        return { factID: factRow?.id ?? "", itemID: existing[0].id, deduped: true as const }
      }
      const embedding = yield* embed(text)
      const now = Date.now()
      const factID = `mem_${now.toString(36)}_${hash.slice(0, 8)}`
      const itemID = `mit_${now.toString(36)}_${hash.slice(0, 8)}`
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(MemoryFactTable)
              .values({
                id: factID,
                session_id: null,
                project_id: null,
                fact: text,
                topic,
                keywords: keywordsOf(text),
                embedding: embedding ?? null,
                vault_path: null,
                kind: "fact",
                source: input.scope,
                scope: input.scope,
                trust: 1.0,
                fetched_at: now,
                hash,
              })
              .onConflictDoNothing()
              .run()
            yield* tx
              .insert(MemoryItemTable)
              .values({
                id: itemID,
                project_id: null,
                kind: "fact",
                scope: input.scope,
                status: "active",
                claim: text,
                topic,
                keywords: keywordsOf(text),
                embedding: embedding ?? null,
                trust: 1.0,
                version: 1,
                source_id: null,
                session_id: null,
                vault_path: null,
                hash,
                fetched_at: now,
              })
              .onConflictDoNothing()
              .run()
          }),
        )
        .pipe(Effect.orDie)
      return { factID, itemID, deduped: false as const }
    })

    const setScope = Effect.fn("MemoryCapture.setScope")(function* (input: {
      id: string
      scope: "session" | "project"
      sessionID: SessionID
    }) {
      if (input.scope !== "session" && input.scope !== "project")
        return yield* new ScopeError({ id: input.id, reason: "scope must be session or project" })
      const actor = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!actor) return yield* new ScopeError({ id: input.id, reason: "actor session not found" })
      const row = yield* db.select().from(MemoryItemTable).where(eq(MemoryItemTable.id, input.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new ScopeError({ id: input.id, reason: "memory item not found" })
      if (row.scope !== "session" && row.scope !== "project")
        return yield* new ScopeError({ id: input.id, reason: "only session/project items can change scope" })
      if (row.project_id == null || actor.project_id == null || row.project_id !== actor.project_id)
        return yield* new ScopeError({ id: input.id, reason: "item and actor session must share a project" })
      if (input.scope === "project" && row.scope === "session") {
        yield* db.update(MemoryItemTable).set({ scope: "project" }).where(eq(MemoryItemTable.id, input.id)).run().pipe(Effect.orDie)
        return { id: input.id, scope: "project" }
      }
      if (input.scope === "session" && row.scope === "project") {
        if (row.session_id !== input.sessionID)
          return yield* new ScopeError({ id: input.id, reason: "only the originating session can take an item back" })
        yield* db.update(MemoryItemTable).set({ scope: "session" }).where(eq(MemoryItemTable.id, input.id)).run().pipe(Effect.orDie)
        return { id: input.id, scope: "session" }
      }
      return { id: input.id, scope: row.scope ?? input.scope }
    })

    const reviseMemory = Effect.fn("MemoryCapture.reviseMemory")(function* (input: {
      id: string
      sessionID: SessionID
      text: string
    }) {
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session || session.time_archived !== null)
        return yield* new ScopeError({ id: input.id, reason: "active session required" })
      const old = yield* db.select().from(MemoryItemTable).where(eq(MemoryItemTable.id, input.id)).get().pipe(Effect.orDie)
      if (!old) return yield* new ScopeError({ id: input.id, reason: "memory item not found" })
      if (old.status !== "active")
        return yield* new ScopeError({ id: input.id, reason: "only active items can be revised" })
      if ((old.project_id ?? null) !== (session.project_id ?? null))
        return yield* new ScopeError({ id: input.id, reason: "item and session must share a project" })
      const text = input.text.trim()
      if (text.length < MIN_CLAIM_LEN)
        return yield* new ScopeError({ id: input.id, reason: `text must be at least ${MIN_CLAIM_LEN} characters` })
      if (text.length > 2000 || BANNED.some((re) => re.test(text)))
        return yield* new ScopeError({ id: input.id, reason: "text too long or banned" })
      const projectID = old.project_id
      const newHash = createHash("sha256").update(`${projectID}\n${text}`).digest("hex")
      if (newHash === old.hash) return { oldID: old.id, itemID: old.id, deduped: true as const }
      const forgotten = yield* db
        .select({ id: MemoryTombstoneTable.id })
        .from(MemoryTombstoneTable)
        .where(
          projectID == null
            ? and(eq(MemoryTombstoneTable.hash, newHash), isNull(MemoryTombstoneTable.project_id))
            : and(eq(MemoryTombstoneTable.hash, newHash), eq(MemoryTombstoneTable.project_id, projectID)),
        )
        .all()
        .pipe(Effect.orDie)
      if (forgotten.length > 0) return yield* new ScopeError({ id: input.id, reason: "revised text was forgotten" })
      const dup = yield* db
        .select({ id: MemoryItemTable.id })
        .from(MemoryItemTable)
        .where(
          projectID == null
            ? and(eq(MemoryItemTable.hash, newHash), isNull(MemoryItemTable.project_id))
            : and(eq(MemoryItemTable.hash, newHash), eq(MemoryItemTable.project_id, projectID)),
        )
        .all()
        .pipe(Effect.orDie)
      if (dup.length > 0) return { oldID: old.id, itemID: dup[0].id, deduped: true as const }
      const embedding = yield* embed(text)
      const now = Date.now()
      const newItemID = `mit_${now.toString(36)}_${newHash.slice(0, 8)}`
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* supersedeItemTx(tx, old, { by: String(input.sessionID), reason: "explicit-revise" })
            yield* tx
              .insert(MemoryItemTable)
              .values({
                id: newItemID,
                project_id: projectID,
                kind: old.kind,
                scope: old.scope,
                status: "active",
                claim: text,
                topic: old.topic ?? "",
                keywords: keywordsOf(text),
                embedding: embedding ?? null,
                trust: old.trust ?? 1.0,
                version: (old.version ?? 1) + 1,
                source_id: old.source_id,
                session_id: input.sessionID,
                vault_path: null,
                hash: newHash,
                fetched_at: now,
              })
              .onConflictDoNothing()
              .run()
            yield* tx
              .insert(MemoryRelationTable)
              .values({ id: `mrel_${now.toString(36)}_${newItemID.slice(-6)}_${old.id.slice(-6)}`, from_id: newItemID, to_id: old.id, relation: "supersedes" })
              .onConflictDoNothing()
              .run()
          }),
        )
        .pipe(Effect.orDie)
      return { oldID: old.id, itemID: newItemID, deduped: false as const }
    })

    const normalizedClaim = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ")

    const rewriteProject = Effect.fn("MemoryCapture.rewriteProject")(function* (input: {
      projectID: string | null
      sessionID: SessionID
    }) {
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session || session.time_archived !== null)
        return yield* new ScopeError({ id: "", reason: "active session required" })
      if ((session.project_id ?? null) !== (input.projectID ?? null))
        return yield* new ScopeError({ id: "", reason: "session must belong to the rewritten project" })
      const projectID = input.projectID
      const projectRef = projectID == null ? null : ProjectV2.ID.make(projectID)
      const items = yield* db
        .select()
        .from(MemoryItemTable)
        .where(
          projectRef == null
            ? and(eq(MemoryItemTable.status, "active"), isNull(MemoryItemTable.project_id))
            : and(eq(MemoryItemTable.status, "active"), eq(MemoryItemTable.project_id, projectRef)),
        )
        .all()
        .pipe(Effect.orDie)
      const now = Date.now()
      const groups = new Map<string, typeof items>()
      for (const item of items) {
        const key = normalizedClaim(item.claim)
        const list = groups.get(key) ?? []
        list.push(item)
        groups.set(key, list)
      }
      let merged = 0
      let archived = 0
      const stale: string[] = []
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            for (const list of groups.values()) {
              if (list.length < 2) continue
              const ordered = [...list].sort((a, b) => (b.time_created ?? 0) - (a.time_created ?? 0) || (a.id < b.id ? 1 : -1))
              const keeper = ordered[0]
              for (const dup of ordered.slice(1)) {
                yield* supersedeItemTx(tx, dup, { by: String(input.sessionID), reason: "rewrite-dedup" })
                yield* tx
                  .insert(MemoryRelationTable)
                  .values({ id: `mrel_${now.toString(36)}_${keeper.id.slice(-6)}_${dup.id.slice(-6)}`, from_id: keeper.id, to_id: dup.id, relation: "supersedes" })
                  .onConflictDoNothing()
                  .run()
                merged += 1
                archived += 1
              }
            }
            const fresh = yield* tx
              .select()
              .from(MemoryItemTable)
              .where(
                projectRef == null
                  ? and(eq(MemoryItemTable.status, "active"), isNull(MemoryItemTable.project_id))
                  : and(eq(MemoryItemTable.status, "active"), eq(MemoryItemTable.project_id, projectRef)),
              )
              .all()
            for (const item of fresh) {
              if (item.ttl_days == null) continue
              const ageDays = Math.max(0, (now - (item.time_created ?? now)) / 86_400_000)
              if (ageDays > item.ttl_days) {
                yield* tx.update(MemoryItemTable).set({ status: "stale" }).where(eq(MemoryItemTable.id, item.id)).run()
                stale.push(item.id)
              }
            }
          }),
        )
        .pipe(Effect.orDie)
      return { merged, archived, stale }
    })

    return Service.of({
      capture,
      enqueueCaptureJob,
      claimCaptureJob,
      completeCaptureJob,
      requeueCaptureJob,
      releaseStaleJobs,
      listCaptureJobs,
      runCaptureJobOnce,
      remember,
      setScope,
      reviseMemory,
      rewriteProject,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Database.node],
})

export * as MemoryCapture from "./capture"
