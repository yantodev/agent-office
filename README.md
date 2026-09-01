# Agent Office

Local-first desktop multi-agent harness inspired by the *category* of apps such as Munder Difflin, implemented from scratch with an original UI and no copied pixel assets.

## MVP features

- Electron + React + TypeScript desktop application.
- Local SQLite agent registry.
- Detect installed coding CLIs: Codex, OpenCode, Claude, Gemini, Qwen, Copilot.
- Create agents with roles and commands.
- Launch each agent as a real pseudo-terminal using `node-pty`.
- Render interactive terminal output with xterm.js.
- 2D office-style dashboard representing each running worker.
- Per-agent start/remove controls.
- Reusable agent profiles with SOUL/system instructions.
- Project/workspace selector with optional per-agent Git worktrees.
- Command Center with durable task board, assignment, retry, and execution.
- Mission orchestrator (Michael) with deterministic bullet/sentence decomposition and profile-based assignment.
- Local schedules/heartbeats with UTC next-run calculation and pause/resume controls.
- Human approval queue for potentially destructive, scope-changing, or costly task prompts.
- Task dependency graph plus branch, artifact, result, error, and review metadata.
- Agent controls for steer, interrupt, POSIX pause/resume, and stop, with crash recovery.
- Profile permission policy, secret redaction, execution budget ledger, and fleet summary.
- Approval-gated GitHub issue import and pull-request preparation/creation through `gh`.
- Single-committer lock for worker branches.
- Settings safety broker with redacted diff, human approval, backup, and atomic CLI config replacement.
- Atomic file mailbox and append-only activity log.
- Markdown shared memory with SQLite FTS5 search.
- Optional deterministic local vector search for shared memory, pin, and retention policy.
- Pixi.js office floor with status-aware avatars, stations, and animated message envelopes.
- Linux AppImage plus Windows NSIS and macOS DMG build targets.
- Cross-platform native smoke test and CI matrix for Ubuntu, Windows, and macOS.

## Run

```bash
npm install
npm run dev
```

Smoke tests:

```bash
npm run smoke:native
npm run smoke:main
npm run smoke:migration
```

Linux build dependencies for `node-pty` may require:

```bash
sudo apt install -y build-essential python3
```

## Recommended next milestones

1. Add provider-specific permission enforcement and richer circuit-breaker constraints.
2. Execute the cross-platform native CI matrix and publish release notes.
3. Harden GitHub sync with richer test reporting and conflict recovery.

## Important

This starter does not include assets or source copied from Munder Difflin. Build your own visual identity or use properly licensed assets.

Reference
<https://chatgpt.com/share/6a96cea6-fc0c-83ec-9a13-913803a02756>
