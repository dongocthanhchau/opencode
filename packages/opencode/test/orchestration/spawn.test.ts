import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-spawn-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

function spawnEff(input: {
  projectID: string
  actorSessionID: string
  role?: "manager" | "researcher" | "implementer" | "verifier" | "maintenance"
  taskID?: string
  directory?: string
  title?: string
}) {
  return Effect.gen(function* () {
    const svc = yield* Orchestration.Service
    return yield* svc.spawnSession(input)
  })
}

function failWith(effect: Effect.Effect<unknown, unknown, any>) {
  return runtime.runPromise(Effect.flip(effect))
}

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const pid of ["sp-p", "sp-q", "sp-cap"]) {
        yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(${pid},${root},'[]',${NOW},${NOW})`)
      }
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_m','sp-p','m',${root},'m','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('t_mgr','sp-p','m','manager','running',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_m','sp-p','manager','t_mgr','busy',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_w','sp-p','w',${root},'w','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('t_w','sp-p','w','implementer','running',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_w','sp-p','implementer','t_w','busy',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('t_new','sp-p','n','implementer','queued',${NOW},${NOW})`,
      )
      for (let i = 0; i < 20; i++) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${"ses_cap" + i},'sp-cap',${"c" + i},${root},'c','v1',${NOW},${NOW})`,
        )
      }
      yield* db.run(
        sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_capmgr','sp-cap','cm',${root},'c','v1',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('t_capmgr','sp-cap','m','manager','running',${NOW},${NOW})`,
      )
      yield* db.run(
        sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_capmgr','sp-cap','manager','t_capmgr','busy',${NOW},${NOW})`,
      )
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("manager spawns a bound worker inside the worktree", async () => {
  const out = await runtime.runPromise(spawnEff({ projectID: "sp-p", actorSessionID: "ses_m", role: "implementer", taskID: "t_new", title: "w1" }))
  expect(out.bound).toBe(true)
  expect(out.sessionID.startsWith("ses_")).toBe(true)
  const rows = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* db.run(sql`SELECT project_id, directory, title FROM session WHERE id = ${out.sessionID}`)
    }),
  )) as unknown as { project_id: string; directory: string; title: string }[]
  expect(rows.length).toBe(1)
  expect(rows[0].project_id).toBe("sp-p")
  expect(rows[0].title).toBe("w1")
  const bindings = (await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* db.run(sql`SELECT role, task_id, status FROM cvis_session_binding WHERE session_id = ${out.sessionID}`)
    }),
  )) as unknown as { role: string; task_id: string; status: string }[]
  expect(bindings).toMatchObject([{ role: "implementer", task_id: "t_new" }])
})

test("spawn without a task leaves the session unbound", async () => {
  const out = await runtime.runPromise(spawnEff({ projectID: "sp-p", actorSessionID: "ses_m" }))
  expect(out.bound).toBe(false)
})

test("non-managers cannot spawn", async () => {
  const r1 = await failWith(spawnEff({ projectID: "sp-p", actorSessionID: "ses_w", role: "implementer" }))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("directories cannot escape the worktree", async () => {
  const r1 = await failWith(spawnEff({ projectID: "sp-p", actorSessionID: "ses_m", directory: "../escape" }))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failWith(spawnEff({ projectID: "sp-p", actorSessionID: "ses_m", directory: "/tmp" }))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("role must be valid and match the task", async () => {
  const r1 = await failWith(
    spawnEff({ projectID: "sp-p", actorSessionID: "ses_m", role: "janitor" as never, taskID: "t_new" }),
  )
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failWith(spawnEff({ projectID: "sp-p", actorSessionID: "ses_m", role: "verifier", taskID: "t_new" }))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("live session cap is enforced", async () => {
  const r = await failWith(spawnEff({ projectID: "sp-cap", actorSessionID: "ses_capmgr" }))
  expect(r).toMatchObject({ _tag: "CvisConflict" })
})
