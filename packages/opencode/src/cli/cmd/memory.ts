import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { CliError, effectCmd } from "../effect-cmd"
import { MemoryCapture, classifyRelation } from "@/memory/capture"
import { MemoryRecall } from "@/memory/recall"
import { MemoryGraphCommand } from "./memory-graph"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { unlink } from "node:fs/promises"
import { inArray, isNotNull } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { MemoryFactTable, MemoryItemTable, MemoryTombstoneTable, SessionTable } from "@opencode-ai/core/session/sql"
import { cosine } from "@/memory/recall"

export const MemoryCommand = cmd({
  command: "memory",
  describe: "manage long-term memory",
  builder: (yargs: Argv) =>
    yargs
      .command(MemoryCaptureCommand)
      .command(MemoryRecallCommand)
      .command(MemoryPruneCommand)
      .command(MemoryGraphCommand)
      .demandCommand(),
  async handler() {},
})

export const MemoryCaptureCommand = effectCmd({
  command: "capture <sessionID>",
  describe: "capture a memory fact from a compacted session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to capture from",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.memory.capture")(function* (args) {
    const svc = yield* MemoryCapture.Service
    yield* svc.capture({ sessionID: SessionID.make(args.sessionID) })
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Memory capture done" + UI.Style.TEXT_NORMAL)
  }),
})
export const MemoryRecallCommand = effectCmd({
  command: "recall <sessionID>",
  describe: "recall relevant memories for a session (debug/verify)",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to recall for",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.memory.recall")(function* (args) {
    const svc = yield* MemoryRecall.Service
    // Strict variant: surfaces failures (e.g. unreadable FTS index) instead
    // of printing an empty result. The live prompt path keeps using recall.
    const out = yield* svc
      .recallStrict({ sessionID: SessionID.make(args.sessionID) })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CliError({
              message: `memory recall failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      )
    UI.println(out ?? "(no memories recalled)")
  }),
})
export const MemoryPruneCommand = effectCmd({
  command: "prune",
  describe: "report or remove duplicated, verbose, or obsolete memory facts",
  builder: (yargs) =>
    yargs
      .option("apply", {
        describe: "actually delete flagged facts (default is dry-run report)",
        type: "boolean",
        default: false,
      })
      .option("days", {
        describe: "facts older than this many days are flagged stale for review (never auto-deleted)",
        type: "number",
        default: 90,
      })
      .option("max-chars", {
        describe: "facts longer than this count as verbose",
        type: "number",
        default: 2000,
      })
      .option("kind", {
        describe: "only consider facts of this kind",
        type: "string",
      })
      .option("source", {
        describe: "only consider facts from this source",
        type: "string",
      }),
  handler: Effect.fn("Cli.memory.prune")(function* (args) {
    const { db } = yield* Database.Service
    const all = yield* db.select().from(MemoryFactTable).all().pipe(Effect.orDie)
    const facts = all.filter(
      (f) => (!args.kind || f.kind === args.kind) && (!args.source || f.source === args.source),
    )
    const now = Date.now()
    const obsoleteCutoff = now - args.days * 86_400_000

    const archivedSessions = new Set(
      (
        yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(isNotNull(SessionTable.time_archived))
          .all()
          .pipe(Effect.orDie)
      ).map((r) => r.id),
    )

    const seen = new Map<string, (typeof facts)[number]>()
    const dupes: string[] = []
    for (const fact of facts) {
      const key = `${fact.project_id ?? ""}\u0000${fact.hash}`
      if (fact.hash && seen.has(key)) dupes.push(fact.id)
      else if (fact.hash) seen.set(key, fact)
    }

    const withEmbeddings = facts.filter((f) => Array.isArray(f.embedding) && (f.embedding as number[]).length > 0)
    const nearDupes = new Set<string>()
    const conflicts: [string, string][] = []
    const capped = withEmbeddings.slice(0, 500)
    for (let i = 0; i < capped.length; i++) {
      for (let j = i + 1; j < capped.length; j++) {
        // B4: duplicates are per-project — never prune across project scopes.
        if (capped[i].project_id !== capped[j].project_id) continue
        const cos = cosine(capped[i].embedding as number[], capped[j].embedding as number[])
        if (cos === undefined || cos < 0.85) continue
        const older = (capped[i].time_created ?? 0) <= (capped[j].time_created ?? 0) ? capped[i] : capped[j]
        const newer = older === capped[i] ? capped[j] : capped[i]
        // Cosine alone cannot tell an update from a contradiction: only prune
        // when the newer fact plausibly replaces the older one, never when
        // their polarity disagrees.
        const verdict = classifyRelation({
          cosine: cos,
          sameTopic: (older.topic ?? "") === (newer.topic ?? ""),
          newClaim: newer.fact,
          oldClaim: older.fact,
        })
        if (verdict === "contradicts") {
          conflicts.push([newer.id, older.id])
          continue
        }
        nearDupes.add(older.id)
      }
    }

    const verbose = facts.filter((f) => f.fact.length > args.maxChars).map((f) => f.id)
    // Age and archived sessions only flag facts for human review — they never
    // justify deletion by themselves. Only exact/near duplicates are removed.
    // TTL expiry means "needs re-verification", reported as stale.
    const stale = facts
      .filter(
        (f) =>
          (f.session_id && archivedSessions.has(f.session_id)) ||
          (f.time_created ?? now) < obsoleteCutoff ||
          (f.ttl_days != null && now - (f.time_created ?? now) > f.ttl_days * 86_400_000),
      )
      .map((f) => f.id)

    const remove = new Set([...dupes, ...nearDupes])
    UI.println(`facts: ${facts.length}  dupes: ${dupes.length}  near-dupes: ${nearDupes.size}  conflicts: ${conflicts.length}  verbose: ${verbose.length}  stale: ${stale.length}`)
    for (const id of remove) UI.println(`  prune ${id}`)
    for (const [a, b] of conflicts) UI.println(`  conflict ${a} <-> ${b} (review, not pruned)`)
    for (const id of verbose) UI.println(`  verbose ${id}`)
    for (const id of stale) UI.println(`  stale ${id}`)

    if (args.apply && remove.size > 0) {
      const ids = [...remove]
      const rows = facts.filter((f) => remove.has(f.id))
      // Items decomposed from a pruned fact would otherwise resurrect it
      // via recall. Remove only the items whose claim came from the pruned
      // fact text — never unrelated items that merely share the session.
      const prunedSessionIDs = [...new Set(rows.flatMap((r) => (r.session_id ? [r.session_id] : [])))]
      const sessionItems =
        prunedSessionIDs.length > 0
          ? yield* db
              .select()
              .from(MemoryItemTable)
              .where(inArray(MemoryItemTable.session_id, prunedSessionIDs))
              .all()
              .pipe(Effect.orDie)
          : []
      const prunedItems = sessionItems.filter((item) =>
        rows.some((row) => row.session_id != null && row.session_id === item.session_id && row.fact.includes(item.claim)),
      )
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(MemoryFactTable).where(inArray(MemoryFactTable.id, ids)).run()
            if (prunedItems.length > 0) {
              yield* tx
                .delete(MemoryItemTable)
                .where(
                  inArray(
                    MemoryItemTable.id,
                    prunedItems.map((i) => i.id),
                  ),
                )
                .run()
            }
            for (const row of rows) {
              yield* tx
                .insert(MemoryTombstoneTable)
                .values({
                  id: `mtb_${Date.now().toString(36)}_${row.hash.slice(0, 8)}`,
                  hash: row.hash,
                  project_id: row.project_id ?? null,
                  reason: "prune-duplicate",
                })
                .onConflictDoNothing()
                .run()
            }
            for (const item of prunedItems) {
              yield* tx
                .insert(MemoryTombstoneTable)
                .values({
                  id: `mtb_${Date.now().toString(36)}_${item.hash.slice(0, 8)}`,
                  hash: item.hash,
                  project_id: item.project_id ?? null,
                  reason: "prune-duplicate",
                })
                .onConflictDoNothing()
                .run()
            }
          }),
        )
        .pipe(Effect.orDie)
      for (const row of rows) {
        if (!row.vault_path) continue
        yield* Effect.tryPromise({
          try: () => unlink(row.vault_path as string),
          catch: () => new Error("unlink failed"),
        }).pipe(Effect.ignore)
      }
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD + `Pruned ${ids.length} fact(s), ${prunedItems.length} item(s)` + UI.Style.TEXT_NORMAL,
      )
    } else {
      UI.println(args.apply ? "Nothing to prune" : "Dry run: pass --apply to delete")
    }
  }),
})
