import { InvalidArgumentsError } from "./errors.js"
import { normalizeThreadSummary } from "./normalize.js"
import { normalizeTurnSelection } from "./query-options.js"
import { VERSION } from "./version.js"

export const PARTICIPANTS_SCHEMA_VERSION = "codex-thread.participants.v1"
export const DEFAULT_PARTICIPANT_LIMIT = 50

const ACTIVITY_KINDS = new Set(["collabAgentToolCall", "subAgentActivity"])
const CHILD_ID_KEYS = new Set([
  "agentThreadId",
  "agentThreadIds",
  "childThreadId",
  "childThreadIds",
  "receiverThreadId",
  "receiverThreadIds",
  "recipientThreadId",
  "recipientThreadIds",
])
const SENDER_ID_KEYS = new Set([
  "senderThreadId",
  "senderThreadIds",
  "sourceThreadId",
])
const TERMINAL_STATES = new Set([
  "cancelled",
  "canceled",
  "complete",
  "completed",
  "error",
  "failed",
  "finished",
  "interrupted",
  "succeeded",
  "terminated",
])

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

function normalizeFlag(value, field) {
  if (value === undefined || value === null || value === "") return false
  if (typeof value !== "boolean") {
    throw new InvalidArgumentsError(`${field} must be a boolean.`, { field, value })
  }
  return value
}

function normalizeCount(value, field, fallback, positive = false) {
  if (value === undefined || value === null || value === "") return fallback
  const text = typeof value === "string" ? value.trim() : null
  const count = text !== null && /^\d+$/u.test(text)
    ? Number(text)
    : value
  if (!Number.isSafeInteger(count) || count < (positive ? 1 : 0)) {
    throw new InvalidArgumentsError(
      `${field} must be a ${positive ? "positive" : "non-negative"} integer.`,
      { field, value },
    )
  }
  return count
}

export function normalizeParticipantsOptions(options = {}) {
  const limit = normalizeCount(options.limit, "limit", DEFAULT_PARTICIPANT_LIMIT, true)
  const offset = normalizeCount(options.offset, "offset", 0)
  if (offset > Number.MAX_SAFE_INTEGER - limit) {
    throw new InvalidArgumentsError("offset and limit are too large when combined.", {
      fields: ["offset", "limit"],
      offset,
      limit,
    })
  }
  const rawSelection = Object.hasOwn(options, "selection") ? options.selection : options
  const turnSelection = rawSelection === null || rawSelection?.kind
    ? rawSelection
    : normalizeTurnSelection(rawSelection)
  return Object.freeze({
    limit,
    offset,
    reverse: normalizeFlag(options.reverse, "reverse"),
    tree: normalizeFlag(options.tree, "tree"),
    selection: turnSelection === null ? null : turnSelection,
  })
}

function warning(code, message, details = {}) {
  return { code, message, details }
}

function warningKey(item) {
  return `${item.code}:${item.details?.threadId ?? ""}:${item.details?.parentThreadId ?? ""}`
}

function addWarning(warnings, seen, item) {
  const key = warningKey(item)
  if (seen.has(key)) return
  seen.add(key)
  warnings.push(item)
}

function idsAt(value, keys) {
  if (!isObject(value)) return []
  const ids = []
  for (const [key, raw] of Object.entries(value)) {
    if (!keys.has(key)) continue
    const values = Array.isArray(raw) ? raw : [raw]
    for (const id of values) {
      const normalized = nonEmptyString(id)
      if (normalized) ids.push(normalized)
    }
  }
  return [...new Set(ids)]
}

function activityReferences(activity) {
  if (!isObject(activity)) return { children: [], senders: [] }
  const payload = isObject(activity.payload) ? activity.payload : activity
  return {
    children: idsAt(payload, CHILD_ID_KEYS),
    senders: idsAt(payload, SENDER_ID_KEYS),
  }
}

function summaryInput(value) {
  if (!isObject(value)) return null
  const candidate = isObject(value.thread) ? value.thread : value
  if (candidate.name === undefined && candidate.title !== undefined) {
    return { ...candidate, name: candidate.title }
  }
  return candidate
}

function summaryFor(value) {
  const raw = summaryInput(value)
  if (!raw || !nonEmptyString(raw.id)) return null
  return normalizeThreadSummary(raw, { includeAdapterSpecific: false, includePreview: false })
}

function safeStatus(value) {
  if (typeof value === "string") return value
  if (!isObject(value)) return null
  const status = {}
  if (typeof value.type === "string") status.type = value.type
  if (Array.isArray(value.activeFlags)) {
    status.activeFlags = value.activeFlags.filter((flag) => typeof flag === "string")
  }
  return Object.keys(status).length > 0 ? status : null
}

function rawMetadata(value) {
  const raw = summaryInput(value)
  if (!raw) return {}
  return {
    status: safeStatus(raw.status),
    state: typeof raw.state === "string" ? raw.state : null,
    agentPath: typeof raw.agentPath === "string" ? raw.agentPath : null,
    agentNickname: raw.agentNickname ?? null,
    agentRole: raw.agentRole ?? null,
  }
}

function activityDate(activity, field) {
  const value = activity?.[field] ?? activity?.payload?.[field]
  return typeof value === "string" ? value : null
}

function stateFor(metadata) {
  const raw = metadata.activityStatus ?? metadata.state ?? metadata.status
  const value = typeof raw === "string" ? raw : raw?.type
  if (!value) return "unknown"
  return TERMINAL_STATES.has(value.toLowerCase()) ? "finished" : "running"
}

function isParticipantActivity(activity) {
  const kind = activity?.kind ?? activity?.type
  return ACTIVITY_KINDS.has(kind)
}

function stableEvidence(activity) {
  return {
    activityId: nonEmptyString(activity?.id ?? activity?.activityId),
    kind: nonEmptyString(activity?.kind ?? activity?.type) ?? "unknown",
  }
}

function uniqueEvidence(values) {
  const seen = new Set()
  return values.filter((value) => {
    const key = `${value.activityId ?? ""}:${value.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function participantFrom(record, parentThreadId, path, depth) {
  const summary = record.summary ?? {}
  const metadata = record.metadata ?? {}
  const turnIds = [...new Set(record.turnIds)]
  const participant = {
    threadId: record.threadId,
    parentThreadId: parentThreadId ?? null,
    path: path ?? null,
    depth: depth ?? null,
    title: summary.title ?? null,
    source: summary.source ?? null,
    agentNickname: metadata.agentNickname ?? summary.agentNickname ?? null,
    agentRole: metadata.agentRole ?? summary.agentRole ?? null,
    model: summary.model ?? null,
    reasoningEffort: summary.reasoningEffort ?? null,
    status: metadata.status ?? null,
    state: stateFor(metadata),
    agentPath: metadata.agentPath ?? null,
    turnId: turnIds[0] ?? null,
    turnIds,
    firstSeenAt: record.firstSeenAt ?? summary.createdAt ?? null,
    lastSeenAt: record.lastSeenAt ?? summary.updatedAt ?? null,
    activityCount: record.evidence.length,
    discoveredBy: uniqueEvidence(record.evidence),
  }
  return participant
}

function collectActivities(root, records) {
  const activities = Array.isArray(root?.activities) ? root.activities : []
  const selectedTurnIds = Array.isArray(root?.selection?.selectedTurnIds)
    ? new Set(root.selection.selectedTurnIds)
    : null
  for (const [activityIndex, activity] of activities.entries()) {
    if (selectedTurnIds && !selectedTurnIds.has(activity?.turnId)) continue
    if (!isParticipantActivity(activity)) continue
    const { children, senders } = activityReferences(activity)
    const evidence = stableEvidence(activity)
    for (const childId of children) {
      const record = records.get(childId) ?? {
        threadId: childId,
        summary: null,
        metadata: {},
        evidence: [],
        turnIds: [],
        parentCandidates: new Map(),
        firstSeenAt: null,
        lastSeenAt: null,
        firstDiscovery: Number.POSITIVE_INFINITY,
      }
      record.evidence.push(evidence)
      const turnId = nonEmptyString(activity.turnId)
      if (turnId) record.turnIds.push(turnId)
      record.firstSeenAt ||= activityDate(activity, "createdAt")
      record.lastSeenAt = activityDate(activity, "createdAt") ?? record.lastSeenAt
      record.firstDiscovery = Math.min(
        record.firstDiscovery,
        Number.isInteger(activity.sequence) ? activity.sequence : activityIndex,
      )
      const agentState = isObject(activity.payload?.agentsStates)
        ? activity.payload.agentsStates[childId]
        : null
      if (isObject(agentState) && nonEmptyString(agentState.status)) {
        record.metadata.activityStatus = agentState.status
      }
      records.set(childId, record)
      for (const senderId of senders) {
        record.parentCandidates.set(senderId, "activity")
      }
    }
  }
}

function addListed(records, listedThreads, rootId, { allowRootDiscovery = true } = {}) {
  const pending = listedThreads.map((listed) => ({ listed, summary: summaryFor(listed) }))
  let changed = true
  while (changed) {
    changed = false
    for (const item of pending) {
      const { listed, summary } = item
      if (!summary?.id || summary.id === rootId) continue
      const parentId = summary.parentThreadId
      const existing = records.get(summary.id)
      if (!existing && (
        (parentId === rootId && !allowRootDiscovery)
        || (parentId !== rootId && !records.has(parentId))
      )) continue
      const record = existing ?? {
        threadId: summary.id,
        summary: null,
        metadata: {},
        evidence: [],
        turnIds: [],
        parentCandidates: new Map(),
        firstSeenAt: null,
        lastSeenAt: null,
        firstDiscovery: Number.POSITIVE_INFINITY,
      }
      record.summary = record.summary ?? summary
      record.metadata = { ...record.metadata, ...rawMetadata(listed) }
      if (parentId) record.parentCandidates.set(parentId, "metadata")
      if (!existing) changed = true
      records.set(summary.id, record)
    }
  }
}

function mergeRead(record, value) {
  const summary = summaryFor(value)
  if (!summary) return false
  record.summary = record.summary ?? summary
  record.metadata = { ...record.metadata, ...rawMetadata(value) }
  return true
}

function resolveParent(record, rootId, knownIds, warnings, warningSeen) {
  const candidates = [...record.parentCandidates.keys()].filter(Boolean)
  if (candidates.length > 1) {
    addWarning(warnings, warningSeen, warning(
      "CONFLICTING_PARENT",
      "A participant had conflicting explicit parent thread IDs.",
      { threadId: record.threadId, parentThreadIds: candidates.sort() },
    ))
    return null
  }
  const parentId = candidates[0] ?? null
  if (!parentId) return null
  if (parentId !== rootId && !knownIds.has(parentId)) {
    addWarning(warnings, warningSeen, warning(
      "UNRESOLVED_PARENT",
      "A participant named a parent thread outside the discovered tree.",
      { threadId: record.threadId, parentThreadId: parentId },
    ))
    return null
  }
  return parentId
}

function detectCycles(parents, warnings, warningSeen) {
  for (const [threadId, parentId] of parents) {
    const seen = new Set([threadId])
    let current = parentId
    while (current && current !== "main") {
      if (seen.has(current)) {
        addWarning(warnings, warningSeen, warning(
          "PARENT_CYCLE",
          "Explicit parent thread IDs contained a cycle.",
          { threadId },
        ))
        for (const id of seen) parents.delete(id)
        break
      }
      seen.add(current)
      current = parents.get(current) ?? null
    }
  }
}

function selectionEnvelope(root) {
  return root?.selection ?? null
}

function hierarchy(records, parents, rootId, orderedIds, selection, warnings, warningSeen) {
  const byParent = new Map()
  for (const id of orderedIds) {
    const parentId = parents.get(id) ?? null
    if (!parentId) continue
    const siblings = byParent.get(parentId) ?? []
    siblings.push(id)
    byParent.set(parentId, siblings)
  }
  const paths = new Map()
  const depths = new Map()
  const visit = (parentId, parentPath, parentDepth) => {
    const children = byParent.get(parentId) ?? []
    children.forEach((id, index) => {
      const segment = parentId === rootId
        ? `subagent${index + 1}`
        : `${paths.get(parentId).split(".").at(-1)}${String.fromCharCode(97 + index)}`
      paths.set(id, `${parentPath}.${segment}`)
      depths.set(id, parentDepth + 1)
      visit(id, paths.get(id), parentDepth + 1)
    })
  }
  visit(rootId, "main", 0)

  for (const id of orderedIds) {
    const record = records.get(id)
    if (selection !== null && !paths.has(id) && record.parentCandidates.size > 0) {
      addWarning(warnings, warningSeen, warning(
        "PARENT_OUT_OF_SELECTION",
        "A participant parent was not represented in the selected participant view.",
        { threadId: id, parentThreadId: [...record.parentCandidates.keys()][0] ?? null },
      ))
    }
  }
  return { paths, depths }
}

function treeParticipants(participants) {
  const nodes = new Map(participants.map((participant) => [participant.threadId, participant]))
  const roots = []
  for (const participant of participants) {
    if (participant.parentThreadId && nodes.has(participant.parentThreadId)) {
      const parent = nodes.get(participant.parentThreadId)
      parent.children ??= []
      parent.children.push(participant)
    } else {
      roots.push(participant)
    }
  }
  return roots
}

export async function discoverParticipants({
  threadId,
  root,
  listedThreads = [],
  readThread = null,
  options = {},
  toolVersion = VERSION,
} = {}) {
  const normalizedOptions = normalizeParticipantsOptions(options)
  const rootId = nonEmptyString(threadId) ?? nonEmptyString(root?.thread?.id)
  if (!rootId) {
    throw new InvalidArgumentsError("threadId must be a non-empty string.", { field: "threadId" })
  }

  const records = new Map()
  const warnings = Array.isArray(root?.warnings) ? [...root.warnings] : []
  const warningSeen = new Set(warnings.map(warningKey))
  collectActivities(root, records)
  const listed = Array.isArray(listedThreads) ? listedThreads : listedThreads?.threads ?? []
  addListed(records, listed, rootId, {
    allowRootDiscovery: selectionEnvelope(root) === null,
  })

  const missingFromList = new Set()
  for (const record of records.values()) {
    if (record.summary) continue
    missingFromList.add(record.threadId)
    if (typeof readThread !== "function") continue
    try {
      const value = await readThread(record.threadId, { includeTurns: false })
      if (!mergeRead(record, value)) {
        addWarning(warnings, warningSeen, warning(
          "CHILD_READ_FAILED",
          "A referenced child returned no usable metadata.",
          { threadId: record.threadId },
        ))
      }
    } catch {
      addWarning(warnings, warningSeen, warning(
        "CHILD_READ_FAILED",
        "A referenced child thread could not be read for metadata.",
        { threadId: record.threadId },
      ))
    }
  }
  for (const threadIdValue of missingFromList) {
    addWarning(warnings, warningSeen, warning(
      "CHILD_NOT_IN_LIST",
      "A child was referenced by activity but was absent from thread/list.",
      { threadId: threadIdValue },
    ))
  }

  const knownIds = new Set(records.keys())
  const parents = new Map()
  for (const record of records.values()) {
    const parentId = resolveParent(record, rootId, knownIds, warnings, warningSeen)
    if (parentId) parents.set(record.threadId, parentId)
  }
  detectCycles(parents, warnings, warningSeen)

  const orderedIds = [...records.keys()].sort((left, right) => (
    records.get(left).firstDiscovery - records.get(right).firstDiscovery
    || left.localeCompare(right)
  ))
  const selection = selectionEnvelope(root)
  const { paths, depths } = hierarchy(
    records,
    parents,
    rootId,
    orderedIds,
    selection,
    warnings,
    warningSeen,
  )
  const allParticipants = orderedIds.map((id) => participantFrom(
    records.get(id),
    parents.get(id) ?? null,
    paths.get(id) ?? null,
    depths.get(id) ?? null,
  ))
  const ordered = normalizedOptions.reverse ? allParticipants.toReversed() : allParticipants
  const pageEnd = normalizedOptions.offset + normalizedOptions.limit
  const page = ordered.slice(normalizedOptions.offset, pageEnd)
  if (normalizedOptions.offset > 0) {
    for (const participant of page) {
      const parentInPage = page.some((item) => item.threadId === participant.parentThreadId)
      if (participant.parentThreadId && !parentInPage) {
        addWarning(warnings, warningSeen, warning(
          "PARENT_OUT_OF_PAGE",
          "A participant parent was omitted by participant paging.",
          { threadId: participant.threadId, parentThreadId: participant.parentThreadId },
        ))
      }
    }
  }
  const participants = normalizedOptions.tree ? treeParticipants(page) : page
  const hierarchyAvailable = [...parents.values()].some((parentId) => (
    parentId === rootId || parents.has(parentId)
  ))
  return {
    schemaVersion: PARTICIPANTS_SCHEMA_VERSION,
    toolVersion,
    threadId: rootId,
    ordering: {
      sortBy: "firstDiscovery",
      direction: normalizedOptions.reverse ? "desc" : "asc",
    },
    selection,
    counts: {
      total: allParticipants.length,
      returned: page.length,
      hasMore: normalizedOptions.offset + page.length < allParticipants.length,
    },
    hierarchyAvailable,
    participants,
    warnings,
  }
}

export const buildParticipants = discoverParticipants
