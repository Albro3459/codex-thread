import { InvalidArgumentsError } from "./errors.js"

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u

export function parseThreadReference(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidArgumentsError("thread reference must be a non-empty string.", {
      field: "threadReference",
      value,
    })
  }

  const reference = value.trim()
  if (reference.startsWith("codex:")) {
    let parsed
    try {
      parsed = new URL(reference)
    } catch {
      throw new InvalidArgumentsError("Codex deep link is malformed.", {
        field: "threadReference",
        value,
      })
    }

    const parts = parsed.pathname.split("/").filter(Boolean)
    if (parsed.protocol !== "codex:" || parsed.hostname !== "threads" || parts.length !== 1) {
      throw new InvalidArgumentsError("Codex deep link must use codex://threads/<thread-id>.", {
        field: "threadReference",
        value,
      })
    }
    if (parsed.search || parsed.hash) {
      throw new InvalidArgumentsError("Codex deep link cannot contain a query or fragment.", {
        field: "threadReference",
        value,
      })
    }
    return validateThreadId(decodeURIComponent(parts[0]))
  }

  return validateThreadId(reference)
}

export function validateThreadId(value) {
  if (typeof value !== "string" || !THREAD_ID.test(value)) {
    throw new InvalidArgumentsError("thread ID must be path-safe.", {
      field: "threadId",
      value,
    })
  }
  return value
}
