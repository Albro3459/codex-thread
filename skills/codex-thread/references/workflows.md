# codex-thread Workflows

## Find without an exact ID

Keep discovery narrow and inspect metadata before reading transcript content:

```bash
codex-thread list --reverse --limit 20 --format json
codex-thread find --title "sanitized topic" --format json
```

`list.v1` reports `limit`, `offset`, `count`, and `hasMore`. If `hasMore` is
true, page with a larger offset. `find.v1` returns every title match and has
no paging fields. Both outputs exclude message and activity content.

## Confirm and retrieve

```bash
codex-thread get THREAD_ID --last-turn --format json
codex-thread get THREAD_ID --turn-limit 3 --format jsonl
codex-thread get THREAD_ID --format json
```

Start with `--last-turn` and request the full history only after the thread
metadata and latest turn match the task. A response with `selection` is partial
history. An exact `--turn` miss is different from a window beyond the end:
the former emits a `TURN_NOT_FOUND` warning and exits 2, while the latter is
an empty successful page.

## Active history and diagnostics

Run `codex-thread doctor --format json` when setup is uncertain. Doctor checks
Node support, executable resolution, app-server startup, initialization, and
the stable `thread/list` and `thread/read` methods without reading transcript
content.

For a get response, inspect `runtime.historyMayChange`, the runtime status,
the newest turn, and `warnings`. Report active-thread uncertainty. Do not infer
completion from timestamps or from an apparently final message.

Preserve JSONL order, null values, warnings, and stderr diagnostics. Never
replace this workflow with direct searches of databases, rollout files,
browser data, or unrelated logs.
