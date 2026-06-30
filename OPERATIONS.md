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
| `.flushqueue` | Bersihkan antrian pencarian (gunakan kalau ada bug "chat not found") |

---

## Troubleshooting

### "chat not found" saat /find
Data stale di queue Redis dari versi lama.
**Fix:** Ketik `.flushqueue` sebagai admin, user `/find` ulang.

### Bot tidak merespons sama sekali
1. Cek `getWebhookInfo` — `last_error_message` harus kosong
2. Cek Vercel logs (Functions tab)
3. Pastikan semua env vars terisi

### Menfess gagal kirim ke channel
Bot harus jadi **Admin** di channel dengan izin **Post Messages**.

### Admin reply tidak sampai ke user
Admin harus **reply** (balas) pesan yang diteruskan bot — bukan kirim pesan baru.

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
