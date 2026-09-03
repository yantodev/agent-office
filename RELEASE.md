# Agent Office release checklist

## Sebelum release

- [x] Naikkan `version` ke `0.0.1-beta` di `package.json` dan catat perubahan pada release notes.
- [x] Jalankan `npm ci` pada environment bersih.
- [x] Jalankan `npm run typecheck`, `npm run smoke:native`, `npm run smoke:main`, dan `npm run build`.
- [x] Rebuild native modules dengan `electron-builder install-app-deps`.
- [x] Uji `node-pty` dan `better-sqlite3` pada Linux/Electron ABI.
- [ ] Uji `node-pty` dan `better-sqlite3` pada runner Windows/macOS target.
- [x] Uji migrasi database dari versi sebelumnya melalui `npm run smoke:migration`.
- [x] Uji mission decomposition, approval queue, scheduler, mailbox retry, dan crash recovery.
- [x] Pastikan secret tidak muncul di event log, task output, atau memory Markdown.

## Artifact

- Linux: `npm run dist:linux` → AppImage (aktif di workflow).
- Windows: `npm run dist:win` → NSIS (sementara dinonaktifkan sampai runner Windows tersedia).
- macOS: `npm run dist:mac` → DMG (sementara dinonaktifkan sampai runner macOS tersedia).

## GitHub Actions release

The release workflow is defined in `.github/workflows/release.yml`. Create and push a semver tag matching `package.json`, for example:

```bash
git tag v0.0.1-beta
git push origin v0.0.1-beta
```

The workflow runs the Linux validation gate, builds the Linux AppImage on a runner labeled `self-hosted` plus `linux`, uploads the artifact, and creates the GitHub Release with generated notes. Packaging entries for Windows and macOS remain commented in the workflow until native runners are available. A manual run is also available from **Actions → Agent Office Release** by providing an existing version tag.

CI menjalankan `smoke:native`, `smoke:main`, dan `smoke:migration` pada Linux serta packaging AppImage. Workflow memiliki timeout, permission minimal, dan artifact wajib (`if-no-files-found: error`); workflow bisa dipicu melalui `workflow_dispatch` untuk review release.

Verifikasi lokal terakhir: 2026-09-03, Linux x64. `npm run dist:linux` berhasil menghasilkan `dist/Agent Office-0.0.1-beta.AppImage` setelah rebuild `better-sqlite3` dan `node-pty`. Production dan full dependency audit bersih (`npm audit` dan `npm audit --omit=dev`).

## Catatan environment

- `ELECTRON_DISABLE_GPU=1` dapat dipakai pada Linux CI/headless yang tidak memiliki GPU usable.
- GitHub workflow membutuhkan GitHub CLI (`gh`) yang sudah login.
- `node-pty` tetap menjadi runtime local-first; migrasi tmux persistent belum termasuk release ini.
