import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012144649_memory_project_hash_idx",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`memory_fact_hash_idx\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`memory_fact_project_hash_idx\` ON \`memory_fact\` (\`project_id\`,\`hash\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
