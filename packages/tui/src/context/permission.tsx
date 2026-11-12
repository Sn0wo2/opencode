import { useConfig } from "../config"
import { createEffect } from "solid-js"
import { useToast } from "../ui/toast"
import { useArgs } from "./args"
import { useData } from "./data"
import { createSimpleContext } from "./helper"
import { useRoute } from "./route"
import { useSessionTabs } from "./session-tabs"

export type PermissionMode = "prompt" | "autoaccept"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const config = useConfig()
    return {
      get mode(): PermissionMode {
        return args.auto ? "autoaccept" : config.data.session.permissions
      },
    }
  },
})

export function PermissionAutoAccept() {
  const permission = usePermission()
  const tabs = useSessionTabs()
  const route = useRoute()
  const data = useData()
  const toast = useToast()
  const autoApproved = new Set<string>()
  createEffect(() => {
    if (permission.mode !== "autoaccept") return
    const active = tabs.enabled() ? tabs.tabs().map((tab) => tab.sessionID) : []
    if (route.data.type === "session" && route.data.sessionID !== "dummy") active.push(route.data.sessionID)
    const roots = new Set(active.map((sessionID) => data.session.root(sessionID)))
    for (const request of [...roots]
      .flatMap((root) => [root, ...data.session.family(root)])
      .flatMap((sessionID) => data.session.permission.list(sessionID) ?? [])) {
      if (autoApproved.has(request.id)) continue
      autoApproved.add(request.id)
      void data.session.permission
        .reply({ sessionID: request.sessionID, decision: "once", requestID: request.id })
        .catch((error) => toast.error(error))
        .finally(() => autoApproved.delete(request.id))
    }
  })
  return null
}
