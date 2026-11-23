export * as ConfigModel from "./model.js"

import { Effect, Schema, SchemaGetter } from "effect"
import type { Entry } from "../config.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import { optional } from "../schema.js"

const ProviderID = Provider.ID.check(Schema.isPattern(/^[^/#]+$/u))
const ModelID = Model.ID.check(Schema.isPattern(/^[^#]+$/u))
export const VariantID = Model.VariantID.check(Schema.isPattern(/^[^#]+$/u))
export const LegacyVariant = VariantID.pipe(
  Schema.catchDecoding(() => Effect.succeedNone),
  optional,
)

const Explicit = Schema.Struct({
  providerID: ProviderID,
  model: ModelID,
  variant: VariantID.pipe(optional),
})

const Short = Schema.String.check(Schema.isPattern(/^[^/#]+\/[^#]+(?:#[^#]+)?$/u))

export interface Selection extends Schema.Schema.Type<typeof Explicit> {}
export const Selection = Schema.Union([Short, Explicit])
  .pipe(
    Schema.decodeTo(Explicit, {
      decode: SchemaGetter.transform((input) => (typeof input === "string" ? parse(input) : input)),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  )
  .annotate({ identifier: "Config.ModelSelection" })

function parse(input: string): Selection {
  const ref = Model.Ref.parse(input)
  return {
    providerID: ref.providerID,
    model: ref.id,
    ...(ref.variant ? { variant: ref.variant } : {}),
  }
}

export function ref({ model, providerID, variant }: Selection, fallback?: Model.VariantID) {
  const selected = variant ?? fallback
  return Model.Ref.make({ providerID, id: model, ...(selected === undefined ? {} : { variant: selected }) })
}

export function configured(entries?: readonly (Entry | typeof Entry.Encoded)[]) {
  let variant: string | undefined
  for (let index = (entries?.length ?? 0) - 1; index >= 0; index--) {
    const entry = entries?.[index]
    if (entry?.type !== "document") continue
    const selection = entry.info.model
    if (selection === undefined) {
      variant ??= entry.info.variant
      continue
    }
    const model = typeof selection === "string" ? parse(selection) : selection
    return {
      model: { providerID: model.providerID, modelID: model.model, variant: model.variant ?? entry.info.variant },
      variant,
    }
  }
  return { variant }
}
