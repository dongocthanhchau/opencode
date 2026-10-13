import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MemoryCapture } from "../../src/memory/capture"

const root = mkdtempSync(path.join(tmpdir(), "cvis-capture-jobs-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(MemoryCapture.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

process.env.OPENCODE_MEMORY_VAULT = path.join(root, "vault")
process.env.OPENCODE_MEMORY_EMBED_URL = "http://127.0.0.1:9"

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('job-p',${root},'[]',${NOW},${NOW})`)
      for (const sid of ["ses_job", "ses_plain"]) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'job-p',${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
      }
      yield* db.run(
        sql`INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('msg_job','ses_job',${NOW},${NOW},'{"role":"assistant","summary":true}')`,
      )
      yield* db.run(
        sql`INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('prt_job','msg_job','ses_job',${NOW},${NOW},${JSON.stringify(JSON.stringify({ type: "text", text: "- The pilot API must return answer 42 for every request.\n- Review artifacts live under /srv/pilot/review for auditors." }))})`,
      )
    }),
  )
})

afterAll(() => runtime.dispose())

test("enqueue is idempotent while a job is open and rejects missing sessions", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      const first = yield* svc.enqueueCaptureJob({ sessionID: "ses_job" as never })
      expect(first.deduped).toBe(false)
      const second = yield* svc.enqueueCaptureJob({ sessionID: "ses_job" as never })
      expect(second).toEqual({ id: first.id, deduped: true })
      const missing = yield* svc.enqueueCaptureJob({ sessionID: "ghost" as never }).pipe(Effect.exit)
      expect(missing._tag).toBe("Failure")
    }),
  )
})

test("concurrent claims elect exactly one winner", async () => {
  const winners = await Promise.all([
    runtime.runPromise(Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      return yield* svc.claimCaptureJob({ owner: "worker-a" })
    })),
    runtime.runPromise(Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      return yield* svc.claimCaptureJob({ owner: "worker-b" })
    })),
  ])
  expect(winners.filter((w) => w !== undefined)).toHaveLength(1)
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      const claimed = winners.find((w) => w !== undefined)!
      const other = claimed.payload && typeof claimed.payload === "object" ? (claimed.payload as { owner?: string }).owner : undefined
      const wrongOwner = other === "worker-a" ? "worker-b" : "worker-a"
      expect(
        (yield* svc.completeCaptureJob({ id: claimed.id, owner: wrongOwner, status: "done" }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(
        (yield* svc.completeCaptureJob({ id: claimed.id, owner: other!, status: "maybe" }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      yield* svc.completeCaptureJob({ id: claimed.id, owner: other!, status: "done" })
    }),
  )
})

test("failed jobs requeue within budget and refuse beyond it", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      const { id } = yield* svc.enqueueCaptureJob({ sessionID: "ses_plain" as never })
      const claimed = yield* svc.claimCaptureJob({ owner: "w1" })
      expect(claimed?.id).toBe(id)
      yield* svc.completeCaptureJob({ id, owner: "w1", status: "failed", error: "simulated" })
      expect((yield* svc.requeueCaptureJob({ id, maxAttempts: 1 }).pipe(Effect.exit))._tag).toBe("Failure")
      yield* svc.requeueCaptureJob({ id, maxAttempts: 3 })
      const pending = yield* svc.listCaptureJobs({ status: "pending" })
      expect(pending.map((j) => j.id)).toContain(id)
      expect((yield* svc.requeueCaptureJob({ id }).pipe(Effect.exit))._tag).toBe("Failure")
      const cleanup = yield* svc.claimCaptureJob({ owner: "w2" })
      expect(cleanup?.id).toBe(id)
      yield* svc.completeCaptureJob({ id, owner: "w2", status: "done" })
    }),
  )
})

test("releaseStaleJobs recovers old running jobs and keeps fresh ones", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      const { db } = yield* Database.Service
      const one = yield* svc.enqueueCaptureJob({ sessionID: "ses_job" as never })
      yield* svc.enqueueCaptureJob({ sessionID: "ses_plain" as never })
      const c1 = yield* svc.claimCaptureJob({ owner: "stale-worker" })
      const c2 = yield* svc.claimCaptureJob({ owner: "fresh-worker" })
      expect(c1).toBeDefined()
      expect(c2).toBeDefined()
      expect(c1?.id).not.toBe(c2?.id)
      yield* db.run(sql`UPDATE memory_job SET time_updated=${NOW - 3_600_000} WHERE id=${one.id}`)
      const out = yield* svc.releaseStaleJobs({ olderThanMs: 60_000 })
      expect(out).toEqual({ released: 1 })
      const running = yield* svc.listCaptureJobs({ status: "running" })
      expect(running).toHaveLength(1)
      expect(running[0].id).not.toBe(one.id)
      const pending = yield* svc.listCaptureJobs({ status: "pending" })
      expect(pending.map((j) => j.id)).toContain(one.id)
      expect((yield* svc.releaseStaleJobs({ olderThanMs: -5 }).pipe(Effect.exit))._tag).toBe("Failure")
      const keeper = (running[0].payload as { owner?: string } | null)?.owner ?? "fresh-worker"
      yield* svc.completeCaptureJob({ id: running[0].id, owner: keeper, status: "done" })
    }),
  )
})

test("runCaptureJobOnce executes a real capture end to end", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* MemoryCapture.Service
      const { db } = yield* Database.Service
      yield* db.run(sql`DELETE FROM memory_job`)
      yield* svc.enqueueCaptureJob({ sessionID: "ses_job" as never })
      const result = yield* svc.runCaptureJobOnce({ owner: "runner" })
      expect(result).toEqual({ ran: true, id: expect.any(String), status: "done" })
      const items = yield* db.run(sql`SELECT count(*) AS n FROM memory_item`)
      expect((items[0] as unknown as { n: number }).n).toBeGreaterThan(0)
      expect(yield* svc.runCaptureJobOnce({ owner: "runner" })).toEqual({ ran: false })
      expect((yield* svc.claimCaptureJob({ owner: "" }).pipe(Effect.exit))._tag).toBe("Failure")
    }),
  )
})
