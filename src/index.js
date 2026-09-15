import {
  createAppServerClient,
  SUBAGENT_SOURCE_KINDS,
} from "./app-server.js"
import {
  AppServerProtocolError,
  ThreadNotFoundError,
  UnsupportedHistoryError,
} from "./errors.js"
import {
  normalizeThread,
  normalizeThreadList,
  normalizeThreadSearch,
} from "./normalize.js"
import {
  normalizeFindOptions,
  normalizeListOptions,
  normalizeTurnSelection,
} from "./query-options.js"
import { discoverParticipants } from "./participants.js"
import { parseThreadReference, validateThreadId } from "./reference.js"
import { tailThread as followThread } from "./tail.js"
import { VERSION } from "./version.js"

const SERVER_PAGE_LIMIT = 100

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertListResponse(response) {
  if (!response || !Array.isArray(response.data)) {
    throw new AppServerProtocolError("Codex app-server returned an invalid thread list.")
  }
  if (response.nextCursor !== null && response.nextCursor !== undefined
    && typeof response.nextCursor !== "string") {
    throw new AppServerProtocolError("Codex app-server returned an invalid list cursor.")
  }
  for (const [index, thread] of response.data.entries()) {
    if (!isObject(thread)) {
      throw new AppServerProtocolError("Codex app-server returned an invalid thread summary.", {
        index,
      })
    }
  }
}

function assertThreadResponse(thread, threadId) {
  if (thread === null || thread === undefined) throw new ThreadNotFoundError(threadId)
  if (!isObject(thread)) {
    throw new AppServerProtocolError("Codex app-server returned an invalid thread.", {
      threadId,
    })
  }
  if (thread.id !== threadId) {
    throw new AppServerProtocolError("Codex app-server returned the wrong thread.", {
      requestedThreadId: threadId,
      returnedThreadId: thread.id ?? null,
    })
  }
  if (!Array.isArray(thread.turns)) {
    throw new AppServerProtocolError("Codex app-server omitted turns from a full thread read.", {
      threadId,
    })
  }
  for (const [turnIndex, turn] of thread.turns.entries()) {
    if (!isObject(turn)
      || (turn.id !== null && turn.id !== undefined && typeof turn.id !== "string")
      || !Array.isArray(turn.items)) {
      throw new AppServerProtocolError("Codex app-server returned an invalid turn.", {
        threadId,
        turnIndex,
      })
    }
    for (const [itemIndex, item] of turn.items.entries()) {
      if (!isObject(item)) {
        throw new AppServerProtocolError("Codex app-server returned an invalid turn item.", {
          threadId,
          turnId: turn.id,
          itemIndex,
        })
      }
      if (item.type === "agentMessage"
        && item.text !== null
        && item.text !== undefined
        && typeof item.text !== "string") {
        throw new AppServerProtocolError("Codex app-server returned an invalid assistant message.", {
          threadId,
          turnId: turn.id,
          itemIndex,
        })
      }
    }
  }
}

function assertThreadMetadataResponse(thread, threadId) {
  if (thread === null || thread === undefined) throw new ThreadNotFoundError(threadId)
  if (!isObject(thread)) {
    throw new AppServerProtocolError("Codex app-server returned invalid thread metadata.", {
      threadId,
    })
  }
  if (thread.id !== threadId) {
    throw new AppServerProtocolError("Codex app-server returned metadata for the wrong thread.", {
      requestedThreadId: threadId,
      returnedThreadId: thread.id ?? null,
    })
  }
}

async function collectThreads(session, options, { stopAfter = null } = {}) {
  const threads = []
  const seenCursors = new Set()
  let cursor = null

  while (true) {
    const remaining = stopAfter === null ? SERVER_PAGE_LIMIT : Math.max(1, stopAfter - threads.length)
    const response = await session.listThreads({
      cursor,
      limit: Math.min(SERVER_PAGE_LIMIT, remaining),
      sortKey: "updated_at",
      sortDirection: options.reverse ? "desc" : "asc",
      archived: options.archived,
      includeSubagents: options.includeSubagents,
      ...(options.sourceKinds ? { sourceKinds: options.sourceKinds } : {}),
    })
    assertListResponse(response)
    threads.push(...response.data)

    if (!response.nextCursor || (stopAfter !== null && threads.length >= stopAfter)) {
      return { threads, serverHasMore: Boolean(response.nextCursor) }
    }
    if (seenCursors.has(response.nextCursor)) {
      throw new AppServerProtocolError("Codex app-server repeated a list cursor.", {
        cursor: response.nextCursor,
      })
    }
    seenCursors.add(response.nextCursor)
    cursor = response.nextCursor
  }
}

function protocolThreadNotFound(error) {
  if (!(error instanceof AppServerProtocolError)) return false
  const message = `${error.message} ${error.serverMessage ?? ""}`.toLowerCase()
  return message.includes("thread") && (
    message.includes("not found")
    || message.includes("does not exist")
    || message.includes("no rollout")
  )
}

function protocolNeedsExperimentalPagination(error) {
  if (!(error instanceof AppServerProtocolError)) return false
  const message = `${error.message} ${error.serverMessage ?? ""}`.toLowerCase()
  return message.includes("paginated") && (
    message.includes("includeturns")
    || message.includes("thread/turns/list")
    || message.includes("full-history")
  )
}

export function createCodexThreadClient(options = {}) {
  const appServer = options.appServerClient ?? createAppServerClient(options.appServer)
  const now = typeof options.now === "function" ? options.now : Date.now

  return Object.freeze({
    async listThreads(requestOptions = {}) {
      const listOptions = normalizeListOptions(requestOptions)
      const needed = listOptions.offset + listOptions.limit + 1
      const collected = await appServer.withSession((session) => (
        collectThreads(session, listOptions, { stopAfter: needed })
      ))
      const page = collected.threads.slice(
        listOptions.offset,
        listOptions.offset + listOptions.limit,
      )
      const hasMore = collected.threads.length > listOptions.offset + listOptions.limit
        || collected.serverHasMore
      return normalizeThreadList(page, {
        options: listOptions,
        hasMore,
        toolVersion: VERSION,
      })
    },

    async findThreads(requestOptions = {}) {
      const findOptions = normalizeFindOptions(requestOptions)
      const collected = await appServer.withSession((session) => collectThreads(session, findOptions))
      const query = findOptions.title.toLowerCase()
      const matches = collected.threads.filter((thread) => (
        typeof thread?.name === "string" && thread.name.toLowerCase().includes(query)
      ))
      return normalizeThreadSearch(matches, { options: findOptions, toolVersion: VERSION })
    },

    async getThread(threadReference, requestOptions = {}) {
      const threadId = parseThreadReference(threadReference)
      const selection = normalizeTurnSelection(requestOptions)
      let response
      try {
        response = await appServer.readThread(threadId, { includeTurns: true })
      } catch (error) {
        if (protocolThreadNotFound(error)) throw new ThreadNotFoundError(threadId)
        if (protocolNeedsExperimentalPagination(error)) throw new UnsupportedHistoryError(threadId)
        throw error
      }
      assertThreadResponse(response?.thread, threadId)
      return normalizeThread(response.thread, {
        selection,
        toolVersion: VERSION,
        observedAt: new Date(now()).toISOString(),
      })
    },

    tailThread(threadReference, requestOptions = {}) {
      const threadId = parseThreadReference(threadReference)
      return followThread({
        threadId,
        options: requestOptions,
        now,
        sleep: options.sleep,
        signal: requestOptions.signal,
        readSnapshot: async () => {
          let response
          try {
            response = await appServer.readThread(threadId, { includeTurns: true })
          } catch (error) {
            if (protocolThreadNotFound(error)) throw new ThreadNotFoundError(threadId)
            if (protocolNeedsExperimentalPagination(error)) throw new UnsupportedHistoryError(threadId)
            throw error
          }
          assertThreadResponse(response?.thread, threadId)
          return normalizeThread(response.thread, {
            toolVersion: VERSION,
            observedAt: new Date(now()).toISOString(),
          })
        },
      })
    },

    async getParticipants(threadReference, requestOptions = {}) {
      const threadId = parseThreadReference(threadReference)
      const selection = normalizeTurnSelection(requestOptions)
      let rootResponse
      try {
        rootResponse = await appServer.readThread(threadId, { includeTurns: true })
      } catch (error) {
        if (protocolThreadNotFound(error)) throw new ThreadNotFoundError(threadId)
        if (protocolNeedsExperimentalPagination(error)) throw new UnsupportedHistoryError(threadId)
        throw error
      }
      assertThreadResponse(rootResponse?.thread, threadId)
      const root = normalizeThread(rootResponse.thread, {
        selection,
        toolVersion: VERSION,
        observedAt: new Date(now()).toISOString(),
      })
      const listOptions = {
        reverse: false,
        archived: false,
        includeSubagents: true,
        sourceKinds: [...SUBAGENT_SOURCE_KINDS],
      }
      const listed = await appServer.withSession((session) => collectThreads(session, listOptions))
      return discoverParticipants({
        threadId,
        root,
        listedThreads: listed.threads,
        options: { ...requestOptions, selection },
        toolVersion: VERSION,
        readThread: async (childThreadId) => {
          const response = await appServer.readThread(childThreadId, { includeTurns: false })
          assertThreadMetadataResponse(response?.thread, childThreadId)
          return response
        },
      })
    },
  })
}

export { createAppServerClient, parseThreadReference, validateThreadId }
export {
  AppServerError,
  AppServerProtocolError,
  AppServerTimeoutError,
  CodexThreadError,
  CodexUnavailableError,
  EXIT_CODES,
  InvalidArgumentsError,
  SkillInstallationError,
  ThreadNotFoundError,
  TurnNotFoundError,
  UnsupportedHistoryError,
  serializeError,
} from "./errors.js"
export {
  FIND_SCHEMA_VERSION,
  LIST_SCHEMA_VERSION,
  THREAD_SCHEMA_VERSION,
  normalizeThread,
  normalizeThreadList,
  normalizeThreadSearch,
  normalizeThreadSummary,
} from "./normalize.js"
export {
  DEFAULT_LIST_LIMIT,
  DEFAULT_TURN_LIMIT,
  normalizeCount,
  normalizeFindOptions,
  normalizeListOptions,
  normalizePositiveCount,
  normalizeTurnSelection,
} from "./query-options.js"
export {
  DEFAULT_TAIL_INTERVAL_MS,
  MAX_TAIL_INTERVAL_MS,
  MIN_TAIL_INTERVAL_MS,
  TAIL_SCHEMA_VERSION,
  normalizeTailOptions,
  snapshotRecords,
  tailThread,
} from "./tail.js"
export {
  DEFAULT_PARTICIPANT_LIMIT,
  PARTICIPANTS_SCHEMA_VERSION,
  buildParticipants,
  discoverParticipants,
  normalizeParticipantsOptions,
} from "./participants.js"
export {
  DOCTOR_SCHEMA_VERSION,
  doctorExitCode,
  formatDoctorHuman,
  inspectInstallation,
} from "./doctor.js"
export {
  BUNDLED_SCHEMAS,
  formatBundledSchema,
  readBundledSchema,
  resolveSchemaPath,
} from "./schema.js"
export {
  SKILL_FILES,
  SKILL_NAME,
  bundledSkillRoot,
  installBundledSkill,
  resolveSkillInstallTarget,
  validateBundledSkill,
} from "./skill-install.js"
export { VERSION }
