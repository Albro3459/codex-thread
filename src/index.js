import { createAppServerClient } from "./app-server.js"
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
import { parseThreadReference, validateThreadId } from "./reference.js"
import { VERSION } from "./version.js"

const SERVER_PAGE_LIMIT = 100

function assertListResponse(response) {
  if (!response || !Array.isArray(response.data)) {
    throw new AppServerProtocolError("Codex app-server returned an invalid thread list.")
  }
  if (response.nextCursor !== null && response.nextCursor !== undefined
    && typeof response.nextCursor !== "string") {
    throw new AppServerProtocolError("Codex app-server returned an invalid list cursor.")
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
      if (!response?.thread || response.thread.id !== threadId) {
        if (!response?.thread) throw new ThreadNotFoundError(threadId)
        throw new AppServerProtocolError("Codex app-server returned the wrong thread.", {
          requestedThreadId: threadId,
          returnedThreadId: response.thread.id ?? null,
        })
      }
      if (!Array.isArray(response.thread.turns)) {
        throw new AppServerProtocolError("Codex app-server omitted turns from a full thread read.", {
          threadId,
        })
      }
      return normalizeThread(response.thread, {
        selection,
        toolVersion: VERSION,
        observedAt: new Date(now()).toISOString(),
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
