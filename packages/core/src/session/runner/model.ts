export * as SessionRunnerModel from "./model.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LanguageModel } from "@opencode/ai/effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Context, Effect, Layer, Schema } from "effect"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ModelResolver } from "../../model-resolver.js"
import { PluginHooks } from "../../plugin/hooks.js"
import { SessionSchema } from "../schema.js"

export class ModelNotSelectedError extends Schema.TaggedError<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  { sessionID: SessionSchema.ID },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedError<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  { providerID: Provider.ID, modelID: Model.ID },
) {
  override get message() {
    if (this.providerID === "azure-cognitive-services")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use azure/${this.modelID} instead.`
    if (this.providerID === "google-vertex-anthropic")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use google-vertex/${this.modelID} instead.`
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}
export type Error = ModelNotSelectedError | ModelUnavailableError | ModelResolver.Error
export type Resolved = ModelResolver.Resolved

type Selection = Pick<SessionSchema.Info, "id" | "model" | "agent">

export interface Interface {
  readonly select: (
    session: Selection,
    available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
  ) => Effect.Effect<
    { readonly info: Model.Info; readonly variant: Model.VariantID | undefined },
    ModelNotSelectedError | ModelUnavailableError
  >
  /** Availability is sampled lazily for each explicitly selected model resolution. */
  readonly resolve: (
    session: SessionSchema.Info,
    available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
    request: { readonly kind: SessionRequestKind; readonly agent: Agent.ID; readonly variant?: Model.VariantID },
  ) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunnerModel") {}

export const inheritedAgentVariant = Effect.fnUntraced(function* (
  agent: Agent.Info | undefined,
  config: Config.Interface,
) {
  if (agent?.variant !== undefined) return agent.variant
  if (agent?.model && agent.model.variant === undefined)
    return ModelResolver.configuredVariant(yield* config.entries(), agent.model)
})

/** Builds a Resolved whose catalog identity mirrors the route model. Test or embedding seam. */
export const resolved = (
  model: LanguageModel,
  options: {
    readonly capabilities: Model.Capabilities
    readonly variant?: Model.VariantID
    readonly cost: Model.Info["cost"]
    readonly limit: Model.Info["limit"]
    readonly compaction?: Provider.Compaction
    readonly transport?: Provider.Transport
  },
): Resolved => ({
  model,
  ref: Model.Ref.make({
    id: Model.ID.make(model.id),
    providerID: Provider.ID.make(model.provider),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  }),
  capabilities: options.capabilities,
  cost: options.cost,
  limit: options.limit,
  compaction: options.compaction,
  transport: options.transport,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const hooks = yield* PluginHooks.Service
    // Location plugins populate and filter the catalog asynchronously during layer startup.
    const select = Effect.fn("SessionRunnerModel.select")(function* (
      session: Selection,
      available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
    ) {
      const find = (ref: Model.Ref) =>
        available().pipe(
          Effect.map((models) => models.find((model) => model.providerID === ref.providerID && model.id === ref.id)),
        )
      if (session.model) {
        const info = yield* find(session.model)
        if (info) return { info, variant: session.model.variant }
        return yield* new ModelUnavailableError({ providerID: session.model.providerID, modelID: session.model.id })
      }
      const agent = (yield* agents.select(session.agent)).info
      const preferred = agent?.model && (yield* find(agent.model))
      if (preferred)
        return {
          info: preferred,
          variant: (yield* inheritedAgentVariant(agent, config)) ?? agent?.model?.variant,
        }
      const info = yield* resolver.fallback()
      if (info) return { info, variant: agent?.variant ?? info.defaultVariant }
      return yield* new ModelNotSelectedError({ sessionID: session.id })
    })
    return Service.of({
      select,
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session, available, request) {
        const selected = yield* select(session, available)
        const variant = request.variant ?? selected.variant
        const ref = Model.Ref.make({
          providerID: selected.info.providerID,
          id: selected.info.id,
          ...(variant === undefined ? {} : { variant }),
        })
        const model = (yield* hooks.trigger("session", "experimental.model.resolve", {
          sessionID: session.id,
          agent: request.agent,
          kind: request.kind,
          model: ref,
        })).model
        if (model.providerID === ref.providerID && model.id === ref.id && model.variant === ref.variant)
          return yield* resolver.resolveModel(selected.info, variant)
        // Same provider only: the model may be hidden from the picker, and its credentials and hooks stay the selection's.
        const resolved = model.providerID === ref.providerID ? yield* resolver.resolve(model) : undefined
        if (resolved) return resolved
        return yield* new ModelUnavailableError({ providerID: model.providerID, modelID: model.id })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ModelResolver.node, Agent.node, PluginHooks.node, Config.node],
})
