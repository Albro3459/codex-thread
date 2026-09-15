import { InvalidArgumentsError } from "./errors.js"

export const DEFAULT_LIST_LIMIT = 50
export const DEFAULT_TURN_LIMIT = 1

const DIGITS = /^\d+$/u

function isUnset(value) {
  return value === undefined || value === null || value === ""
}

export function normalizeCount(value, field, fallback) {
  if (isUnset(value)) return fallback

  if (typeof value === "string") {
    if (!DIGITS.test(value.trim())) {
      throw new InvalidArgumentsError(`${field} must be a non-negative integer.`, { field, value })
    }
    const count = Number.parseInt(value.trim(), 10)
    if (!Number.isSafeInteger(count)) {
      throw new InvalidArgumentsError(`${field} must be a safe integer.`, { field, value })
    }
    return count
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidArgumentsError(`${field} must be a non-negative integer.`, { field, value })
  }
  return value
}

export function normalizePositiveCount(value, field, fallback) {
  const count = normalizeCount(value, field, fallback)
  if (count < 1) {
    throw new InvalidArgumentsError(`${field} must be a positive integer.`, { field, value })
  }
  return count
}

function normalizeFlag(value, field) {
  if (isUnset(value)) return false
  if (typeof value !== "boolean") {
    throw new InvalidArgumentsError(`${field} must be a boolean.`, { field, value })
  }
  return value
}

export function normalizeListOptions(options = {}) {
  const limit = normalizePositiveCount(options.limit, "limit", DEFAULT_LIST_LIMIT)
  const offset = normalizeCount(options.offset, "offset", 0)
  if (offset > Number.MAX_SAFE_INTEGER - limit - 1) {
    throw new InvalidArgumentsError("offset and limit are too large when combined.", {
      fields: ["offset", "limit"],
      offset,
      limit,
    })
  }

  return Object.freeze({
    limit,
    offset,
    reverse: normalizeFlag(options.reverse, "reverse"),
    archived: normalizeFlag(options.archived, "archived"),
    includeSubagents: normalizeFlag(options.includeSubagents, "includeSubagents"),
  })
}

export function normalizeFindOptions(options = {}) {
  if (typeof options.title !== "string" || options.title.trim() === "") {
    throw new InvalidArgumentsError("title must be a non-empty string.", {
      field: "title",
      value: options.title,
    })
  }

  return Object.freeze({
    title: options.title.trim(),
    reverse: normalizeFlag(options.reverse, "reverse"),
    archived: normalizeFlag(options.archived, "archived"),
    includeSubagents: normalizeFlag(options.includeSubagents, "includeSubagents"),
  })
}

export function normalizeTurnSelection(options = {}) {
  const lastTurn = normalizeFlag(options.lastTurn, "lastTurn")
  const hasWindow = !isUnset(options.turnLimit) || !isUnset(options.turnOffset)

  if (!isUnset(options.turnId)) {
    if (lastTurn || hasWindow) {
      throw new InvalidArgumentsError(
        "turnId cannot be combined with lastTurn, turnLimit, or turnOffset.",
        { field: "turnId" },
      )
    }
    if (typeof options.turnId !== "string" || options.turnId.trim() === "") {
      throw new InvalidArgumentsError("turnId must be a non-empty string.", {
        field: "turnId",
        value: options.turnId,
      })
    }
    return Object.freeze({ kind: "turn", turnId: options.turnId.trim() })
  }

  if (lastTurn && hasWindow) {
    throw new InvalidArgumentsError("lastTurn cannot be combined with turnLimit or turnOffset.", {
      field: "lastTurn",
    })
  }
  if (lastTurn) return Object.freeze({ kind: "turn-window", turnLimit: 1, turnOffset: 0 })
  if (!hasWindow) return null

  return Object.freeze({
    kind: "turn-window",
    turnLimit: normalizePositiveCount(options.turnLimit, "turnLimit", DEFAULT_TURN_LIMIT),
    turnOffset: normalizeCount(options.turnOffset, "turnOffset", 0),
  })
}
