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
