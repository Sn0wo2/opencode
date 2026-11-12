import { Script, constants } from "node:vm"
import { registerHooks } from "node:module"
import { statSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const bun = typeof Bun === "undefined" ? undefined : Bun

export async function importModule(specifier: string) {
  const imported = (await new Script(`import(${JSON.stringify(specifier)})`, {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }).runInThisContext()) as unknown
  if (typeof imported !== "object" || imported === null) return imported

  const module = imported as Record<string, unknown>
  const exports = module["module.exports"]
  if (exports !== module.default || (typeof exports !== "object" && typeof exports !== "function") || exports === null)
    return imported
  return Object.assign({}, module, exports)
}

export function resolveModule(specifier: string, directory: string) {
  if (bun)
    return complete(specifier, (target) => {
      const resolved = path.isAbsolute(target) ? target : bun.resolveSync(target, directory)
      statSync(resolved)
      return pathToFileURL(resolved).href
    })
  // Node only accepts import.meta.resolve's parent URL behind an experimental
  // flag. Scope this synchronous resolution to the caller's package directory
  // through the supported resolver hook instead.
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier, { ...context, parentURL: pathToFileURL(path.join(directory, "package.json")).href })
    },
  })
  try {
    return complete(specifier, (target) => {
      const resolved = import.meta.resolve(path.isAbsolute(target) ? pathToFileURL(target).href : target)
      if (resolved.startsWith("file:")) statSync(new URL(resolved))
      return resolved
    })
  } finally {
    hook.deregister?.()
  }
}

function complete(specifier: string, resolve: (target: string) => string) {
  try {
    return resolve(specifier)
  } catch (error) {
    if (path.extname(specifier) || !missing(error)) throw error
    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]) {
      try {
        return resolve(specifier + extension)
      } catch (cause) {
        if (!missing(cause)) throw cause
      }
    }
    throw error
  }
}

function missing(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "ERR_MODULE_NOT_FOUND"].includes(String(error.code))
  )
}
