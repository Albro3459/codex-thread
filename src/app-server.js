import fs from "node:fs"
import path from "node:path"
import { spawn as nodeSpawn } from "node:child_process"

import {
  AppServerError,
  AppServerProtocolError,
  AppServerTimeoutError,
  CodexUnavailableError,
} from "./errors.js"
import { VERSION } from "./version.js"

export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
export const DEFAULT_MAX_STDERR_BYTES = 16 * 1024

export const TOP_LEVEL_SOURCE_KINDS = Object.freeze([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
])

export const SUBAGENT_SOURCE_KINDS = Object.freeze([
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
])

export const READ_METHODS = Object.freeze(new Set(["thread/list", "thread/read"]))

function positiveTimeout(value, fallback, field) {
  if (value === undefined) {
    return fallback
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(field + " must be a positive finite number.")
  }

  return value
}

function positiveByteLimit(value, fallback, field) {
  if (value === undefined) {
    return fallback
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(field + " must be a positive integer.")
  }

  return value
}

function boundedText(value, maxBytes) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value)
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text
  }

  const marker = "…"
  const markerBytes = Buffer.byteLength(marker, "utf8")
  if (maxBytes <= markerBytes) {
    return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")
  }
  return Buffer.from(text, "utf8").subarray(0, maxBytes - markerBytes).toString("utf8") + marker
}

function responseIdKey(id) {
  return typeof id + ":" + String(id)
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function protocolErrorMessage(error) {
  if (!isObject(error)) {
    return "Codex app-server returned an error response."
  }

  if (typeof error.message === "string" && error.message.length > 0) {
    return "Codex app-server rejected the request: " + boundedText(error.message, 4_096)
  }

  return "Codex app-server returned an error response."
}

function protocolErrorDetails(error) {
  if (!isObject(error)) {
    return { error: boundedText(JSON.stringify(error), 4_096) }
  }

  const details = {}
  if (typeof error.code === "number" || typeof error.code === "string") {
    details.serverCode = error.code
  }
  if (typeof error.message === "string") {
    details.serverMessage = boundedText(error.message, 4_096)
  }
  return details
}

function pathCandidates(command, env, platform) {
  const pathValue = env.PATH || ""
  const entries = pathValue.split(path.delimiter)
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""]

  return entries.flatMap((entry) => extensions.map((extension) => {
    const directory = entry || "."
    return path.join(directory, command + extension)
  }))
}

export function resolveCodexExecutable({ codexPath, env = process.env, platform = process.platform } = {}) {
  if (codexPath !== undefined) {
    if (typeof codexPath !== "string" || codexPath.trim() === "") {
      throw new CodexUnavailableError("The configured Codex executable is invalid.", {
        field: "codexPath",
      })
    }
    return codexPath
  }

  for (const candidate of pathCandidates("codex", env, platform)) {
    try {
      const stats = fs.statSync(candidate)
      if (stats.isFile() && fs.accessSync(candidate, fs.constants.X_OK) === undefined) {
        return path.resolve(candidate)
      }
    } catch {
      continue
    }
  }

  throw new CodexUnavailableError("The Codex executable was not found on PATH.", {
    command: "codex",
  })
}

function createInitializeParams({ toolVersion = VERSION, clientInfo = {} } = {}) {
  return {
    clientInfo: {
      name: "codex-thread",
      title: "codex-thread",
      version: toolVersion,
      ...clientInfo,
    },
    capabilities: {},
  }
}

function closeStdin(child) {
  if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
    return
  }

  try {
    child.stdin.end()
  } catch {
    // The process may have closed stdin while a response was being handled
  }
}

class AppServerSession {
  constructor(options = {}) {
    this.options = options
    this.startupTimeoutMs = positiveTimeout(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs",
    )
    this.requestTimeoutMs = positiveTimeout(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    )
    this.shutdownTimeoutMs = positiveTimeout(
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "shutdownTimeoutMs",
    )
    this.maxStderrBytes = positiveByteLimit(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      "maxStderrBytes",
    )
    this.spawnProcess = options.spawnProcess || nodeSpawn
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.seenResponseIds = new Set()
    this.stdoutBuffer = ""
    this.stderr = ""
    this.started = false
    this.closing = false
    this.closed = false
    this.failure = null
    this.startupPromise = null
    this.closePromise = null
  }

  async run(method, params) {
    if (!READ_METHODS.has(method)) {
      throw new AppServerProtocolError("Only stable read methods are available through this client.", {
        method,
      })
    }

    let result
    let failure = null
    try {
      await this.start()
      await this.request("initialize", createInitializeParams(this.options), this.startupTimeoutMs, "startup")
      this.write({ method: "initialized" })
      result = await this.request(method, params, this.requestTimeoutMs, "request")
    } catch (error) {
      failure = error
    }

    failure ||= this.failure
    try {
      await this.close()
    } catch (error) {
      failure ||= error
    }
    failure ||= this.failure

    if (failure) {
      throw failure
    }

    return result
  }

  async start() {
    if (this.child) {
      return
    }

    let executable
    try {
      executable = resolveCodexExecutable(this.options)
      this.child = this.spawnProcess(executable, ["app-server"], {
        ...(this.options.spawnOptions || {}),
        env: this.options.env || process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      if (error instanceof AppServerError) {
        throw error
      }
      throw new CodexUnavailableError("Failed to start the Codex app-server.", {
        command: executable ? executable + " app-server" : "codex app-server",
        reason: error instanceof Error ? error.message : String(error),
      }, error)
    }

    this.attachListeners()
    this.startupPromise = new Promise((resolve, reject) => {
      this.resolveStartup = resolve
      this.rejectStartup = reject
    })
    const timer = setTimeout(() => {
      this.fail(new AppServerTimeoutError("startup", this.startupTimeoutMs))
    }, this.startupTimeoutMs)

    try {
      await this.startupPromise
    } finally {
      clearTimeout(timer)
    }
  }

  attachListeners() {
    const child = this.child
    child.once("spawn", () => {
      this.started = true
      this.resolveStartup?.()
    })
    child.once("error", (error) => {
      const unavailable = error?.code === "ENOENT" || error?.code === "EACCES"
      this.fail(unavailable
        ? new CodexUnavailableError("The Codex app-server could not be started.", {
          reason: error.code,
        }, error)
        : new AppServerError("The Codex app-server process failed.", {
          reason: error instanceof Error ? error.message : String(error),
        }, error))
    })
    child.once("close", (code, signal) => {
      if (this.stdoutBuffer.trim() !== "") {
        const trailing = this.stdoutBuffer
        this.stdoutBuffer = ""
        this.consumeLine(trailing)
      }
      this.closed = true
      if (this.closing) {
        this.resolveClose?.({ code, signal })
        return
      }

      this.fail(new CodexUnavailableError("The Codex app-server exited before completing the request.", {
        exitCode: code,
        signal: signal || null,
        stderr: this.stderr || null,
      }))
    })
    child.stdout?.on("data", (chunk) => this.consumeStdout(chunk))
    child.stdout?.on("error", (error) => {
      this.fail(new AppServerProtocolError("The Codex app-server stdout stream failed.", {}, error))
    })
    child.stderr?.on("data", (chunk) => {
      this.stderr = boundedText(
        this.stderr + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk),
        this.maxStderrBytes,
      )
    })
    child.stderr?.on("error", () => {})
    child.stdin?.on("error", (error) => {
      if (!this.closing) {
        this.fail(new CodexUnavailableError("The Codex app-server stdin stream failed.", {
          reason: error instanceof Error ? error.message : String(error),
        }, error))
      }
    })
  }

  consumeStdout(chunk) {
    if (this.failure) {
      return
    }

    this.stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    let newlineIndex = this.stdoutBuffer.indexOf("\n")
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, "")
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line.trim() !== "") {
        this.consumeLine(line)
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n")
    }
  }

  consumeLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      this.fail(new AppServerProtocolError("Codex app-server emitted malformed JSON.", {
        reason: error instanceof Error ? error.message : String(error),
      }, error))
      return
    }

    if (!isObject(message)) {
      this.fail(new AppServerProtocolError("Codex app-server emitted a non-object message."))
      return
    }

    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      return
    }

    const idKey = responseIdKey(message.id)
    if (this.seenResponseIds.has(idKey)) {
      this.fail(new AppServerProtocolError("Codex app-server emitted a duplicate response ID.", {
        id: message.id,
      }))
      return
    }
    this.seenResponseIds.add(idKey)

    const pending = this.pending.get(idKey)
    if (!pending) {
      this.fail(new AppServerProtocolError("Codex app-server emitted an unknown response ID.", {
        id: message.id,
      }))
      return
    }
    this.pending.delete(idKey)

    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      pending.reject(new AppServerProtocolError(
        protocolErrorMessage(message.error),
        protocolErrorDetails(message.error),
      ))
      return
    }

    if (!Object.prototype.hasOwnProperty.call(message, "result")) {
      pending.reject(new AppServerProtocolError("Codex app-server response had neither result nor error.", {
        id: message.id,
      }))
      return
    }

    pending.resolve(message.result)
  }

  write(message) {
    if (!this.child?.stdin || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      throw new CodexUnavailableError("The Codex app-server stdin stream is closed.", {
        stderr: this.stderr || null,
      })
    }

    let serialized
    try {
      serialized = JSON.stringify(message) + "\n"
    } catch (error) {
      throw new AppServerProtocolError("The app-server request could not be serialized.", {}, error)
    }

    try {
      this.child.stdin.write(serialized)
    } catch (error) {
      throw new CodexUnavailableError("The Codex app-server stdin stream failed.", {
        reason: error instanceof Error ? error.message : String(error),
      }, error)
    }
  }

  request(method, params, timeoutMs, operation) {
    const id = this.nextId
    this.nextId += 1
    const key = responseIdKey(id)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        const error = new AppServerTimeoutError(operation, timeoutMs)
        reject(error)
        this.fail(error)
      }, timeoutMs)
      this.pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })

      try {
        this.write({ id, method, params })
      } catch (error) {
        this.pending.delete(key)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  fail(error) {
    if (this.failure) {
      return
    }
    this.failure = error
    this.rejectStartup?.(error)
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }

  async close() {
    if (!this.child || this.closed) {
      return
    }
    this.closing = true
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve
    })
    closeStdin(this.child)
    const timer = setTimeout(() => {
      if (!this.closed) {
        try {
          this.child.kill()
        } catch {
          // The process may have exited between the check and kill
        }
        this.resolveClose?.({ code: null, signal: "SIGTERM" })
      }
    }, this.shutdownTimeoutMs)

    try {
      const status = await this.closePromise
      if (!this.closed) {
        throw new AppServerTimeoutError("shutdown", this.shutdownTimeoutMs)
      }
      if (status.code !== 0 || status.signal !== null) {
        throw new CodexUnavailableError("The Codex app-server exited unsuccessfully.", {
          exitCode: status.code,
          signal: status.signal,
          stderr: this.stderr || null,
        })
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export async function requestAppServer(method, params = {}, options = {}) {
  return new AppServerSession(options).run(method, params)
}

export function createAppServerClient(options = {}) {
  return Object.freeze({
    request(method, params = {}) {
      return requestAppServer(method, params, options)
    },
    listThreads(params = {}) {
      const { includeSubagents, ...wireParams } = params
      if (wireParams.sourceKinds === undefined) {
        wireParams.sourceKinds = includeSubagents
          ? [...TOP_LEVEL_SOURCE_KINDS, ...SUBAGENT_SOURCE_KINDS]
          : [...TOP_LEVEL_SOURCE_KINDS]
      }
      return requestAppServer("thread/list", wireParams, options)
    },
    readThread(threadId, params = {}) {
      return requestAppServer("thread/read", {
        ...params,
        threadId,
        includeTurns: true,
      }, options)
    },
  })
}

export { AppServerSession }
export {
  AppServerError,
  AppServerProtocolError,
  AppServerTimeoutError,
  CodexUnavailableError,
}
