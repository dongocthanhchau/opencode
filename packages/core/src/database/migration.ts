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
