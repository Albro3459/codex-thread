import test from "node:test"
import assert from "node:assert/strict"

import {
  normalizeFindOptions,
  normalizeListOptions,
  normalizeThread,
  normalizeThreadList,
  normalizeThreadSearch,
} from "../src/index.js"
import {
  formatCollectionJson,
  formatCollectionJsonl,
  formatParticipantsHuman,
  formatParticipantsJson,
  formatParticipantsJsonl,
  formatThreadJsonl,
} from "../src/output.js"
import { rawThread, threadSummary } from "./fixtures/raw-thread-fixture.js"
import { assertSchema } from "./fixtures/schema-assert.js"

function parseJsonLines(output) {
  return output.trim().split("\n").map((line) => JSON.parse(line))
}

test("thread JSONL emits one header, turns, and items in source order", () => {
  const envelope = normalizeThread(rawThread(), {
    selection: { kind: "turn-window", turnLimit: 2, turnOffset: 0 },
  })
  const records = parseJsonLines(formatThreadJsonl(envelope))

  assert.equal(records[0].recordType, "header")
  assert.deepEqual(records.map((record) => record.recordType), [
    "header",
    "turn",
    "message",
    "activity",
    "message",
    "activity",
    "turn",
    "message",
    "message",
  ])
  assert.deepEqual(records.slice(2).map((record) => record.data.sequence).filter(Number.isInteger), [
    0, 1, 2, 3, 4, 5,
  ])
  assert.deepEqual(records[0].data.selection.selectedTurnIds, ["turn-1", "turn-2"])
  assert.deepEqual(records[0].data.warnings.map((warning) => warning.code), ["UNKNOWN_ITEM_TYPE"])
  assert.deepEqual(records.slice(1).map((record) => record.threadId), Array(8).fill("thread-1"))
  for (const record of records) assertSchema(record, "jsonl-record")
})

test("list and find JSON output remain metadata-only", () => {
  const summary = threadSummary("thread-1", "Metadata title")
  summary.preview = "SECRET_PREVIEW_TEXT"
  summary.message = "SECRET_MESSAGE_TEXT"
  summary.command = "SECRET_COMMAND_TEXT"
  const options = normalizeListOptions({ limit: 1 })
  const list = normalizeThreadList([summary], {
    options,
    hasMore: false,
    toolVersion: "test-version",
  })
  const find = normalizeThreadSearch([summary], {
    options: normalizeFindOptions({ title: "metadata" }),
    toolVersion: "test-version",
  })

  for (const output of [formatCollectionJson(list), formatCollectionJsonl(list), formatCollectionJson(find), formatCollectionJsonl(find)]) {
    assert.ok(!output.includes("SECRET_PREVIEW_TEXT"))
    assert.ok(!output.includes("SECRET_MESSAGE_TEXT"))
    assert.ok(!output.includes("SECRET_COMMAND_TEXT"))
  }
  const listRecords = parseJsonLines(formatCollectionJsonl(list))
  const findRecords = parseJsonLines(formatCollectionJsonl(find))
  assert.deepEqual(listRecords.map((record) => record.recordType), ["header", "thread"])
  assert.deepEqual(findRecords.map((record) => record.recordType), ["header", "thread"])
})

test("participant output keeps JSONL flat and metadata-only", () => {
  const participant = {
    threadId: "child-1",
    parentThreadId: "thread-1",
    path: "main.subagent1",
    depth: 1,
    title: "Worker",
    source: "subAgent",
    agentNickname: "Ada",
    agentRole: "worker",
    model: "gpt-test",
    reasoningEffort: "high",
    status: { type: "completed" },
    state: "finished",
    agentPath: null,
    turnId: "turn-1",
    turnIds: ["turn-1"],
    firstSeenAt: null,
    lastSeenAt: null,
    activityCount: 1,
    discoveredBy: [{ activityId: "activity-1", kind: "collabAgentToolCall" }],
  }
  const envelope = {
    schemaVersion: "codex-thread.participants.v1",
    toolVersion: "0.2.0",
    threadId: "thread-1",
    ordering: { sortBy: "firstDiscovery", direction: "asc" },
    selection: null,
    counts: { total: 1, returned: 1, hasMore: false },
    hierarchyAvailable: true,
    participants: [participant],
    warnings: [],
  }
  assertSchema(envelope, "participants")
  const records = parseJsonLines(formatParticipantsJsonl(envelope))
  assert.deepEqual(records.map((entry) => entry.recordType), ["header", "participant"])
  for (const entry of records) assertSchema(entry, "jsonl-record")
  for (const output of [
    formatParticipantsJson(envelope),
    formatParticipantsJsonl(envelope),
    formatParticipantsHuman(envelope),
  ]) {
    assert.equal(output.includes("prompt"), false)
    assert.equal(output.includes("tool output"), false)
  }
})
