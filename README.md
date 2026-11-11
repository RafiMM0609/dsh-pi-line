# dsh-pi-line

Bundle [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) yang memasang agent preset
**`software-build`**: loadout coding ramping gaya [pi](https://github.com/earendil-works/pi) — persona pendek
yang *menggantikan* system prompt besar, tool seperlunya (read / write / edit batch / bash), plus timeout
context via grup compaction.

Satu repo, satu paket, dua artefak:

| Artefak | Lokasi | Fungsi |
|---|---|---|
| Preset `software-build` | `cordis.patch.yml` (row `@deepseek-ai/dsh-agent-preset`) | komposisi persona + tool |
| Tool `edit` batch | `lib/tool-edit-batch.js` | banyak targeted replacement dalam satu call, dicocokkan ke isi file **ORIGINAL** |

## Mekanisme pengemasan (dan kenapa bukan monorepo dua paket)

Dua opsi diuji langsung dengan pnpm 12.18 di mesin pengembangan:

**1. Monorepo dua paket + dependency silang lewat git — GAGAL.**

```
$ pnpm add "git+file:///tmp/mono-probe#path:/packages/a"
✗ ERR_PNPM_EXOTIC_SUBDEP
  Exotic dependency "probe-b" (resolved via git-repository) is not allowed in
  subdependencies when blockExoticSubdeps is enabled
```

pnpm 12 memblokir *exotic subdependency* (git/tarball) secara default, jadi paket preset tidak boleh
bergantung pada paket tool lewat spec git/`#path:`. Bisa juga lewat npm, tapi itu menambah langkah rilis
(publish 2 paket) dan kredensial registry.

**2. Nama relatif di dalam patch preset — TIDAK DIDUKUNG.**

`anchorInsertedPluginNames()` di `@deepseek-ai/dsh-app-boot` memang mengubah nama relatif/absolut menjadi
`file://` URL, **tetapi hanya** untuk row hasil `insert` dan hanya me-rekursi ke row `cordis:group`
(`entry.group && Array.isArray(entry.config)`). Row `@deepseek-ai/dsh-agent-preset` menyimpan anaknya di
`config.plugins`, yang **tidak** dikunjungi — sudah diverifikasi: nama tetap `./lib/tool-edit-batch.js`.

**3. Satu paket, row tool memakai nama paket — DIPAKAI.**

`package.json` paket ini menetapkan:

```json
"main": "lib/tool-edit-batch.js",
"exports": { ".": "./lib/tool-edit-batch.js" },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Sehingga di dalam preset, row tool cukup:

```yaml
- id: tool-edit-batch
  name: 'dsh-pi-line'
```

Loader me-resolve nama paket dari `node_modules` profile — pola yang sama dengan plugin lain di profile DSH
(mis. `dsh-plugin-mobile-gateway`), dan sudah terbukti jalan untuk paket tool yang dipasang sebagai dependency
biasa. Package ini juga yang memasang dependency registry-nya (`@deepseek-ai/dsh-tools`, `dsh-fs`,
`schemastery`), jadi `lib/tool-edit-batch.js` bisa me-resolve import-nya lewat `nodeLinker: hoisted`
(bawaan template profile DSH).

Hasilnya: **satu spec install, satu tag, tanpa publish, tanpa dependency silang.**

## Instalasi (device mana pun)

Prasyarat: DSH `0.2.1-rc.5`, Node ≥ 22, profile `web` sudah ada. Cek: `dsh --version && node -v`.

### 1. Web UI (disarankan — ada inspect & rollback)

1. `http://<host>:3080/` → sidebar **Plugins** → **Add plugin**
2. Spec: `github:RafiMM0609/dsh-pi-line#v1.0.0`
   (atau `dsh-pi-line@1.0.0` bila di-publish ke npm, atau `link:/abs/path/dsh-pi-line` untuk uji lokal)
3. **Inspect**: harus `status: accepted` dan terdeteksi sebagai bundle (kalau `not-a-bundle` → field
   `dsh.bundle.patch` tidak terbaca)
4. **Install**, lalu cek `application`:
   - `applied` → preset langsung ada di roster
   - `restart-required` → restart DSH Web di device itu
5. Bundle otomatis masuk `dsh.profile.bundles` dan aktif.

> Installer akan menarik dependency `@deepseek-ai/dsh-tools`, `dsh-fs`, `schemastery` dari registry yang
> dikonfigurasi pnpm di device itu (semuanya tersedia di npm/npmmirror). Tidak ada build script → tidak ada
> `pendingBuilds` yang perlu approval.

### 2. Dari HP (lewat gateway device itu)

Ke koneksi **control** dengan token device yang sudah ter-pair:

```json
{"type":"plugin-inspect","requestId":"i1","spec":"github:RafiMM0609/dsh-pi-line#v1.0.0"}
{"type":"plugin-install","requestId":"p1","spec":"github:RafiMM0609/dsh-pi-line#v1.0.0"}
{"type":"plugin-catalog","requestId":"c1"}
```

Progres: `plugin-install-state` (`installing`/`cancelling`/`applying`) + `plugin-install-log`.
Hasil: `plugin-install-result`. Koneksi putus → `{"type":"plugin-install-status","installId":"p1"}`;
jangan ulangi install dengan `requestId` baru.

### 3. CLI

```bash
dsh plugin --profile web add github:RafiMM0609/dsh-pi-line#v1.0.0
```

CLI hanya menjalankan `pnpm add`, jadi nama paket **harus** ditambahkan sendiri ke `dsh.profile.bundles`
di `~/.dsh/profiles/web/package.json` (paling akhir = prioritas terendah), lalu restart DSH di device itu:

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-pi-line"
    ]
  }
}
```

## Verifikasi

```bash
# 1) baris preset masuk komposisi, dan nama tool sudah jadi file:// URL
dsh --profile web --dump-config | grep -n -A10 preset-software-build

# 2) roster dari sisi app/gateway: entri software-build ada dan TANPA field "broken"
#    (selector preset di Web UI, atau /mgw/pair + probe WS)

# 3) fungsional: sesi baru dengan preset "software-build"
#    - persona pendek (bukan system prompt besar)
#    - tool edit batch menerima {"path": "...", "edits": [...]}
```

## Uninstall / rollback

1. Plugins page → **toggle off** bundle (preset hilang dari roster; sesi lama tetap memakai komposisinya),
   lalu **Remove**.
2. Alternatif manual: hapus blok `- insert:` dengan `id: preset-software-build` dari
   `~/.dsh/profiles/web/cordis.patch.yml`, lalu restart.

## Jebakan

1. **Jangan** memasang bundle ini di device yang masih punya blok manual `preset-software-build` di
   `cordis.patch.yml` → id row duplikat. Cek dulu:
   `grep -n preset-software-build ~/.dsh/profiles/web/cordis.patch.yml`
   Hapus blok manualnya **setelah** bundle terpasang dan roster bersih.
2. **Versi harness harus sama** (`0.2.1-rc.5`): `engines.dsh` + dependency inti di-pin exact. Beda versi
   ditolak gate kompatibilitas → pakai `dsh plugin allow-version` / version-exemption, jangan dipaksa.
3. Urutan layer: **bundle dulu**, baru `cordis.patch.yml` profil. Override per-device (mis. ganti `prefix`
   persona) tulis di `cordis.patch.yml` — itu menang.
4. Tool ini memakai `ctx.fs` dan gate `fs/edit-intent` yang sama dengan `edit` bawaan; jangan mount dua tool
   `edit` sekaligus (`tool-fs` di preset ini disetel `edit: false`).

## Struktur repo

```
dsh-pi-line/
├── cordis.patch.yml        # row preset software-build (+ rujukan ./lib/tool-edit-batch.js)
├── lib/tool-edit-batch.js  # tool edit batch (salinan apa adanya dari profil yang terbukti jalan)
├── package.json            # name, dsh.bundle.patch, repository, dependency registry
├── README.md
├── LICENSE
└── .gitignore
```

## Status verifikasi (saat paket dibuat)

Diuji pada mesin pengembangan dengan DSH `0.2.1-rc.5`, **tanpa menyentuh instalasi yang sedang aktif**
(DSH_HOME terpisah di `/tmp`, port 3099):

| Uji | Hasil |
|---|---|
| `pnpm add file:<paket>` di profile bersih (`nodeLinker: hoisted`) | ✅ paket + dependency registry terpasang, `files` lengkap (`cordis.patch.yml`, `lib/tool-edit-batch.js`) |
| `dsh --profile web --dump-config` | ✅ row `preset-software-build` muncul; row `tool-edit-batch` = `dsh-pi-line` |
| boot instance + query `agent-presets` lewat gateway | ✅ `software-build` ada, **`broken` count 0** → semua row preset (termasuk tool) berhasil start |
| `engines.dsh` / gate kompatibilitas | ✅ lolos (runtime 0.2.1-rc.5) |

Catatan: import modul plugin dari Node polos di profile gagal (`@deepseek-ai/cordis` tidak ada di profile,
karena `autoInstallPeers: false`), tetapi loader DSH me-resolve modul inti harness sendiri — terbukti dari
`broken: 0` di atas. Jadi jangan mount tool ini di luar loader DSH.

## Lisensi

MIT — lihat `LICENSE`.
