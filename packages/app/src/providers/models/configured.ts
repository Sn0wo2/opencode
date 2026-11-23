import { createEffect, createMemo, on } from "solid-js"
import { ConfigModel } from "@opencode/schema/config/model"
import { useData } from "@/runtime/server/current"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useServerSDK } from "@/runtime/server/client"

export function useConfiguredModel() {
  const data = useData()
  const location = useWorkspaceLocation()
  const server = useServerSDK()
  createEffect(
    on(
      () => [location().directory, server.connection.status()] as const,
      ([directory]) => {
        void data.location.config.sync({ directory }).catch(() => undefined)
      },
    ),
  )
  const documents = () => data.location.config.list({ directory: location().directory })

  const configured = createMemo(() => ConfigModel.configured(documents()))

  return Object.assign(() => configured().model, {
    variant: () => configured().variant,
    ready: () => documents() !== undefined,
  })
}
