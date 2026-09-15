---
name: "codex-thread"
description: "Read local Codex threads through the read-only codex-thread CLI. Use for listing, title search, bounded confirmation, selected-turn retrieval, diagnostics, and stable JSON or JSONL output."
---

# Codex Thread Skill

Use `codex-thread` to inspect local Codex conversation history without reading
Codex storage directly or changing a thread. The CLI uses the caller's normal
Codex environment, including `CODEX_HOME` when it is already set.

## Prerequisites

Check both executables before attempting a read:

```bash
command -v codex-thread >/dev/null 2>&1
command -v codex >/dev/null 2>&1
```

If `codex-thread` is missing, install `@albro3459/codex-thread` with the
environment's approved package workflow, for example `npm install -g
@albro3459/codex-thread`. Do not substitute a database or rollout-file scan.
Run this when the installation may be missing, incompatible, or unavailable:

```bash
codex-thread doctor --format json
```

`doctor.v1` never includes transcript content. A failed doctor report is still
complete and its exit status identifies the class of failure.

## Recovery workflow

1. If an exact thread ID is unavailable, discover a candidate with `list` or
   `find`. `list` pages metadata. `find` performs a trimmed,
   case-insensitive substring match against titles only. Neither command
   returns messages, activities, commands, tool output, or instruction text.

   ```bash
   codex-thread list --reverse --limit 20 --format json
   codex-thread find --title "sanitized topic" --format json
   ```

   `list` supports `--limit`, `--offset`, `--reverse`, `--archived`, and
   `--include-subagents`. `find` returns every title match and supports
   `--reverse`, `--archived`, and `--include-subagents`. Do not guess an ID or
   choose among ambiguous matches without confirmation.

2. Confirm one candidate with a bounded read before requesting all history:

   ```bash
   codex-thread get THREAD_ID --last-turn --format json
   ```

   A deep link (`codex://threads/THREAD_ID`) is accepted in place of the ID.
   The exact ID is never treated as a title search.

3. Retrieve only the needed turns when possible:

   ```bash
   codex-thread get THREAD_ID --turn TURN_ID --format json
   codex-thread get THREAD_ID --turn-limit 3 --format jsonl
   codex-thread get THREAD_ID --turn-offset 1 --turn-limit 2 --format json
   ```

   `--turn` is an exact selection and cannot be combined with window options.
   `--last-turn` is the newest one-turn window and cannot be combined with
   `--turn-limit` or `--turn-offset`. Window selections count from the newest
   turn and are emitted in chronological order. A missing exact turn reports
   `TURN_NOT_FOUND` and exits 2. A window beyond the end is a valid empty page
   and exits 0.

4. Request a full read only after the candidate is confirmed:

   ```bash
   codex-thread get THREAD_ID --format json
   ```

## Output rules

Use `--format json` for one `thread.v1`, `list.v1`, `find.v1`, or `doctor.v1`
envelope. Use `--format jsonl` when a consumer needs records. JSONL starts
with a header and then emits normalized records in chronological order. Never
sort those records again.

The presence of `selection` in a thread envelope always means partial history.
Preserve that fact when summarizing the result. Null values are deliberate and
unknown values are not evidence that a title, result, parent, or completion
state can be inferred.

Messages contain normalized user and assistant content. Other Codex items are
activities. Unmapped item types stay under `adapterSpecific` and generate a
warning. Preserve all warnings and report nonzero stderr diagnostics alongside
the machine-readable stdout result.

An active thread may change while it is being read. Check `runtime.status`,
`runtime.historyMayChange`, the newest turn status, and `warnings`. The CLI
reports what its short-lived app-server observation returned. It does not know
another client's in-memory state and must not claim that an active transcript
is complete.

## Safety and scope

The CLI is read-only. Do not search Codex databases, rollout files, browser
profiles, or unrelated logs. Do not print credentials, authentication data,
private prompts, or raw diagnostics that contain them. V1 does not resume,
fork, rename, archive, delete, modify, tail, or build a subagent hierarchy.

For the command details and stable field meanings, read the bundled references:

- [CLI reference](references/cli.md)
- [Recovery workflows](references/workflows.md)
