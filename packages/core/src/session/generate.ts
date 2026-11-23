export * as SessionGenerate from "./generate.js"

import type { FileSystem } from "../filesystem.js"
import { AIError, LLMClient, Message, SystemPart, ToolChoice } from "@opencode/ai/effect"
import { Effect, Option, type JsonSchema } from "effect"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionModelRequest } from "./model-request.js"
import { ModelRetry } from "../model-retry.js"
import { Model } from "../model.js"
import { ConfigModel } from "@opencode/schema/config/model"
import { Tool } from "@opencode/schema/tool"
import type { Snapshot } from "../tool.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"
import { Config } from "../config.js"

export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

export type Result = SessionUsage.Recorded & {
  readonly text: string
  /** With `output`, the arguments the model passed to the forced output tool, not yet checked against the schema. */
  readonly output?: unknown
  /** The model the request actually resolved to. */
  readonly experimental?: { readonly model: Model.Ref }
}

/** The forced tool a request with `output` answers through. */
export const OUTPUT_TOOL = "respond"

/** Experimental request knobs: another model or variant, or a side question routed through the `btw` config. */
export type Options = { model?: Model.Ref; variant?: string; btw?: string }

export interface Input {
  readonly session: SessionSchema.Info
  readonly prompt: string
  /** Without history, the request carries only `system` and `prompt`, not the Session's instructions or messages. */
  readonly history?: boolean
  readonly system?: string
  /** Serve this request with another model than the Session's. */
  readonly model?: Model.Ref
  /** A JSON Schema with an object root. The model must answer by calling {@link OUTPUT_TOOL} with matching arguments. */
  readonly output?: JsonSchema.JsonSchema
  /** Experimental: may change without compatibility guarantees. */
  readonly experimental?: Options
}

/**
 * Generates text from current Session context without mutating history.
 * Usage is reported like a step's and added to the Session's totals.
 */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: Input) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const llm = yield* LLMClient.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const btw = input.experimental?.btw
    const config = btw === undefined ? undefined : Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const settings = config ? Config.latest(yield* config.entries(), "btw") : undefined
    const ref =
      input.model ??
      input.experimental?.model ??
      (settings?.model ? ConfigModel.ref(settings.model, settings.variant) : undefined)
    const variant = input.experimental?.variant ?? (ref === undefined ? settings?.variant : undefined)
    const prompt =
      btw === undefined || settings?.prompt === undefined
        ? input.prompt
        : settings.prompt.includes("${question}")
          ? settings.prompt.replaceAll("${question}", () => btw)
          : [settings.prompt, btw].join("\n\n")
    // Without history, skip context.select() (MCP flush, tool snapshot, and instruction loading) so parallel llm() calls
    // don't pay full session-preflight overhead only to discard the result.
    const prepared = yield* input.history === false
      ? Effect.gen(function* () {
          const agent = input.session.agent ?? Agent.defaultID
          const model = yield* context.resolveModel(
            ref === undefined ? input.session : { ...input.session, model: ref },
            {
              kind: "generate",
              agent,
              ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
            },
          )
          const req = yield* context.request.generate({
            session: input.session,
            agent,
            model,
            tools: input.output === undefined ? undefined : outputTools(input.output),
            system: input.system === undefined ? [] : [SystemPart.make(input.system)],
            messages: [Message.user(prompt)],
            ...(input.output === undefined ? {} : { toolChoice: OUTPUT_TOOL }),
          })
          return { session: input.session, model, prepared: req }
        })
      : Effect.gen(function* () {
          const selection = yield* context.select(input.session.id)
          const model = yield* context.resolveModel(
            ref === undefined ? selection.session : { ...selection.session, model: ref },
            {
              kind: "generate",
              agent: selection.agent.id,
              ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
            },
          )
          const history = yield* SessionHistory.preview(
            database.db,
            selection.session.id,
            selection.instructions,
            model.ref,
          )
          const transcript = SessionModelRequest.baseTranscript({
            agent: selection.agent.info,
            model,
            tools: selection.tools,
            initial: history.initial,
            messages: history.messages,
          })
          const req = yield* context.request.generate({
            session: selection.session,
            agent: selection.agent.id,
            model,
            tools: input.output === undefined ? selection.tools : outputTools(input.output),
            system: [...transcript.system, ...(input.system === undefined ? [] : [SystemPart.make(input.system)])],
            messages: [
              ...transcript.messages,
              ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
              Message.user(prompt),
            ],
            ...(input.output === undefined ? {} : { toolChoice: OUTPUT_TOOL }),
          })
          return { session: selection.session, model, prepared: req }
        })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: prepared.session.id,
      providerID: prepared.model.ref.providerID,
      modelID: prepared.model.ref.id,
    })
    const send = llm.generate(prepared.prepared.request, prepared.prepared.options).pipe(ModelRetry.retry)
    // Providers or gateways that only accept tool_choice: "auto" reject named toolChoice (#45953). Fall back once to
    // "auto" with only the output tool offered, nudging the model to call it.
    const response = yield* input.output === undefined
      ? send
      : send.pipe(
          Effect.catchIf(isToolChoiceRejected, () =>
            llm
              .generate(
                {
                  ...prepared.prepared.request,
                  toolChoice: new ToolChoice({ type: "auto" }),
                  system: [
                    ...prepared.prepared.request.system,
                    SystemPart.make(`Return your answer by calling the \`${OUTPUT_TOOL}\` tool.`),
                  ],
                },
                prepared.prepared.options,
              )
              .pipe(ModelRetry.retry),
          ),
        )
    const usage = SessionUsage.record(response.usage, prepared.model.cost)
    yield* bus.publish(SessionEvent.UsageRecorded, { sessionID: prepared.session.id, source: "generate", ...usage })
    const call = input.output === undefined ? undefined : response.toolCalls.find((item) => item.name === OUTPUT_TOOL)
    return {
      text: response.text,
      experimental: { model: prepared.model.ref },
      ...(call === undefined ? {} : { output: call.input }),
      ...usage,
    }
  }).pipe(instances.provide(input.session))
})

const isToolChoiceRejected = (error: unknown): error is AIError => {
  if (!(error instanceof AIError)) return false
  if (error.reason._tag === "UnsupportedOperation") return true
  if (error.reason._tag !== "InvalidRequest") return false
  if (error.reason.parameter === "tool_choice" || error.reason.parameter === "toolChoice") return true
  return /tool[_ ]?choice/i.test(`${error.reason.message}\n${error.reason.body ?? ""}`)
}

// Only the output tool, so the model has nothing else to call; the forced choice makes it answer through it.
const outputTools = (schema: JsonSchema.JsonSchema): Snapshot => ({
  definitions: [
    { type: "tool", name: OUTPUT_TOOL, description: "Return your answer by calling this tool.", inputSchema: schema },
  ],
  execute: () => new Tool.Error({ message: `${OUTPUT_TOOL} only carries the answer; it does not run.` }),
})
