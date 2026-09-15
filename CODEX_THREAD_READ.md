# Read a local Codex thread

The manual rollout-file recipe that started this project has been replaced by
the `codex-thread` CLI. The CLI uses Codex's supported read-only app-server
methods and avoids direct storage parsing.

```bash
codex-thread doctor
codex-thread find --title "part of the title" --format json
codex-thread get THREAD_ID --last-turn --format json
```

See [README.md](README.md) for the full command and output contract.
