import type { Provider } from "./provider"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

export function routingEnabled() {
  if (process.env.CVIS_MODEL_ROUTING !== undefined) return process.env.CVIS_MODEL_ROUTING === "opencode-first"
  const file = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode", "cvis-routing.json")
  if (!existsSync(file)) return false
  const policy = JSON.parse(readFileSync(file, "utf8")) as { mode?: string }
  if (!["opencode-first", "disabled"].includes(policy.mode ?? "")) throw new Error("Invalid CVIS routing policy mode")
  return policy.mode === "opencode-first"
}

export type RouteModel = Pick<Provider.Model, "id" | "providerID" | "cost" | "capabilities" | "limit" | "status">
export type RouteFailure = { name?: string; data?: { statusCode?: number; message?: string; responseBody?: string; responseHeaders?: Record<string, string> } }
export const MAX_ROUTE_ATTEMPTS = 4
const failures = new Map<string, number>()

export function modelKey(model: Pick<RouteModel, "providerID" | "id">) {
  return `${model.providerID}/${model.id}`
}

export function retryableRoute(error: RouteFailure | undefined) {
  if (!error || ["MessageAbortedError", "ContextOverflowError", "StructuredOutputError"].includes(error.name ?? "")) return false
  const status = error.data?.statusCode
  const message = `${error.data?.message ?? ""} ${error.data?.responseBody ?? ""}`
  if (/permission|scope|budget exhausted|cancelled|aborted|context.{0,20}(length|limit|window)/i.test(message)) return false
  return status === 401 || status === 403 || status === 404 || status === 408 || status === 410 || status === 429 || (status !== undefined && status >= 500) ||
    /FreeUsageLimitError|quota|rate.?limit|timed? ?out|timeout|fetch failed|connection|overloaded|empty provider response|model.{0,80}(deprecated|not found|not available|removed)/i.test(message)
}

export function cooldownDuration(error: RouteFailure, now = Date.now()) {
  const value = error.data?.responseHeaders?.["retry-after"]
  const supplied = value ? (Number.isFinite(Number(value)) ? Number(value) * 1000 : Date.parse(value) - now) : 0
  const base = [404, 410].includes(error.data?.statusCode ?? 0) ? 60 * 60_000 : /quota|FreeUsageLimitError/i.test(error.data?.message ?? "") ? 30 * 60_000 : 5 * 60_000
  return Math.min(24 * 60 * 60_000, Math.max(base, Number.isFinite(supplied) ? supplied : 0))
}

export function markRouteFailure(model: RouteModel, error: RouteFailure) {
  const now = Date.now()
  for (const [key, until] of failures) if (until <= now) failures.delete(key)
  if (failures.size >= 128) failures.delete(failures.keys().next().value!)
  failures.set(modelKey(model), now + cooldownDuration(error, now))
  if (model.providerID === "opencode" && (error.data?.statusCode === 401 || error.data?.statusCode === 403 || /FreeUsageLimitError/i.test(`${error.data?.message ?? ""} ${error.data?.responseBody ?? ""}`))) failures.set("opencode/*", now + cooldownDuration(error, now))
}

export function routeCandidates<T extends RouteModel>(models: T[], input: { attempted: ReadonlySet<string>; estimatedInput: number; needsTools: boolean; needsImage?: boolean; needsPDF?: boolean; now?: number; cooldowns?: ReadonlyMap<string, number> }) {
  const now = input.now ?? Date.now()
  const cooldowns = input.cooldowns ?? failures
  const tier = (model: T) => model.providerID === "opencode" ? 0 : model.providerID === "cvis-litellm" ? 1 : model.providerID === "cline" ? 2 : 3
  return models.filter((model) => {
    if (input.attempted.size >= MAX_ROUTE_ATTEMPTS) return false
    const attempts = [...input.attempted].filter((key) => key.startsWith(model.providerID + "/")).length
    if (attempts >= (model.providerID === "opencode" ? 2 : 1) || (cooldowns.get(model.providerID + "/*") ?? 0) > now) return false
    if (tier(model) === 3 || input.attempted.has(modelKey(model)) || (cooldowns.get(modelKey(model)) ?? 0) > now) return false
    if (model.status === "deprecated" || model.status === "alpha" || (input.needsTools && !model.capabilities.toolcall)) return false
    if (input.needsImage && !model.capabilities.input.image) return false
    if (input.needsPDF && !model.capabilities.input.pdf) return false
    if (model.limit.context > 0 && model.limit.context < input.estimatedInput + 4096) return false
    if (input.needsTools && /(?:no-tool|cvis-chat)/.test(model.id)) return false
    if (model.providerID === "opencode") return model.cost.input === 0 && model.cost.output === 0 && model.cost.cache.read === 0 && model.cost.cache.write === 0
    return true
  }).sort((a, b) => tier(a) - tier(b) || (a.providerID === "cvis-litellm" ? Number(a.id !== "cvis-coding") - Number(b.id !== "cvis-coding") : 0) || (a.providerID === "cline" ? Number(!a.id.startsWith("cline-free/")) - Number(!b.id.startsWith("cline-free/")) : 0) || b.limit.context - a.limit.context || a.id.localeCompare(b.id))
}

export function safeToReroute(parts: { type: string; text?: string; state?: { status: string } }[]) {
  return !parts.some((part) => (part.type === "text" && !!part.text?.trim()) || part.type === "tool" || (part.type === "reasoning" && !!part.text?.trim()))
}
