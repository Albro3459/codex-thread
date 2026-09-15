export const ERROR_SCHEMA_VERSION = "codex-thread.error.v1"

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  UNEXPECTED_FAILURE: 1,
  NOT_FOUND: 2,
  INVALID_ARGUMENTS: 3,
  CODEX_UNAVAILABLE: 4,
})

export class CodexThreadError extends Error {
  constructor(message, {
    code = "CODEX_THREAD_ERROR",
    exitCode = EXIT_CODES.UNEXPECTED_FAILURE,
    details = {},
    cause,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "CodexThreadError"
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }

  toJSON() {
    return serializeError(this)
  }
}

export class InvalidArgumentsError extends CodexThreadError {
  constructor(message, details = {}) {
    super(message, {
      code: "INVALID_ARGUMENTS",
      exitCode: EXIT_CODES.INVALID_ARGUMENTS,
      details,
    })
    this.name = "InvalidArgumentsError"
  }
}

export class UnknownCommandError extends InvalidArgumentsError {
  constructor(command) {
    super(`Unknown command: ${command}`, { command })
    this.name = "UnknownCommandError"
    this.code = "UNKNOWN_COMMAND"
  }
}

export class ThreadNotFoundError extends CodexThreadError {
  constructor(threadId, details = {}) {
    super("No Codex thread matched the supplied ID.", {
      code: "THREAD_NOT_FOUND",
      exitCode: EXIT_CODES.NOT_FOUND,
      details: { threadId, ...details },
    })
    this.name = "ThreadNotFoundError"
  }
}

export class TurnNotFoundError extends CodexThreadError {
  constructor(threadId, turnId) {
    super("The thread does not contain the supplied turn ID.", {
      code: "TURN_NOT_FOUND",
      exitCode: EXIT_CODES.NOT_FOUND,
      details: { threadId, turnId },
    })
    this.name = "TurnNotFoundError"
  }
}

export class AppServerError extends CodexThreadError {
  constructor(message, details = {}, cause) {
    super(message, {
      code: "APP_SERVER_ERROR",
      exitCode: EXIT_CODES.CODEX_UNAVAILABLE,
      details,
      cause,
    })
    this.name = "AppServerError"
  }
}

export class CodexUnavailableError extends AppServerError {
  constructor(message, details = {}, cause) {
    super(message, details, cause)
    this.name = "CodexUnavailableError"
    this.code = "CODEX_UNAVAILABLE"
  }
}

export class AppServerProtocolError extends AppServerError {
  constructor(message, details = {}, cause) {
    super(message, details, cause)
    this.name = "AppServerProtocolError"
    this.code = "APP_SERVER_PROTOCOL_ERROR"
  }
}

export class AppServerTimeoutError extends AppServerError {
  constructor(operation, timeoutMs) {
    super(`Codex app-server ${operation} timed out.`, { operation, timeoutMs })
    this.name = "AppServerTimeoutError"
    this.code = "APP_SERVER_TIMEOUT"
  }
}

export class UnsupportedHistoryError extends AppServerError {
  constructor(threadId) {
    super("This Codex thread uses paginated history, which cannot be read through stable APIs.", {
      threadId,
      requiredMethods: ["thread/turns/list", "thread/items/list"],
      experimentalApiRequired: true,
    })
    this.name = "UnsupportedHistoryError"
    this.code = "PAGINATED_HISTORY_UNSUPPORTED"
  }
}

export class SkillInstallationError extends CodexThreadError {
  constructor(message, details = {}, cause) {
    super(message, {
      code: "SKILL_INSTALL_FAILED",
      exitCode: EXIT_CODES.INVALID_ARGUMENTS,
      details,
      cause,
    })
    this.name = "SkillInstallationError"
  }
}

export function isCodexThreadError(error) {
  return error instanceof CodexThreadError
}

export function toCodexThreadError(error) {
  if (isCodexThreadError(error)) return error
  if (error instanceof Error) {
    return new CodexThreadError(error.message, { cause: error })
  }
  return new CodexThreadError(String(error))
}

export function serializeError(error) {
  const normalized = toCodexThreadError(error)
  return {
    schemaVersion: ERROR_SCHEMA_VERSION,
    code: normalized.code,
    message: normalized.message,
    details: normalized.details,
  }
}
