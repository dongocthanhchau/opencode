export const PLUGIN_KINDS = ["tool", "skill", "mcp", "template", "hook"] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]

export interface PluginManifest {
  name: string
  version: number
  kind: PluginKind
  description: string
  entry?: string
  body?: string
  source?: string
  permissions?: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// Strict manifest validation.Hook is a reserved kind: it validates so
// manifests stay forward-compatible, but installation refuses it until
// a hook runtime exists instead of pretending to install.
export function parsePluginManifest(raw: unknown):
  | { ok: true; manifest: PluginManifest }
  | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "manifest must be an object" }
  if (typeof raw.name !== "string" || raw.name.trim().length === 0 || raw.name.trim().length > 80)
    return { ok: false, reason: "manifest needs a name (1..80 chars)" }
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1)
    return { ok: false, reason: "manifest needs a positive integer version" }
  if (typeof raw.kind !== "string" || !(PLUGIN_KINDS as readonly string[]).includes(raw.kind))
    return { ok: false, reason: `kind must be one of ${PLUGIN_KINDS.join(",")}` }
  if (typeof raw.description !== "string" || raw.description.trim().length < 10 || raw.description.trim().length > 2000)
    return { ok: false, reason: "manifest needs a description (10..2000 chars)" }
  const manifest: PluginManifest = {
    name: raw.name.trim(),
    version: raw.version,
    kind: raw.kind as PluginKind,
    description: raw.description.trim(),
  }
  if (raw.entry !== undefined) {
    if (typeof raw.entry !== "string" || raw.entry.length === 0 || raw.entry.length > 500)
      return { ok: false, reason: "entry must be a short string" }
    manifest.entry = raw.entry
  }
  if (raw.body !== undefined) {
    if (typeof raw.body !== "string" || raw.body.length === 0 || raw.body.length > 20000)
      return { ok: false, reason: "body must be non-empty and at most 20000 chars" }
    manifest.body = raw.body
  }
  if (raw.source !== undefined) {
    if (typeof raw.source !== "string" || raw.source.length > 500)
      return { ok: false, reason: "source must be a short string" }
    manifest.source = raw.source
  }
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions) || raw.permissions.some((p) => typeof p !== "string"))
      return { ok: false, reason: "permissions must be string[]" }
    manifest.permissions = raw.permissions as string[]
  }
  if (manifest.kind === "template" && !manifest.body)
    return { ok: false, reason: "template plugins need a body" }
  return { ok: true, manifest }
}

// Minimal agentskills.io frontmatter: name + description fences.
export function parseSkillFile(text: string): { ok: true; name: string; description: string; body: string } | { ok: false; reason: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { ok: false, reason: "SKILL.md needs --- frontmatter ---" }
  const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? ""
  const description = match[1].match(/^description:\s*([\s\S]*?)(?=^\w+:|\s*$)/m)?.[1]?.trim().replace(/\s+/g, " ") ?? ""
  if (!name) return { ok: false, reason: "frontmatter needs a name" }
  if (description.length < 10) return { ok: false, reason: "frontmatter needs a description (10+ chars)" }
  return { ok: true, name, description, body: match[2] }
}

export function renderSkillFile(input: { name: string; description: string; body: string }): string {
  return `---\nname: ${input.name}\ndescription: ${input.description}\n---\n\n${input.body.replace(/^\n+/, "")}`
}

export * as PluginManifest from "./plugin-manifest"
