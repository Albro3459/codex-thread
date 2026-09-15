export const JSONL_SCHEMA_VERSION = "codex-thread.jsonl-record.v1"

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

function display(value) {
  if (value === null || value === undefined || value === "") return "-"
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function record(recordType, data, { threadId = null, turnId = null } = {}) {
  return {
    schemaVersion: JSONL_SCHEMA_VERSION,
    recordType,
    threadId,
    turnId,
    data,
  }
}

export function jsonlRecordsForThread(envelope) {
  const threadId = envelope.thread.id
  const header = {
    schemaVersion: envelope.schemaVersion,
    toolVersion: envelope.toolVersion,
    thread: envelope.thread,
    runtime: envelope.runtime,
    warnings: envelope.warnings,
  }
  if (envelope.selection) header.selection = envelope.selection
  const records = [record("header", header, { threadId })]

  for (const turn of envelope.turns) {
    records.push(record("turn", turn, { threadId, turnId: turn.id }))
    const items = [
      ...envelope.messages.filter((message) => message.turnId === turn.id)
        .map((message) => ({ type: "message", sequence: message.sequence, data: message })),
      ...envelope.activities.filter((activity) => activity.turnId === turn.id)
        .map((activity) => ({ type: "activity", sequence: activity.sequence, data: activity })),
    ].sort((left, right) => left.sequence - right.sequence)

    for (const item of items) {
      records.push(record(item.type, item.data, { threadId, turnId: turn.id }))
    }
  }
  return records
}

function collectionJsonlRecords(envelope) {
  const { threads, ...metadata } = envelope
  return [
    record("header", metadata),
    ...threads.map((thread) => record("thread", thread, { threadId: thread.id })),
  ]
}

export function formatThreadJson(envelope) {
  return json(envelope)
}

export function formatThreadJsonl(envelope) {
  return jsonl(jsonlRecordsForThread(envelope))
}

export function formatCollectionJson(envelope) {
  return json(envelope)
}

export function formatCollectionJsonl(envelope) {
  return jsonl(collectionJsonlRecords(envelope))
}

export function formatThreadHuman(envelope) {
  const lines = [
    envelope.thread.title || envelope.thread.preview || "(untitled)",
    "=".repeat((envelope.thread.title || envelope.thread.preview || "(untitled)").length),
    "",
    `ID: ${display(envelope.thread.id)}`,
    `Source: ${display(envelope.thread.source)}`,
    `Working directory: ${display(envelope.thread.cwd)}`,
    `Created: ${display(envelope.thread.createdAt)}`,
    `Updated: ${display(envelope.thread.updatedAt)}`,
    `Runtime: ${display(envelope.runtime.status?.type)}`,
  ]

  if (envelope.selection) {
    lines.push(
      "",
      "Selection",
      "---------",
      `Kind: ${envelope.selection.kind}`,
      `Total turns: ${envelope.selection.totalTurns}`,
      `Selected turns: ${envelope.selection.selectedTurnIds.join(", ") || "-"}`,
      "Partial history: yes",
    )
  }

  lines.push("", envelope.selection ? "Conversation (partial)" : "Conversation", "------------")
  const entries = [
    ...envelope.messages.map((message) => ({ ...message, entryType: "message" })),
    ...envelope.activities.map((activity) => ({ ...activity, entryType: "activity" })),
  ].sort((left, right) => left.sequence - right.sequence)

  if (entries.length === 0) lines.push("No stored items.")
  for (const entry of entries) {
    if (entry.entryType === "message") {
      lines.push("", `${entry.role.toUpperCase()} [${entry.turnId || "unknown turn"}]`, entry.text ?? "")
    } else {
      lines.push("", `${entry.kind} [${entry.turnId || "unknown turn"}]`, display(entry.summary))
    }
  }

  if (envelope.warnings.length > 0) {
    lines.push("", "Warnings", "--------")
    for (const warning of envelope.warnings) lines.push(`${warning.code}: ${warning.message}`)
  }
  return `${lines.join("\n")}\n`
}

export function formatCollectionHuman(envelope) {
  const lines = [
    "Codex threads",
    "=============",
    "",
    `Returned: ${envelope.count}`,
  ]
  if (Object.hasOwn(envelope, "hasMore")) lines.push(`More available: ${envelope.hasMore ? "yes" : "no"}`)
  lines.push("")

  if (envelope.threads.length === 0) lines.push("No matching threads.")
  for (const thread of envelope.threads) {
    lines.push(
      thread.title || thread.preview || "(untitled)",
      `  ID: ${thread.id}`,
      `  Source: ${display(thread.source)}`,
      `  Updated: ${display(thread.updatedAt)}`,
      "",
    )
  }
  return `${lines.join("\n")}\n`
}

export function formatDoctorJson(report) {
  return json(report)
}
