import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import { Hash } from "@opencode/util/hash"

// Keep source fingerprints and import attempts together. Filesystem events
// should reload changed local graphs, not repeat unchanged evaluations.
export function createPluginSources(watch: (file: string) => Promise<void>) {
  const sources = new Map<string, Source>()
  const cleanups: Array<() => void> = []
  const watching = new Set<Promise<void>>()
  return {
    read: async (entrypoint: string) => {
      await Promise.all(watching)
      const previous = sources.get(entrypoint)
      if (previous && [...previous.files].every(([file, item]) => item.digest === digest(file, item.directory)))
        return previous.loaded

      const files: Source["files"] = new Map()
      const track = (file: string, directory = false) => {
        if (files.has(file)) return
        files.set(file, { digest: digest(file, directory), directory })
        const pending = watch(file).finally(() => watching.delete(pending))
        watching.add(pending)
        // Watch setup can be interrupted while module evaluation is still pending.
        void pending.catch(() => {})
      }
      track(fileURLToPath(entrypoint))
      const { prepareSource } = await import("#plugin-source")
      const prepared: { version: string; load: () => Promise<unknown>; dispose?: () => void } = await prepareSource(
        entrypoint,
        track,
      )
      if (prepared.dispose) cleanups.push(prepared.dispose)
      // Cache the attempt before evaluating it: unchanged failing modules must
      // not repeat import-time effects on every filesystem notification.
      const loaded = prepared.load().then((module) => ({ version: prepared.version, module }))
      sources.set(entrypoint, { loaded, files })
      return loaded.finally(() => Promise.all(watching))
    },
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup()
      sources.clear()
    },
  }
}

const staticSources = new Map<
  string,
  { loaded: Promise<{ module: unknown; version: string | undefined }>; dispose: () => void }
>()

export function readStaticSource(entrypoint: string, version?: string) {
  const key = `${entrypoint}\0${version ?? ""}`
  const cached = staticSources.get(key)
  if (cached) return cached.loaded

  let prepared: { version: string; load: () => Promise<unknown>; dispose?: () => void } | undefined
  const loaded = (async () => {
    const { prepareSource } = await import("#plugin-source")
    prepared = await prepareSource(entrypoint, () => {})
    return { module: await prepared.load(), version }
  })()
  const entry = { loaded, dispose: () => prepared?.dispose?.() }
  void loaded.catch(() => {
    staticSources.delete(key)
    entry.dispose()
  })
  staticSources.set(key, entry)
  return loaded
}

export function acceptStaticSource(entrypoint: string, version?: string) {
  const key = `${entrypoint}\0${version ?? ""}`
  for (const [k, item] of staticSources) {
    if (k === key || !k.startsWith(`${entrypoint}\0`)) continue
    staticSources.delete(k)
    item.dispose()
  }
}

type Source = {
  loaded: Promise<{ version: string; module: unknown }>
  files: Map<string, { digest: string; directory: boolean }>
}

function digest(file: string, directory: boolean) {
  try {
    return Hash.sha256(directory ? JSON.stringify(readdirSync(file).sort()) : readFileSync(file))
  } catch {
    return "missing"
  }
}

export function localSource(spec: string, directory: string) {
  if (spec.startsWith("file://")) return new URL(spec)
  if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec))
    return pathToFileURL(path.resolve(directory, spec))
  return undefined
}
