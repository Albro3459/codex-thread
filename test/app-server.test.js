import assert from "node:assert/strict"
import test from "node:test"

import {
  AppServerProtocolError,
  AppServerTimeoutError,
  CodexUnavailableError,
  createAppServerClient,
  requestAppServer,
} from "../src/app-server.js"
import { createSpawnProcess, FakeAppServerProcess } from "./fixtures/app-server-fixture.js"

function optionsFor(fakeProcess, options = {}) {
  return {
    codexPath: "fixture-codex",
    spawnProcess: createSpawnProcess(fakeProcess),
    ...options,
  }
}

async function assertProtocolFailure(operation, code = "APP_SERVER_PROTOCOL_ERROR") {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof AppServerProtocolError)
    assert.equal(error.code, code)
    return true
  })
}

test("runs initialize, initialized, read, and clean shutdown over chunked stdio", async () => {
  const child = new FakeAppServerProcess({ chunkSize: 1 })
  const spawnProcess = createSpawnProcess(child)
  const client = createAppServerClient({ codexPath: "fixture-codex", spawnProcess })
  const result = await client.readThread("fixture-thread")

  assert.deepEqual(result, { threadId: "fixture-thread", turns: [] })
  assert.equal(spawnProcess.calls.length, 1)
  assert.equal(spawnProcess.calls[0][0], "fixture-codex")
  assert.deepEqual(spawnProcess.calls[0][1], ["app-server"])
  assert.equal(spawnProcess.calls[0][2].shell, false)
  assert.deepEqual(spawnProcess.calls[0][2].stdio, ["pipe", "pipe", "pipe"])
  assert.deepEqual(child.requests.map(({ id, method }) => ({ id, method })), [
    { id: 1, method: "initialize" },
    { id: undefined, method: "initialized" },
    { id: 2, method: "thread/read" },
  ])
  assert.deepEqual(child.requests[2].params, {
    threadId: "fixture-thread",
    includeTurns: true,
  })
  assert.equal(child.closed, true)
})

test("rejects methods outside the read-only app-server allowlist before spawning", async () => {
  for (const method of ["initialize", "thread/write", "thread/delete", "", null]) {
    let spawned = false
    await assert.rejects(
      () => requestAppServer(method, {}, {
        codexPath: "fixture-codex",
        spawnProcess() {
          spawned = true
          return new FakeAppServerProcess()
        },
      }),
      (error) => {
        assert.ok(error instanceof AppServerProtocolError)
        assert.equal(error.code, "APP_SERVER_PROTOCOL_ERROR")
        return true
      },
    )
    assert.equal(spawned, false, `method ${String(method)} must be rejected before spawn`)
  }
})

test("rejects malformed JSON messages", async () => {
  const child = new FakeAppServerProcess({
    onRequest(request, process) {
      if (request.method === "initialize") {
        process.send({ id: request.id, result: {} })
      } else if (request.method === "thread/list") {
        process.sendRaw("{malformed-json}\n")
      }
    },
  })

  await assertProtocolFailure(
    () => requestAppServer("thread/list", {}, optionsFor(child)),
  )
})

test("rejects non-object JSON messages", async () => {
  const child = new FakeAppServerProcess({
    onRequest(request, process) {
      if (request.method === "initialize") {
        process.send({ id: request.id, result: {} })
      } else if (request.method === "thread/list") {
        process.sendRaw("null\n")
      }
    },
  })

  await assertProtocolFailure(
    () => requestAppServer("thread/list", {}, optionsFor(child)),
  )
})

test("rejects responses with unknown IDs", async () => {
  const child = new FakeAppServerProcess({
    onRequest(request, process) {
      if (request.method === "initialize") {
        process.send({ id: request.id, result: {} })
      } else if (request.method === "thread/list") {
        process.send({ id: 999, result: {} })
      }
    },
  })

  await assertProtocolFailure(
    () => requestAppServer("thread/list", {}, optionsFor(child, { requestTimeoutMs: 20 })),
  )
})

test("rejects duplicate response IDs", async () => {
  const child = new FakeAppServerProcess({
    onRequest(request, process) {
      if (request.method === "initialize") {
        process.send({ id: request.id, result: {} })
      } else if (request.method === "thread/list") {
        process.send({ id: request.id, result: { data: [] } })
        queueMicrotask(() => process.send({ id: request.id, result: { data: [] } }))
      }
    },
  })

  await assertProtocolFailure(
    () => requestAppServer("thread/list", {}, optionsFor(child, { requestTimeoutMs: 20 })),
  )
})

test("rejects responses missing both result and error", async () => {
  const child = new FakeAppServerProcess({
    onRequest(request, process) {
      if (request.method === "initialize") {
        process.send({ id: request.id, result: {} })
      } else if (request.method === "thread/list") {
        process.send({ id: request.id })
      }
    },
  })

  await assertProtocolFailure(
    () => requestAppServer("thread/list", {}, optionsFor(child)),
  )
})

test("maps wire errors without serializing the bounded server message", async () => {
  const serverMessage = `thread does not exist ${"x".repeat(5_000)}`
  const child = new FakeAppServerProcess({
    onRequest(request, process) {
      if (request.method === "initialize") {
        process.send({ id: request.id, result: {} })
      } else if (request.method === "thread/read") {
        process.send({
          id: request.id,
          error: { code: -32001, message: serverMessage },
        })
      }
    },
  })

  await assert.rejects(
    () => requestAppServer("thread/read", {}, optionsFor(child)),
    (error) => {
      assert.ok(error instanceof AppServerProtocolError)
      assert.equal(error.details.serverCode, -32001)
      assert.equal(error.serverMessage.length <= 4_096, true)
      assert.equal(error.serverMessage.startsWith("thread does not exist"), true)
      assert.equal(Object.keys(error).includes("serverMessage"), false)
      assert.equal(JSON.stringify(error).includes("thread does not exist"), false)
      return true
    },
  )
})

test("settles startup timeout without hanging", { timeout: 1_000 }, async () => {
  const child = new FakeAppServerProcess({ autoSpawn: false })

  await assert.rejects(
    () => requestAppServer("thread/list", {}, optionsFor(child, {
      startupTimeoutMs: 5,
      shutdownTimeoutMs: 5,
    })),
    (error) => {
      assert.ok(error instanceof AppServerTimeoutError)
      assert.equal(error.code, "APP_SERVER_TIMEOUT")
      assert.deepEqual(error.details, {
        operation: "startup",
        timeoutMs: 5,
        stderrCaptured: false,
        stderrBytes: 0,
        stderrTruncated: false,
        stderrReason: null,
      })
      return true
    },
  )
})

test("settles request timeout without hanging", { timeout: 1_000 }, async () => {
  const child = new FakeAppServerProcess({
    onRequest(request, process) {
      if (request.method === "initialize") {
        process.send({ id: request.id, result: {} })
      }
    },
  })

  await assert.rejects(
    () => requestAppServer("thread/list", {}, optionsFor(child, {
      requestTimeoutMs: 5,
      shutdownTimeoutMs: 5,
    })),
    (error) => {
      assert.ok(error instanceof AppServerTimeoutError)
      assert.equal(error.code, "APP_SERVER_TIMEOUT")
      assert.equal(error.details.operation, "request")
      assert.equal(error.details.timeoutMs, 5)
      return true
    },
  )
})

test("settles shutdown timeout without hanging", { timeout: 1_000 }, async () => {
  const child = new FakeAppServerProcess({ closeOnStdinEnd: false })

  await assert.rejects(
    () => requestAppServer("thread/list", {}, optionsFor(child, {
      shutdownTimeoutMs: 5,
    })),
    (error) => {
      assert.ok(error instanceof AppServerTimeoutError)
      assert.equal(error.code, "APP_SERVER_TIMEOUT")
      assert.equal(error.details.operation, "shutdown")
      assert.equal(error.details.timeoutMs, 5)
      assert.equal(child.killed, true)
      return true
    },
  )
})

test("reports bounded classified stderr when the app-server exits early", async () => {
  const child = new FakeAppServerProcess({
    onRequest(request, process) {
      if (request.method === "initialize") {
        process.writeStderr("not authenticated: SECRET_PROMPT_CONTENT and more diagnostics")
        process.exit(1, null)
      }
    },
  })

  await assert.rejects(
    () => requestAppServer("thread/list", {}, optionsFor(child, { maxStderrBytes: 32 })),
    (error) => {
      assert.ok(error instanceof CodexUnavailableError)
      assert.equal(error.code, "CODEX_UNAVAILABLE")
      assert.equal(error.details.exitCode, 1)
      assert.equal(error.details.signal, null)
      assert.equal(error.details.stderrCaptured, true)
      assert.equal(error.details.stderrBytes, Buffer.byteLength(
        "not authenticated: SECRET_PROMPT_CONTENT and more diagnostics",
        "utf8",
      ))
      assert.equal(error.details.stderrTruncated, true)
      assert.equal(error.details.stderrReason, "authentication-required")
      assert.equal(Object.prototype.hasOwnProperty.call(error.details, "stderr"), false)
      assert.equal(error.message.includes("SECRET_PROMPT_CONTENT"), false)
      assert.equal(JSON.stringify(error).includes("SECRET_PROMPT_CONTENT"), false)
      return true
    },
  )
})

test("does not expose raw stderr text for a clean process failure", async () => {
  const child = new FakeAppServerProcess({
    closeCode: 1,
    onRequest(request, process) {
      if (request.method === "initialize") {
        process.writeStderr("permission denied for SECRET_PATH")
        process.exit(1, null)
      }
    },
  })

  await assert.rejects(
    () => requestAppServer("thread/list", {}, optionsFor(child)),
    (error) => {
      assert.ok(error instanceof CodexUnavailableError)
      assert.equal(error.details.stderrReason, "permission-denied")
      assert.equal(error.details.stderrCaptured, true)
      assert.equal(JSON.stringify(error).includes("SECRET_PATH"), false)
      return true
    },
  )
})

test("createAppServerClient keeps the same read-only method boundary", async () => {
  const child = new FakeAppServerProcess()
  const client = createAppServerClient(optionsFor(child))

  await assert.rejects(
    () => client.request("thread/write", {}),
    (error) => {
      assert.equal(error.code, "APP_SERVER_PROTOCOL_ERROR")
      return true
    },
  )
  assert.equal(child.requests.length, 0)
})
