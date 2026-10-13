import { Orchestration } from "../src/orchestration/service"
import { makeRuntime } from "../src/effect/run-service"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const runtime = makeRuntime(Orchestration.Service, LayerNode.compile(Orchestration.node))
const input = JSON.parse(process.argv[2]) as { taskID: string; scope: { read_paths: string[]; write_paths: string[]; tools: string[]; max_tokens: number }; description: string }
await runtime.runPromise((service) => service.reviseTask(input)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
process.exit(process.exitCode ?? 0)
