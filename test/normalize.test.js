import test from "node:test"
import assert from "node:assert/strict"

import {
  AppServerProtocolError,
  normalizeFindOptions,
  normalizeListOptions,
  normalizeThread,
  normalizeThreadList,
  normalizeThreadSearch,
} from "../src/index.js"
import { rawThread, threadSummary } from "./fixtures/raw-thread-fixture.js"
import { assertSchema } from "./fixtures/schema-assert.js"

test("normalizeThread preserves source order with stable item sequences", () => {
  const result = normalizeThread(rawThread(), {
    toolVersion: "test-version",
    observedAt: "2023-11-14T22:13:20.000Z",
  })

  assert.deepEqual(result.turns.map((turn) => turn.id), ["turn-1", "turn-2"])
  assert.deepEqual(result.messages.map((message) => [message.id, message.sequence]), [
    ["item-1", 0],
    ["item-3", 2],
    ["item-5", 4],
    ["item-6", 5],
  ])
  assert.deepEqual(result.activities.map((activity) => [activity.id, activity.sequence]), [
    ["item-2", 1],
    ["item-4", 3],
  ])
  assert.equal(result.messages[0].text, "hello")
  assert.equal(result.messages.at(-1).text, null)
})

test("normalizeThread preserves unknown items with a warning and adapter-specific data", () => {
  const result = normalizeThread(rawThread())
  const unknown = result.activities.find((activity) => activity.id === "item-4")

  assert.equal(unknown.kind, "futureItem")
  assert.deepEqual(unknown.adapterSpecific, {
    type: "futureItem",
    id: "item-4",
    secret: "preserve-me",
  })
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["UNKNOWN_ITEM_TYPE"])
})

test("normalizeThread rejects invalid declared field types and duplicate turn IDs", () => {
  assert.throws(
    () => normalizeThread(rawThread({ turns: [{ ...rawThread().turns[0], status: 12 }] })),
    (error) => error instanceof AppServerProtocolError && error.details.field === "turn.status",
  )

  const first = rawThread().turns[0]
  assert.throws(
    () => normalizeThread(rawThread({ turns: [first, { ...rawThread().turns[1], id: first.id }] })),
    (error) => error instanceof AppServerProtocolError
      && error.details.turnId === "turn-1",
  )
})

test("turn selection distinguishes a missing exact turn from an empty valid window", () => {
  const missing = normalizeThread(rawThread(), { selection: { kind: "turn", turnId: "missing" } })
  assert.deepEqual(missing.turns, [])
  assert.deepEqual(missing.selection.selectedTurnIds, [])
  assert.deepEqual(missing.warnings.map((warning) => warning.code), ["TURN_NOT_FOUND"])

  const emptyWindow = normalizeThread(rawThread(), {
    selection: { kind: "turn-window", turnLimit: 1, turnOffset: 10 },
  })
  assert.deepEqual(emptyWindow.turns, [])
  assert.deepEqual(emptyWindow.selection.selectedTurnIds, [])
  assert.deepEqual(emptyWindow.warnings, [])
})

test("turn windows return recent turns in chronological order and retain warnings", () => {
  const result = normalizeThread(rawThread({
    status: { type: "active", activeFlags: ["running"] },
    turns: [
      rawThread().turns[0],
      { ...rawThread().turns[1], status: "inProgress" },
    ],
  }), {
    selection: { kind: "turn-window", turnLimit: 1, turnOffset: 0 },
  })

  assert.deepEqual(result.turns.map((turn) => turn.id), ["turn-2"])
  assert.deepEqual(result.selection.selectedTurnIds, ["turn-2"])
  assert.deepEqual(result.warnings.map((warning) => warning.code), [
    "ACTIVE_THREAD_MAY_CHANGE",
    "TURN_IN_PROGRESS",
  ])
  assert.equal(result.runtime.historyMayChange, true)
})

test("representative normalized thread, list, and find envelopes match bundled schemas", () => {
  const thread = normalizeThread(rawThread())
  const options = normalizeListOptions({ limit: 2, offset: 0 })
  const list = normalizeThreadList([threadSummary("thread-1", "A small test thread")], {
    options,
    hasMore: false,
    toolVersion: "test-version",
  })
  const findOptions = normalizeFindOptions({ title: "small" })
  const find = normalizeThreadSearch([threadSummary("thread-1", "A small test thread")], {
    options: findOptions,
    toolVersion: "test-version",
  })

  assertSchema(thread, "thread")
  assertSchema(list, "list")
  assertSchema(find, "find")
})
