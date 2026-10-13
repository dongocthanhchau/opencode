import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261013010844_cvis_prompt_templates",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`cvis_prompt_template\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`role\` text,
          \`version\` integer DEFAULT 1 NOT NULL,
          \`body\` text NOT NULL,
          \`inputs\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`cvis_template_name_version_idx\` ON \`cvis_prompt_template\` (\`name\`,\`version\`);`,
      )
      yield* tx.run(`CREATE INDEX \`cvis_template_role_idx\` ON \`cvis_prompt_template\` (\`role\`);`)
      yield* tx.run(`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_clarify_v1', 'clarify', 'manager', 1, 'Restate the following request in your own words, then list every ambiguity as a numbered question. Do not add commitments, drop conditions, or widen scope. Request: {{request}}', '[{"name": "request", "required": true}]', 0, 0);`)
      yield* tx.run(`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_plan_v1', 'plan', 'manager', 1, 'Break this objective into tasks with acceptance checklists, dependencies, and roles. Objective: {{objective}}. Constraints: {{constraints}}', '[{"name": "objective", "required": true}, {"name": "constraints", "required": false}]', 0, 0);`)
      yield* tx.run(`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_research_v1', 'research', 'researcher', 1, 'Investigate and report facts with sources plus a recommendation. Do NOT change code. Topic: {{topic}}. Scope: {{scope}}', '[{"name": "topic", "required": true}, {"name": "scope", "required": false}]', 0, 0);`)
      yield* tx.run(`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_implement_v1', 'implement', 'implementer', 1, 'Implement the task inside its write scope only. Task goal: {{goal}}. Acceptance: {{acceptance}}. Touched files outside the scope are a failure.', '[{"name": "goal", "required": true}, {"name": "acceptance", "required": false}]', 0, 0);`)
      yield* tx.run(`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_verify_v1', 'verify', 'verifier', 1, 'Check the work against these requirements: {{requirements}}. Run the permitted checks. Do NOT change source code. Reply PASS or FAIL with evidence.', '[{"name": "requirements", "required": true}]', 0, 0);`)
      yield* tx.run(`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_repair_v1', 'repair', 'implementer', 1, 'Fix exactly what the verifier reported, nothing more. Findings: {{findings}}. Re-run the failing checks afterwards.', '[{"name": "findings", "required": true}]', 0, 0);`)
      yield* tx.run(`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_handoff_v1', 'handoff', NULL, 1, 'Write a handoff checkpoint: current goal revision, completed and pending checklist items, blockers, changed files, and test evidence. Context: {{context}}', '[{"name": "context", "required": true}]', 0, 0);`)
      yield* tx.run(`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_compact_v1', 'compact', NULL, 1, 'Summarize this session so work can continue. Preserve role, permissions, goal revision, active task, decisions, checkpoints, and evidence references. Do not alter goals or permissions. Transcript tail: {{transcript}}', '[{"name": "transcript", "required": true}]', 0, 0);`)
      yield* tx.run(`INSERT OR IGNORE INTO "cvis_prompt_template"("id", "name", "role", "version", "body", "inputs", "time_created", "time_updated") VALUES ('tmpl_report_v1', 'report', 'manager', 1, 'Summarize results for the user: completed tasks with evidence, failures with reasons, token spend, and next steps. Results: {{results}}', '[{"name": "results", "required": true}]', 0, 0);`)
    })
  },
} satisfies DatabaseMigration.Migration
