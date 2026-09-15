import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import packageMetadata from "../package.json" with { type: "json" }
import { VERSION } from "../src/index.js"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const requiredPackageFiles = [
  "scripts/",
  "src/",
  "schemas/",
  "skills/",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE.txt",
]
const expectedSchemas = {
  "schemas/thread.v1.json": "codex-thread.thread.v1",
  "schemas/error.v1.json": "codex-thread.error.v1",
  "schemas/jsonl-record.v1.json": "codex-thread.jsonl-record.v1",
  "schemas/list.v1.json": "codex-thread.list.v1",
  "schemas/doctor.v1.json": "codex-thread.doctor.v1",
  "schemas/find.v1.json": "codex-thread.find.v1",
}
const requiredReleaseFiles = [
  ...Object.keys(expectedSchemas),
  "scripts/codex-thread.js",
  "skills/codex-thread/SKILL.md",
  "skills/codex-thread/references/cli.md",
  "skills/codex-thread/references/workflows.md",
  "skills/codex-thread/agents/openai.yaml",
]

test("package metadata includes every runtime contract", () => {
  assert.deepEqual(packageMetadata.files, requiredPackageFiles)
  assert.deepEqual(packageMetadata.bin, { "codex-thread": "scripts/codex-thread.js" })
  assert.deepEqual(packageMetadata.exports, { ".": "./src/index.js" })
  for (const relativePath of requiredReleaseFiles) {
    assert.equal(fs.statSync(path.join(projectRoot, relativePath)).isFile(), true, relativePath)
  }
})

test("schemas, public import, and executable expose the package version", () => {
  for (const [relativePath, schemaVersion] of Object.entries(expectedSchemas)) {
    const schema = JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"))
    assert.equal(schema.properties.schemaVersion.const, schemaVersion)
  }

  assert.equal(VERSION, packageMetadata.version)
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, "scripts", "codex-thread.js"),
    "--version",
  ], { cwd: projectRoot, encoding: "utf8" })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, "")
  assert.equal(result.stdout, `${packageMetadata.version}\n`)
})
