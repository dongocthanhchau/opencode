import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"

const root = mkdtempSync(path.join(tmpdir(), "cvis-tmpl-lib-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

function svcEff(fn: (svc: any) => Effect.Effect<any, any, any>): Promise<any> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* Orchestration.Service
      return yield* fn(svc)
    }),
  )
}

function failSvc(fn: (svc: any) => Effect.Effect<unknown, unknown, any>) {
  return runtime.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const svc = yield* Orchestration.Service
        return yield* fn(svc)
      }),
    ),
  )
}

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('tl-p',${root},'[]',${NOW},${NOW})`)
      for (const [sid, role, tid] of [["ses_lm", "manager", "t_lm"], ["ses_lw", "implementer", "t_lw"]] as [string, string, string][]) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'tl-p',${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES(${tid},'tl-p',${tid},${role},'running',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},'tl-p',${role},${tid},'busy',${NOW},${NOW})`,
        )
      }
      mkdirSync(path.join(root, "plib"), { recursive: true })
      writeFileSync(path.join(root, "plib", "good.json"), JSON.stringify({ name: "libtest", body: "Library body {{x}}", inputs: [{ name: "x", required: true }] }))
      writeFileSync(path.join(root, "plib", "noname.json"), JSON.stringify({ body: "No name here, still long enough to pass body checks." }))
      writeFileSync(path.join(root, "plib", "broken.json"), "{not json")
      writeFileSync(path.join(root, "plib", "notes.txt"), "ignored")
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("library files land as canary versions with per-file reports", async () => {
  const out = await svcEff((svc) => svc.importPromptLibrary({ projectID: "tl-p", dir: "plib", actorSessionID: "ses_lm" }))
  expect(out.imported).toMatchObject([{ name: "libtest", version: 1 }, { name: "noname", version: 1 }])
  expect(out.skipped.map((s: { file: string }) => s.file)).toEqual(["broken.json"])
  const list = await svcEff((svc) => svc.listTemplates({}))
  const row = (list as { name: string; status: string }[]).find((t) => t.name === "libtest")
  expect(row?.status).toBe("canary")
  const again = await svcEff((svc) => svc.importPromptLibrary({ projectID: "tl-p", dir: "plib", actorSessionID: "ses_lm" }))
  expect(again.imported).toMatchObject([{ name: "libtest", version: 2 }, { name: "noname", version: 2 }])
})

test("import is manager-only and worktree-bound", async () => {
  const r1 = await failSvc((svc) => svc.importPromptLibrary({ projectID: "tl-p", dir: "plib", actorSessionID: "ses_lw" }))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failSvc((svc) => svc.importPromptLibrary({ projectID: "tl-p", dir: "..", actorSessionID: "ses_lm" }))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r3 = await failSvc((svc) => svc.importPromptLibrary({ projectID: "tl-p", dir: "missing", actorSessionID: "ses_lm" }))
  expect(r3).toMatchObject({ _tag: "CvisNotFound" })
})
