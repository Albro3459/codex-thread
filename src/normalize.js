import { AppServerProtocolError } from "./errors.js"
import { VERSION } from "./version.js"

export const THREAD_SCHEMA_VERSION = "codex-thread.thread.v1"
export const LIST_SCHEMA_VERSION = "codex-thread.list.v1"
export const FIND_SCHEMA_VERSION = "codex-thread.find.v1"

const KNOWN_ITEM_TYPES = new Set([
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "functionCallOutput",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
])

const THREAD_FIELDS = new Set([
  "id",
  "sessionId",
  "forkedFromId",
  "parentThreadId",
  "preview",
  "ephemeral",
  "section",
  "projectId",
  "historyMode",
  "modelProvider",
  "model",
  "reasoningEffort",
  "createdAt",
  "updatedAt",
  "recencyAt",
  "status",
  "cwd",
  "cliVersion",
  "originator",
  "source",
  "agentNickname",
  "agentRole",
  "gitInfo",
  "name",
  "isPinned",
  "turns",
])

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function objectValue(value, field) {
  if (isObject(value)) return value
  throw new AppServerProtocolError("Codex app-server returned an invalid object.", {
    field,
    valueType: value === null ? "null" : typeof value,
  })
}

function stringOrNull(value, field) {
  if (value === null || value === undefined || typeof value === "string") return value ?? null
  throw new AppServerProtocolError("Codex app-server returned an invalid string field.", {
    field,
    valueType: typeof value,
  })
}

function booleanOrNull(value, field) {
  if (value === null || value === undefined || typeof value === "boolean") return value ?? null
  throw new AppServerProtocolError("Codex app-server returned an invalid boolean field.", {
    field,
    valueType: typeof value,
  })
}

function finiteNumberOrNull(value, field) {
  if (value === null || value === undefined) return null
  if (typeof value === "number" && Number.isFinite(value)) return value
  throw new AppServerProtocolError("Codex app-server returned an invalid number field.", {
    field,
    valueType: typeof value,
  })
}

function isoTimestamp(value, field, warnings = null) {
  if (value === null || value === undefined) return null
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings?.push({
      code: "INVALID_TIMESTAMP",
      message: `${field} is not a Unix timestamp.`,
      details: { field, value },
    })
    return null
  }

  const timestamp = new Date(value * 1000)
  if (Number.isNaN(timestamp.getTime())) return null
  return timestamp.toISOString()
}

function remainingFields(source, excluded) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null
  const entries = Object.entries(source).filter(([key]) => !excluded.has(key))
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

export function normalizeThreadSummary(raw = {}, {
  includeAdapterSpecific = false,
  includePreview = true,
} = {}) {
  raw = objectValue(raw, "thread")
  const summary = {
    id: stringOrNull(raw.id, "thread.id"),
    sessionId: stringOrNull(raw.sessionId, "thread.sessionId"),
    title: stringOrNull(raw.name, "thread.name"),
    source: raw.source ?? null,
    originator: stringOrNull(raw.originator, "thread.originator"),
    cwd: stringOrNull(raw.cwd, "thread.cwd"),
    projectId: stringOrNull(raw.projectId, "thread.projectId"),
    parentThreadId: stringOrNull(raw.parentThreadId, "thread.parentThreadId"),
    forkedFromId: stringOrNull(raw.forkedFromId, "thread.forkedFromId"),
    ephemeral: booleanOrNull(raw.ephemeral, "thread.ephemeral"),
    isPinned: booleanOrNull(raw.isPinned, "thread.isPinned"),
    historyMode: stringOrNull(raw.historyMode, "thread.historyMode"),
    modelProvider: stringOrNull(raw.modelProvider, "thread.modelProvider"),
    model: stringOrNull(raw.model, "thread.model"),
    reasoningEffort: stringOrNull(raw.reasoningEffort, "thread.reasoningEffort"),
    createdAt: isoTimestamp(raw.createdAt, "thread.createdAt"),
    updatedAt: isoTimestamp(raw.updatedAt, "thread.updatedAt"),
    recencyAt: isoTimestamp(raw.recencyAt, "thread.recencyAt"),
    cliVersion: stringOrNull(raw.cliVersion, "thread.cliVersion"),
    gitInfo: raw.gitInfo ?? null,
    section: raw.section ?? null,
    agentNickname: stringOrNull(raw.agentNickname, "thread.agentNickname"),
    agentRole: stringOrNull(raw.agentRole, "thread.agentRole"),
  }
  if (includePreview) summary.preview = stringOrNull(raw.preview, "thread.preview")

  if (includeAdapterSpecific) {
    const adapterSpecific = remainingFields(raw, THREAD_FIELDS)
    if (adapterSpecific) summary.adapterSpecific = adapterSpecific
  }
  return summary
}

function normalizeTurn(raw = {}, warnings) {
  raw = objectValue(raw, "turn")
  return {
    id: stringOrNull(raw.id, "turn.id"),
    status: stringOrNull(raw.status, "turn.status"),
    error: raw.error ?? null,
    startedAt: isoTimestamp(raw.startedAt, `turns.${raw.id ?? "unknown"}.startedAt`, warnings),
    completedAt: isoTimestamp(raw.completedAt, `turns.${raw.id ?? "unknown"}.completedAt`, warnings),
    durationMs: finiteNumberOrNull(raw.durationMs, "turn.durationMs"),
    itemsView: raw.itemsView ?? null,
    itemCount: Array.isArray(raw.items) ? raw.items.length : 0,
  }
}

function userMessageText(content) {
  if (!Array.isArray(content)) return null
  const text = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
  return text === "" ? null : text
}

function normalizeMessage(item, turnId, sequence) {
  const user = item.type === "userMessage"
  const text = user ? userMessageText(item.content) : stringOrNull(item.text, "item.text")
  const message = {
    id: stringOrNull(item.id, "item.id"),
    turnId,
    role: user ? "user" : "assistant",
    text,
    phase: user ? null : stringOrNull(item.phase, "item.phase"),
    content: user ? item.content : [{ type: "text", text: text ?? "" }],
    createdAt: null,
    sequence,
  }
  const messageFields = new Set(["id", "type", "content", "text", "phase"])
  const adapterSpecific = remainingFields(item, messageFields)
  if (adapterSpecific) message.adapterSpecific = adapterSpecific
  return message
}

function activitySummary(item) {
  if (item.type === "commandExecution") return stringOrNull(item.command, "item.command")
  if (item.type === "mcpToolCall") {
    return [
      stringOrNull(item.server, "item.server"),
      stringOrNull(item.tool, "item.tool"),
    ].filter(Boolean).join("/") || null
  }
  if (item.type === "dynamicToolCall") return stringOrNull(item.tool, "item.tool")
  if (item.type === "collabAgentToolCall") return stringOrNull(item.tool, "item.tool")
  if (item.type === "webSearch") {
    return stringOrNull(item.query ?? item.action?.query, "item.query")
  }
  if (item.type === "imageView") return stringOrNull(item.path, "item.path")
  if (item.type === "fileChange") {
    const count = Array.isArray(item.changes) ? item.changes.length : 0
    return `${count} file change${count === 1 ? "" : "s"}`
  }
  if (item.type === "plan") return stringOrNull(item.text, "item.text")
  if (item.type === "reasoning") {
    return Array.isArray(item.summary) ? item.summary.join("\n") || null : null
  }
  return item.type ?? "unknown"
}

function normalizeActivity(item, turnId, sequence, warnings) {
  const known = KNOWN_ITEM_TYPES.has(item.type)
  if (!known) {
    warnings.push({
      code: "UNKNOWN_ITEM_TYPE",
      message: "A Codex item type was preserved without stable field mapping.",
      details: { itemId: item.id ?? null, itemType: item.type ?? null, turnId },
    })
  }

  const { id, type, ...payload } = item
  const activity = {
    id: stringOrNull(id, "item.id"),
    turnId,
    kind: stringOrNull(type, "item.type") ?? "unknown",
    status: stringOrNull(item.status, "item.status"),
    summary: activitySummary(item),
    payload,
    createdAt: null,
    sequence,
  }
  if (!known) activity.adapterSpecific = item
  return activity
}

function selectRawTurns(turns, selection) {
  if (selection === null) return { turns, details: null, warning: null }

  if (selection.kind === "turn") {
    const selected = turns.filter((turn) => turn?.id === selection.turnId)
    return {
      turns: selected,
      details: {
        kind: "turn",
        turnId: selection.turnId,
        turnLimit: null,
        turnOffset: null,
        totalTurns: turns.length,
        selectedTurnIds: selected.map((turn) => turn.id),
      },
      warning: selected.length === 0
        ? {
            code: "TURN_NOT_FOUND",
            message: "The thread does not contain the supplied turn ID.",
            details: { turnId: selection.turnId },
          }
        : null,
    }
  }

  const end = Math.max(0, turns.length - selection.turnOffset)
  const start = Math.max(0, end - selection.turnLimit)
  const selected = turns.slice(start, end)
  return {
    turns: selected,
    details: {
      kind: "turn-window",
      turnId: null,
      turnLimit: selection.turnLimit,
      turnOffset: selection.turnOffset,
      totalTurns: turns.length,
      selectedTurnIds: selected.map((turn) => turn.id),
    },
    warning: null,
  }
}

export function normalizeThread(raw = {}, {
  selection = null,
  toolVersion = VERSION,
  observedAt = new Date().toISOString(),
} = {}) {
  raw = objectValue(raw, "thread")
  const warnings = []
  const rawTurns = Array.isArray(raw.turns) ? raw.turns : []
  const selected = selectRawTurns(rawTurns, selection)
  if (selected.warning) warnings.push(selected.warning)

  const turns = []
  const messages = []
  const activities = []
  const seenTurnIds = new Set()
  let sequence = 0

  for (const rawTurn of selected.turns) {
    const turn = normalizeTurn(rawTurn, warnings)
    const turnId = turn.id
    if (seenTurnIds.has(turnId)) {
      throw new AppServerProtocolError("Codex app-server returned a duplicate turn ID.", {
        turnId,
      })
    }
    seenTurnIds.add(turnId)
    turns.push(turn)
    for (const item of Array.isArray(rawTurn?.items) ? rawTurn.items : []) {
      const normalizedItem = objectValue(item, "turn.items")
      if (normalizedItem.type === "userMessage" || normalizedItem.type === "agentMessage") {
        messages.push(normalizeMessage(normalizedItem, turnId, sequence))
      } else {
        activities.push(normalizeActivity(normalizedItem, turnId, sequence, warnings))
      }
      sequence += 1
    }
  }

  const runtimeStatus = raw.status === undefined ? { type: "unknown" } : raw.status
  const latestReturnedTurn = selected.turns.at(-1) ?? null
  const returnedTurnInProgress = latestReturnedTurn?.status === "inProgress"
  if (runtimeStatus?.type === "active") {
    warnings.push({
      code: "ACTIVE_THREAD_MAY_CHANGE",
      message: "The thread is active and its stored history may still change.",
      details: { activeFlags: runtimeStatus.activeFlags ?? [] },
    })
  }
  if (returnedTurnInProgress) {
    warnings.push({
      code: "TURN_IN_PROGRESS",
      message: "The latest returned turn is still in progress and its items may change.",
      details: { turnId: latestReturnedTurn.id ?? null },
    })
  }

  const envelope = {
    schemaVersion: THREAD_SCHEMA_VERSION,
    toolVersion,
    thread: normalizeThreadSummary(raw, { includeAdapterSpecific: true }),
    turns,
    messages,
    activities,
    runtime: {
      status: runtimeStatus,
      observedAt,
      scope: "spawned-app-server",
      historyMayChange: runtimeStatus?.type === "active" || returnedTurnInProgress,
    },
    warnings,
  }
  if (selected.details) envelope.selection = selected.details
  return envelope
}

export function normalizeThreadList(rawThreads, {
  options,
  hasMore,
  toolVersion = VERSION,
} = {}) {
  const threads = rawThreads.map((thread) => normalizeThreadSummary(thread, { includePreview: false }))
  return {
    schemaVersion: LIST_SCHEMA_VERSION,
    toolVersion,
    filters: {
      archived: options.archived,
      includeSubagents: options.includeSubagents,
    },
    ordering: {
      sortBy: "updatedAt",
      direction: options.reverse ? "desc" : "asc",
    },
    limit: options.limit,
    offset: options.offset,
    count: threads.length,
    hasMore,
    threads,
  }
}

export function normalizeThreadSearch(rawThreads, {
  options,
  toolVersion = VERSION,
} = {}) {
  const threads = rawThreads.map((thread) => normalizeThreadSummary(thread, { includePreview: false }))
  return {
    schemaVersion: FIND_SCHEMA_VERSION,
    toolVersion,
    filters: {
      title: options.title,
      archived: options.archived,
      includeSubagents: options.includeSubagents,
    },
    ordering: {
      sortBy: "updatedAt",
      direction: options.reverse ? "desc" : "asc",
    },
    count: threads.length,
    threads,
  }
}
