import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { InvalidArgumentsError } from "./errors.js"

const SCHEMA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas")
const SCHEMA_FILES = Object.freeze({
  "thread.v1": "thread.v1.json",
  "list.v1": "list.v1.json",
  "find.v1": "find.v1.json",
  "jsonl-record.v1": "jsonl-record.v1.json",
  "doctor.v1": "doctor.v1.json",
  "error.v1": "error.v1.json",
})

export const BUNDLED_SCHEMAS = Object.freeze(Object.keys(SCHEMA_FILES))

export function resolveSchemaPath(name) {
  const fileName = SCHEMA_FILES[name]
  if (!fileName) {
    throw new InvalidArgumentsError(`Unknown schema: ${name}.`, {
      schema: name,
      supportedSchemas: BUNDLED_SCHEMAS,
    })
  }
  return path.join(SCHEMA_ROOT, fileName)
}

export function readBundledSchema(name) {
  return JSON.parse(fs.readFileSync(resolveSchemaPath(name), "utf8"))
}

export function formatBundledSchema(name) {
  return `${JSON.stringify(readBundledSchema(name), null, 2)}\n`
}
