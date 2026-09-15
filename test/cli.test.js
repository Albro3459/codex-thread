import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import { main } from "../src/cli.js"
import {
  CodexUnavailableError,
  ThreadNotFoundError,
} from "../src/errors.js"
import { createCodexThreadClient } from "../src/index.js"
import { captureStream } from "./fixtures/capture.js"

function collectionEnvelope(kind, threads = []) {
  const envelope = {
    schemaVersion: `codex-thread.${kind}.v1`,
    toolVersion: "0.1.0",
    filters: {},
    ordering: { sortBy: "updatedAt", direction: "asc" },
    count: threads.length,
    threads,
  }
  if (kind === "list") {
    envelope.limit = 50
    envelope.offset = 0
    envelope.hasMore = false
  }
  return envelope
}

function threadEnvelope(warnings = []) {
  return {
    schemaVersion: "codex-thread.thread.v1",
    toolVersion: "0.1.0",
    thread: { id: "thread-1", title: "Example" },
    turns: [],
    messages: [],
    activities: [],
    runtime: { status: { type: "idle" } },
    warnings,
  }
}

async function invoke(argv, createClient) {
  const stdout = captureStream()
  const stderr = captureStream()
  const exitCode = await main(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    createClient,
  })
  return { exitCode, stdout: stdout.read(), stderr: stderr.read() }
}

test("dispatches list, find, and get options through the injected client", async () => {
  const calls = []
  const client = {
    async listThreads(options) {
      calls.push(["list", options])
      return collectionEnvelope("list")
    },
    async findThreads(options) {
      calls.push(["find", options])
      return collectionEnvelope("find")
    },
    async getThread(reference, options) {
      calls.push(["get", reference, options])
      return threadEnvelope()
    },
  }
  const createClient = () => client

  assert.equal((await invoke([
    "--format", "json", "list", "--limit", "2", "--offset", "1", "--reverse",
  ], createClient)).exitCode, 0)
  assert.equal((await invoke([
    "find", "--title", "Example", "--archived", "--format", "json",
  ], createClient)).exitCode, 0)
  assert.equal((await invoke([
    "get", "thread-1", "--turn-limit", "2", "--turn-offset", "1", "--format", "json",
  ], createClient)).exitCode, 0)

  assert.equal(calls.length, 3)
  assert.equal(calls[0][0], "list")
  assert.equal(calls[1][0], "find")
  assert.deepEqual(calls[2], ["get", "thread-1", {
    lastTurn: false,
    turnId: undefined,
    turnLimit: "2",
    turnOffset: "1",
  }])
  assert.deepEqual(calls[0][1], {
    command: "list",
    args: [],
    format: "json",
    title: undefined,
    limit: "2",
    offset: "1",
    turn: undefined,
    turnLimit: undefined,
    turnOffset: undefined,
    interval: undefined,
    maxCycles: undefined,
    timeout: undefined,
    skills: undefined,
    reverse: true,
    archived: false,
    includeSubagents: false,
    lastTurn: false,
    once: false,
    tree: false,
    overwrite: false,
    backup: false,
    help: false,
    version: false,
    seen: new Set(["format", "limit", "offset", "reverse"]),
  })
  assert.equal(calls[1][1].title, "Example")
  assert.equal(calls[1][1].archived, true)
})

test("rejects ambiguous and malformed options before creating a client", async () => {
  const cases = [
    ["list", "--limit"],
    ["list", "--offset", "-1"],
    ["list", "--format", "json", "--format", "jsonl"],
    ["get", "thread-1", "--limit", "1"],
    ["list", "--title", "value"],
  ]

  for (const argv of cases) {
    let created = false
    const result = await invoke(argv, () => {
      created = true
      return {}
    })
    assert.equal(result.exitCode, 3, argv.join(" "))
    assert.equal(result.stdout, "", argv.join(" "))
    const error = JSON.parse(result.stderr)
    assert.equal(error.schemaVersion, "codex-thread.error.v1")
    assert.equal(error.code, "INVALID_ARGUMENTS")
    assert.equal(created, false, argv.join(" "))
  }
})

test("rejects conflicting turn selectors before reading from the app-server", async () => {
  let read = false
  const result = await invoke([
    "get", "thread-1", "--turn", "turn-1", "--last-turn",
  ], async () => ({
    async getThread(reference, options) {
      return createCodexThreadClient({
        appServerClient: {
          async readThread() {
            read = true
          },
        },
      }).getThread(reference, options)
    },
  }))

  assert.equal(result.exitCode, 3)
  assert.equal(result.stdout, "")
  assert.equal(JSON.parse(result.stderr).code, "INVALID_ARGUMENTS")
  assert.equal(read, false)
})

test("keeps machine failures on stderr with their documented exit codes", async () => {
  const cases = [
    {
      error: new ThreadNotFoundError("thread-1"),
      exitCode: 2,
      code: "THREAD_NOT_FOUND",
    },
    {
      error: new CodexUnavailableError("Codex is unavailable"),
      exitCode: 4,
      code: "CODEX_UNAVAILABLE",
    },
  ]

  for (const entry of cases) {
    const result = await invoke(["get", "thread-1", "--format", "json"], () => ({
      async getThread() {
        throw entry.error
      },
    }))
    assert.equal(result.exitCode, entry.exitCode)
    assert.equal(result.stdout, "")
    assert.equal(JSON.parse(result.stderr).code, entry.code)
    assert.equal(result.stderr.trimEnd().split("\n").length, 1)
  }
})

test("returns exit code 2 for an exact missing turn warning", async () => {
  const result = await invoke([
    "get", "thread-1", "--turn", "missing-turn", "--format", "json",
  ], () => ({
    async getThread() {
      return threadEnvelope([{
        code: "TURN_NOT_FOUND",
        message: "The thread does not contain the supplied turn ID.",
        details: { turnId: "missing-turn" },
      }])
    },
  }))

  assert.equal(result.exitCode, 2)
  assert.equal(result.stderr, "")
  assert.equal(JSON.parse(result.stdout).warnings[0].code, "TURN_NOT_FOUND")
})

test("dispatches bounded tail records and participant options", async () => {
  const calls = []
  const createClient = () => ({
    async *tailThread(reference, options) {
      calls.push(["tail", reference, options])
      yield {
        schemaVersion: "codex-thread.tail-record.v1",
        op: "end",
        recordType: "end",
        threadId: reference,
        observedAt: "2023-11-14T22:13:20.000Z",
        cycle: 1,
        data: { reason: "once", attemptedCycles: 1 },
      }
    },
    async getParticipants(reference, options) {
      calls.push(["participants", reference, options])
      return {
        schemaVersion: "codex-thread.participants.v1",
        toolVersion: "0.2.0",
        threadId: reference,
        ordering: { sortBy: "firstDiscovery", direction: "desc" },
        selection: null,
        counts: { total: 0, returned: 0, hasMore: false },
        hierarchyAvailable: false,
        participants: [],
        warnings: [],
      }
    },
  })

  const tail = await invoke(["tail", "thread-1", "--once"], createClient)
  assert.equal(tail.exitCode, 0)
  assert.equal(JSON.parse(tail.stdout).data.reason, "once")
  const participants = await invoke([
    "participants", "thread-1", "--last-turn", "--limit", "2", "--reverse", "--format", "json",
  ], createClient)
  assert.equal(participants.exitCode, 0)
  assert.equal(JSON.parse(participants.stdout).schemaVersion, "codex-thread.participants.v1")
  assert.equal(calls[0][0], "tail")
  assert.equal(calls[0][2].once, true)
  assert.equal(calls[0][2].format, "jsonl")
  assert.deepEqual(calls[1], ["participants", "thread-1", {
    lastTurn: true,
    turnId: undefined,
    turnLimit: undefined,
    turnOffset: undefined,
    limit: "2",
    offset: undefined,
    reverse: true,
    tree: false,
  }])
})

test("rejects unbounded JSON tails and conflicting tail bounds before creating a client", async () => {
  for (const argv of [
    ["tail", "thread-1", "--format", "json"],
    ["tail", "thread-1", "--once", "--interval", "100"],
  ]) {
    let created = false
    const result = await invoke(argv, () => {
      created = true
      return {}
    })
    assert.equal(result.exitCode, 3)
    assert.equal(result.stdout, "")
    assert.equal(JSON.parse(result.stderr).code, "INVALID_ARGUMENTS")
    assert.equal(created, false)
  }
})

test("stops a tail quietly when stdout closes", async () => {
  let closed = false
  const error = Object.assign(new Error("closed"), { code: "EPIPE" })
  const stdout = { write() { throw error } }
  const stderr = captureStream()
  const exitCode = await main(["tail", "thread-1", "--once"], {
    stdout,
    stderr: stderr.stream,
    createClient: () => ({
      async *tailThread() {
        try {
          yield { recordType: "runtime", data: {} }
          yield { recordType: "end", data: { reason: "once" } }
        } finally {
          closed = true
        }
      },
    }),
  })
  assert.equal(exitCode, 0)
  assert.equal(stderr.read(), "")
  assert.equal(closed, true)
})

test("SIGINT emits one interrupt end record and exits cleanly", async () => {
  const signalSource = new EventEmitter()
  const result = await (async () => {
    const stdout = captureStream()
    const stderr = captureStream()
    const exitCode = await main(["tail", "thread-1"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      signalSource,
      createClient: () => ({
        async *tailThread(reference, options) {
          signalSource.emit("SIGINT")
          assert.equal(options.signal.aborted, true)
          yield {
            schemaVersion: "codex-thread.tail-record.v1",
            op: "end",
            recordType: "end",
            threadId: reference,
            observedAt: "2023-11-14T22:13:20.000Z",
            cycle: 0,
            data: { reason: "interrupt", attemptedCycles: 0 },
          }
        },
      }),
    })
    return { exitCode, stdout: stdout.read(), stderr: stderr.read() }
  })()
  assert.equal(result.exitCode, 0)
  assert.equal(result.stderr, "")
  const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
  assert.deepEqual(records.map((record) => record.data.reason), ["interrupt"])
  assert.equal(signalSource.listenerCount("SIGINT"), 0)
})

test("a thread that disappears during tail emits end and exits 2", async () => {
  const result = await invoke(["tail", "thread-1", "--max-cycles", "2"], () => ({
    async *tailThread(reference) {
      yield {
        schemaVersion: "codex-thread.tail-record.v1",
        op: "end",
        recordType: "end",
        threadId: reference,
        observedAt: "2023-11-14T22:13:20.000Z",
        cycle: 2,
        data: { reason: "thread-not-found", attemptedCycles: 2 },
      }
    },
  }))
  assert.equal(result.exitCode, 2)
  assert.equal(result.stderr, "")
  assert.equal(JSON.parse(result.stdout).data.reason, "thread-not-found")
})
