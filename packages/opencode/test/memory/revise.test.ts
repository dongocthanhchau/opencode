import { createHash } from "node:crypto"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MemoryCapture } from "../../src/memory/capture"
import { MemoryRecall } from "../../src/memory/recall"
import { SessionID } from "../../src/session/schema"

const root = mkdtempSync(path.join(tmpdir(), "cvis-revise-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  Layer.merge(
    LayerNode.compile(MemoryCapture.node, [[Database.node, database]]),
    LayerNode.compile(MemoryRecall.node, [[Database.node, database]]),
  ).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()
const OLD = NOW - 2 * 86_400_000

process.env.OPENCODE_MEMORY_VAULT = path.join(root, "vault")
process.env.OPENCODE_MEMORY_EMBED_URL = "http://127.0.0.1:9"

function seedUserQuery(sid: string, text: string, at: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(
      sql`INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(${"q_" + sid + at},${sid},${at},${at},'{"role":"user"}')`,
    )
    yield* db.run(
      sql`INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(${"qp_" + sid + at},${"q_" + sid + at},${sid},${at},${at},${JSON.stringify(JSON.stringify({ type: "text", text }))})`,
    )
  })
}

function flip(effect: Effect.Effect<unknown, unknown, any>) {
  return runtime.runPromise(Effect.flip(effect))
}

type CapSvc = {
  reviseMemory: (input: { id: string; sessionID: SessionID; text: string }) => Effect.Effect<{ oldID: string; itemID: string; deduped: boolean }, any>
  rewriteProject: (input: { projectID: string | null; sessionID: SessionID }) => Effect.Effect<{ merged: number; archived: number; stale: string[] }, any>
}

function capEff<R>(fn: (svc: CapSvc) => Effect.Effect<R, unknown, any>) {
  return Effect.gen(function* () {
    const svc = yield* MemoryCapture.Service
    return yield* fn(svc)
  })
}

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const pid of ["rv-p", "rv-q"]) {
        yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(${pid},${root},'[]',${NOW},${NOW})`)
      }
      for (const [sid, pid] of [["ses_r1", "rv-p"], ["ses_r2", "rv-p"], ["ses_ro", "rv-q"]] as [string, string][]) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},${pid},${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
      }
      const item = (id: string, claim: string, sid: string) =>
        db.run(sql`INSERT INTO memory_item(id,project_id,kind,scope,status,claim,topic,hash,session_id,time_created,time_updated) VALUES(${id},'rv-p','fact','project','active',${claim},'t',${createHash("sha256").update(`rv-p\n${claim}`).digest("hex")},${sid},${NOW},${NOW})`)
      void item
      yield* db.run(
        sql`INSERT INTO memory_item(id,project_id,kind,scope,status,claim,topic,hash,session_id,time_created,time_updated) VALUES('it_a','rv-p','fact','project','active','The quasar xylophone array requires drift logging every cycle for audits.','t',${createHash("sha256").update("rv-p\nThe quasar xylophone array requires drift logging every cycle for audits.").digest("hex")},'ses_r1',${NOW},${NOW})`,
      )
      const dup = "Nebula piston waffle reviews are required every quarter for compliance."
      for (const [id, sid, suffix] of [["it_dup1", "ses_r1", ""], ["it_dup2", "ses_r2", " "]] as [string, string, string][]) {
        const text = dup + suffix
        yield* db.run(
          sql`INSERT INTO memory_item(id,project_id,kind,scope,status,claim,topic,hash,session_id,time_created,time_updated) VALUES(${id},'rv-p','fact','project','active',${text},'t',${createHash("sha256").update(`rv-p\n${text}`).digest("hex")},${sid},${NOW},${NOW})`,
        )
      }
      yield* db.run(
        sql`INSERT INTO memory_item(id,project_id,kind,scope,status,claim,topic,ttl_days,hash,session_id,time_created,time_updated) VALUES('it_old','rv-p','fact','project','active','The harbor crane schedule is posted on the green bulletin board downtown.', 't',1,${createHash("sha256").update("rv-p\nThe harbor crane schedule is posted on the green bulletin board downtown.").digest("hex")},'ses_r1',${OLD},${OLD})`,
      )
      yield* seedUserQuery("ses_r1", "Any news on quasar xylophone drift logging?", NOW + 1)
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("revise retires the old claim with archive, tombstone, and relation", async () => {
  const out = await runtime.runPromise(
    capEff((svc) =>
      svc.reviseMemory({
        id: "it_a",
        sessionID: SessionID.make("ses_r1"),
        text: "The quasar xylophone array requires drift logging every hour with timestamps.",
      }),
    ),
  )
  expect(out.deduped).toBe(false)
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const old = (yield* db.run(sql`SELECT status FROM memory_item WHERE id = 'it_a'`)) as unknown as { status: string }[]
      expect(old[0].status).toBe("superseded")
      const arch = (yield* db.run(sql`SELECT id FROM memory_archive WHERE payload LIKE '%it_a%'`)) as unknown as { id: string }[]
      expect(arch.length).toBe(1)
      const tomb = (yield* db.run(
        sql`SELECT id FROM memory_tombstone WHERE hash = ${createHash("sha256").update("rv-p\nThe quasar xylophone array requires drift logging every cycle for audits.").digest("hex")}`,
      )) as unknown as { id: string }[]
      expect(tomb.length).toBe(1)
      const rel = (yield* db.run(
        sql`SELECT relation FROM memory_relation WHERE from_id = ${out.itemID} AND to_id = 'it_a'`,
      )) as unknown as { relation: string }[]
      expect(rel).toMatchObject([{ relation: "supersedes" }])
      const nu = (yield* db.run(sql`SELECT version, claim FROM memory_item WHERE id = ${out.itemID}`)) as unknown as { version: number; claim: string }[]
      expect(nu[0].version).toBe(2)
    }),
  )
  const recalled = await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryRecall.Service
      return yield* svc.recallStrict({ sessionID: SessionID.make("ses_r1") })
    }),
  )
  expect(recalled).toContain("every hour")
  expect(recalled).not.toContain("every cycle")
})

test("revise refuses short, forgotten, and foreign claims", async () => {
  const r1 = await flip(
    capEff((svc) => svc.reviseMemory({ id: "it_dup1", sessionID: SessionID.make("ses_r1"), text: "too short" })),
  )
  expect(r1).toMatchObject({ _tag: "MemoryScopeError" })
  const forgottenText = "Forgotten claim text here for the tombstone unit test case."
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(
        sql`INSERT INTO memory_tombstone(id,hash,project_id,time_created,time_updated) VALUES('mt_forget',${createHash("sha256").update(`rv-p\n${forgottenText}`).digest("hex")},'rv-p',${NOW},${NOW})`,
      )
    }),
  )
  const r2 = await flip(
    capEff((svc) => svc.reviseMemory({ id: "it_dup1", sessionID: SessionID.make("ses_r1"), text: forgottenText })),
  )
  expect(r2).toMatchObject({ _tag: "MemoryScopeError" })
  const r3 = await flip(
    capEff((svc) => svc.reviseMemory({ id: "it_dup1", sessionID: SessionID.make("ses_ro"), text: "Cross project revision attempt with enough words here." })),
  )
  expect(r3).toMatchObject({ _tag: "MemoryScopeError" })
})

test("rewrite merges duplicates and flags stale items", async () => {
  const out = await runtime.runPromise(
    capEff((svc) => svc.rewriteProject({ projectID: "rv-p", sessionID: SessionID.make("ses_r2") })),
  )
  expect(out.merged).toBe(1)
  expect(out.archived).toBe(1)
  expect(out.stale).toContain("it_old")
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const actives = (yield* db.run(
        sql`SELECT id FROM memory_item WHERE claim LIKE 'Nebula piston%' AND status = 'active'`,
      )) as unknown as { id: string }[]
      expect(actives.length).toBe(1)
      const stale = (yield* db.run(sql`SELECT status FROM memory_item WHERE id = 'it_old'`)) as unknown as { status: string }[]
      expect(stale[0].status).toBe("stale")
    }),
  )
  const recalled = await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedUserQuery("ses_r1", "When is the harbor crane schedule posted?", NOW + 5)
      const svc = yield* MemoryRecall.Service
      return yield* svc.recallStrict({ sessionID: SessionID.make("ses_r1") })
    }),
  )
  expect(recalled ?? "").not.toContain("harbor crane")
})
