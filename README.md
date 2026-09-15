# codex-thread

Read local Codex conversation threads from any agent or terminal.

`codex-thread` starts a private, short-lived `codex app-server` process for each
operation. It uses the Codex installation and standard Codex home already
available to the caller. It does not connect to an open desktop, IDE, or T3 Code
process.

## Requirements

- Node.js 22.16 or newer
- the `codex` CLI available on `PATH`
- local Codex threads in the caller's standard Codex home

The package does not include Codex. Install and sign in to Codex before using
this CLI.

## Install

```bash
npm install --global @albro3459/codex-thread
codex-thread doctor
codex-thread install --skills codex
```

The skill installs under `${CODEX_HOME}/skills/codex-thread` when `CODEX_HOME`
is set. Otherwise it installs under the current user's `.codex/skills` folder.
An existing skill is kept unless you pass `--backup` or `--overwrite`.

## Find a thread

List recent thread metadata:

```bash
codex-thread list --reverse --limit 20
```

Search titles with a case-insensitive substring:

```bash
codex-thread find --title "billing retry" --format json
```

List and find include CLI, IDE, desktop, exec, app-server, and unknown top-level
sources. Add `--include-subagents` to include Codex subagent sources. Add
`--archived` to query archived threads.

`find` searches titles only. It returns every match and never chooses one for
you.

## Read a thread

Use a thread ID:

```bash
codex-thread get 01a0a19f-2c1f-7640-a820-0bdc42e64e10
```

Or use a Codex deep link:

```bash
codex-thread get codex://threads/01a0a19f-2c1f-7640-a820-0bdc42e64e10
```

Confirm a candidate without loading its full history:

```bash
codex-thread get THREAD_ID --last-turn --format json
```

Read one exact turn or a recent window:

```bash
codex-thread get THREAD_ID --turn TURN_ID --format json
codex-thread get THREAD_ID --turn-limit 3 --turn-offset 2 --format jsonl
```

Turn windows count backward from the newest turn and emit selected turns in
chronological order. A response with `selection` contains partial history. A
missing exact turn returns a thread envelope with a `TURN_NOT_FOUND` warning and
exit code 2. A window past the end is a valid empty result.

## Output

List, find, and get support all three output formats:

```text
--format json
--format jsonl
```

JSON returns one versioned envelope. JSONL starts with a header, then emits
thread, turn, message, and activity records in chronological order. List and
find return metadata only.

Doctor and skill installation support human or JSON output. Schema commands
print JSON.

Messages contain normalized user and assistant content. Commands, file changes,
plans, tool calls, web searches, subagent activity, and other items appear under
`activities`. Unknown Codex item types stay available in `adapterSpecific` and
produce a warning.

Print a bundled schema with:

```bash
codex-thread schema thread.v1
```

Available schemas are `thread.v1`, `list.v1`, `find.v1`, `jsonl-record.v1`,
`doctor.v1`, and `error.v1`.

## Exit codes

```text
0  success
1  unexpected failure
2  thread or exact turn not found
3  invalid arguments or install conflict
4  Codex executable or app-server unavailable
```

Errors use `codex-thread.error.v1` JSON on stderr.

## Limits

V1 uses the caller's standard Codex environment. It does not discover profiles,
alternate homes, or T3 storage. A caller that sets `CODEX_HOME` keeps Codex's
normal environment behavior.

The CLI reads stable `thread/list` and `thread/read` app-server methods. It does
not resume, subscribe to, or modify threads. Active history may change while it
is being read, and the output reports that state when the spawned app-server can
observe it. Paginated Codex threads that reject full-history reads require a
future CLI version.

See the official [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
for the underlying protocol.

## Development

```bash
npm run check
```

The repository does not bundle `@openai/codex` and has no runtime npm
dependencies.
