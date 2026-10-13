import { Cause, Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import { CvisHttpApi } from "../api"
import { Orchestration } from "@/orchestration/service"
import { OrchestrationControl } from "@/orchestration/control"
import { OrchestrationHarness } from "@/orchestration/harness"
import type { Role } from "@/orchestration/roles"
import { InvalidRequestError } from "../errors"

const request = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause)
      const fields = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {}
      const message =
        typeof fields.reason === "string"
          ? fields.reason
          : fields.entity
            ? `${fields.entity} ${fields.id ?? ""}: ${fields.from ?? ""} -> ${fields.to ?? ""}`
            : error instanceof Error
              ? error.message
              : String(error)
      return Effect.fail(new InvalidRequestError({ message }))
    }),
  )

export const cvisHandlers = HttpApiBuilder.group(CvisHttpApi, "cvis", (handlers) =>
  Effect.gen(function* () {
    const orchestration = yield* Orchestration.Service
    const control = yield* OrchestrationControl.Service
    const harness = yield* OrchestrationHarness.Service
    return handlers
      .handle("snapshot", (ctx) => request(orchestration.projectSnapshot({ projectID: ctx.params.projectID })))
      .handle("events", (ctx) =>
        request(
          orchestration.listEvents({
            projectID: ctx.params.projectID,
            cursor: ctx.query.cursor,
            limit: ctx.query.limit,
          }),
        ),
      )
      .handle("detail", (ctx) => request(orchestration.taskDetail({ taskID: ctx.params.taskID })))
      .handle("command", (ctx) =>
        request(
          (ctx.payload.operation === "goal_budget" || ctx.payload.operation === "task_budget" ? control.invokeOperator : control.invoke)({
            actor: ctx.payload.actor,
            operation: ctx.payload.operation,
            args: ctx.payload.arguments,
          }),
        ),
      )
      .handle("execute", (ctx) =>
        request(harness.execute({ taskID: ctx.params.taskID, sessionID: ctx.payload.sessionID })),
      )
      .handle("bind", (ctx) =>
        request(
          orchestration.bindSession({
            sessionID: ctx.payload.sessionID,
            projectID: ctx.payload.projectID,
            role: ctx.payload.role as Role,
          }),
        ).pipe(Effect.as(true)),
      )
      .handle("recover", (ctx) => request(orchestration.recover({ projectID: ctx.params.projectID })))
      .handle("pump", (ctx) => request(harness.pump({ managerSessionID: ctx.payload.managerSessionID })))
      .handleRaw("stream", (ctx) =>
        Effect.sync(() => {
          const url = new URL(ctx.request.url, "http://localhost")
          const projectID = decodeURIComponent(url.pathname.split("/")[3])
          const resume = url.searchParams.get("cursor") ?? ctx.request.headers["last-event-id"] ?? "0"
          if (!/^\d{1,16}$/.test(resume) || !Number.isSafeInteger(Number(resume)))
            throw new Error("Invalid event cursor")
          let cursor = Number(resume)
          const stream = Stream.tick("1 second").pipe(
            Stream.mapEffect(() =>
              orchestration.listEvents({ projectID, cursor, limit: 500 }).pipe(
                Effect.tap((events) =>
                  Effect.sync(() => {
                    const last = events[events.length - 1]
                    if (last) cursor = (last as typeof last & { cursor: number }).cursor
                  }),
                ),
              ),
            ),
            Stream.flatMap((events) => Stream.fromIterable(events)),
            Stream.map(
              (event) =>
                `id: ${(event as typeof event & { cursor: number }).cursor}\nevent: cvis\ndata: ${JSON.stringify(event)}\n\n`,
            ),
            Stream.merge(Stream.tick("10 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))),
            Stream.encodeText,
          )
          return HttpServerResponse.stream(stream, {
            contentType: "text/event-stream",
            headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
          })
        }),
      )
  }),
)
