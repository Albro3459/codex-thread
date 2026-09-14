# Read a local Codex thread

Use this for threads created by the Codex VS Code extension on this machine.

It only reads local files.

## Get the thread ID

From a deep link:

```text
codex://threads/01a0a0f0-e40c-7ab2-9bcb-c277d557d2eb
```

The thread ID is the final UUID:

```text
01a0a0f0-e40c-7ab2-9bcb-c277d557d2eb
```

Set it in the shell:

```bash
THREAD_ID='01a0a0f0-e40c-7ab2-9bcb-c277d557d2eb'
```

## Confirm the thread exists

```bash
rg "$THREAD_ID" /Users/abrodsky/.codex/session_index.jsonl
```

## Find its rollout

Active threads:

```bash
find /Users/abrodsky/.codex/sessions \
  -type f -name "*-${THREAD_ID}.jsonl" -print
```

Archived threads:

```bash
find /Users/abrodsky/.codex/archived_sessions \
  -type f -name "*-${THREAD_ID}.jsonl" -print
```

Copy the matching path:

```bash
ROLLOUT='/Users/abrodsky/.codex/sessions/YYYY/MM/DD/rollout-...jsonl'
```

## Print the visible conversation

```bash
python3 - "$ROLLOUT" <<'PY'
import json
import sys

for line in open(sys.argv[1]):
    item = json.loads(line)
    if item.get("type") != "event_msg":
        continue

    payload = item.get("payload", {})
    kind = payload.get("type")
    if kind == "user_message":
        role = "USER"
    elif kind == "agent_message":
        role = "ASSISTANT"
    else:
        continue

    print(f"\n## {role}\n\n{payload.get('message', '')}")
PY
```

This skips developer instructions, reasoning records, and tool traffic.

## Inspect the raw thread

```bash
less "$ROLLOUT"
```

Raw rollouts can contain internal instructions, commands, tool output, paths,
and sensitive text. Avoid copying the full file into another chat.

An active thread may append new records while it is being read.

