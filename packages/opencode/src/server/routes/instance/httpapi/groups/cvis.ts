import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

export const CvisApi = HttpApi.make("cvis").add(
  HttpApiGroup.make("cvis").add(
    HttpApiEndpoint.get("snapshot", "/cvis/projects/:projectID", {
      params: { projectID: Schema.String },
      success: Schema.Unknown,
      error: InvalidRequestError,
    }),
    HttpApiEndpoint.get("events", "/cvis/projects/:projectID/events", {
      params: { projectID: Schema.String },
      query: { cursor: Schema.optional(Schema.Number), limit: Schema.optional(Schema.Number) },
      success: Schema.Unknown,
      error: InvalidRequestError,
    }),
    HttpApiEndpoint.get("detail", "/cvis/tasks/:taskID", {
      params: { taskID: Schema.String },
      success: Schema.Unknown,
      error: InvalidRequestError,
    }),
    HttpApiEndpoint.post("command", "/cvis/command", {
      payload: Schema.Struct({
        actor: Schema.String,
        operation: Schema.String,
        arguments: Schema.Record(Schema.String, Schema.Unknown),
      }),
      success: Schema.Unknown,
      error: InvalidRequestError,
    }),
    HttpApiEndpoint.post("execute", "/cvis/tasks/:taskID/execute", {
      params: { taskID: Schema.String },
      payload: Schema.Struct({ sessionID: Schema.String }),
      success: Schema.Unknown,
      error: InvalidRequestError,
    }),
    HttpApiEndpoint.post("bind", "/cvis/bind", {
      payload: Schema.Struct({ sessionID: Schema.String, projectID: Schema.String, role: Schema.String }),
      success: Schema.Boolean,
      error: InvalidRequestError,
    }),
    HttpApiEndpoint.post("recover", "/cvis/projects/:projectID/recover", {
      params: { projectID: Schema.String },
      success: Schema.Unknown,
      error: InvalidRequestError,
    }),
    HttpApiEndpoint.post("pump", "/cvis/pump", {
      payload: Schema.Struct({ managerSessionID: Schema.String }),
      success: Schema.Unknown,
      error: InvalidRequestError,
    }),
    HttpApiEndpoint.get("stream", "/cvis/projects/:projectID/stream", {
      params: { projectID: Schema.String },
      success: Schema.String,
      error: InvalidRequestError,
    }),
  ),
)
