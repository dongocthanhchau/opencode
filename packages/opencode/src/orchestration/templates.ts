export interface TemplateInput {
  name: string
  required: boolean
}

export type RenderResult = { ok: true; text: string } | { ok: false; missing: string[] }

// Render {{var}} placeholders. Missing required inputs fail closed;
// undeclared placeholders are left untouched so template typos stay visible
// instead of silently producing wrong prompts.
export function renderTemplate(body: string, inputs: TemplateInput[], vars: Record<string, string>): RenderResult {
  const required = inputs.filter((input) => input.required).map((input) => input.name)
  const missing = required.filter((name) => (vars[name] ?? "").trim().length === 0)
  if (missing.length > 0) return { ok: false, missing }
  const text = body.replace(/\{\{([^{}]+)\}\}/g, (placeholder, name: string) => vars[name] ?? placeholder)
  return { ok: true, text }
}

export * as OrchestrationTemplates from "./templates"
