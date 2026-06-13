# 🤖 Combo Bot — Anonymous Chat + Menfess

Satu bot, dua fitur utama, gratis selamanya.

| Fitur | Keterangan |
|---|---|
| 💌 Menfess | Kirim pesan anonim ke channel |
| 🔍 Anonymous Chat | Ngobrol 1-on-1 dengan orang asing secara anonim |

---

## 🗂️ Struktur File

```
combo-bot/
├── api/
│   ├── webhook.js   ← Handler utama (semua logika)
│   ├── _db.js       ← Upstash Redis (anonchat + menfess)
│   └── _tg.js       ← Telegram API helper
├── package.json
├── vercel.json
└── README.md
```

---

## 🚀 Deploy via Browser

### 1. Upload ke GitHub

1. Buka [github.com/new](https://github.com/new) → buat repo private
2. Upload semua file, **pertahankan struktur folder** `api/`
3. Commit

### 2. Deploy ke Vercel

1. Buka [vercel.com](https://vercel.com) → **Add New Project**
2. Import repo GitHub
3. Klik **Deploy**

### 3. Set Environment Variables

Di Vercel → **Settings → Environment Variables**, tambahkan:

| Name | Value |
|---|---|
| `BOT_TOKEN` | Token dari @BotFather |
| `CHANNEL_ID` | ID channel menfess (contoh: `-1001234567890`) |
| `ADMIN_ID` | User ID admin (angka) |
| `BOT_USERNAME` | Username bot tanpa @ |
| `UPSTASH_REDIS_URL` | URL dari Upstash REST API |
| `UPSTASH_REDIS_TOKEN` | Token dari Upstash REST API |
| `DAILY_MAX` | `3` (max menfess per hari) |
| `AUTO_DELETE_MINUTES` | `10` |
| `REFERRAL_BONUS` | `3` |
| `REFERRAL_WELCOME` | `3` |

Setelah semua terisi → **Redeploy**

### 4. Set Webhook

Buka di browser (ganti nilai sesuai milikmu):

```
https://api.telegram.org/botTOKEN/setWebhook?url=https://nama-project.vercel.app/webhook
```

Hasil sukses:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

**Bot langsung aktif! 🎉**

---

## 📖 Cara Pakai

### User Baru
1. Ketik `/start`
2. Pilih gender (untuk anon chat)
3. Muncul menu utama dengan 2 fitur

### 💌 Menfess
- Klik **💌 Kirim Menfess** atau langsung ketik `mfs!` + pesan
- Mendukung: teks, foto (auto spoiler), video (auto spoiler), voice note
- Preview sebelum kirim
- Pilih: Kirim biasa / Auto-delete / Batalkan

### 🔍 Anonymous Chat
- Klik **🔍 Cari Chat Anonim** atau ketik `/find`
- Saat terhubung: semua pesan diteruskan ke partner (teks, foto, video, stiker, voice, dll)
- `/next` — Ganti partner
- `/stop` — Keluar sesi

### 🎁 Referral
- `/referral` — Lihat link & statistik referralmu
- Ajak teman → kamu & teman dapat bonus kuota menfess

---

## 🧾 Admin Commands

| Command | Fungsi |
|---|---|
| `.bl (id) (alasan)` | Blokir user dari menfess |
| `.unbl (id)` | Unblock user |
| `.listbl` | Daftar user diblokir |
| `.mute (id) (durasi) (h\|d)` | Mute sementara |
| `.unmute (id)` | Cabut mute |
| `.reset (id)` | Reset limit harian |
| `.addf (kata)` | Tambah kata terlarang |
| `.delf (kata)` | Hapus kata terlarang |
| `.listf` | Daftar keyword blacklist |
| `.bc (pesan)` | Broadcast ke semua user |
| `.stats` | Statistik bot |
