import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "../../src/orchestration/service"
import { parsePluginManifest, parseSkillFile, renderSkillFile } from "../../src/orchestration/plugin-manifest"

const root = mkdtempSync(path.join(tmpdir(), "cvis-plugin-"))
const database = Database.layerFromPath(path.join(root, "state.db"))
const runtime = ManagedRuntime.make(
  LayerNode.compile(Orchestration.node, [[Database.node, database]]).pipe(Layer.provideMerge(database)),
)

const NOW = Date.now()

function svcEff<R>(fn: (svc: any) => Effect.Effect<R, any, any>) {
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
      yield* db.run(sql`INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('pg-p',${root},'[]',${NOW},${NOW})`)
      yield* db.run(sql`INSERT INTO cvis_managed_project(id,slug,type,status,time_created,time_updated) VALUES('mp_pg','plug','initiative','planning',${NOW},${NOW})`)
      for (const [sid, role, tid] of [["ses_pm", "manager", "t_pm"], ["ses_pw", "implementer", "t_pw"]] as [string, string, string][]) {
        yield* db.run(
          sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(${sid},'pg-p',${sid},${root},${sid},'v1',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES(${tid},'pg-p',${tid},${role},'running',${NOW},${NOW})`,
        )
        yield* db.run(
          sql`INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(${sid},'pg-p',${role},${tid},'busy',${NOW},${NOW})`,
        )
      }
      mkdirSync(path.join(root, "fixture-skill"), { recursive: true })
      writeFileSync(
        path.join(root, "fixture-skill", "SKILL.md"),
        "---\nname: fixture-skill\ndescription: A fixture skill used to prove directory imports work end to end.\n---\n\n# Fixture\n\nDo the thing.\n",
      )
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
})

test("manifest and skill file helpers validate strictly", () => {
  expect(parsePluginManifest({ name: "x", version: 1, kind: "skill", description: "long enough description here" }).ok).toBe(true)
  expect(parsePluginManifest({ name: "x", version: 0, kind: "skill", description: "long enough description here" }).ok).toBe(false)
  expect(parsePluginManifest({ name: "x", version: 1, kind: "widget", description: "long enough description here" }).ok).toBe(false)
  expect(parsePluginManifest({ name: "x", version: 1, kind: "template", description: "long enough description here" }).ok).toBe(false)
  const parsed = parseSkillFile("---\nname: s\ndescription: a description long enough here\n---\n\nBody.\n")
  expect(parsed.ok).toBe(true)
  expect(parseSkillFile("no frontmatter").ok).toBe(false)
  const rendered = renderSkillFile({ name: "s", description: "a description long enough here", body: "Body." })
  expect(rendered.startsWith("---\nname: s\n")).toBe(true)
})

test("install routes kinds and refuses hooks", async () => {
  const skill = await svcEff((svc) =>
    svc.installPlugin({ projectID: "pg-p", manifest: { name: "s1", version: 1, kind: "skill", description: "A skill manifest for install routing tests here." }, actorSessionID: "ses_pw" }),
  )
  expect(skill).toMatchObject({ kind: "skill", version: 1 })
  const r1 = await failSvc((svc) =>
    svc.installPlugin({ projectID: "pg-p", manifest: { name: "h1", version: 1, kind: "hook", description: "A hook manifest that must stay reserved for now." }, actorSessionID: "ses_pw" }),
  )
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failSvc((svc) =>
    svc.installPlugin({ projectID: "pg-p", manifest: { name: "bad", version: 1, kind: "skill", description: "short" }, actorSessionID: "ses_pw" }),
  )
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("template plugins land as canary templates", async () => {
  const out = await svcEff((svc) =>
    svc.installPlugin({ projectID: "pg-p", manifest: { name: "tmplplug", version: 1, kind: "template", description: "A template plugin body for canary tests.", body: "Hello {{who}}" }, actorSessionID: "ses_pw" }),
  )
  expect(out).toMatchObject({ kind: "template" })
  const list = await svcEff((svc) => svc.listTemplates({}))
  const row = (list as { name: string; status: string }[]).find((t) => t.name === "tmplplug")
  expect(row?.status).toBe("canary")
})

test("skill dir import respects the worktree and frontmatter", async () => {
  const out = await svcEff((svc) => svc.importSkillDir({ projectID: "pg-p", dir: "fixture-skill", actorSessionID: "ses_pw" }))
  expect((out as { name: string }).name).toBe("fixture-skill")
  const r1 = await failSvc((svc) => svc.importSkillDir({ projectID: "pg-p", dir: "..", actorSessionID: "ses_pw" }))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  const r2 = await failSvc((svc) => svc.importSkillDir({ projectID: "pg-p", dir: "no-such-dir", actorSessionID: "ses_pw" }))
  expect(r2).toMatchObject({ _tag: "CvisNotFound" })
})

test("export needs active status, manager, and no overwrite", async () => {
  const proposed = await svcEff((svc) =>
    svc.installPlugin({ projectID: "pg-p", manifest: { name: "expskill", version: 1, kind: "skill", description: "An exportable skill with procedure notes here.", entry: "SKILL.md" }, actorSessionID: "ses_pw" }),
  )
  const pid = (proposed as { id: string }).id
  const r1 = await failSvc((svc) => svc.exportSkill({ id: pid, dir: "out", actorSessionID: "ses_pm" }))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
  await svcEff((svc) => svc.setCapabilityStatus({ id: pid, status: "canary", actorSessionID: "ses_pm" }))
  await svcEff((svc) => svc.setCapabilityStatus({ id: pid, status: "active", actorSessionID: "ses_pm" }))
  const r2 = await failSvc((svc) => svc.exportSkill({ id: pid, dir: "out", actorSessionID: "ses_pw" }))
  expect(r2).toMatchObject({ _tag: "CvisInvalidTransition" })
  const out = await svcEff((svc) => svc.exportSkill({ id: pid, dir: "out", actorSessionID: "ses_pm" }))
  expect((out as { path: string }).path.endsWith("out/SKILL.md")).toBe(true)
  const r3 = await failSvc((svc) => svc.exportSkill({ id: pid, dir: "out", actorSessionID: "ses_pm" }))
  expect(r3).toMatchObject({ _tag: "CvisConflict" })
})

test("managed metadata merges for linked managers only", async () => {
  const r0 = await failSvc((svc) => svc.setManagedMetadata({ slug: "plug", metadata: { skills: ["a"] }, actorSessionID: "ses_pm" }))
  expect(r0).toMatchObject({ _tag: "CvisInvalidTransition" })
  await svcEff((svc) => svc.linkManagedProject({ id: "mp_pg", nativeProjectID: "pg-p" }))
  const out = await svcEff((svc) => svc.setManagedMetadata({ slug: "plug", metadata: { skills: ["a"] }, actorSessionID: "ses_pm" }))
  expect((out as { metadata: Record<string, unknown> }).metadata).toMatchObject({ skills: ["a"] })
  const out2 = await svcEff((svc) => svc.setManagedMetadata({ slug: "plug", metadata: { owner: "x" }, actorSessionID: "ses_pm" }))
  expect((out2 as { metadata: Record<string, unknown> }).metadata).toMatchObject({ skills: ["a"], owner: "x" })
  const r1 = await failSvc((svc) => svc.setManagedMetadata({ slug: "plug", metadata: { z: 1 }, actorSessionID: "ses_pw" }))
  expect(r1).toMatchObject({ _tag: "CvisInvalidTransition" })
})

test("tasks accept explicit acceptance at creation", async () => {
  const out = await svcEff((svc) =>
    svc.createTask({ projectID: "pg-p", title: "t", role: "implementer", acceptance: [{ id: "a1", label: "done", weight: 1 }] }),
  )
  await runtime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rows = (yield* db.run(sql`SELECT acceptance FROM cvis_task WHERE id = ${(out as { id: string }).id}`)) as unknown as { acceptance: unknown }[]
      const acceptance = typeof rows[0].acceptance === "string" ? JSON.parse(rows[0].acceptance) : rows[0].acceptance
      expect(acceptance).toMatchObject([{ id: "a1" }])
    }),
  )
})
