# Agent Office — TODO

Roadmap ini disusun dari percakapan pada [ChatGPT share](https://chatgpt.com/share/6a96cea6-fc0c-83ec-9a13-913803a02756) dan konsep arsitektur pada [Munder Difflin README](https://github.com/chaitanyagiri/munder-difflin/blob/main/README.md) serta [SPEC](https://github.com/chaitanyagiri/munder-difflin/blob/main/SPEC.md).

## Status saat ini

- [x] Electron + React + TypeScript.
- [x] SQLite untuk registry agent.
- [x] Native terminal dengan `node-pty` dan xterm.js.
- [x] Office floor 2D dasar.
- [x] Deteksi CLI: Codex, OpenCode, Claude, Gemini, Qwen, Copilot.
- [x] Agent profiles dan reusable SOUL/system instructions.
- [x] Native dependency externalization dan rebuild terhadap Electron ABI.
- [x] `npm run typecheck` dan `npm run build` berhasil.
- [x] Main-process integration smoke test untuk schema dan IPC coordination.

## P0 — Fondasi multi-agent

### 1. Project/workspace dan Git worktree

- [x] Tambahkan entitas `projects` dan project aktif.
- [x] Tambahkan pemilih workspace/project di UI.
- [x] Simpan `cwd` berdasarkan project aktif, bukan `'.'`.
- [x] Buat satu Git worktree per agent secara opsional.
- [x] Tambahkan branch policy dasar dan validasi repository.
- [x] Jalankan operasi workspace/Git melalui main process IPC.
- [x] Tampilkan workspace dan branch pada agent terpilih.
- [x] Tampilkan status dirty files dan worktree pada kartu agent.

**Selesai jika:** dua agent dapat bekerja paralel pada project yang sama tanpa berbagi working tree.

### 2. Orchestrator / Michael

- [x] Tambahkan agent supervisor yang menerima request dari user.
- [x] Buat task ledger: `backlog → assigned → running → blocked → review → done/failed`.
- [x] Implementasikan decomposition request menjadi task kecil dengan dependency.
- [x] Implementasikan assignment task ke agent berdasarkan profile.
- [x] Simpan hasil, artifact, error, branch, dan review metadata pada task.
- [x] Tambahkan approval queue untuk operasi destructive, perubahan scope, dan biaya tinggi.
- [x] Tambahkan kontrol `pause`, `steer`, `resume`, `interrupt`, dan `stop` (pause/resume native process saat ini POSIX).
- [x] Pastikan supervisor tidak mengambil alih commit agent lain; gunakan single-committer lock.

**Selesai jika:** satu request user dapat dipecah, dikerjakan beberapa agent, direview, lalu diringkas kembali.

### 3. Mailbox dan append-only event log

- [x] Buat struktur `.agent-office/` per project: `inbox/`, `outbox/`, `tasks/`, `memory/`, `logs/`.
- [x] Definisikan format pesan JSON dasar: `id`, `from`, `to`, `body`, `createdAt`.
- [x] Tulis message secara atomic (`tmp → rename`) agar tidak terbaca setengah.
- [x] Tampilkan mailbox dan activity log di Command Center.
- [x] Implementasikan router outbox → inbox dengan retry dan dead-letter log.
- [x] Simpan event append-only untuk task, message, memory, dan exit.
- [x] Tambahkan event viewer dasar.
- [x] Tambahkan watchdog untuk inbox/outbox yang stale dan event `mailbox.stalled`.

**Selesai jika:** agent dapat mengirim pesan yang durable, dapat dilacak, dan tidak hilang saat app restart.

### 4. Terminal dan event plane

- [x] Putuskan mode runtime: pertahankan `node-pty` untuk local-first MVP; tmux persistent ditunda.
- [x] N/A untuk runtime MVP `node-pty`; target `session:window.pane` berlaku jika migrasi tmux dipilih.
- [x] Pisahkan terminal plane (raw bytes) dari event plane (structured JSON events).
- [x] Tambahkan command bar untuk prompt, quick action, dan interrupt.
- [x] Tampilkan status busy/paused/blocked/idle dari event dan task state, bukan hanya exit code process.
- [x] Tambahkan validasi nama/path CLI sebelum spawn.

## P1 — Memory dan Command Center

### 5. Shared memory

- [x] Simpan memory agent sebagai Markdown yang dapat dibaca manusia.
- [x] Buat kategori memory bebas dan kaitkan dengan agent.
- [x] Tambahkan tabel `memories` dan metadata source/agent.
- [x] Sediakan memory browser, search dasar, edit, dan delete di UI.
- [x] Tambahkan SQLite FTS untuk pencarian lokal cepat dengan fallback `LIKE`.
- [x] Tambahkan deterministic local semantic/vector index sebagai fitur opsional.
- [x] Tambahkan retention agar memory tidak tumbuh tanpa batas.
- [x] Tambahkan pin dan retention policy.

### 6. Kanban Command Center

- [x] Buat tampilan board dengan kolom status task.
- [x] Tambahkan task title, prompt, assignee, workspace, dan status.
- [x] Tambahkan dependency, branch, artifact, dan review detail.
- [x] Tambahkan scheduled missions dan heartbeat dengan next-run UTC serta timezone metadata.
- [x] Tambahkan fleet monitor: agent aktif, task berjalan, queue, error, approval, dan usage budget.
- [x] Tambahkan activity log terpadu dari event plane.
- [x] Tambahkan retry/resume task yang gagal.

## P2 — Integrasi, safety, dan pengalaman pengguna

### 7. GitHub workflow

- [x] Hubungkan GitHub issue → task → agent → branch/worktree → review → pull request melalui `gh` dan approval gate.
- [x] Tambahkan import issue open dan sinkronisasi status/task.
- [x] Tambahkan ringkasan diff sebelum membuat PR.
- [x] Minta approval manusia sebelum push atau membuat PR.

### 8. Permissions dan reliability

- [x] Tambahkan permission profile per agent: filesystem, network, shell, Git, dan secrets (policy/env baseline).
- [x] Sediakan `settings.local.json` sebagai file lokal ter-ignore untuk konfigurasi hook.
- [x] Backup dan tampilkan diff sebelum mengubah konfigurasi CLI user melalui Settings approval broker.
- [x] Implementasikan circuit breaker baseline: `steer → interrupt/constrain → stop`.
- [x] Tambahkan budget time dan durable execution usage ledger.
- [x] Redact secret dan prompt/output sensitif dari log serta memory/task persistence.
- [x] Tambahkan crash recovery serta cleanup session saat app ditutup.

### 9. Office floor interaktif

- [x] Migrasikan visual floor ke Pixi.js setelah model event stabil.
- [x] Tambahkan avatar state: idle, working, paused, error, dan task review melalui Command Center.
- [x] Tambahkan floor station layout untuk terminal, mailbox, review, dan Git workflow.
- [x] Tampilkan envelope/message flow antar-agent.
- [x] Pastikan animasi envelope menyampaikan message flow operasional yang nyata.

### 10. Packaging dan distribution

- [x] Pastikan `electron-builder install-app-deps` berjalan pada fresh install.
- [x] Tambahkan build Linux AppImage.
- [x] Tambahkan target build Windows NSIS.
- [x] Tambahkan target build macOS DMG.
- [x] Uji native modules pada host Linux/Electron ABI.
- [ ] Jalankan native smoke/build/packaging pada runner Windows dan macOS yang didukung.
  CI matrix dan artifact upload sudah tersedia; checkbox ini menunggu eksekusi runner native Windows/macOS.
- [x] Sediakan native smoke test dan CI matrix Ubuntu/Windows/macOS untuk gate tersebut.
- [x] Tambahkan release checklist, versioning, dan update notes.

## Urutan implementasi berikutnya

1. Provider-specific permission enforcement dan backup/diff konfigurasi CLI.
2. Uji migrasi database serta native modules pada OS/arsitektur target.
3. Hardening GitHub sync, PR result/test summary, dan recovery lintas crash scenario.

## Keputusan yang perlu dikunci

- [x] Runtime MVP tetap memakai `node-pty`; tmux persistent ditunda.
- [x] Goal/SOUL MVP diinjeksi lewat environment; hook provider-specific ditunda.
- [x] Worktree bersifat opt-in per project.
- [x] Operasi yang mengandung destructive/scope/cost keyword masuk approval queue.
- [x] Provider CLI MVP bersifat agnostik dan memakai profile command.
- [x] Dukungan remote/multi-machine ditunda sampai local-first stabil.

## Referensi

- [Percakapan sumber](https://chatgpt.com/share/6a96cea6-fc0c-83ec-9a13-913803a02756)
- [Munder Difflin README](https://github.com/chaitanyagiri/munder-difflin/blob/main/README.md)
- [Munder Difflin SPEC](https://github.com/chaitanyagiri/munder-difflin/blob/main/SPEC.md)
- [Munder Difflin RELEASE notes](https://github.com/chaitanyagiri/munder-difflin/blob/main/RELEASE.md)
