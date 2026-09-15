#!/usr/bin/env node

import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function collectJavaScriptFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(entryPath))
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath)
  }
  return files
}

const files = ["scripts", "src"]
  .flatMap((directory) => collectJavaScriptFiles(path.join(projectRoot, directory)))

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" })
  if (result.status !== 0) process.exit(result.status || 1)
}
