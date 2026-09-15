import { InvalidArgumentsError } from "./errors.js"

export const TAIL_SCHEMA_VERSION = "codex-thread.tail-record.v1"
export const DEFAULT_TAIL_INTERVAL_MS = 1_000
export const MIN_TAIL_INTERVAL_MS = 100
export const MAX_TAIL_INTERVAL_MS = 60_000

function isUnset(value) {
  return value === undefined || value === null || value === ""
}

function booleanOption(value, field, fallback = false) {
  if (isUnset(value)) return fallback
  if (typeof value !== "boolean") {
    throw new InvalidArgumentsError(`${field} must be a boolean.`, { field, value })
  }
  return value
}

function positiveInteger(value, field) {
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    value = Number.parseInt(value.trim(), 10)
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidArgumentsError(`${field} must be a positive integer.`, { field, value })
  }
  return value
}

function optionalPositiveInteger(value, field) {
  return isUnset(value) ? null : positiveInteger(value, field)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function equalValues(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function identity(record) {
  if (record.recordType === "thread") return `thread:${record.threadId}`
  if (record.recordType === "turn") return `turn:${record.data.id ?? record.turnId ?? record.cycle}`
  if (record.recordType === "message" || record.recordType === "activity") {
    const id = record.data.id
    if (id !== null && id !== undefined) return `${record.recordType}:${id}`
    const turnId = record.data.turnId ?? record.turnId ?? "unknown"
    const kind = record.data.kind ?? "message"
    return `${record.recordType}:${turnId}:${kind}:${record.data.sequence ?? 0}`
  }
  return record.recordType
}

function dataForComparison(record) {
  if (record.recordType !== "runtime") return record.data
  if (!record.data || typeof record.data !== "object") return record.data
  const { observedAt, ...runtime } = record.data
  return runtime
}

function tailRecord({ op, recordType, threadId, observedAt, cycle, data }) {
  return {
    schemaVersion: TAIL_SCHEMA_VERSION,
    op,
    recordType,
    threadId,
    observedAt,
    cycle,
    data,
  }
}

function selectedEnvelope(envelope, turnLimit) {
  if (turnLimit === null || !Array.isArray(envelope.turns)) return envelope

  const turns = envelope.turns.slice(-turnLimit)
  const selectedIds = new Set(turns.map((turn) => turn.id))
  return {
    ...envelope,
    turns,
    messages: (envelope.messages ?? []).filter((message) => selectedIds.has(message.turnId)),
    activities: (envelope.activities ?? []).filter((activity) => selectedIds.has(activity.turnId)),
    selection: {
      kind: "turn-window",
      turnId: null,
      turnLimit,
      turnOffset: 0,
      totalTurns: envelope.turns.length,
      selectedTurnIds: turns.map((turn) => turn.id),
    },
  }
}

function snapshotRecords(envelope, threadId, observedAt, cycle) {
  const records = []
  records.push(tailRecord({
    op: "upsert",
    recordType: "thread",
    threadId,
    observedAt,
    cycle,
    data: envelope.thread,
  }))

  for (const turn of envelope.turns ?? []) {
    records.push(tailRecord({
      op: "upsert",
      recordType: "turn",
      threadId,
      observedAt,
      cycle,
      data: turn,
    }))
    const items = [
      ...(envelope.messages ?? []).filter((message) => message.turnId === turn.id)
        .map((message) => ({ recordType: "message", sequence: message.sequence, data: message })),
      ...(envelope.activities ?? []).filter((activity) => activity.turnId === turn.id)
        .map((activity) => ({ recordType: "activity", sequence: activity.sequence, data: activity })),
    ].sort((left, right) => left.sequence - right.sequence)
    for (const item of items) {
      records.push(tailRecord({
        op: "upsert",
        recordType: item.recordType,
        threadId,
        observedAt,
        cycle,
        data: item.data,
      }))
    }
  }

  records.push(tailRecord({
    op: "runtime",
    recordType: "runtime",
    threadId,
    observedAt,
    cycle,
    data: {
      ...(envelope.runtime ?? {}),
      warnings: envelope.warnings ?? [],
      selection: envelope.selection ?? null,
    },
  }))
  return records
}

function isNotFound(error) {
  return error?.code === "THREAD_NOT_FOUND" || error?.name === "ThreadNotFoundError"
}

function waitFor(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export function normalizeTailOptions(options = {}) {
  const once = booleanOption(options.once, "once")
  const rawInterval = options.interval ?? options.intervalMs
  const hasInterval = !isUnset(rawInterval) || options.seen?.has?.("interval") === true
  const intervalMs = isUnset(rawInterval)
    ? DEFAULT_TAIL_INTERVAL_MS
    : positiveInteger(rawInterval, "interval")
  if (intervalMs < MIN_TAIL_INTERVAL_MS || intervalMs > MAX_TAIL_INTERVAL_MS) {
    throw new InvalidArgumentsError(
      `interval must be between ${MIN_TAIL_INTERVAL_MS} and ${MAX_TAIL_INTERVAL_MS} milliseconds.`,
      { field: "interval", value: rawInterval },
    )
  }

  const maxCycles = optionalPositiveInteger(options.maxCycles, "maxCycles")
  const rawTimeout = options.timeout ?? options.timeoutMs
  const timeoutMs = optionalPositiveInteger(rawTimeout, "timeout")
  const turnLimit = optionalPositiveInteger(options.turnLimit, "turnLimit")
  const format = options.format ?? "jsonl"
  if (!["json", "jsonl"].includes(format)) {
    throw new InvalidArgumentsError("tail format must be json or jsonl.", {
      field: "format",
      value: format,
    })
  }
  if (once && (hasInterval || maxCycles !== null || timeoutMs !== null)) {
    throw new InvalidArgumentsError("once cannot be combined with interval, maxCycles, or timeout.", {
      field: "once",
    })
  }
  if (format === "json" && !once && maxCycles === null && timeoutMs === null) {
    throw new InvalidArgumentsError(
      "json tail output requires once, maxCycles, or timeout.",
      { field: "format" },
    )
  }

  return Object.freeze({ once, intervalMs, maxCycles, timeoutMs, turnLimit, format })
}

function completionReason(options, cycle, elapsed) {
  if (options.once) return "once"
  if (options.maxCycles !== null && cycle >= options.maxCycles) return "max-cycles"
  if (options.timeoutMs !== null && elapsed >= options.timeoutMs) return "timeout"
  return null
}

export async function* tailThread({
  threadId,
  readSnapshot,
  options = {},
  now = Date.now,
  sleep = waitFor,
  signal,
} = {}) {
  if (typeof readSnapshot !== "function") {
    throw new InvalidArgumentsError("readSnapshot must be a function.", { field: "readSnapshot" })
  }
  if (typeof threadId !== "string" || threadId.trim() === "") {
    throw new InvalidArgumentsError("threadId must be a non-empty string.", { field: "threadId" })
  }
  const normalizedOptions = normalizeTailOptions(options)
  const startedAt = now()
  let cycle = 0
  let previous = new Map()
  let ended = false

  const finish = (reason) => {
    if (ended) return null
    ended = true
    return tailRecord({
      op: "end",
      recordType: "end",
      threadId,
      observedAt: new Date(now()).toISOString(),
      cycle,
      data: { reason, attemptedCycles: cycle },
    })
  }

  while (true) {
    if (signal?.aborted) {
      yield finish("interrupt")
      return
    }
    if (normalizedOptions.timeoutMs !== null && now() - startedAt >= normalizedOptions.timeoutMs) {
      yield finish("timeout")
      return
    }

    cycle += 1
    let envelope
    try {
      envelope = await readSnapshot({
        threadId,
        cycle,
        turnLimit: normalizedOptions.turnLimit,
      })
    } catch (error) {
      if (isNotFound(error)) {
        if (cycle === 1) throw error
        yield finish("thread-not-found")
        return
      }
      throw error
    }
    const observedAt = envelope.runtime?.observedAt ?? new Date(now()).toISOString()
    const selected = selectedEnvelope(envelope, normalizedOptions.turnLimit)
    const records = snapshotRecords(selected, threadId, observedAt, cycle)
    const current = new Map(records.map((record) => [identity(record), record]))
    for (const record of records) {
      const key = identity(record)
      const before = previous.get(key)
      const changed = !before || !equalValues(dataForComparison(before), dataForComparison(record))
      if (changed) yield record
    }
    previous = current

    const reason = completionReason(normalizedOptions, cycle, now() - startedAt)
    if (reason) {
      yield finish(reason)
      return
    }

    if (signal?.aborted) {
      yield finish("interrupt")
      return
    }
    let waitMs = normalizedOptions.intervalMs
    if (normalizedOptions.timeoutMs !== null) {
      waitMs = Math.min(waitMs, Math.max(0, normalizedOptions.timeoutMs - (now() - startedAt)))
    }
    await sleep(waitMs, signal)
  }
}

export { snapshotRecords }
