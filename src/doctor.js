import { spawn } from "node:child_process"

import { createAppServerClient, resolveCodexExecutable } from "./app-server.js"
import { EXIT_CODES } from "./errors.js"
import { VERSION } from "./version.js"

export const DOCTOR_SCHEMA_VERSION = "codex-thread.doctor.v1"
const MINIMUM_NODE = [22, 16, 0]

function check(ok, status, message, details = {}) {
  return { ok, status, message, details }
}

function nodeSupported(version = process.versions.node) {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parts[index] > MINIMUM_NODE[index]) return true
    if (parts[index] < MINIMUM_NODE[index]) return false
  }
  return true
}

function readCodexVersion(executable, { timeoutMs = 5_000, spawnProcess = spawn } = {}) {
  return new Promise((resolve) => {
    let output = ""
    let settled = false
    let child
    try {
      child = spawnProcess(executable, ["--version"], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      resolve(null)
      return
    }

    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    child.stdout?.on("data", (chunk) => {
      if (output.length < 4_096) output += String(chunk)
    })
    child.on("error", () => finish(null))
    child.on("close", (code) => finish(code === 0 ? output.trim() || null : null))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        finish(null)
        return
      }
      finish(null)
    }, timeoutMs)
  })
}

function appServerVersion(initialize) {
  for (const value of [initialize?.serverVersion, initialize?.version, initialize?.userAgent]) {
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return null
}

export async function inspectInstallation(options = {}) {
  const warnings = []
  const runtimeVersion = process.versions.node
  const nodeOk = nodeSupported(runtimeVersion)
  const checks = {
    node: check(
      nodeOk,
      nodeOk ? "ok" : "unsupported",
      nodeOk ? "Node.js meets the minimum version." : "Node.js 22.16 or newer is required.",
      { version: runtimeVersion, minimum: "22.16.0" },
    ),
    codex: check(false, "missing", "The Codex executable was not found."),
    appServer: check(false, "not-run", "Codex app-server was not started."),
    initialize: check(false, "not-run", "The initialize handshake was not run."),
    methods: check(false, "not-run", "Stable read methods were not checked."),
  }
  const versions = { package: VERSION, codex: null, appServer: null }

  let executable
  try {
    executable = resolveCodexExecutable(options.appServer)
    checks.codex = check(true, "ok", "The Codex executable is available.", { path: executable })
    versions.codex = await readCodexVersion(executable, options.versionCheck)
  } catch (error) {
    checks.codex = check(false, "missing", "The Codex executable is unavailable.", {
      reason: error.code ?? "CODEX_UNAVAILABLE",
    })
  }

  if (executable) {
    const appServer = options.appServerClient ?? createAppServerClient({
      ...options.appServer,
      codexPath: executable,
    })
    try {
      await appServer.withSession(async (session, context) => {
        checks.appServer = check(true, "ok", "Codex app-server started.")
        checks.initialize = check(true, "ok", "The app-server initialize handshake succeeded.")
        versions.appServer = appServerVersion(context.initialize)

        const listed = await session.listThreads({ limit: 1, sortKey: "updated_at" })
        if (!Array.isArray(listed?.data)) throw new Error("thread/list returned an invalid result")
        if (listed.data.length === 0) {
          checks.methods = check(
            true,
            "partial",
            "thread/list works. thread/read could not be checked because no thread exists.",
            { threadList: true, threadRead: null },
          )
          warnings.push({
            code: "THREAD_READ_NOT_CHECKED",
            message: "No thread was available for a metadata-only thread/read check.",
          })
          return
        }

        const read = await session.readThread(listed.data[0].id, { includeTurns: false })
        if (!read?.thread) throw new Error("thread/read returned an invalid result")
        checks.methods = check(true, "ok", "Stable thread/list and thread/read methods work.", {
          threadList: true,
          threadRead: true,
        })
      })
    } catch (error) {
      if (!checks.appServer.ok && error.code === "CODEX_UNAVAILABLE") {
        checks.appServer = check(false, "failed", "Codex app-server did not start.", {
          reason: error.code,
        })
      } else if (!checks.appServer.ok) {
        checks.appServer = check(true, "ok", "Codex app-server started.")
      }
      if (checks.appServer.ok && !checks.initialize.ok) {
        checks.initialize = check(false, "failed", "The app-server initialize handshake failed.", {
          reason: error.code ?? "APP_SERVER_ERROR",
        })
      } else if (checks.initialize.ok) {
        checks.methods = check(false, "failed", "A stable read method failed.", {
          reason: error.code ?? "APP_SERVER_ERROR",
        })
      }
    }
  }

  const healthy = Object.values(checks).every((item) => item.ok)
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    toolVersion: VERSION,
    runtimeVersion,
    checks,
    versions,
    healthy,
    status: healthy ? "ok" : "error",
    warnings,
  }
}

export function doctorExitCode(report) {
  return report.healthy ? EXIT_CODES.SUCCESS : EXIT_CODES.CODEX_UNAVAILABLE
}

export function formatDoctorHuman(report) {
  const lines = ["codex-thread doctor", "===================", ""]
  for (const [name, result] of Object.entries(report.checks)) {
    lines.push(`${result.ok ? "OK" : "FAIL"} ${name}: ${result.message}`)
  }
  lines.push("", `Package: ${report.versions.package}`)
  lines.push(`Node.js: ${report.runtimeVersion}`)
  lines.push(`Codex: ${report.versions.codex ?? "unknown"}`)
  lines.push(`App-server: ${report.versions.appServer ?? "unknown"}`)
  for (const warning of report.warnings) lines.push(`Warning: ${warning.message}`)
  return `${lines.join("\n")}\n`
}
