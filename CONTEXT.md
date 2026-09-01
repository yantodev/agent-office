# Agent Office — Domain Context

## Istilah inti

- **Project** — root workspace yang menjadi konteks kerja bersama, termasuk repository Git bila tersedia.
- **Agent** — worker yang menjalankan satu command CLI untuk sebuah Project.
- **Profile** — identitas reusable Agent: nama, role, command, dan SOUL/system instructions.
- **Worktree** — working copy Git terisolasi yang secara opsional dimiliki satu Agent.
- **Task** — unit pekerjaan yang dapat ditugaskan ke Agent dan bergerak melalui lifecycle.
- **Mailbox** — kanal pesan durable antar-Agent dan antara orchestrator dengan Agent.
- **Event** — catatan append-only tentang perubahan state atau aktivitas penting.
- **Memory** — pengetahuan durable dalam format Markdown yang dapat dicari kembali.

## Hubungan

- Satu Project dapat memiliki banyak Agent.
- Satu Agent memakai satu Profile dan satu Project pada satu waktu.
- Satu Agent dapat memiliki satu Worktree; Worktree tidak boleh dipakai Agent lain secara bersamaan.
- Satu Task ditugaskan ke paling banyak satu Agent aktif, tetapi dapat berpindah ketika gagal atau di-retry.
- Mailbox dan Event tetap durable ketika process Agent berhenti atau aplikasi restart.

## Lifecycle utama

`Project → Agent → Worktree → Task → Event/Memory`

## Invariants

- Path workspace harus absolute dan diverifikasi sebelum Agent dimulai.
- Operasi filesystem dan Git dilakukan oleh main process.
- Penghapusan Agent tidak boleh menghapus perubahan kerja yang belum tersimpan tanpa keputusan eksplisit.
- Profile dapat dipakai banyak Agent dan perubahan Profile berlaku pada Agent yang terhubung.
