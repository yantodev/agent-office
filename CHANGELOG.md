# Changelog

## 0.0.1-beta — 2026-09-01

- Memutakhirkan Electron ke `41.10.3` dan `better-sqlite3` ke `13.0.3`; native ABI rebuild serta `npm audit` kini bersih.
- Memperkuat migrasi database legacy, fallback project aktif, crash recovery, serta smoke test mailbox retry/dead-letter dan secret redaction.
- Menyesuaikan shell PTY dan smoke command untuk PowerShell Windows (`-NoLogo -NoProfile -Command`) serta POSIX shell.
- Menambahkan orchestrator mission, scheduler, dependency graph, artifact, review, dan approval queue.
- Menambahkan mailbox routing retry/dead-letter, watchdog, event plane, secret redaction, dan crash recovery.
- Menambahkan pause/resume/steer/interrupt/stop serta single-committer lock.
- Menambahkan GitHub issue sync dan approval-gated pull-request workflow melalui `gh`.
- Menambahkan fleet summary, execution usage ledger, memory pin, dan retention.
- Menambahkan main-process integration smoke test untuk koordinasi IPC, worktree, Git lock, scheduler, config, dan memory.
- Memperbaiki collision branch agent serta pelepasan commit lock setelah commit sukses.
- Menjalankan memory retention otomatis dari scheduler dan memperluas integration smoke ke expiry/pin policy.
- Menambahkan circuit breaker steer budget/rate-limit dan mode constrain yang durable melalui event log.
- Menambahkan GitHub PR preflight untuk uncommitted changes, merge conflict, dan whitespace errors sebelum approval/create.
