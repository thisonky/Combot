# Combo Bot — Operations Guide

## Deploy

### Env vars wajib (Vercel → Settings → Environment Variables)

| Variable | Contoh | Keterangan |
|---|---|---|
| `BOT_TOKEN` | `7123:AAHx...` | Dari @BotFather |
| `CHANNEL_ID` | `-1001234567890` | Channel menfess |
| `ADMIN_ID` | `123456789` | User ID admin (angka) |
| `BOT_USERNAME` | `KEKprojects_bot` | Tanpa @ |
| `UPSTASH_REDIS_URL` | `https://xxx.upstash.io` | Upstash REST URL |
| `UPSTASH_REDIS_TOKEN` | `AXxx...` | Upstash REST token |

### Env vars opsional (ada default)

| Variable | Default | Keterangan |
|---|---|---|
| `DAILY_MAX` | `3` | Max menfess per hari |
| `AUTO_DELETE_MINUTES` | `10` | Durasi auto-delete |
| `REFERRAL_BONUS` | `3` | Bonus untuk referrer |
| `REFERRAL_WELCOME` | `3` | Bonus untuk user baru |
| `GAS_URL` | _(kosong)_ | URL Web App GAS (`https://script.google.com/macros/s/XXX/exec`). Kalau kosong, bot 100% jalan di Redis tanpa Sheets |
| `GAS_SECRET` | _(kosong)_ | Secret yang sama persis dengan `SHARED_SECRET` di `Code.gs`, mencegah orang lain memanggil endpoint GAS sembarangan |

### Setup Google Apps Script (opsional, untuk arsip & data sekunder)

1. Buka Google Sheets baru → Extensions → Apps Script
2. Hapus isi default, paste seluruh isi `gas/Code.gs` dari repo ini
3. Ganti baris pertama: `var SHARED_SECRET = "..."` dengan string acak panjang (contoh: hasil `openssl rand -hex 32`)
4. Deploy → New deployment → Web app → Execute as: **Me**, Who has access: **Anyone**
5. Copy URL yang dihasilkan (`.../exec`) → set sebagai `GAS_URL` di Vercel
6. Set `GAS_SECRET` di Vercel dengan nilai yang sama persis dengan langkah 3

**Arsitektur hybrid:** Redis tetap jadi sumber kebenaran utama untuk semua pengecekan real-time (block/mute/kuota saat user kirim menfess, session & queue anon chat). GAS Sheets menerima salinan paralel (fire-and-forget) setiap kali ada perubahan data — kalau GAS down/lambat, bot tetap berjalan normal karena tidak menunggu respons GAS.

### Set webhook (sekali setelah deploy)

```
https://api.telegram.org/botTOKEN/setWebhook?url=https://nama.vercel.app/webhook
```

Verifikasi:
```
https://api.telegram.org/botTOKEN/getWebhookInfo
```
`last_error_message` harus kosong.

---

## Admin Commands

| Command | Fungsi |
|---|---|
| `.bl (id) (alasan)` | Blokir user dari menfess |
| `.unbl (id)` | Unblock user |
| `.listbl` | Daftar user diblokir |
| `.mute (id) (durasi) (h\|d)` | Mute sementara |
| `.unmute (id)` | Cabut mute |
| `.reset (id)` | Reset limit harian user |
| `.addf (kata)` | Tambah kata terlarang |
| `.delf (kata)` | Hapus kata terlarang |
| `.listf` | Daftar keyword blacklist |
| `.bc (pesan)` | Broadcast ke semua user |
| `.stats` | Statistik bot |
| `.queue` | Lihat jumlah antrian, status searching, dan sesi chat aktif — cek ini SEBELUM `.flushqueue` |
| `.flushqueue` | Bersihkan antrian pencarian (gunakan kalau ada bug "chat not found"). Sesi chat aktif TIDAK ikut terhapus |
| `.resetdb` | Reset database total (semua data dihapus). Wajib ketik `.resetdb confirm` untuk eksekusi. Gunakan saat update kode besar |

---

## Troubleshooting

### "chat not found" saat /find
Data stale di queue Redis dari versi lama.
**Fix:** Cek dulu dengan `.queue` untuk lihat berapa banyak antrian dan sesi aktif. Kalau aman (tidak ada sesi aktif yang ikut kena), ketik `.flushqueue`, lalu user `/find` ulang.

### Update kode besar / migrasi versi
Kalau struktur data Redis berubah signifikan dan butuh database benar-benar kosong:
1. Ketik `.resetdb` — bot akan tampilkan ringkasan data yang akan terhapus
2. Kalau yakin, ketik `.resetdb confirm`
3. Semua data (user, sesi, blokir, mute, kuota, referral) akan terhapus total
4. Bot otomatis siap dipakai dari nol setelah user `/start` ulang

### Bot tidak merespons sama sekali
1. Cek `getWebhookInfo` — `last_error_message` harus kosong
2. Cek Vercel logs (Functions tab)
3. Pastikan semua env vars terisi

### Menfess gagal kirim ke channel
Bot harus jadi **Admin** di channel dengan izin **Post Messages**.

### Admin reply tidak sampai ke user
Admin harus **reply** (balas) pesan yang diteruskan bot — bukan kirim pesan baru.

### Data tidak muncul di Google Sheets
Cek di Vercel Functions logs untuk pesan `sync failed` (contoh: `shBlock sync failed: ...`). Itu artinya panggilan ke GAS gagal tapi **bot tetap jalan normal** (data tetap valid di Redis). Penyebab umum:
- `GAS_URL` atau `GAS_SECRET` salah/belum di-set
- Deployment GAS belum di-set "Anyone" pada Who has access
- `SHARED_SECRET` di `Code.gs` tidak sama dengan `GAS_SECRET` di Vercel

### Reset hanya Redis, tapi data Sheets ikut ke-reset?
**Tidak.** `.resetdb` hanya menjalankan `FLUSHDB` di Redis — data di Google Sheets (`gas/Code.gs`) tidak ikut terhapus karena terpisah sepenuhnya. Kalau mau hapus data Sheets juga, lakukan manual lewat spreadsheet.

---

## Run Tests

```bash
node test.js
```

Semua 26 test harus pass sebelum deploy.

---

## Redis Key Schema

| Prefix | Fungsi |
|---|---|
| `user:{id}` | Profil anon chat user |
| `session:{id}` | Sesi anon chat aktif (TTL 24h) |
| `queue` | Antrian pencarian partner |
| `ac_searching_set` | SET user ID yang sedang status searching |
| `ac_chatting_set` | SET user ID yang sedang status chatting (2 entry per pasangan) |
| `done:{update_id}` | Idempotency (TTL 1h) |
| `mf_user:{id}` | Registrasi user menfess |
| `mf_users_list` | SET semua user ID |
| `mf_blocked:{id}` | Data blokir user |
| `mf_blocked_set` | SET user diblokir |
| `mf_muted:{id}` | ISO string waktu mute berakhir |
| `mf_muted_set` | SET user di-mute |
| `mf_daily:{id}:{date}` | Counter menfess harian |
| `mf_kwbl` | SET keyword blacklist |
| `mf_msg:{msgId}` | Data menfess aktif |
| `mf_msg_set` | SET msg ID aktif |
| `mf_pending:{id}` | Pending menfess (TTL 5 menit) |
| `mf_refbonus:{id}` | Bonus kuota referral |
| `mf_refused:{id}` | Flag sudah pakai referral |
| `mf_refcount:{id}` | Counter referral berhasil |
| `contact_mode:{id}` | Mode hubungi admin aktif (TTL 30 menit) |
| `admin_reply:{msgId}` | Mapping reply admin → user (TTL 24h) |
| `report_pending:{id}` | Alasan report custom pending (TTL 5 menit) |
