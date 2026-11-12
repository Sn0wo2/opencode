import { registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { transform } from "sucrase"
import { localSource } from "./source.js"
import { missingPackageTarget } from "./source.package.js"
import { Host } from "./host.js"

let generation = Date.now()

function moduleFormat(file: string) {
  if (file.endsWith(".mts")) return "module"
  if (file.endsWith(".cts")) return "commonjs"
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    try {
      return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).type === "module" ? "module" : "commonjs"
    } catch {
      if (path.dirname(dir) === dir) return "commonjs"
    }
  }
}

export async function prepareSource(entrypoint: string, track: (file: string, directory?: boolean) => void) {
  const version = String(++generation)
  const fresh = (specifier: string) => {
    const url = new URL(specifier)
    url.searchParams.set("__opencode_reload", version)
    return url.href
  }
  const hook = registerHooks?.({
    resolve(specifier, context, nextResolve) {
      if (!context.parentURL || new URL(context.parentURL).searchParams.get("__opencode_reload") !== version)
        return nextResolve(specifier, context)
      const relative = specifier.startsWith("./") || specifier.startsWith("../")
      const local = relative
        ? new URL(specifier, context.parentURL)
        : localSource(specifier, path.dirname(fileURLToPath(context.parentURL)))
      const external = local !== undefined && fileURLToPath(local).split(path.sep).includes("node_modules")
      const resolved = (() => {
        try {
          return nextResolve(specifier, context)
        } catch (error) {
          if (relative) {
            const stem = specifier.replace(/\.(?:c|m)?jsx?$/, "")
            if (!/\.[cm]?tsx?$/.test(stem))
              for (const extension of [".ts", ".cts", ".mts", "/index.ts", "/index.cts", "/index.mts"]) {
                try {
                  return nextResolve(stem + extension, context)
                } catch {}
              }
          }
          if (!external) {
            const target = local
              ? path.dirname(fileURLToPath(local))
              : missingPackageTarget(specifier, fileURLToPath(context.parentURL))
            if (target) track(target, true)
          }
          throw error
        }
      })()
      if (!resolved.url.startsWith("file:")) return resolved
      const file = fileURLToPath(resolved.url)
      if (file.split(path.sep).includes("node_modules"))
        return /\.[cm]?ts$/.test(file) ? { ...resolved, url: fresh(resolved.url) } : resolved
      track(file)
      return { ...resolved, url: fresh(resolved.url) }
    },
    load(url, context, nextLoad) {
      const parsed = new URL(url)
      if (!parsed.protocol.startsWith("file:") || parsed.searchParams.get("__opencode_reload") !== version)
        return nextLoad(url, context)
      const file = fileURLToPath(parsed)
      if (!/\.[cm]?ts$/.test(file)) return nextLoad(url, context)
      const commonjs = moduleFormat(file) === "commonjs"
      const { code } = transform(readFileSync(file, "utf8"), {
        transforms: commonjs ? ["typescript", "imports"] : ["typescript"],
        preserveDynamicImport: true,
        filePath: file,
      })
      return { format: commonjs ? "commonjs" : "module", source: code, shortCircuit: true }
    },
  })
  const specifier = fresh(entrypoint)
  return { version: specifier, load: () => Host.load(specifier), dispose: () => hook?.deregister?.() }
}
