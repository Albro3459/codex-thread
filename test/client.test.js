import test from "node:test"
import assert from "node:assert/strict"

import {
  AppServerProtocolError,
  ThreadNotFoundError,
  UnsupportedHistoryError,
  createCodexThreadClient,
} from "../src/index.js"
import { rawThread, threadSummary } from "./fixtures/raw-thread-fixture.js"

function fakeAppServer({ pages = [], thread = rawThread(), readError = null } = {}) {
  const listRequests = []
  const appServer = {
    async withSession(callback) {
      let pageIndex = 0
      const session = {
        async listThreads(request) {
          listRequests.push(request)
          const page = pages[pageIndex++] ?? { data: [], nextCursor: null }
          return page
        },
      }
      return callback(session)
    },
    async readThread(threadId, options) {
      if (readError) throw readError
      return { thread: typeof thread === "function" ? thread(threadId, options) : thread }
    },
  }
  return { appServer, listRequests }
}

function protocolError(serverMessage) {
  const error = new AppServerProtocolError("Codex app-server rejected the request.")
  Object.defineProperty(error, "serverMessage", { value: serverMessage })
  return error
}

test("listThreads collects pages, applies offset and limit, and reports remaining results", async () => {
  const { appServer, listRequests } = fakeAppServer({
    pages: [
      { data: [threadSummary("one", "One"), threadSummary("two", "Two")], nextCursor: "page-2" },
      { data: [threadSummary("three", "Three"), threadSummary("four", "Four")], nextCursor: "page-3" },
    ],
  })

  const result = await createCodexThreadClient({ appServerClient: appServer }).listThreads({
    limit: 2,
    offset: 1,
  })

  assert.deepEqual(result.threads.map((thread) => thread.id), ["two", "three"])
  assert.equal(result.count, 2)
  assert.equal(result.hasMore, true)
  assert.equal(listRequests.length, 2)
  assert.equal(listRequests[0].cursor, null)
  assert.equal(listRequests[0].limit, 4)
  assert.equal(listRequests[1].cursor, "page-2")
  assert.equal(listRequests[1].limit, 2)
})

test("list and find reject a repeated cursor instead of looping", async () => {
  const pages = [
    { data: [threadSummary("one", "One")], nextCursor: "same" },
    { data: [threadSummary("two", "Two")], nextCursor: "same" },
  ]
  const listClient = createCodexThreadClient({ appServerClient: fakeAppServer({ pages }).appServer })
  await assert.rejects(
    listClient.findThreads({ title: "two" }),
    (error) => error instanceof AppServerProtocolError && error.details.cursor === "same",
  )

  const listClientWithOffset = createCodexThreadClient({ appServerClient: fakeAppServer({ pages }).appServer })
  await assert.rejects(
    listClientWithOffset.listThreads({ limit: 1, offset: 10 }),
    (error) => error instanceof AppServerProtocolError && error.details.cursor === "same",
  )
})

test("findThreads searches every page with trimmed case-insensitive title matching", async () => {
  const { appServer, listRequests } = fakeAppServer({
    pages: [
      { data: [threadSummary("one", "First result")], nextCursor: "page-2" },
      { data: [threadSummary("two", "The IMPORTANT result")], nextCursor: "page-3" },
      { data: [threadSummary("three", "last result")], nextCursor: null },
    ],
  })

  const result = await createCodexThreadClient({ appServerClient: appServer }).findThreads({
    title: "  important ",
  })

  assert.deepEqual(result.threads.map((thread) => thread.id), ["two"])
  assert.equal(result.filters.title, "important")
  assert.equal(listRequests.length, 3)
  assert.ok(!Object.hasOwn(result.threads[0], "preview"))
  assert.ok(!Object.hasOwn(result.threads[0], "turns"))
})

test("getThread requests complete turns and rejects wrong or malformed responses", async () => {
  const calls = []
  const { appServer } = fakeAppServer({
    thread: (threadId, options) => {
      calls.push({ threadId, options })
      return rawThread()
    },
  })
  const client = createCodexThreadClient({
    appServerClient: appServer,
    now: () => 1_700_000_200_000,
  })
  const result = await client.getThread("thread-1")
  assert.equal(result.thread.id, "thread-1")
  assert.deepEqual(calls, [{ threadId: "thread-1", options: { includeTurns: true } }])
  assert.equal(result.runtime.observedAt, "2023-11-14T22:16:40.000Z")

  const wrong = createCodexThreadClient({
    appServerClient: fakeAppServer({ thread: rawThread({ id: "other-thread" }) }).appServer,
  })
  await assert.rejects(wrong.getThread("thread-1"), AppServerProtocolError)

  const malformed = createCodexThreadClient({
    appServerClient: fakeAppServer({ thread: { id: "thread-1" } }).appServer,
  })
  await assert.rejects(malformed.getThread("thread-1"), AppServerProtocolError)
})

test("getThread maps missing-thread and paginated-history protocol errors", async () => {
  const missing = protocolError("thread does not exist")
  const missingClient = createCodexThreadClient({
    appServerClient: fakeAppServer({ readError: missing }).appServer,
  })
  await assert.rejects(
    missingClient.getThread("thread-1"),
    (error) => error instanceof ThreadNotFoundError && error.details.threadId === "thread-1",
  )

  const paginated = protocolError("full-history requires paginated thread/turns/list")
  const paginatedClient = createCodexThreadClient({
    appServerClient: fakeAppServer({ readError: paginated }).appServer,
  })
  await assert.rejects(
    paginatedClient.getThread("thread-1"),
    (error) => error instanceof UnsupportedHistoryError
      && error.details.threadId === "thread-1",
  )
})
