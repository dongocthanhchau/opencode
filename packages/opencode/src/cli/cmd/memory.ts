import type { Argv } from "yargs"
import { Cause, Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
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
      .command(MemoryJobEnqueueCommand)
      .command(MemoryJobClaimCommand)
      .command(MemoryJobCompleteCommand)
      .command(MemoryJobRetryCommand)
      .command(MemoryJobReleaseCommand)
      .command(MemoryJobListCommand)
      .command(MemoryJobRunOnceCommand)
      .command(MemoryRememberCommand)
      .command(MemorySetScopeCommand)
      .command(MemoryReviseCommand)
      .command(MemoryRewriteCommand)
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
    const exit = yield* Effect.exit(svc.recallStrict({ sessionID: SessionID.make(args.sessionID) }))
    if (exit._tag === "Failure") {
      return yield* fail(`memory recall failed: ${Cause.pretty(exit.cause)}`)
    }
    UI.println(exit.value ?? "(no memories recalled)")
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

function jobFailureMessage(cause: unknown): string {
  const failure = Cause.squash(cause as never)
  if (typeof failure === "object" && failure !== null && typeof (failure as { _tag?: unknown })._tag === "string") {
    const tagged = failure as { _tag: string; id?: unknown; reason?: unknown }
    if (tagged._tag === "MemoryJobNotFound") return `memory job not found: ${String(tagged.id)}`
    if (tagged._tag === "MemoryJobConflict") return `memory job conflict ${String(tagged.id)}: ${String(tagged.reason)}`
    if (tagged._tag === "MemoryScopeError") return `memory scope error ${String(tagged.id)}: ${String(tagged.reason)}`
  }
  return Cause.pretty(cause as never)
}

function runJob<A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, import("../effect-cmd").CliError> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (exit._tag === "Failure") {
      return yield* fail(`memory job failed: ${jobFailureMessage(exit.cause)}`)
    }
    return exit.value
  }) as Effect.Effect<A, import("../effect-cmd").CliError>
}

export const MemoryJobEnqueueCommand = effectCmd({
  command: "job-enqueue <sessionID>",
  describe: "enqueue a durable capture job for a session (idempotent while open)",
  instance: false,
  builder: (yargs) => yargs.positional("sessionID", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.jobEnqueue")(function* (args) {
    const svc = yield* MemoryCapture.Service
    const out = yield* runJob(svc.enqueueCaptureJob({ sessionID: SessionID.make(args.sessionID as string) }))
    UI.println(JSON.stringify(out))
  }),
})

export const MemoryJobClaimCommand = effectCmd({
  command: "job-claim",
  describe: "claim the oldest pending capture job for an owner (single winner)",
  instance: false,
  builder: (yargs) => yargs.option("owner", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.jobClaim")(function* (args) {
    const svc = yield* MemoryCapture.Service
    const out = yield* runJob(svc.claimCaptureJob({ owner: args.owner as string }))
    UI.println(JSON.stringify(out ?? null))
  }),
})

export const MemoryJobCompleteCommand = effectCmd({
  command: "job-complete <id>",
  describe: "record a claimed capture job as done or failed",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("owner", { type: "string", demandOption: true })
      .option("status", { type: "string", demandOption: true })
      .option("error", { type: "string" }),
  handler: Effect.fn("Cli.memory.jobComplete")(function* (args) {
    const svc = yield* MemoryCapture.Service
    yield* runJob(
      svc.completeCaptureJob({
        id: args.id as string,
        owner: args.owner as string,
        status: args.status as string,
        error: (args.error as string | undefined) ?? undefined,
      }),
    )
    UI.println("ok")
  }),
})

export const MemoryJobRetryCommand = effectCmd({
  command: "job-retry <id>",
  describe: "requeue a failed capture job while its attempt budget lasts",
  instance: false,
  builder: (yargs) =>
    yargs.positional("id", { type: "string", demandOption: true }).option("max-attempts", { type: "number" }),
  handler: Effect.fn("Cli.memory.jobRetry")(function* (args) {
    const svc = yield* MemoryCapture.Service
    yield* runJob(
      svc.requeueCaptureJob({
        id: args.id as string,
        maxAttempts: (args["max-attempts"] as number | undefined) ?? undefined,
      }),
    )
    UI.println("ok")
  }),
})

export const MemoryJobReleaseCommand = effectCmd({
  command: "job-release",
  describe: "release running capture jobs untouched for longer than a cutoff back to pending",
  instance: false,
  builder: (yargs) => yargs.option("older-than-ms", { type: "number", demandOption: true }),
  handler: Effect.fn("Cli.memory.jobRelease")(function* (args) {
    const svc = yield* MemoryCapture.Service
    const out = yield* runJob(svc.releaseStaleJobs({ olderThanMs: args["older-than-ms"] as number }))
    UI.println(JSON.stringify(out))
  }),
})

export const MemoryJobListCommand = effectCmd({
  command: "job-list",
  describe: "list capture jobs, optionally filtered by status",
  instance: false,
  builder: (yargs) => yargs.option("status", { type: "string" }),
  handler: Effect.fn("Cli.memory.jobList")(function* (args) {
    const svc = yield* MemoryCapture.Service
    const out = yield* runJob(svc.listCaptureJobs({ status: (args.status as string | undefined) ?? undefined }))
    UI.println(JSON.stringify(out))
  }),
})

export const MemoryJobRunOnceCommand = effectCmd({
  command: "job-run-once",
  describe: "claim the oldest pending capture job and run its capture immediately",
  instance: false,
  builder: (yargs) => yargs.option("owner", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.jobRunOnce")(function* (args) {
    const svc = yield* MemoryCapture.Service
    const out = yield* runJob(svc.runCaptureJobOnce({ owner: args.owner as string }))
    UI.println(JSON.stringify(out))
  }),
})

export const MemoryRememberCommand = effectCmd({
  command: "remember",
  describe: "store an explicit global (user/system) memory visible to every session",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("scope", { type: "string", demandOption: true, choices: ["user", "system"] })
      .option("text", { type: "string", demandOption: true })
      .option("topic", { type: "string" }),
  handler: Effect.fn("Cli.memory.remember")(function* (args) {
    const svc = yield* MemoryCapture.Service
    const out = yield* runJob(
      svc.remember({
        scope: args.scope as "user" | "system",
        text: args.text as string,
        topic: (args.topic as string | undefined) ?? undefined,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const MemorySetScopeCommand = effectCmd({
  command: "set-scope <id> <scope>",
  describe: "promote a session memory to project visibility (or take it back)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .positional("scope", { type: "string", demandOption: true, choices: ["session", "project"] })
      .option("session", { type: "string", demandOption: true, describe: "actor session in the same project" }),
  handler: Effect.fn("Cli.memory.setScope")(function* (args) {
    const svc = yield* MemoryCapture.Service
    const out = yield* runJob(
      svc.setScope({
        id: args.id as string,
        scope: args.scope as "session" | "project",
        sessionID: SessionID.make(args.session as string),
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const MemoryReviseCommand = effectCmd({
  command: "revise <id>",
  describe: "revise one memory claim (old version archived + tombstoned for rollback)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("session", { type: "string", demandOption: true })
      .option("text", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.revise")(function* (args) {
    const svc = yield* MemoryCapture.Service
    const out = yield* runJob(
      svc.reviseMemory({
        id: args.id as string,
        sessionID: SessionID.make(args.session as string),
        text: args.text as string,
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})

export const MemoryRewriteCommand = effectCmd({
  command: "rewrite",
  describe: "merge duplicate claims and flag past-TTL items stale for one project",
  instance: false,
  builder: (yargs) =>
    yargs.option("project", { type: "string", describe: "project ID (omit for global rows)" }).option("session", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.memory.rewrite")(function* (args) {
    const svc = yield* MemoryCapture.Service
    const out = yield* runJob(
      svc.rewriteProject({
        projectID: (args.project as string | undefined) ?? null,
        sessionID: SessionID.make(args.session as string),
      }),
    )
    UI.println(JSON.stringify(out))
  }),
})
