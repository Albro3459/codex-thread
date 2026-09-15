import { inspectInstallation, doctorExitCode, formatDoctorHuman } from "./doctor.js"
import {
  EXIT_CODES,
  InvalidArgumentsError,
  UnknownCommandError,
  serializeError,
  toCodexThreadError,
} from "./errors.js"
import { createCodexThreadClient } from "./index.js"
import {
  formatCollectionHuman,
  formatCollectionJson,
  formatCollectionJsonl,
  formatDoctorJson,
  formatThreadHuman,
  formatThreadJson,
  formatThreadJsonl,
} from "./output.js"
import { formatBundledSchema } from "./schema.js"
import { installBundledSkill } from "./skill-install.js"
import { VERSION } from "./version.js"

const COMMANDS = new Set(["list", "find", "get", "doctor", "schema", "install"])
const FORMATS = new Set(["human", "json", "jsonl"])
const NEGATIVE_NUMBER = /^-\d/u

const OPTIONS = Object.freeze({
  "--format": { key: "format", value: true },
  "--title": { key: "title", value: true },
  "--limit": { key: "limit", value: true },
  "--offset": { key: "offset", value: true },
  "--turn": { key: "turn", value: true },
  "--turn-limit": { key: "turnLimit", value: true },
  "--turn-offset": { key: "turnOffset", value: true },
  "--skills": { key: "skills", value: true },
  "--reverse": { key: "reverse", value: false },
  "--archived": { key: "archived", value: false },
  "--include-subagents": { key: "includeSubagents", value: false },
  "--last-turn": { key: "lastTurn", value: false },
  "--overwrite": { key: "overwrite", value: false },
  "--backup": { key: "backup", value: false },
})

const ALLOWED_OPTIONS = Object.freeze({
  list: new Set(["format", "limit", "offset", "reverse", "archived", "includeSubagents"]),
  find: new Set(["format", "title", "reverse", "archived", "includeSubagents"]),
  get: new Set(["format", "turn", "turnLimit", "turnOffset", "lastTurn"]),
  doctor: new Set(["format"]),
  schema: new Set(),
  install: new Set(["format", "skills", "overwrite", "backup"]),
})

function optionValue(argv, index, option) {
  const value = argv[index + 1]
  if (value !== undefined && NEGATIVE_NUMBER.test(value)) {
    throw new InvalidArgumentsError(`${option} does not accept a negative value.`, { option, value })
  }
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new InvalidArgumentsError(`Missing value for ${option}.`, { option })
  }
  return value
}

export function parseCliArgs(argv = []) {
  const parsed = {
    command: null,
    args: [],
    format: undefined,
    title: undefined,
    limit: undefined,
    offset: undefined,
    turn: undefined,
    turnLimit: undefined,
    turnOffset: undefined,
    skills: undefined,
    reverse: false,
    archived: false,
    includeSubagents: false,
    lastTurn: false,
    overwrite: false,
    backup: false,
    help: false,
    version: false,
    seen: new Set(),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help" || value === "-h") {
      parsed.help = true
      continue
    }
    if (value === "--version" || value === "-v") {
      parsed.version = true
      continue
    }

    const definition = OPTIONS[value]
    if (definition) {
      if (parsed.seen.has(definition.key)) {
        throw new InvalidArgumentsError(`${value} can only be supplied once.`, { option: value })
      }
      parsed.seen.add(definition.key)
      if (definition.value) {
        parsed[definition.key] = optionValue(argv, index, value)
        index += 1
      } else {
        parsed[definition.key] = true
      }
      continue
    }

    if (value.startsWith("-")) {
      throw new InvalidArgumentsError(`Unknown option: ${value}`, { option: value })
    }
    if (parsed.command === null) parsed.command = value
    else parsed.args.push(value)
  }
  return parsed
}

function validateCommandOptions(parsed) {
  if (!COMMANDS.has(parsed.command)) throw new UnknownCommandError(parsed.command)
  for (const option of parsed.seen) {
    if (!ALLOWED_OPTIONS[parsed.command].has(option)) {
      throw new InvalidArgumentsError(`${option} is not supported by ${parsed.command}.`, {
        command: parsed.command,
        option,
      })
    }
  }

  if (parsed.format !== undefined && !FORMATS.has(parsed.format)) {
    throw new InvalidArgumentsError("format must be human, json, or jsonl.", {
      field: "format",
      value: parsed.format,
    })
  }
  if (parsed.command === "doctor" && parsed.format === "jsonl") {
    throw new InvalidArgumentsError("doctor does not support jsonl output.", { field: "format" })
  }
  if (parsed.command === "install" && parsed.format === "jsonl") {
    throw new InvalidArgumentsError("install does not support jsonl output.", { field: "format" })
  }
}

function requireArgs(parsed, count, usage) {
  if (parsed.args.length !== count) {
    throw new InvalidArgumentsError(`Usage: ${usage}`, {
      command: parsed.command,
      arguments: parsed.args,
    })
  }
}

function helpText() {
  return `codex-thread ${VERSION}

Read local Codex threads through the installed Codex CLI.

Usage:
  codex-thread list [--limit N] [--offset N] [--reverse] [--archived] [--include-subagents]
  codex-thread find --title TEXT [--reverse] [--archived] [--include-subagents]
  codex-thread get THREAD [--last-turn | --turn ID | --turn-limit N --turn-offset N]
  codex-thread doctor
  codex-thread schema NAME
  codex-thread install --skills codex [--overwrite | --backup]

Shared options:
  --format human|json|jsonl
  -h, --help
  -v, --version

THREAD may be a Codex thread ID or codex://threads/<thread-id>.
Machine errors are JSON on stderr.
`
}

function write(stream, value) {
  stream.write(value.endsWith("\n") ? value : `${value}\n`)
}

function formatCollection(envelope, format) {
  if (format === "json") return formatCollectionJson(envelope)
  if (format === "jsonl") return formatCollectionJsonl(envelope)
  return formatCollectionHuman(envelope)
}

function formatThread(envelope, format) {
  if (format === "json") return formatThreadJson(envelope)
  if (format === "jsonl") return formatThreadJsonl(envelope)
  return formatThreadHuman(envelope)
}

function turnSelectionExitCode(envelope) {
  return envelope.warnings.some((warning) => warning.code === "TURN_NOT_FOUND")
    ? EXIT_CODES.NOT_FOUND
    : EXIT_CODES.SUCCESS
}

export async function run(parsed, {
  stdout = process.stdout,
  createClient = createCodexThreadClient,
} = {}) {
  const format = parsed.format ?? "human"

  if (parsed.command === "schema") {
    requireArgs(parsed, 1, "codex-thread schema <schema-name>")
    write(stdout, formatBundledSchema(parsed.args[0]))
    return EXIT_CODES.SUCCESS
  }

  if (parsed.command === "install") {
    requireArgs(parsed, 0, "codex-thread install --skills codex")
    if (parsed.skills !== "codex") {
      throw new InvalidArgumentsError("--skills must be codex.", {
        field: "skills",
        value: parsed.skills,
      })
    }
    if (parsed.overwrite && parsed.backup) {
      throw new InvalidArgumentsError("--overwrite cannot be combined with --backup.", {
        field: "overwrite",
      })
    }
    const result = installBundledSkill("codex", {
      overwrite: parsed.overwrite,
      backup: parsed.backup,
    })
    const human = [
      `Installed ${result.skill} at ${result.destination}`,
      ...result.warnings.map((warning) => `Warning: ${warning.message} ${warning.details.path}`),
    ].join("\n")
    write(stdout, format === "json" ? JSON.stringify(result, null, 2) : human)
    return EXIT_CODES.SUCCESS
  }

  if (parsed.command === "doctor") {
    requireArgs(parsed, 0, "codex-thread doctor")
    const report = await inspectInstallation()
    write(stdout, format === "json" ? formatDoctorJson(report) : formatDoctorHuman(report))
    return doctorExitCode(report)
  }

  const client = await createClient()
  if (parsed.command === "list") {
    requireArgs(parsed, 0, "codex-thread list [options]")
    const result = await client.listThreads(parsed)
    write(stdout, formatCollection(result, format))
    return EXIT_CODES.SUCCESS
  }
  if (parsed.command === "find") {
    requireArgs(parsed, 0, "codex-thread find --title <text> [options]")
    const result = await client.findThreads(parsed)
    write(stdout, formatCollection(result, format))
    return EXIT_CODES.SUCCESS
  }
  if (parsed.command === "get") {
    requireArgs(parsed, 1, "codex-thread get <thread-reference> [options]")
    const result = await client.getThread(parsed.args[0], {
      lastTurn: parsed.lastTurn,
      turnId: parsed.turn,
      turnLimit: parsed.turnLimit,
      turnOffset: parsed.turnOffset,
    })
    write(stdout, formatThread(result, format))
    return turnSelectionExitCode(result)
  }

  throw new UnknownCommandError(parsed.command)
}

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
  createClient = createCodexThreadClient,
} = {}) {
  try {
    const parsed = parseCliArgs(argv)
    if (parsed.version) {
      write(stdout, VERSION)
      return EXIT_CODES.SUCCESS
    }
    if (parsed.help || parsed.command === null) {
      write(stdout, helpText())
      return EXIT_CODES.SUCCESS
    }
    validateCommandOptions(parsed)
    return await run(parsed, { stdout, createClient })
  } catch (error) {
    const normalized = toCodexThreadError(error)
    write(stderr, JSON.stringify(serializeError(normalized)))
    return normalized.exitCode
  }
}
