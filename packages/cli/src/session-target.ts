import type { LocationGetOutput, ModelRef, OpenCodeClient, SessionInfo } from "@opencode/client/promise"
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import path from "node:path"
import { waitForPlugins } from "./services/plugin-startup"
import { errorMessage } from "./util/error"

const SESSION_PAGE_LIMIT = 50

export type SessionTarget = {
  session: SessionInfo
  location: LocationGetOutput
  model: ModelRef | undefined
  agent: string | undefined
  resume: boolean
}

type SessionTargetPreparation = (input: {
  client: OpenCodeClient
  location: LocationGetOutput
  session: SessionInfo | undefined
  model: ModelRef | undefined
  agent: string | undefined
  signal?: AbortSignal
}) => Promise<{ model: ModelRef | undefined; agent: string | undefined; variant?: string }>

export class SessionTargetMutationError extends Error {
  override readonly name = "SessionTargetMutationError"

  constructor(cause: unknown) {
    super(errorMessage(cause), { cause })
  }
}

export async function resolveSessionTarget(input: {
  client: OpenCodeClient
  location?: { directory?: string; workspace?: string }
  continue?: boolean
  session?: string
  fork?: boolean
  model?: ModelRef
  agent?: string
  environment?: Readonly<Record<string, string>>
  prepare: SessionTargetPreparation
  signal?: AbortSignal
}): Promise<SessionTarget> {
  const selection = await selectSession(input)
  const selected = selection.session
  const location =
    selection.location ??
    (await resolveLocation(
      input.client,
      selected ? { directory: selected.location.directory } : input.location,
      input.signal,
    ))
  const prepared = await input.prepare({
    client: input.client,
    location,
    session: selected,
    model: input.model ?? selected?.model,
    agent: input.agent ?? selected?.agent,
    signal: input.signal,
  })
  const session =
    selected ??
    (await input.client.session
      .create(
        {
          id: input.session,
          agent: prepared.agent,
          model: prepared.model,
          experimental: prepared.variant === undefined ? undefined : { variant: prepared.variant },
          location: { directory: location.directory },
        },
        ...requestOptions(input.signal),
      )
      .catch((error) => {
        throw new SessionTargetMutationError(error)
      }))
  if (input.environment !== undefined)
    await input.client.session
      .environment({ sessionID: session.id, variables: input.environment }, ...requestOptions(input.signal))
      .catch((error) => {
        throw new SessionTargetMutationError(error)
      })
  return {
    session,
    location,
    model: selected === undefined && prepared.variant !== undefined ? session.model : prepared.model,
    agent: prepared.agent ?? session.agent,
    resume: selected !== undefined,
  }
}

export function parseSessionTargetModel(value?: string): ModelRef | undefined {
  if (!value) return
  const model = Model.Ref.parse(value)
  return { providerID: model.providerID, id: model.id, variant: model.variant }
}

export function prepareVariant(variant?: string): SessionTargetPreparation {
  return async (input) => {
    const selection = { model: input.model, agent: input.agent }
    if (variant === undefined) return selection
    await Effect.runPromise(waitForPlugins(input.client, input.location.directory), { signal: input.signal })
    if (!input.session) return { ...selection, variant }
    const query = { location: { directory: input.location.directory } }
    const options = requestOptions(input.signal)
    const { data } = await input.client.model.list(query, ...options)
    const find = (ref?: ModelRef) => ref && data.find((item) => item.id === ref.id && item.providerID === ref.providerID)
    const model = input.model
      ? find(input.model)
      : await Promise.all([input.client.agent.list(query, ...options), input.client.model.default(query, ...options)]).then(
          ([agents, fallback]) => {
            const preferred = find(
              agents.data.find((agent) => input.agent === undefined || agent.id === input.agent)?.model,
            )
            if (preferred) return preferred
            if (fallback.data?.package) return fallback.data
            return data.find(
              (item) =>
                item.package &&
                [item.capabilities.input, item.capabilities.output].every(
                  (types) => types.length === 0 || types.some((type) => type.startsWith("text")),
                ),
            )
          },
        )
    if (!model)
      throw new Error(
        input.model ? `Model unavailable: ${input.model.providerID}/${input.model.id}` : "No model is available",
      )
    if (variant !== "default" && !model.variants.some((item) => item.id === variant))
      throw new Error(`Variant unavailable for ${model.providerID}/${model.id}: ${variant}`)
    return { model: { providerID: model.providerID, id: model.id, variant }, agent: input.agent }
  }
}

async function selectSession(input: {
  client: OpenCodeClient
  location?: { directory?: string }
  continue?: boolean
  session?: string
  fork?: boolean
  signal?: AbortSignal
}) {
  const explicit = input.session ? await findSession(input.client, input.session, input.signal) : undefined
  if (input.session && !explicit) {
    if (input.fork) throw new Error("Session not found")
    return { session: undefined }
  }
  if (explicit)
    return {
      session: input.fork
        ? await input.client.session
            .fork({ sessionID: explicit.id }, ...requestOptions(input.signal))
            .catch((error) => {
              throw new SessionTargetMutationError(error)
            })
        : explicit,
    }
  if (!input.continue) return { session: undefined }

  const location = await resolveLocation(input.client, input.location, input.signal)
  const selected = await latestSession(input.client, location, undefined, input.signal)
  if (!selected) return { session: undefined, location }
  return {
    session: input.fork
      ? await input.client.session.fork({ sessionID: selected.id }, ...requestOptions(input.signal)).catch((error) => {
          throw new SessionTargetMutationError(error)
        })
      : selected,
  }
}

/** Create a new worktree of the location's project, keeping the caller's subfolder when the worktree has it. */
export async function createWorktreeLocation(input: {
  client: OpenCodeClient
  location?: { directory?: string }
  name?: string
  signal?: AbortSignal
}) {
  const base = await resolveLocation(input.client, input.location, input.signal)
  const created = await input.client.worktree
    .create(
      { projectID: base.project.id, from: base.project.directory, name: input.name },
      ...requestOptions(input.signal),
    )
    .catch((error) => {
      throw new SessionTargetMutationError(error)
    })
  const subfolder = path.relative(base.project.directory, base.directory)
  if (!subfolder || subfolder.startsWith("..") || path.isAbsolute(subfolder))
    return { root: created.directory, directory: created.directory }
  const directory = path.join(created.directory, subfolder)
  return resolveLocation(input.client, { directory }, input.signal).then(
    () => ({ root: created.directory, directory }),
    () => ({ root: created.directory, directory: created.directory }),
  )
}

export function findSession(client: OpenCodeClient, sessionID: string, signal?: AbortSignal) {
  return client.session.get({ sessionID }, ...requestOptions(signal)).catch((error) => {
    if (error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError") return undefined
    throw error
  })
}

async function latestSession(
  client: OpenCodeClient,
  location: LocationGetOutput,
  cursor?: string,
  signal?: AbortSignal,
): Promise<SessionInfo | undefined> {
  const page = await client.session.list(
    {
      directory: location.directory,
      parentID: null,
      archived: false,
      limit: SESSION_PAGE_LIMIT,
      order: "desc",
      ...(cursor ? { cursor } : {}),
    },
    ...requestOptions(signal),
  )
  const selected = page.data.find((session) => session.location.directory === location.directory)
  if (selected) return selected
  if (!page.cursor.next || page.data.length === 0) return
  return latestSession(client, location, page.cursor.next, signal)
}

function resolveLocation(client: OpenCodeClient, location?: { directory?: string }, signal?: AbortSignal) {
  if (!location && !signal) return client.location.get()
  if (!location) return client.location.get(undefined, { signal })
  return client.location.get({ location }, ...requestOptions(signal))
}

function requestOptions(signal?: AbortSignal): [] | [{ signal: AbortSignal }] {
  return signal ? [{ signal }] : []
}
