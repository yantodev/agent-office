<p align="center">
  <img src="assets/logo/logo-landscape.png" alt="Agent Office" width="560">
</p>

# Agent Office

Workspace desktop local-first untuk menjalankan, mengoordinasikan, dan memantau banyak coding agent dalam pixel-art office yang interaktif.

<p align="center">
  <a href="https://github.com/yantodev/agent-office/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/yantodev/agent-office/ci.yml?branch=master&label=CI&logo=githubactions&logoColor=white" alt="CI" height="30"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Lisensi-MIT-yellow.svg" alt="Lisensi: MIT" height="30"></a>
  <br>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-41-47848F?logo=electron&logoColor=white" alt="Electron 41" height="30"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=20232A" alt="React 19" height="30"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5.7" height="30"></a>
  <a href="https://pixijs.com/"><img src="https://img.shields.io/badge/PixiJS-8-EA4C89?logo=pixijs&logoColor=white" alt="PixiJS 8" height="30"></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white" alt="Vite 6" height="30"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white" alt="SQLite dengan better-sqlite3" height="30"></a>
  <a href="https://github.com/microsoft/node-pty"><img src="https://img.shields.io/badge/node--pty-1.0-339933?logo=node.js&logoColor=white" alt="node-pty 1.0" height="30"></a>
</p>

[English documentation](README.md)

## Ringkasan

Agent Office adalah aplikasi desktop Electron untuk developer yang bekerja dengan beberapa coding CLI secara bersamaan. Aplikasi ini menggabungkan registry agent yang persisten, pseudo-terminal nyata, koordinasi task, project workspace, dan office floor berbasis Pixi.js dalam satu pengalaman local-first.

Data project dan state koordinasi disimpan di komputer lokal. Integrasi dengan Git, GitHub CLI, dan provider coding agent dapat digunakan secara opsional.

## Fitur

### Operasional agent

- Mendeteksi coding CLI yang terpasang, termasuk Codex, OpenCode, Claude, Gemini, Qwen, dan Copilot.
- Membuat profile reusable dengan role, command, dan instruksi SOUL/system.
- Menjalankan setiap agent dalam pseudo-terminal nyata menggunakan `node-pty`.
- Menampilkan output terminal interaktif melalui xterm.js.
- Melakukan steer, interrupt, pause, resume, atau stop pada agent.
- Memulihkan state agent setelah process crash.
- Menerapkan permission profile, execution budget, dan secret redaction.

### Koordinasi project dan task

- Mengelola project dan Git worktree opsional untuk setiap agent.
- Menggunakan task board persisten dengan metadata assignment, retry, dependency, branch, artifact, result, error, dan review.
- Memecah mission secara deterministik dan mendistribusikan pekerjaan melalui orchestrator Michael.
- Menjadwalkan heartbeat dan pekerjaan berulang secara lokal dengan kontrol pause/resume.
- Mengirim pesan durable melalui atomic mailbox dengan retry dan dead-letter handling.
- Melindungi branch worker menggunakan single-committer lock.
- Meminta persetujuan manusia untuk request yang berpotensi destructive, mengubah scope, atau menimbulkan biaya.

### Office interaktif

- Menjelajahi office floor berbasis Pixi.js dengan avatar animasi yang mengikuti status agent.
- Melihat workstation setiap agent, termasuk composite desk, monitor, keyboard, CPU, kursi, dan lampu meja.
- Mengamati animasi message envelope dan aktivitas agent secara langsung.
- Menggunakan navigasi office untuk membuka Live Office, Selected Agent, dan Terminal.

### Memory dan integrasi

- Menyimpan pengetahuan bersama dalam Markdown dengan pencarian SQLite FTS5.
- Menandai dan mempertahankan memory penting.
- Menggunakan deterministic local vector search secara opsional.
- Mengimpor GitHub issue dan menyiapkan atau membuat pull request melalui workflow `gh` yang memerlukan approval.
- Merutekan traffic CLI yang kompatibel dengan OpenAI dan Claude melalui gateway 9router lokal secara opsional.
- Menyimpan append-only activity log dan workflow settings diff yang sudah di-redact, memiliki backup, serta atomic replacement.

### Integrasi 9router

Agent Office dapat menggunakan [9router](https://github.com/decolua/9router) sebagai gateway model lokal opsional.
Integrasi ini bersifat opt-in dan berlaku untuk session agent CLI yang berjalan di komputer yang sama atau server web
worker. Agent Office tidak menyimpan atau mengekspos API key gateway ke renderer maupun browser.

1. Install dan jalankan 9router, lalu konfigurasi provider dan API key di 9router.
2. Salin `.env.example` menjadi `.env`, lalu isi konfigurasi berikut:

```dotenv
AGENT_OFFICE_9ROUTER_ENABLED=1
AGENT_OFFICE_9ROUTER_BASE_URL=http://127.0.0.1:20128/v1
AGENT_OFFICE_9ROUTER_API_KEY=api-key-9router-anda
AGENT_OFFICE_9ROUTER_MODEL=provider/model
```

3. Restart Agent Office atau web worker setelah mengubah `.env`. Pada halaman Settings & Safety, konfigurasi gateway
   juga dapat disimpan dan diuji; Electron menyimpannya di settings lokal, sedangkan server browser menyimpan perubahan
   dari UI di memory sampai server direstart.

Bridge memetakan command Codex/OpenAI-compatible ke variable `OPENAI_*` dan command Claude ke variable
`ANTHROPIC_*`. Biarkan `AGENT_OFFICE_9ROUTER_ENABLED=0` jika ingin memakai routing provider langsung. Endpoint harus
menggunakan `http://` atau `https://` dan tidak boleh berisi credential pada URL. Indikator health membedakan kegagalan
authentication, rate limit, timeout, routing, dan network.

## Tech stack

- Electron 41
- React 19 dan TypeScript
- Pixi.js 8 untuk office floor interaktif
- xterm.js untuk rendering terminal
- SQLite melalui `better-sqlite3`
- `node-pty` untuk pseudo-terminal lokal
- Vite dan electron-vite untuk development dan bundling
- electron-builder untuk package AppImage, NSIS, dan DMG

## Arsitektur

| Layer | Tanggung jawab |
| --- | --- |
| Main process | Persistence SQLite, lifecycle PTY, operasi filesystem dan Git, scheduler, koordinasi, serta integrasi |
| Preload | IPC bridge yang typed dan dibatasi antara process Electron |
| Renderer | Interface React, navigasi, dashboard, terminal view, dan visualisasi office Pixi.js |
| Local storage | Registry agent, state task, mailbox, event, schedule, dan memory Markdown |

## Persyaratan

- Node.js 20 atau lebih baru diperlukan untuk browser server; Node.js 22 atau lebih baru direkomendasikan untuk build Electron.
- npm 10 atau lebih baru direkomendasikan.
- Git untuk fitur project dan worktree.
- Opsional: GitHub CLI (`gh`) yang sudah authenticated untuk workflow GitHub.
- Build tools native Linux untuk `node-pty` dan `better-sqlite3`:

```bash
sudo apt install -y build-essential python3
```

## Memulai development

```bash
git clone git@github.com:yantodev/agent-office.git
cd agent-office
npm install
npm run dev
```

Command development akan menjalankan Vite renderer dan membuka aplikasi Electron.

## Menjalankan versi browser

Versi browser menggunakan interface React yang sama melalui gateway HTTP/WebSocket dengan autentikasi. Browser tidak mendapat akses langsung ke filesystem atau process; workspace project dan coding CLI tetap berjalan di web server.

Untuk development lokal, salin `.env.example` menjadi `.env`, isi token yang kuat, lalu jalankan command development gabungan API + Vite. Script `web:dev` dan `web:server` akan membaca `.env` secara otomatis; file tersebut di-ignore oleh Git.

```bash
cp .env.example .env
# edit .env dan ganti token
npm run web:dev
```

Buka `http://localhost:5173`, lalu masukkan token yang sama. Untuk bundle production:

```bash
npm run web:build
npm run web:server
```

Script web otomatis memeriksa native module dan melakukan rebuild untuk runtime Node yang sedang aktif jika diperlukan. Rebuild pertama dapat memerlukan beberapa menit pada Node 20 karena prebuilt binary mungkin tidak tersedia; pasang build tools native di atas. Jika kembali menggunakan Electron setelah menjalankan script browser, jalankan `npm run electron:rebuild`, karena Electron dan Node menggunakan ABI native module yang berbeda.

Server standalone mendengarkan `127.0.0.1:8787` secara default. Restart web process setelah mengubah `.env` karena token dibaca saat startup. Gunakan `AGENT_OFFICE_WEB_HOST=0.0.0.0` hanya jika server dilindungi HTTPS/WSS melalui reverse proxy. `AGENT_OFFICE_WEB_DATA` memilih directory data SQLite. Image Docker production tersedia melalui `docker build -f Dockerfile.web -t agent-office-web .`; gunakan token kuat dan volume `/data` yang persistent.

## Script yang tersedia

| Command | Deskripsi |
| --- | --- |
| `npm run dev` | Menjalankan environment development Electron |
| `npm run typecheck` | Menjalankan TypeScript compiler tanpa membuat file output |
| `npm run smoke:9router` | Memeriksa gateway 9router yang sedang berjalan (skip jika integrasi nonaktif) |
| `npm run build` | Membuild bundle main, preload, dan renderer |
| `npm run web:server` | Menjalankan authenticated web API standalone |
| `npm run web:dev` | Menjalankan web API dan browser client dengan proxy API/WebSocket Vite |
| `npm run web:rebuild-native` | Rebuild native module untuk runtime Node yang sedang aktif |
| `npm run electron:rebuild` | Rebuild native module untuk runtime Electron yang terpasang |
| `npm run web:build` | Membuild browser client ke `dist/web` |
| `npm run web:preview` | Preview browser client hasil build dengan Vite |
| `npm run smoke:web` | Memverifikasi API web, static hosting, dan WebSocket |
| `npm run smoke:native` | Memverifikasi native dependency dan runtime |
| `npm run smoke:main` | Menjalankan integration smoke test main process |
| `npm run smoke:migration` | Memverifikasi behavior database migration |
| `npm run dist` | Membuild dan package untuk platform saat ini |
| `npm run dist:linux` | Membuat Linux AppImage |
| `npm run dist:win` | Membuat installer Windows NSIS |
| `npm run dist:mac` | Membuat macOS DMG |
| `npm run release:version` | Menyiapkan commit dan annotated tag untuk release SemVer |

Sebelum membuat pull request, jalankan:

```bash
npm run typecheck
npm run smoke:native
npm run smoke:main
npm run smoke:migration
npm run build
```

## Troubleshooting Linux

Beberapa instalasi Linux memerlukan owner dan permission setuid yang benar untuk sandbox helper Electron. Jika Electron berhenti dengan error konfigurasi `chrome-sandbox`, jalankan command berikut satu kali dari dalam project:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Setelah itu jalankan aplikasi sebagai user biasa. Pada environment CI headless, `ELECTRON_DISABLE_GPU=1` dapat digunakan jika tidak tersedia GPU yang usable.

## Membuat release

Application identifier yang digunakan adalah `com.agentoffice.desktop`. Icon Electron default dimuat dari `assets/logo/logo.png`, sedangkan logo landscape untuk sidebar berada di `assets/logo/logo-landscape.png`.

Artifact build dibuat di `dist/` dan sengaja diabaikan oleh Git.

### Versioning release

Gunakan script release untuk memperbarui versi package, membuat commit release, dan membuat annotated tag. Script menerima versi SemVer stabil maupun prerelease seperti `0.0.2-beta` atau `0.0.2-rc.1`:

```bash
npm run release:version -- 0.0.2-beta
```

Review commit yang dibuat sebelum melakukan push. Untuk melakukan push branch aktif dan tag sekaligus memicu release workflow, tambahkan `--push`:

```bash
npm run release:version -- 0.0.2-beta --push
```

Tag harus sama persis dengan versi di `package.json`: versi `0.0.2-beta` menjadi tag `v0.0.2-beta`.

## Kontribusi

Kontribusi sangat terbuka. Untuk mengusulkan perubahan:

### Melaporkan issue

Karena repository ini sudah public, silakan buat [GitHub Issue](https://github.com/yantodev/agent-office/issues/new) jika menemukan bug, behavior yang tidak sesuai, atau memiliki usulan fitur. Sebelum mengirim laporan, cari issue yang sudah ada dan sertakan behavior yang diharapkan, behavior aktual, langkah reproduksi, detail environment, serta log atau screenshot yang relevan. Hapus token, credential, dan data sensitif dari semua laporan.

1. Fork repository dan buat branch yang fokus pada satu perubahan.
2. Jaga scope perubahan tetap jelas dan perbarui dokumentasi jika behavior berubah.
3. Jalankan typecheck, smoke test, dan build seperti yang tercantum di atas.
4. Buat pull request dengan deskripsi singkat, langkah validasi, dan screenshot untuk perubahan UI.

Jangan commit credential, token, local settings, bundle hasil build, atau file database. Ikuti konvensi TypeScript yang sudah ada dan utamakan perubahan kecil yang mudah direview.

## Contributor

| Contributor | Peran |
| --- | --- |
| [Yanto (@yantodev)](https://github.com/yantodev) | Creator dan maintainer |

Contributor tambahan dipersilakan melalui pull request.

## Keamanan

Jangan menaruh API key, GitHub PAT, atau credential lain di source code, issue, commit, atau pull request. Gunakan konfigurasi environment lokal dan segera revoke credential jika tidak sengaja terekspos.

## Lisensi

Project ini menggunakan MIT License. Lihat [LICENSE](LICENSE) untuk teks lisensi lengkap.

## Referensi project

- [Changelog](CHANGELOG.md)
- [Release checklist](RELEASE.md)
- [Domain context](CONTEXT.md)
- [Planned work](TODO.md)
