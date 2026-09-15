import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"

import {
  AppServerProtocolError,
  CodexUnavailableError,
  EXIT_CODES,
} from "../src/errors.js"
import { doctorExitCode, inspectInstallation } from "../src/doctor.js"

function versionProcess(output = "codex-cli 1.2.3\n", code = 0) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.kill = () => {}
  process.nextTick(() => {
    child.stdout.end(output)
    child.emit("close", code)
  })
  return child
}

function protocolError(message, serverCode = -32000) {
  const error = new AppServerProtocolError("Codex app-server rejected the request.", {
    serverCode,
  })
  Object.defineProperty(error, "serverMessage", { value: message })
  return error
}

function options(appServerClient) {
  return {
    appServer: { codexPath: "/fake/codex" },
    appServerClient,
    versionCheck: { spawnProcess: () => versionProcess() },
  }
}

test("reports a healthy installation after checking both stable methods", async () => {
  const report = await inspectInstallation(options({
    async withSession(operation) {
      return operation({
        async listThreads() {
          return { data: [{ id: "thread-1" }] }
        },
        async readThread(id, params) {
          assert.equal(id, "thread-1")
          assert.deepEqual(params, { includeTurns: false })
          return { thread: { id } }
        },
      }, { initialize: { serverVersion: "app-server 2.0" } })
    },
  }))

  assert.equal(report.healthy, true)
  assert.equal(report.status, "ok")
  assert.equal(report.checks.methods.ok, true)
  assert.equal(report.versions.codex, "codex-cli 1.2.3")
  assert.equal(report.versions.appServer, "app-server 2.0")
  assert.equal(doctorExitCode(report), EXIT_CODES.SUCCESS)
})

test("accepts a missing-thread error as proof that thread/read exists", async () => {
  const report = await inspectInstallation(options({
    async withSession(operation) {
      return operation({
        async listThreads() {
          return { data: [] }
        },
        async readThread(id) {
          assert.equal(id, "00000000-0000-7000-8000-000000000000")
          throw protocolError("Thread not found")
        },
      }, { initialize: {} })
    },
  }))

  assert.equal(report.healthy, true)
  assert.equal(report.checks.methods.details.threadReadProbe, "missing-thread")
})

test("keeps installation failures in a complete transcript-free report", async () => {
  const cases = [
    {
      name: "missing executable",
      options: { appServer: { env: { PATH: "" } } },
      failedCheck: "codex",
    },
    {
      name: "initialization failure",
      options: options({
        async withSession() {
          throw new AppServerProtocolError("initialize failed")
        },
      }),
      failedCheck: "initialize",
    },
    {
      name: "stable method failure",
      options: options({
        async withSession(operation) {
          return operation({
            async listThreads() {
              throw protocolError("thread/list failed SECRET_TRANSCRIPT_CONTENT")
            },
          }, { initialize: {} })
        },
      }),
      failedCheck: "methods",
    },
    {
      name: "app-server unavailable",
      options: options({
        async withSession() {
          throw new CodexUnavailableError("app-server unavailable")
        },
      }),
      failedCheck: "appServer",
    },
  ]

  for (const entry of cases) {
    const report = await inspectInstallation(entry.options)
    assert.equal(report.healthy, false, entry.name)
    assert.equal(report.status, "error", entry.name)
    assert.equal(report.checks[entry.failedCheck].ok, false, entry.name)
    assert.equal(doctorExitCode(report), EXIT_CODES.CODEX_UNAVAILABLE, entry.name)
    assert.deepEqual(Object.keys(report.checks), [
      "node",
      "codex",
      "appServer",
      "initialize",
      "methods",
    ])
    assert.equal(JSON.stringify(report).includes("SECRET_TRANSCRIPT_CONTENT"), false, entry.name)
  }
})

test("maps an unsupported Node report to the unexpected failure exit code", () => {
  assert.equal(doctorExitCode({
    healthy: false,
    checks: { node: { ok: false } },
  }), EXIT_CODES.UNEXPECTED_FAILURE)
})
