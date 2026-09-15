import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const schemaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schemas")

function typeMatches(value, type) {
  if (type === "null") return value === null
  if (type === "array") return Array.isArray(value)
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value)
  if (type === "integer") return Number.isInteger(value)
  return typeof value === type
}

function validate(value, schema, root, pathName) {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\/\$defs\//u, "")
    return validate(value, root.$defs[target], root, pathName)
  }
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, pathName)
  if (schema.enum) assert.ok(schema.enum.includes(value), `${pathName} must be one of ${schema.enum.join(", ")}`)
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    assert.ok(types.some((type) => typeMatches(value, type)), `${pathName} has an invalid type`)
  }
  if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${pathName} is too short`)
  if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${pathName} is below minimum`)
  if (schema.required) {
    for (const key of schema.required) assert.ok(Object.hasOwn(value, key), `${pathName}.${key} is required`)
  }
  if (schema.properties) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) validate(value[key], childSchema, root, `${pathName}.${key}`)
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => validate(item, schema.items, root, `${pathName}[${index}]`))
  }
  if (schema.additionalProperties === false && value && typeof value === "object" && !Array.isArray(value)) {
    const allowed = new Set([
      ...Object.keys(schema.properties ?? {}),
      ...schema.required ?? [],
    ])
    for (const key of Object.keys(value)) assert.ok(allowed.has(key), `${pathName}.${key} is not allowed`)
  }
}

export function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(schemaRoot, `${name}.v1.json`), "utf8"))
}

export function assertSchema(value, name) {
  const schema = readSchema(name)
  validate(value, schema, schema, "$")
}
