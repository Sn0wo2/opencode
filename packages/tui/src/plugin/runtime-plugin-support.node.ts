// OpenTUI's runtime plugin transform uses Bun's plugin API. Node loads precompiled plugins without it.
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"

Object.assign(globalThis, { [Symbol.for("opencode.plugin.tui")]: { Plugin, PluginContextProvider, usePlugin } })
