export * as SessionGenerate from "./generate.js"

import type { FileSystem } from "../filesystem.js"
import { LLMClient, Message, type AIError } from "@opencode/ai/effect"
import { ConfigModel } from "@opencode/schema/config/model"
import type { Model } from "@opencode/schema/model"
import { Effect, Option } from "effect"
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

export type Result = SessionUsage.Recorded & { readonly text: string; readonly experimental?: { readonly model: Model.Ref } }

/**
 * Generates text from current Session context without mutating history.
 * Usage is reported like a step's and added to the Session's totals.
 */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
  experimental?: { model?: Model.Ref; btw?: string }
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const llm = yield* LLMClient.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    const btw = input.experimental?.btw
    const config = btw === undefined ? undefined : Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const settings = config ? Config.latest(yield* config.entries(), "btw") : undefined
    const ref = input.experimental?.model ?? (settings?.model ? ConfigModel.ref(settings.model) : undefined)
    const model = yield* context.resolveModel(ref ? { ...selection.session, model: ref } : selection.session, {
      kind: "generate",
      agent: selection.agent.id,
    })
    const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions, model.ref)
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: history.messages,
    })
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: transcript.system,
      messages: [
        ...transcript.messages,
        ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
        Message.user(
          btw === undefined || settings?.prompt === undefined
            ? input.prompt
            : settings.prompt.includes("${question}")
              ? settings.prompt.replaceAll("${question}", () => btw)
              : [settings.prompt, btw].join("\n\n"),
        ),
      ],
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: model.ref.providerID,
      modelID: model.ref.id,
    })
    const response = yield* llm.generate(prepared.request, prepared.options).pipe(ModelRetry.retry)
    const usage = SessionUsage.record(response.usage, model.cost)
    yield* bus.publish(SessionEvent.UsageRecorded, { sessionID: selection.session.id, source: "generate", ...usage })
    return { text: response.text, ...usage, experimental: { model: model.ref } }
  }).pipe(instances.provide(input.session))
})
