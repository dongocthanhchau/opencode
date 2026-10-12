import { sqliteTable, text } from "drizzle-orm/sqlite-core"

// Read-only mirror of memory_fact maintained by SQLite triggers (see migration
// memory_provenance_fts). Used for keyword prefiltering. Never auto-migrate:
// drizzle would emit CREATE TABLE for it, but it must stay a VIRTUAL TABLE.
// Kept in this file (outside sql.ts) so drizzle-kit schema globs ignore it.
export const MemoryFactFtsTable = sqliteTable("memory_fact_fts", {
  id: text(),
  fact: text(),
  topic: text(),
})
