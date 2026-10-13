import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-schedule-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()
let managed = ""

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      managed = (yield* svc.registerManagedProject({ slug: "sched-proj", type: "work" })).id
    }),
  )
})

afterAll(() => runtime.dispose())

test("register validates input and is idempotent on name", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      const first = yield* svc.registerSchedule({ managedProjectID: managed, name: "hourly", intervalSeconds: 3600, nextDueAt: NOW + 10_000_000 })
      const second = yield* svc.registerSchedule({ managedProjectID: managed, name: "hourly", intervalSeconds: 60 })
      expect(second.id).toBe(first.id)
      expect((yield* svc.getSchedule({ id: first.id })).interval_seconds).toBe(3600)
      for (const bad of [
        svc.registerSchedule({ managedProjectID: "ghost", name: "x" }),
        svc.registerSchedule({ managedProjectID: managed, name: "Bad Name" }),
        svc.registerSchedule({ managedProjectID: managed, name: "x", intervalSeconds: -5 }),
        svc.registerSchedule({ managedProjectID: managed, name: "x", intervalSeconds: 1.5 }),
      ]) {
        expect((yield* bad.pipe(Effect.exit))._tag).toBe("Failure")
      }
    }),
  )
})

test("concurrent ticks elect exactly one winner", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      yield* svc.registerSchedule({ managedProjectID: managed, name: "race", nextDueAt: NOW - 1000 })
    }),
  )
  const winners = await Promise.all([
    runtime.runPromise(Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* svc.claimDueSchedule({ owner: "owner-a", now: NOW + 10_000 })
    })),
    runtime.runPromise(Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* svc.claimDueSchedule({ owner: "owner-b", now: NOW + 10_000 })
    })),
  ])
  expect(winners.filter((w) => w !== undefined)).toHaveLength(1)
})

test("expired leases are reclaimable, disabled and future schedules are not", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      const { id } = yield* svc.registerSchedule({ managedProjectID: managed, name: "reclaim", nextDueAt: NOW - 1000 })
      const first = yield* svc.claimDueSchedule({ owner: "o1", leaseMs: 50, now: NOW })
      expect(first?.id).toBe(id)
      expect(yield* svc.claimDueSchedule({ owner: "o2", now: NOW })).toBeUndefined()
      const second = yield* svc.claimDueSchedule({ owner: "o2", now: NOW + 1000 })
      expect(second?.id).toBe(id)
      yield* svc.completeScheduleRun({ id, owner: "o2", status: "ok" })
      yield* svc.setScheduleEnabled({ id, enabled: false })
      expect(yield* svc.claimDueSchedule({ owner: "o3", now: NOW + 100_000 })).toBeUndefined()
      const future = yield* svc.registerSchedule({ managedProjectID: managed, name: "future", nextDueAt: NOW + 1_000_000 })
      expect(yield* svc.claimDueSchedule({ owner: "o3", now: NOW })).toBeUndefined()
      expect((yield* svc.getSchedule({ id: future.id })).enabled).toBe(1)
    }),
  )
})

test("completion enforces lease ownership and tracks failures", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      const { id } = yield* svc.registerSchedule({ managedProjectID: managed, name: "owned", intervalSeconds: 60, nextDueAt: NOW - 5000 })
      const claimed = yield* svc.claimDueSchedule({ owner: "rightful", now: NOW })
      expect(claimed?.id).toBe(id)
      expect((yield* svc.completeScheduleRun({ id, owner: "wrong", status: "ok" }).pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* svc.completeScheduleRun({ id, owner: "rightful", status: "maybe" }).pipe(Effect.exit))._tag).toBe("Failure")
      yield* svc.completeScheduleRun({ id, owner: "rightful", status: "failed" })
      const afterFail = yield* svc.getSchedule({ id })
      expect(afterFail.consecutive_failures).toBe(1)
      expect(afterFail.lease_owner).toBeNull()
      expect(afterFail.next_due_at).toBeGreaterThan(NOW)
      const again = yield* svc.claimDueSchedule({ owner: "rightful", now: afterFail.next_due_at })
      expect(again?.id).toBe(id)
      yield* svc.completeScheduleRun({ id, owner: "rightful", status: "ok" })
      expect((yield* svc.getSchedule({ id })).consecutive_failures).toBe(0)
    }),
  )
})

test("one-shot schedules disable themselves after completion", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      const { id } = yield* svc.registerSchedule({ managedProjectID: managed, name: "once", nextDueAt: NOW - 5000 })
      const claimed = yield* svc.claimDueSchedule({ owner: "runner", now: NOW })
      expect(claimed?.id).toBe(id)
      yield* svc.completeScheduleRun({ id, owner: "runner", status: "ok" })
      expect((yield* svc.getSchedule({ id })).enabled).toBe(0)
      for (const row of yield* svc.listSchedules({ managedProjectID: managed })) {
        if (row.enabled === 1) yield* svc.setScheduleEnabled({ id: row.id, enabled: false })
      }
      expect(yield* svc.claimDueSchedule({ owner: "runner", now: NOW + 1_000_000 })).toBeUndefined()
      const listed = yield* svc.listSchedules({ managedProjectID: managed })
      expect(listed.map((r) => r.name)).toContain("once")
    }),
  )
})

test("empty owner is rejected", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      expect((yield* svc.claimDueSchedule({ owner: "  " }).pipe(Effect.exit))._tag).toBe("Failure")
    }),
  )
})
