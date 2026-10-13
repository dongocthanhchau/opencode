export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          // schema.gen excludes the FTS virtual tables and triggers (raw SQL
          // outside the drizzle schema), so fresh DBs would otherwise skip
          // them entirely. Create them here to match migrated DBs.
          yield* tx.run(
            sql`CREATE VIRTUAL TABLE IF NOT EXISTS "memory_fact_fts" USING fts5("id" UNINDEXED, "fact", "topic", "project_id" UNINDEXED)`,
          )
          yield* tx.run(
            sql`CREATE VIRTUAL TABLE IF NOT EXISTS "memory_item_fts" USING fts5("id" UNINDEXED, "fact", "topic", "project_id" UNINDEXED)`,
          )
          yield* tx.run(
            sql`CREATE TRIGGER IF NOT EXISTS "memory_fact_fts_insert" AFTER INSERT ON "memory_fact" BEGIN INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic", "project_id") VALUES (new.rowid, new."id", new."fact", new."topic", new."project_id"); END`,
          )
          yield* tx.run(
            sql`CREATE TRIGGER IF NOT EXISTS "memory_fact_fts_delete" AFTER DELETE ON "memory_fact" BEGIN DELETE FROM "memory_fact_fts" WHERE rowid = old.rowid; END`,
          )
          yield* tx.run(
            sql`CREATE TRIGGER IF NOT EXISTS "memory_fact_fts_update" AFTER UPDATE ON "memory_fact" BEGIN DELETE FROM "memory_fact_fts" WHERE rowid = old.rowid; INSERT INTO "memory_fact_fts"(rowid, "id", "fact", "topic", "project_id") VALUES (new.rowid, new."id", new."fact", new."topic", new."project_id"); END`,
          )
          yield* tx.run(
            sql`CREATE TRIGGER IF NOT EXISTS "memory_item_fts_insert" AFTER INSERT ON "memory_item" BEGIN INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic", "project_id") VALUES (new.rowid, new."id", new."claim", new."topic", new."project_id"); END`,
          )
          yield* tx.run(
            sql`CREATE TRIGGER IF NOT EXISTS "memory_item_fts_delete" AFTER DELETE ON "memory_item" BEGIN DELETE FROM "memory_item_fts" WHERE rowid = old.rowid; END`,
          )
          yield* tx.run(
            sql`CREATE TRIGGER IF NOT EXISTS "memory_item_fts_update" AFTER UPDATE ON "memory_item" BEGIN DELETE FROM "memory_item_fts" WHERE rowid = old.rowid; INSERT INTO "memory_item_fts"(rowid, "id", "fact", "topic", "project_id") VALUES (new.rowid, new."id", new."claim", new."topic", new."project_id"); END`,
          )
          // Seed prompt templates: fresh DBs skip migration bodies, so
          // data migrations must also run here (same pattern as FTS).
          yield* tx.run(sql`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_clarify_v1', 'clarify', 'manager', 1, 'Restate the following request in your own words, then list every ambiguity as a numbered question. Do not add commitments, drop conditions, or widen scope. Request: {{request}}', '[{"name": "request", "required": true}]', 0, 0);`,          )
          yield* tx.run(sql`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_plan_v1', 'plan', 'manager', 1, 'Break this objective into tasks with acceptance checklists, dependencies, and roles. Objective: {{objective}}. Constraints: {{constraints}}', '[{"name": "objective", "required": true}, {"name": "constraints", "required": false}]', 0, 0);`,          )
          yield* tx.run(sql`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_research_v1', 'research', 'researcher', 1, 'Investigate and report facts with sources plus a recommendation. Do NOT change code. Topic: {{topic}}. Scope: {{scope}}', '[{"name": "topic", "required": true}, {"name": "scope", "required": false}]', 0, 0);`,          )
          yield* tx.run(sql`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_implement_v1', 'implement', 'implementer', 1, 'Implement the task inside its write scope only. Task goal: {{goal}}. Acceptance: {{acceptance}}. Touched files outside the scope are a failure.', '[{"name": "goal", "required": true}, {"name": "acceptance", "required": false}]', 0, 0);`,          )
          yield* tx.run(sql`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_verify_v1', 'verify', 'verifier', 1, 'Check the work against these requirements: {{requirements}}. Run the permitted checks. Do NOT change source code. Reply PASS or FAIL with evidence.', '[{"name": "requirements", "required": true}]', 0, 0);`,          )
          yield* tx.run(sql`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_repair_v1', 'repair', 'implementer', 1, 'Fix exactly what the verifier reported, nothing more. Findings: {{findings}}. Re-run the failing checks afterwards.', '[{"name": "findings", "required": true}]', 0, 0);`,          )
          yield* tx.run(sql`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_handoff_v1', 'handoff', NULL, 1, 'Write a handoff checkpoint: current goal revision, completed and pending checklist items, blockers, changed files, and test evidence. Context: {{context}}', '[{"name": "context", "required": true}]', 0, 0);`,          )
          yield* tx.run(sql`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_compact_v1', 'compact', NULL, 1, 'Summarize this session so work can continue. Preserve role, permissions, goal revision, active task, decisions, checkpoints, and evidence references. Do not alter goals or permissions. Transcript tail: {{transcript}}', '[{"name": "transcript", "required": true}]', 0, 0);`,          )
          yield* tx.run(sql`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_report_v1', 'report', 'manager', 1, 'Summarize results for the user: completed tasks with evidence, failures with reasons, token spend, and next steps. Results: {{results}}', '[{"name": "results", "required": true}]', 0, 0);`,          )
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            ),
          )
        }),
      )
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        const named = (yield* db.all<{ name: string }>(
          sql`SELECT name FROM pragma_table_info('__drizzle_migrations')`,
        )).some((column) => column.name === "name")

        if (named) {
          yield* db.run(sql`
            INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
            SELECT name, ${Date.now()}
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE name IS NOT NULL
          `)
        }

        if (!named) {
          const entries = yield* db.all<{ created_at: number; prefix: string | null }>(sql`
            SELECT created_at, strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE created_at IS NOT NULL
          `)

          for (const entry of entries) {
            const migration = input.find((item) => item.id.startsWith(`${entry.prefix}_`))
            if (!migration) {
              return yield* Effect.die(
                new Error(`Legacy migration timestamp ${entry.created_at} does not match any known migration`),
              )
            }
            yield* db.run(sql`
              INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
              VALUES (${migration.id}, ${Date.now()})
            `)
          }
        }
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
