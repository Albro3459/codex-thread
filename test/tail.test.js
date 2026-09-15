import test from "node:test"
import assert from "node:assert/strict"

import { InvalidArgumentsError, normalizeThread } from "../src/index.js"
import {
  TAIL_SCHEMA_VERSION,
  normalizeTailOptions,
  tailThread,
} from "../src/tail.js"
import { rawThread } from "./fixtures/raw-thread-fixture.js"
import { assertSchema } from "./fixtures/schema-assert.js"

async function collect(generator) {
  const records = []
  for await (const record of generator) records.push(record)
  return records
}

function snapshot(thread, observedAt = "2023-11-14T22:13:20.000Z") {
  return normalizeThread(thread, { observedAt })
}

test("tail emits a chronological baseline and one end record", async () => {
  const records = await collect(tailThread({
    threadId: "thread-1",
    options: { once: true },
    readSnapshot: async () => snapshot(rawThread()),
  }))
  assert.deepEqual(records.map((record) => record.recordType), [
    "thread", "turn", "message", "activity", "message", "activity",
    "turn", "message", "message", "runtime", "end",
  ])
  assert.equal(records.at(-1).data.reason, "once")
  assert.equal(records.at(-1).data.attemptedCycles, 1)
  for (const record of records) assertSchema(record, "tail-record")
})

test("tail emits changed records once and ignores runtime observation time", async () => {
  const versions = [
    rawThread(),
    rawThread({
      status: { type: "active" },
      turns: [{ ...rawThread().turns[0], items: [{ ...rawThread().turns[0].items[0], content: [{ type: "text", text: "changed" }] }] }],
    }),
  ]
  let index = 0
  const records = await collect(tailThread({
    threadId: "thread-1",
    options: { maxCycles: 2, interval: 100 },
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    readSnapshot: async () => snapshot(versions[Math.min(index++, versions.length - 1)], `2023-11-14T22:13:2${index}.000Z`),
  }))
  const cycleTwo = records.filter((record) => record.cycle === 2)
  assert.deepEqual(cycleTwo.map((record) => [record.recordType, record.op]), [
    ["turn", "upsert"], ["message", "upsert"], ["runtime", "runtime"], ["end", "end"],
  ])
  assert.equal(cycleTwo.find((record) => record.recordType === "message").data.text, "changed")
})

test("tail applies the newest turn window on every cycle", async () => {
  const records = await collect(tailThread({
    threadId: "thread-1",
    options: { once: true, turnLimit: 1 },
    readSnapshot: async () => snapshot(rawThread()),
  }))
  assert.deepEqual(records.filter((record) => ["turn", "message", "activity"].includes(record.recordType))
    .map((record) => record.data.id), ["turn-2", "item-5", "item-6"])
})

test("tail reports a requested turn window even when it contains the whole thread", async () => {
  const records = await collect(tailThread({
    threadId: "thread-1",
    options: { once: true, turnLimit: 10 },
    readSnapshot: async () => snapshot(rawThread()),
  }))
  const runtime = records.find((record) => record.recordType === "runtime")
  assert.equal(runtime.data.selection.turnLimit, 10)
  assert.deepEqual(runtime.data.selection.selectedTurnIds, ["turn-1", "turn-2"])
})

test("tail re-emits a record that leaves and returns to a moving turn window", async () => {
  const source = rawThread()
  const versions = [
    [source.turns[0], source.turns[1]],
    [source.turns[1], {
      id: "turn-3",
      status: "completed",
      items: [{ type: "agentMessage", id: "item-7", text: "third" }],
    }],
    [source.turns[0], source.turns[1]],
  ]
  let index = 0
  const records = await collect(tailThread({
    threadId: "thread-1",
    options: { maxCycles: 3, interval: 100, turnLimit: 1 },
    sleep: async () => {},
    readSnapshot: async () => snapshot(rawThread({ turns: versions[index++] })),
  }))
  assert.deepEqual(records.filter((record) => record.recordType === "turn")
    .map((record) => [record.cycle, record.data.id]), [
      [1, "turn-2"],
      [2, "turn-3"],
      [3, "turn-2"],
    ])
})

test("tail validates bounds and JSON termination", () => {
  assert.throws(() => normalizeTailOptions({ once: true, maxCycles: 2 }), InvalidArgumentsError)
  assert.throws(() => normalizeTailOptions({ format: "json" }), InvalidArgumentsError)
  assert.throws(() => normalizeTailOptions({ format: "human", once: true }), InvalidArgumentsError)
  assert.equal(normalizeTailOptions({ maxCycles: 2, format: "json" }).maxCycles, 2)
  assert.equal(TAIL_SCHEMA_VERSION, "codex-thread.tail-record.v1")
})

test("tail emits one end record for timeout and interrupt", async () => {
  let clockCalls = 0
  const timeoutRecords = await collect(tailThread({
    threadId: "thread-1",
    options: { timeout: 100, interval: 100 },
    now: () => [0, 0, 100, 100][clockCalls++] ?? 100,
    sleep: async () => {},
    readSnapshot: async () => snapshot(rawThread()),
  }))
  assert.deepEqual(timeoutRecords.filter((record) => record.recordType === "end")
    .map((record) => record.data.reason), ["timeout"])

  const controller = new AbortController()
  const interruptRecords = await collect(tailThread({
    threadId: "thread-1",
    options: { interval: 100 },
    signal: controller.signal,
    readSnapshot: async () => {
      controller.abort()
      return snapshot(rawThread())
    },
  }))
  assert.deepEqual(interruptRecords.filter((record) => record.recordType === "end")
    .map((record) => record.data.reason), ["interrupt"])
})

test("tail preserves warnings and fails a missing first observation without stdout records", async () => {
  const active = rawThread({ status: { type: "active", activeFlags: ["waiting"] } })
  const records = await collect(tailThread({
    threadId: "thread-1",
    options: { once: true },
    readSnapshot: async () => snapshot(active),
  }))
  assert.ok(records.find((record) => record.recordType === "runtime").data.warnings
    .some((warning) => warning.code === "ACTIVE_THREAD_MAY_CHANGE"))

  const missing = Object.assign(new Error("missing"), { code: "THREAD_NOT_FOUND" })
  const emitted = []
  await assert.rejects((async () => {
    for await (const record of tailThread({
      threadId: "thread-1",
      options: { once: true },
      readSnapshot: async () => { throw missing },
    })) emitted.push(record)
  })(), (error) => error === missing)
  assert.deepEqual(emitted, [])
})

test("tail reports a later missing thread through its end record", async () => {
  const missing = Object.assign(new Error("missing"), { code: "THREAD_NOT_FOUND" })
  let reads = 0
  const records = []
  const iterator = tailThread({
    threadId: "thread-1",
    options: { maxCycles: 2, interval: 100 },
    sleep: async () => {},
    readSnapshot: async () => {
      reads += 1
      if (reads > 1) throw missing
      return snapshot(rawThread())
    },
  })
  for await (const record of iterator) records.push(record)
  assert.equal(records.at(-1).data.reason, "thread-not-found")
  assert.equal(records.at(-1).data.attemptedCycles, 2)
})
