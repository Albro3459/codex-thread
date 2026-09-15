import test from "node:test"
import assert from "node:assert/strict"

import {
  PARTICIPANTS_SCHEMA_VERSION,
  discoverParticipants,
  normalizeParticipantsOptions,
} from "../src/participants.js"
import { assertSchema } from "./fixtures/schema-assert.js"

function rawSummary(id, {
  parentThreadId = null,
  name = id,
  status = { type: "idle" },
  source = "subAgent",
} = {}) {
  return {
    id,
    sessionId: `${id}-session`,
    name,
    preview: "do not expose this preview",
    source,
    originator: "codex",
    cwd: "/tmp/codex-thread-test",
    projectId: null,
    parentThreadId,
    forkedFromId: null,
    ephemeral: false,
    isPinned: false,
    historyMode: "regular",
    modelProvider: "openai",
    model: "gpt-test",
    reasoningEffort: "high",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    recencyAt: 1_700_000_100,
    cliVersion: "0.2.0",
    gitInfo: null,
    section: null,
    agentNickname: `nick-${id}`,
    agentRole: "worker",
    status,
    turns: [{ id: "secret-turn", items: [{ type: "userMessage", content: [{ type: "text", text: "secret" }] }] }],
  }
}

function rootWithActivities(activities, selection = null) {
  return {
    thread: { id: "root-thread" },
    activities,
    ...(selection ? { selection } : {}),
  }
}

function activity(id, turnId, payload, kind = "collabAgentToolCall") {
  return { id, turnId, kind, payload }
}

test("normalizes participant paging and hierarchy options", () => {
  const options = normalizeParticipantsOptions({ limit: "2", offset: "1", reverse: true, tree: true })
  assert.deepEqual(options, {
    limit: 2,
    offset: 1,
    reverse: true,
    tree: true,
    selection: null,
  })
  assert.throws(
    () => normalizeParticipantsOptions({ limit: 0 }),
    (error) => error.code === "INVALID_ARGUMENTS",
  )
  assert.throws(
    () => normalizeParticipantsOptions({ offset: "nope" }),
    (error) => error.code === "INVALID_ARGUMENTS",
  )
})

test("discovers and deduplicates explicit child IDs from both activity kinds", async () => {
  const result = await discoverParticipants({
    threadId: "root-thread",
    root: rootWithActivities([
      activity("spawn-1", "turn-1", {
        senderThreadId: "root-thread",
        receiverThreadIds: ["child-b", "child-a"],
      }),
      activity("spawn-2", "turn-2", {
        senderThreadId: "root-thread",
        agentThreadId: "child-a",
      }, "subAgentActivity"),
    ]),
    listedThreads: [rawSummary("child-a", { parentThreadId: "root-thread" }), rawSummary("child-b", { parentThreadId: "root-thread" })],
  })

  assert.deepEqual(result.participants.map((participant) => participant.threadId), ["child-a", "child-b"])
  assert.equal(result.participants[0].activityCount, 2)
  assert.deepEqual(result.participants[0].turnIds, ["turn-1", "turn-2"])
  assert.equal(result.hierarchyAvailable, true)
  assert.deepEqual(result.warnings, [])
  assertSchema(result, "participants")
})

test("enriches listed children without exposing transcript content or reading them", async () => {
  const calls = []
  const result = await discoverParticipants({
    threadId: "root-thread",
    root: rootWithActivities([activity("spawn", "turn-1", {
      senderThreadId: "root-thread",
      agentThreadId: "child-a",
    })]),
    listedThreads: [{
      ...rawSummary("child-a", {
        parentThreadId: "root-thread",
        status: { type: "completed", prompt: "SECRET_STATUS_PROMPT" },
      }),
      result: "SECRET_UNKNOWN_RESULT",
    }],
    readThread: async (...args) => calls.push(args),
  })
  const serialized = JSON.stringify(result)
  assert.deepEqual(calls, [])
  assert.equal(result.participants[0].state, "finished")
  assert.equal(serialized.includes("do not expose this preview"), false)
  assert.equal(serialized.includes("secret-turn"), false)
  assert.equal(serialized.includes("secret"), false)
  assert.equal(serialized.includes("SECRET_STATUS_PROMPT"), false)
  assert.equal(serialized.includes("SECRET_UNKNOWN_RESULT"), false)
})

test("recovers an activity child omitted from list and preserves it on metadata failure", async () => {
  const calls = []
  const recovered = await discoverParticipants({
    threadId: "root-thread",
    root: rootWithActivities([activity("spawn", "turn-1", {
      senderThreadId: "root-thread",
      receiverThreadId: "child-a",
    })]),
    readThread: async (id, options) => {
      calls.push([id, options])
      return { thread: rawSummary(id, { parentThreadId: "root-thread" }) }
    },
  })
  assert.deepEqual(calls, [["child-a", { includeTurns: false }]])
  assert.equal(recovered.participants[0].title, "child-a")
  assert.ok(recovered.warnings.some((warning) => warning.code === "CHILD_NOT_IN_LIST"))

  const failed = await discoverParticipants({
    threadId: "root-thread",
    root: rootWithActivities([activity("spawn", "turn-1", {
      senderThreadId: "root-thread",
      receiverThreadId: "child-missing",
    })]),
    readThread: async () => { throw new Error("gone") },
  })
  assert.deepEqual(failed.participants.map((participant) => participant.threadId), ["child-missing"])
  assert.equal(failed.participants[0].title, null)
  assert.ok(failed.warnings.some((warning) => warning.code === "CHILD_READ_FAILED"))
  assert.ok(failed.warnings.some((warning) => warning.code === "CHILD_NOT_IN_LIST"))
})

test("rejects conflicting, unresolved, and cyclic parent links", async () => {
  const result = await discoverParticipants({
    threadId: "root-thread",
    root: rootWithActivities([
      activity("spawn-a", "turn-1", { agentThreadId: "child-a" }),
      activity("spawn-b", "turn-1", { agentThreadId: "child-b" }),
      activity("spawn-c", "turn-1", { agentThreadId: "child-c" }),
      activity("spawn-d", "turn-1", { senderThreadId: "root-thread", agentThreadId: "child-d" }),
    ]),
    listedThreads: [
      rawSummary("child-a", { parentThreadId: "child-b" }),
      rawSummary("child-b", { parentThreadId: "child-a" }),
      rawSummary("child-c", { parentThreadId: "unresolved" }),
      rawSummary("child-d", { parentThreadId: "other-parent" }),
    ],
  })
  const codes = result.warnings.map((warning) => warning.code)
  assert.ok(codes.includes("CONFLICTING_PARENT"))
  assert.ok(codes.includes("PARENT_CYCLE"))
  assert.ok(codes.includes("UNRESOLVED_PARENT"))
  assert.equal(result.hierarchyAvailable, false)
  assert.ok(result.participants.every((participant) => participant.path === null))
})

test("builds explicit nested trees and reports page truncation", async () => {
  const result = await discoverParticipants({
    threadId: "root-thread",
    root: rootWithActivities([
      activity("spawn-a", "turn-1", { senderThreadId: "root-thread", agentThreadId: "child-a" }),
      activity("spawn-b", "turn-1", { senderThreadId: "child-a", agentThreadId: "child-b" }),
      activity("spawn-c", "turn-1", { senderThreadId: "root-thread", agentThreadId: "child-c" }),
    ]),
    listedThreads: [
      rawSummary("child-a", { parentThreadId: "root-thread" }),
      rawSummary("child-b", { parentThreadId: "child-a" }),
      rawSummary("child-c", { parentThreadId: "root-thread" }),
    ],
    options: { limit: 1, offset: 1, tree: true },
  })
  assert.equal(result.counts.total, 3)
  assert.equal(result.counts.returned, 1)
  assert.equal(result.counts.hasMore, true)
  assert.deepEqual(result.participants.map((participant) => participant.threadId), ["child-b"])
  assert.equal(result.participants[0].path, "main.subagent1.subagent1a")
  assert.equal(result.participants[0].children, undefined)
  assert.ok(result.warnings.some((warning) => warning.code === "PARENT_OUT_OF_PAGE"))

  const full = await discoverParticipants({
    threadId: "root-thread",
    root: rootWithActivities([
      activity("spawn-a", "turn-1", { senderThreadId: "root-thread", agentThreadId: "child-a" }),
      activity("spawn-b", "turn-1", { senderThreadId: "child-a", agentThreadId: "child-b" }),
    ]),
    listedThreads: [rawSummary("child-a", { parentThreadId: "root-thread" }), rawSummary("child-b", { parentThreadId: "child-a" })],
    options: { tree: true },
  })
  assert.equal(full.participants.length, 1)
  assert.equal(full.participants[0].children[0].path, "main.subagent1.subagent1a")
  assert.equal(full.participants[0].children[0].depth, 2)
})

test("applies turn selection, ordering, and counts before paging", async () => {
  const result = await discoverParticipants({
    threadId: "root-thread",
    root: rootWithActivities([
      activity("spawn-a", "turn-1", { senderThreadId: "root-thread", agentThreadId: "child-a" }),
      activity("spawn-b", "turn-2", { senderThreadId: "root-thread", agentThreadId: "child-b" }),
      activity("spawn-c", "turn-3", { senderThreadId: "root-thread", agentThreadId: "child-c" }),
    ], { kind: "turn-window", turnLimit: 1, turnOffset: 0, totalTurns: 3, selectedTurnIds: ["turn-3"] }),
    listedThreads: [rawSummary("child-a", { parentThreadId: "root-thread" }), rawSummary("child-b", { parentThreadId: "root-thread" }), rawSummary("child-c", { parentThreadId: "root-thread" })],
    options: { reverse: true, limit: 1, offset: 0 },
  })
  assert.deepEqual(result.participants.map((participant) => participant.threadId), ["child-c"])
  assert.equal(result.counts.total, 1)
  assert.equal(result.counts.returned, 1)
  assert.deepEqual(result.selection.selectedTurnIds, ["turn-3"])
})

test("uses explicit child activity status without exposing its result message", async () => {
  const result = await discoverParticipants({
    threadId: "root-thread",
    root: rootWithActivities([activity("spawn", "turn-1", {
      senderThreadId: "root-thread",
      receiverThreadIds: ["child-a"],
      agentsStates: {
        "child-a": { status: "completed", message: "SECRET_CHILD_RESULT" },
      },
    })]),
  })
  assert.equal(result.participants[0].state, "finished")
  assert.equal(JSON.stringify(result).includes("SECRET_CHILD_RESULT"), false)
})

test("returns a valid empty envelope when no child references exist", async () => {
  const result = await discoverParticipants({
    threadId: "root-thread",
    root: rootWithActivities([
      activity("ordinary", "turn-1", { prompt: "not a child reference" }, "commandExecution"),
    ]),
  })
  assert.equal(result.schemaVersion, PARTICIPANTS_SCHEMA_VERSION)
  assert.deepEqual(result.participants, [])
  assert.deepEqual(result.counts, { total: 0, returned: 0, hasMore: false })
  assert.equal(result.hierarchyAvailable, false)
  assertSchema(result, "participants")
})

test("preserves root selection warnings", async () => {
  const result = await discoverParticipants({
    threadId: "root-thread",
    root: {
      ...rootWithActivities([]),
      selection: {
        kind: "turn",
        turnId: "missing",
        turnLimit: null,
        turnOffset: null,
        totalTurns: 1,
        selectedTurnIds: [],
      },
      warnings: [{
        code: "TURN_NOT_FOUND",
        message: "The thread does not contain the supplied turn ID.",
        details: { turnId: "missing" },
      }],
    },
  })
  assert.deepEqual(result.warnings.map((item) => item.code), ["TURN_NOT_FOUND"])
})
