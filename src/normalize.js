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

export function normalizeThreadSummary(raw = {}, { includeAdapterSpecific = false } = {}) {
  const summary = {
    id: raw.id ?? null,
    sessionId: raw.sessionId ?? null,
    title: raw.name ?? null,
    preview: raw.preview ?? null,
    source: raw.source ?? null,
    originator: raw.originator ?? null,
    cwd: raw.cwd ?? null,
    projectId: raw.projectId ?? null,
    parentThreadId: raw.parentThreadId ?? null,
    forkedFromId: raw.forkedFromId ?? null,
    ephemeral: raw.ephemeral ?? null,
    isPinned: raw.isPinned ?? null,
    historyMode: raw.historyMode ?? null,
    modelProvider: raw.modelProvider ?? null,
    model: raw.model ?? null,
    reasoningEffort: raw.reasoningEffort ?? null,
    createdAt: isoTimestamp(raw.createdAt, "thread.createdAt"),
    updatedAt: isoTimestamp(raw.updatedAt, "thread.updatedAt"),
    recencyAt: isoTimestamp(raw.recencyAt, "thread.recencyAt"),
    cliVersion: raw.cliVersion ?? null,
    gitInfo: raw.gitInfo ?? null,
    section: raw.section ?? null,
    agentNickname: raw.agentNickname ?? null,
    agentRole: raw.agentRole ?? null,
  }

  if (includeAdapterSpecific) {
    const adapterSpecific = remainingFields(raw, THREAD_FIELDS)
    if (adapterSpecific) summary.adapterSpecific = adapterSpecific
  }
  return summary
}

function normalizeTurn(raw = {}, warnings) {
  return {
    id: raw.id ?? null,
    status: raw.status ?? null,
    error: raw.error ?? null,
    startedAt: isoTimestamp(raw.startedAt, `turns.${raw.id ?? "unknown"}.startedAt`, warnings),
    completedAt: isoTimestamp(raw.completedAt, `turns.${raw.id ?? "unknown"}.completedAt`, warnings),
    durationMs: raw.durationMs ?? null,
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
  const message = {
    id: item.id ?? null,
    turnId,
    role: user ? "user" : "assistant",
    text: user ? userMessageText(item.content) : (item.text ?? null),
    phase: user ? null : (item.phase ?? null),
    content: user ? (item.content ?? null) : [{ type: "text", text: item.text ?? "" }],
    createdAt: null,
    sequence,
  }
  const messageFields = new Set(["id", "type", "content", "text", "phase"])
  const adapterSpecific = remainingFields(item, messageFields)
  if (adapterSpecific) message.adapterSpecific = adapterSpecific
  return message
}

function activitySummary(item) {
  if (item.type === "commandExecution") return item.command ?? null
  if (item.type === "mcpToolCall") return [item.server, item.tool].filter(Boolean).join("/") || null
  if (item.type === "dynamicToolCall") return item.tool ?? null
  if (item.type === "collabAgentToolCall") return item.tool ?? null
  if (item.type === "webSearch") return item.query ?? item.action?.query ?? null
  if (item.type === "imageView") return item.path ?? null
  if (item.type === "fileChange") {
    const count = Array.isArray(item.changes) ? item.changes.length : 0
    return `${count} file change${count === 1 ? "" : "s"}`
  }
  if (item.type === "plan") return item.text ?? null
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
    id: id ?? null,
    turnId,
    kind: type ?? "unknown",
    status: item.status ?? null,
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
  const warnings = []
  const rawTurns = Array.isArray(raw.turns) ? raw.turns : []
  const selected = selectRawTurns(rawTurns, selection)
  if (selected.warning) warnings.push(selected.warning)

  const turns = []
  const messages = []
  const activities = []
  let sequence = 0

  for (const rawTurn of selected.turns) {
    const turnId = rawTurn?.id ?? null
    turns.push(normalizeTurn(rawTurn, warnings))
    for (const item of Array.isArray(rawTurn?.items) ? rawTurn.items : []) {
      if (item?.type === "userMessage" || item?.type === "agentMessage") {
        messages.push(normalizeMessage(item, turnId, sequence))
      } else {
        activities.push(normalizeActivity(item ?? {}, turnId, sequence, warnings))
      }
      sequence += 1
    }
  }

  const runtimeStatus = raw.status ?? { type: "unknown" }
  if (runtimeStatus?.type === "active") {
    warnings.push({
      code: "ACTIVE_THREAD_MAY_CHANGE",
      message: "The thread is active and its stored history may still change.",
      details: { activeFlags: runtimeStatus.activeFlags ?? [] },
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
      historyMayChange: runtimeStatus?.type === "active",
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
  const threads = rawThreads.map((thread) => normalizeThreadSummary(thread))
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
  const threads = rawThreads.map((thread) => normalizeThreadSummary(thread))
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
