# codex-thread CLI Reference

The CLI is read-only and uses the existing `codex` executable. It inherits the
caller's environment, including an existing `CODEX_HOME`.

## Commands

```text
codex-thread list [--limit N] [--offset N] [--reverse] [--archived] [--include-subagents]
codex-thread find --title TEXT [--reverse] [--archived] [--include-subagents]
codex-thread get THREAD_ID|codex://threads/THREAD_ID [--last-turn | --turn ID | --turn-limit N [--turn-offset N]]
codex-thread tail THREAD_ID|codex://threads/THREAD_ID [--once] [--interval MS] [--max-cycles N] [--timeout MS] [--turn-limit N]
codex-thread participants THREAD_ID|codex://threads/THREAD_ID [--last-turn | --turn ID | --turn-limit N [--turn-offset N]] [--limit N] [--offset N] [--reverse] [--tree]
codex-thread doctor
codex-thread schema thread.v1|list.v1|find.v1|jsonl-record.v1|tail-record.v1|participants.v1|doctor.v1|error.v1
codex-thread install --skills codex
```

List, find, and get accept `--format human|json|jsonl`. Doctor accepts human or
JSON. Help and version are available globally. JSON is an envelope. JSONL
starts with a header and then emits records in chronological order. `find` has
no limit or offset and returns every title match.

Tail supports JSONL or JSON and defaults to JSONL. JSON requires a bound. The
interval range is 100 through 60000 milliseconds. `--once` cannot be combined
with other lifecycle bounds. Participants supports all three formats. `--tree`
is available for human and JSON output, while JSONL stays flat.

## Stable schemas

The package owns these identifiers:

```text
codex-thread.thread.v1
codex-thread.list.v1
codex-thread.find.v1
codex-thread.jsonl-record.v1
codex-thread.tail-record.v1
codex-thread.participants.v1
codex-thread.doctor.v1
codex-thread.error.v1
```

`thread.v1` contains `thread`, `turns`, `messages`, `activities`, `runtime`,
and `warnings`. A `selection` object is present only for bounded history and
always means partial output. List and find summaries contain metadata only.

Errors are JSON on stderr:

```json
{
  "schemaVersion": "codex-thread.error.v1",
  "code": "INVALID_ARGUMENTS",
  "message": "limit must be a positive integer.",
  "details": { "field": "limit", "value": "0" }
}
```

Exit codes are 0 for success, 1 for an unexpected failure, 2 for a missing
thread or exact turn, 3 for invalid arguments or an install conflict, and 4
when `codex` or its app-server is unavailable.

## Install the bundled skill

```bash
codex-thread install --skills codex
codex-thread install --skills codex --backup
codex-thread install --skills codex --overwrite
```

The installer copies only the bundled `SKILL.md`, references, and
`agents/openai.yaml`. It never silently replaces an existing destination.
