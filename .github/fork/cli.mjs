#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
let entry
try {
  entry = path.join(path.dirname(require.resolve(`@me0wo/opencode-${target}/package.json`)), "opencode.mjs")
} catch {
  console.error(`@me0wo/opencode: no bundle available for ${target}`)
  process.exit(1)
}
const bunBin =
  process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, "bin", process.platform === "win32" ? "bun.exe" : "bun")
const bunRun = /[/\\]install[/\\]global[/\\]node_modules[/\\]/.test(import.meta.url)
const executable = !bunRun ? process.execPath : bunBin && existsSync(bunBin) ? bunBin : "bun"
const args = [entry, ...process.argv.slice(2)]
const { status, signal, error } = spawnSync(
  executable,
  !bunRun && typeof Bun === "undefined" ? ["--experimental-ffi", ...args] : args,
  { stdio: "inherit" },
)
if (error) console.error(error.message)
if (signal) process.kill(process.pid, signal)
else process.exitCode = error ? 1 : status ?? 1
