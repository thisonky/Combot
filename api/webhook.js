// api/webhook.js — Combo Bot v1.0 (Anonymous Chat + Menfess)
// Vercel Serverless | Upstash Redis

// api/webhook.js — Combo Bot v1.0 (Anonymous Chat + Menfess)
// Vercel Serverless | Upstash Redis
// Production Hardened Edition — Bagian 1 dari 3

import { tg, ikbd, btn, burl } from "./_tg.js";
import {
  acGetUser, acSetUser, acGetSession, acDelSession, acSetSession,
  acGetQueue, acAddToQueue, acRemoveFromQueue, acPickPartner,
  acIsDone, acMarkDone,
  dbRegisterUser, dbCountUsers, dbAllUserIds,
  dbIsBlocked, dbBlock, dbUnblock, dbListBlocked, dbCountBlocked,
  dbIsMuted, dbMute, dbUnmute, dbCountMuted,
  dbGetDailyCount, dbIncrementDaily, dbResetDaily,
  dbContainsBlacklistedKw, dbAddKw, dbDelKw, dbListKw, dbCountKw,
  dbSaveMenfess, dbGetMenfess, dbDeleteMenfess, dbCountMenfess,
  dbSavePending, dbGetPending, dbDeletePending,
  dbGetReferralBonus, dbAddReferralBonus, dbUseReferralBonus,
  dbHasUsedReferral, dbRecordReferral, dbCountReferrals,
} from "./_db.js";

const NEXT_COOLDOWN  = 5000;   // milidetik cooldown untuk fitur /next
const TG_TIMEOUT_MS  = 8000;   // batas timeout untuk eksekusi API Telegram
const BC_CHUNK_DELAY = 50;     // milidetik jeda siaran massal (anti rate-limit)
const WAITING_MSG    = "🔍 Mencari partner obrolan yang cocok...\nSilakan tunggu atau ketik /stop untuk membatalkan.";

// ── Env Validation Core ────────────────────────────────────────────────

function getEnv() {
  // Daftar variabel lingkungan sesuai persis dengan yang ada di Vercel Anda
  const vars = [
    "BOT_TOKEN", 
    "ADMIN_ID", 
    "CHANNEL_ID", 
    "DAILY_MAX", 
    "AUTO_DELETE_MINUTES", 
    "REFERRAL_BONUS", 
    "REFERRAL_WELCOME",
    "BOT_USERNAME",
    "UPSTASH_REDIS_URL",
    "UPSTASH_REDIS_TOKEN"
  ];
  
  const env = {};
  for (const v of vars) {
    if (!process.env[v]) throw new Error(`Missing environment variable: ${v}`);
    env[v] = process.env[v];
  }

  // Pemetaan (Mapping) internal agar kompatibel dengan mesin database _db.js
  env.KV_URL       = env.UPSTASH_REDIS_URL;
  env.KV_TOKEN     = env.UPSTASH_REDIS_TOKEN;
  env.AUTO_DEL_MIN = Number(env.AUTO_DELETE_MINUTES);
  env.REF_BONUS    = Number(env.REFERRAL_BONUS);
  env.REF_WELCOME  = Number(env.REFERRAL_WELCOME);

  // Standardisasi casting tipe data angka
  env.ADMIN_ID     = Number(env.ADMIN_ID);
  env.DAILY_MAX    = Number(env.DAILY_MAX);
  
  return env;
}


// ── Telegram Native Raw Request Handler (Async Hygiene Protocol) ───────

async function tgRaw(token, method, payload = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TG_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return await res.json();
  } catch (e) {
    console.error(`tgRaw Network Failure [${method}]:`, e.name === "AbortError" ? "TIMEOUT" : e.message);
    return { ok: false, error_code: 500, description: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── Text Formatting Utilities ──────────────────────────────────────────

function escapeMd(text) {
  if (!text) return "";
  return text.replace(/[_*`\[\]()]/g, "\\$&");
}

function refLink(env, uid) {
  return `https://t.me/${String(env.CHANNEL_ID).replace("@", "") || "bot"}?start=ref_${uid}`;
}

function shareUrl(link) {
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Yuk gabung ke bot menfess dan chat anonim ini! dapat bonus kuota harian gratis lho.")}`;
}

// ── Navigation Reply Keyboard Generator ────────────────────────────────

function mainMenuKbd(isAdmin) {
  const baseKbd = [
    [{ text: "🔍 Cari Chat Anonim" }, { text: "💌 Kirim Menfess" }],
    [{ text: "📊 Sisa Limit Menfess" }, { text: "🚨 Laporkan User" }],
    [{ text: "📬 Hubungi Admin" }, { text: "ℹ️ Bantuan" }]
  ];
  if (isAdmin) {
    baseKbd.push([{ text: "📊 Stats" }, { text: "🧾 Command Admin" }]);
  }
  return { keyboard: baseKbd, resize_keyboard: true, is_persistent: true };
}

// ── Webhook Main Request Routing Handler ────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, status: "Combo Bot Engine running" });
  }
  try {
    const update = req.body;
    if (!update?.update_id) return res.status(200).json({ ok: true });

    const env = getEnv();
    const api = tg(env.BOT_TOKEN);

    // ── 🔥 PERBAIKAN MUTLAK IDEMPOTENSI ───────────────────────────────
    // Proteksi duplikasi request eksklusif hanya untuk tipe data MESSAGE.
    // Menjamin CALLBACK_QUERY peninjauan admin tidak terblokir gerbang awal.
    if (update.message) {
      const updateKey = `up_msg:${update.update_id}`;
      if (await acIsDone(env, updateKey)) return res.status(200).json({ ok: true });
      await acMarkDone(env, updateKey);
    }
    // ──────────────────────────────────────────────────────────────────

    if (update.callback_query) {
      await handleCallback(update.callback_query, env, api);
    } else if (update.my_chat_member) {
      await handleMyChatMember(update.my_chat_member, env, api);
    } else if (update.message) {
      const msg = update.message;
      
      // Deteksi instan balasan admin ke pesan hubungi admin (mode kontak)
      const isAdminContactReply = 
        msg.from?.id === env.ADMIN_ID && 
        msg.reply_to_message != null && 
        !(msg.text || "").startsWith(".");

      if (isAdminContactReply) {
        const handled = await handleAdminReply(msg, env, api);
        if (handled) return res.status(200).json({ ok: true });
      }

      await handleMessage(msg, env, api);
    }
  } catch (e) {
    console.error("Webhook route crash:", e.message, e.stack);
  }
  return res.status(200).json({ ok: true });
}

// ── Temporary Redis Contact State Fallbacks ────────────────────────────

async function redisGetContact(env, uid) {
  return await tgRaw(env.BOT_TOKEN, "getChat", { chat_id: uid }).then(async () => {
    const s = await tgRaw(env.BOT_TOKEN, "getArgsFall", { uid }); 
    return s?.result || null; 
  }).catch(() => null);
}
// api/webhook.js — Combo Bot v1.0 (Anonymous Chat + Menfess)
// Production Hardened Edition — Bagian 2 dari 3

// ── Core Message Router & Admin Command Interceptor ────────────────────

async function handleMessage(msg, env, api) {
  const userId  = String(msg.from?.id);
  const uidNum  = Number(userId);
  const chatId  = msg.chat?.id;
  if (!userId || !chatId) return;

  const text    = (msg.text || msg.caption || "").trim();
  const textLow = text.toLowerCase();

  // INTERSEPSI MUTLAK KONSOL ADMIN: Perintah destruktif tidak boleh bocor ke chat partner
  if (uidNum === env.ADMIN_ID) {
    if (text === "📊 Stats" || text === "🧾 Command Admin" || text.startsWith(".")) {
      if (text === "📊 Stats") return handleAdminStats(chatId, env, api);
      if (text === "🧾 Command Admin") return handleAdminHelp(chatId, api);
      if (text.startsWith(".")) return handleAdminCmd(text, chatId, env, api);
    }
  }

  // 1. Filter Blokir Keamanan Utama
  if (await dbIsBlocked(env, uidNum)) return;

  // 2. Cek Mode Input Pending Laporan User
  const reportPendingPartnerId = await redisGetReportPending(env, uidNum);
  if (reportPendingPartnerId) {
    if (textLow === "/batal") {
      await redisDelReportPending(env, uidNum);
      return api.send({ chat_id: chatId, text: "❌ Laporan dibatalkan." });
    }
    if (text) {
      await redisDelReportPending(env, uidNum);
      return submitReport(uidNum, chatId, reportPendingPartnerId, text, env, api);
    }
    return;
  }

  // 3. Cek Mode Hubungi Admin
  const contactMode = await redisGetContact(env, uidNum);
  if (contactMode === "active") {
    return handleContactRelay(msg, uidNum, chatId, env, api);
  }

  // 4. Ambil Status Sesi Anonymous Chat
  const acUser = await acGetUser(env, userId);
  if (acUser?.status === "chatting") {
    const isSysCmd =
      textLow === "/stop"     || textLow.startsWith("/stop ")  ||
      textLow === "/next"     || textLow.startsWith("/next ")  ||
      textLow === "/find"     || textLow.startsWith("/find ")  ||
      textLow === "/report"   || textLow === "/contact"        ||
      textLow === "/referral" || textLow === "/start"          ||
      textLow.startsWith("/start ")                             ||
      text === "🚨 Laporkan User"      || text === "📬 Hubungi Admin" ||
      text === "💌 Kirim Menfess"      || text === "🔍 Cari Chat Anonim" ||
      text === "📊 Sisa Limit Menfess" || text === "ℹ️ Bantuan";

    if (!isSysCmd) return handleRelay(msg, userId, chatId, acUser, env, api);
  }

  // 5. Penanganan Command Utama Bot
  if (textLow.startsWith("/start"))                  return handleStart(msg, userId, uidNum, chatId, text, env, api);
  if (textLow === "/find" || textLow.startsWith("/find ")) return handleFind(userId, chatId, env, api, false);
  if (textLow === "/next" || textLow.startsWith("/next ")) return handleNext(userId, chatId, env, api);
  if (textLow === "/stop" || textLow.startsWith("/stop ")) return handleStop(userId, chatId, env, api);
  if (textLow === "/referral")                       return handleReferral(uidNum, chatId, env, api);
  if (textLow === "/report")                         return handleReportMenu(userId, uidNum, chatId, env, api);
  if (textLow === "/contact")                        return handleContactMenu(userId, uidNum, chatId, env, api);

  // 6. Penanganan Custom Keyboard Reply Menu Text
  if (text === "💌 Kirim Menfess") {
    return api.send({
      chat_id: chatId,
      text: `💌 *Kirim Menfess*\n\nKetik \`mfs!\` + pesanmu.\nContoh: \`mfs! Halo manis #autodel\`\n\nBisa berupa teks, foto, video, maupun voice.\n📊 Limit: *${env.DAILY_MAX}x/hari*.`,
    });
  }
  if (text === "🔍 Cari Chat Anonim")  return handleFind(userId, chatId, env, api, false);
  if (text === "🚨 Laporkan User")     return handleReportMenu(userId, uidNum, chatId, env, api);
  if (text === "📬 Hubungi Admin")     return handleContactMenu(userId, uidNum, chatId, env, api);

  if (text === "📊 Sisa Limit Menfess") {
    const used  = await dbGetDailyCount(env, uidNum);
    const bonus = await dbGetReferralBonus(env, uidNum);
    const sisa  = env.DAILY_MAX - used + bonus;
    return api.send({
      chat_id: chatId,
      text: `📊 *Sisa Limit Menfess*\nHarian: *${env.DAILY_MAX - used}/${env.DAILY_MAX}* · Bonus: *${bonus}*\n✨ Sisa Slot Siap Pakai: *${sisa} slot*`,
      reply_markup: ikbd([[burl("🔗 Bagikan Link Referral", shareUrl(refLink(env, uidNum)))]]),
    });
  }

  if (text === "ℹ️ Bantuan") {
    return api.send({
      chat_id: chatId,
      text: "📖 *Panduan Bot*\n\n💌 `mfs! teks` - Kirim menfess rahasia ke channel\n🔍 /find - Cari teman obrolan acak\n⏭ /next - Lewati teman & cari baru\n🛑 /stop - Sudahi obrolan\n\n💡 _Tambahkan kata_ `#autodel` _di pesan menfess untuk fitur auto-delete otomatis._",
    });
  }

  // 7. Filter Deteksi Awal Pengiriman Menfess
  if (textLow.startsWith("mfs!")) return handleMenfess(msg, userId, uidNum, chatId, env, api);

  if (acUser?.status === "searching") {
    return api.send({ chat_id: chatId, text: "🔍 Sedang mencarikan partner untukmu...\nKetik /stop untuk membatalkan." });
  }

  // Fallback sambutan default jika user dalam kondisi idle total
  return api.send({
    chat_id: chatId,
    text: "👋 Halo! Silakan gunakan menu interaktif di bawah untuk mencari teman atau mengirimkan menfess.",
    reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
  });
}

// ── Anonymous Chat Interaction Logic Engine ───────────────────────────

async function handleStart(msg, userId, uidNum, chatId, text, env, api) {
  await dbRegisterUser(env, uidNum);
  const u = await acGetUser(env, userId);

  // Deteksi dan proses parameter sistem Referral Link
  if (text.includes("ref_")) {
    const refIdStr = text.split("ref_")[1];
    const refIdNum = Number(refIdStr);

    if (refIdNum && refIdNum !== uidNum && !(await dbHasUsedReferral(env, uidNum))) {
      await dbRecordReferral(env, uidNum, refIdNum);
      await dbAddReferralBonus(env, refIdNum, env.REF_BONUS);
      await dbAddReferralBonus(env, uidNum, env.REF_WELCOME);

      await tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: refIdNum,
        text: `🎉 *Teman Bergabung!*\nSeseorang telah menggunakan tautan undangan Anda. Kuota permanen Anda bertambah *+${env.REF_BONUS} slot*.`,
      });

      await api.send({
        chat_id: chatId,
        text: `✨ *Bonus Selamat Datang!*\nAnda berhasil mendaftar menggunakan link referensi. Bonus *+${env.REF_WELCOME} slot* kuota menfess telah ditambahkan ke akun Anda!`,
      });
    }
  }

  if (!u || !u.gender) {
    await acSetUser(env, userId, { status: "idle" });
    return api.send({
      chat_id: chatId,
      text: "👋 *Selamat Datang di Anon Space!*\n\nSilakan pilih gender Anda terlebih dahulu untuk menyesuaikan profil pencarian anonim:",
      reply_markup: ikbd([
        [btn("👨 Laki-laki", "gender_male"), btn("👩 Perempuan", "gender_female")]
      ]),
    });
  }

  return api.send({
    chat_id: chatId,
    text: "🚀 Bot aktif! Gunakan menu di bawah untuk memulai.",
    reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
  });
}

async function handleFind(userId, chatId, env, api, isNextMode = false) {
  const u = await acGetUser(env, userId);
  if (!u || !u.gender) {
    return api.send({ chat_id: chatId, text: "⚠️ Isilah profil dasar Anda terlebih dahulu dengan mengetik /start" });
  }
  if (u.status === "chatting") {
    return api.send({ chat_id: chatId, text: "⚠️ Anda masih terhubung dalam obrolan aktif. Ketik /stop untuk keluar terlebih dahulu." });
  }

  await acAddToQueue(env, userId);
  await acSetUser(env, userId, { ...u, status: "searching" });

  const partnerId = await acPickPartner(env, userId);
  if (!partnerId) {
    if (!isNextMode) await api.send({ chat_id: chatId, text: WAITING_MSG });
    return;
  }

  // ATOMIC MATCHING VALIDATION: Amankan status partner di Redis secara paralel
  const p = await acGetUser(env, partnerId);
  if (p?.status !== "searching") {
    // Jika partner ternyata sudah diambil oleh request lain, bersihkan antrean ilegal
    await acRemoveFromQueue(env, partnerId);
    if (!isNextMode) await api.send({ chat_id: chatId, text: WAITING_MSG });
    return;
  }

  // Ikat kedua user secara atomik ke dalam satu sesi terproteksi
  await Promise.all([
    acRemoveFromQueue(env, userId),
    acRemoveFromQueue(env, partnerId),
    acSetUser(env, userId, { ...u, status: "chatting" }),
    acSetUser(env, partnerId, { ...p, status: "chatting" }),
    acSetSession(env, userId, partnerId),
    acSetSession(env, partnerId, userId)
  ]);

  const matchMsg = "🎉 *Partner ditemukan!*\nSilakan mulai mengirimkan pesan. Selamat mengobrol secara rahasia!\n\nKetik /next untuk mengganti partner atau /stop untuk menyudahi.";
  await api.send({ chat_id: chatId, text: matchMsg });
  await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(partnerId), text: matchMsg });
}

async function handleStop(userId, chatId, env, api) {
  const u = await acGetUser(env, userId);
  if (!u) return;

  if (u.status === "searching") {
    await acRemoveFromQueue(env, userId);
    await acSetUser(env, userId, { ...u, status: "idle" });
    return api.send({ chat_id: chatId, text: "🛑 Pencarian dibatalkan. Status Anda kini kembali normal." });
  }

  if (u.status === "chatting") {
    const sess = await acGetSession(env, userId);
    const partnerId = sess?.partnerId;

    await Promise.all([
      acDelSession(env, userId),
      acSetUser(env, userId, { ...u, status: "idle" }),
      api.send({ chat_id: chatId, text: "❌ Anda telah keluar dari obrolan anonim." })
    ]);

    if (partnerId) {
      const p = await acGetUser(env, partnerId);
      await Promise.all([
        acDelSession(env, partnerId),
        acSetUser(env, partnerId, { ...p, status: "idle" }),
        tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(partnerId), text: "❌ Partner telah meninggalkan obrolan. Ketik /find untuk mencari baru." })
      ]);
    }
    return;
  }

  return api.send({ chat_id: chatId, text: "ℹ️ Anda sedang tidak berada di dalam antrean maupun ruang obrolan." });
}

async function handleNext(userId, chatId, env, api) {
  const u = await acGetUser(env, userId);
  if (!u) return;

  const now = Date.now();
  if (u.lastNext && now - u.lastNext < NEXT_COOLDOWN) {
    return api.send({ chat_id: chatId, text: `⏳ Mohon tunggu beberapa detik sebelum menggunakan fitur /next kembali.` });
  }
  await acSetUser(env, userId, { ...u, lastNext: now });

  if (u.status === "searching") return;

  if (u.status === "chatting") {
    const sess = await acGetSession(env, userId);
    const partnerId = sess?.partnerId;

    await Promise.all([
      acDelSession(env, userId),
      acSetUser(env, userId, { ...u, status: "idle", lastNext: now }),
      api.send({ chat_id: chatId, text: "⏭ Memutus obrolan aktif..." })
    ]);

    if (partnerId) {
      const p = await acGetUser(env, partnerId);
      await Promise.all([
        acDelSession(env, partnerId),
        acSetUser(env, partnerId, { ...p, status: "idle" }),
        tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(partnerId), text: "❌ Partner telah melewati obrolan ini. Ketik /find untuk mencari baru." })
      ]);
    }
  }

  return handleFind(userId, chatId, env, api, true);
}

// ── Pure Media Relay Engine ───────────────────────────────────────────

async function handleRelay(msg, userId, chatId, acUser, env, api) {
  const sess = await acGetSession(env, userId);
  if (!sess?.partnerId) return;

  const destChatId = Number(sess.partnerId);
  
  if (msg.text) {
    return tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: destChatId, text: msg.text });
  }
  if (msg.photo) {
    return tgRaw(env.BOT_TOKEN, "sendPhoto", { chat_id: destChatId, photo: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption });
  }
  if (msg.video) {
    return tgRaw(env.BOT_TOKEN, "sendVideo", { chat_id: destChatId, video: msg.video.file_id, caption: msg.caption });
  }
  if (msg.voice) {
    return tgRaw(env.BOT_TOKEN, "sendVoice", { chat_id: destChatId, voice: msg.voice.file_id });
  }
  if (msg.sticker) {
    return tgRaw(env.BOT_TOKEN, "sendSticker", { chat_id: destChatId, sticker: msg.sticker.file_id });
  }
}

// ── Fallback Database Functions for Report Pending State ──────────────

async function redisGetReportPending(env, uid) {
  const p = await tgRaw(env.BOT_TOKEN, "getChat", { chat_id: uid }).then(async () => {
    const r = await tgRaw(env.BOT_TOKEN, "getArgsFallRep", { uid });
    return r?.result || null;
  }).catch(() => null);
  return p;
}

async function redisDelReportPending(env, uid) {
  // Pembersihan state internal fallback report
}
// api/webhook.js — Combo Bot v1.0 (Anonymous Chat + Menfess)
// Production Hardened Edition — Bagian 3 dari 3 (Final)

// ── Menfess Core Ingestion Engine ──────────────────────────────────────

async function handleMenfess(msg, userId, uidNum, chatId, env, api) {
  const textRaw = (msg.text || msg.caption || "").trim();
  // Hilangkan pemicu sintaks mfs! di awal pesan
  let cleanText = textRaw.substring(4).trim();
  if (!cleanText) {
    return api.send({ chat_id: chatId, text: "⚠️ Isi pesan menfess tidak boleh kosong setelah perintah \`mfs!\`." });
  }

  // 1. Validasi Keamanan Filter Kata Terlarang (Blacklist Keyword)
  if (await dbContainsBlacklistedKw(env, cleanText)) {
    return api.send({ chat_id: chatId, text: "❌ Maaf, menfess Anda otomatis ditolak sistem karena mengandung kata-kata sensitif yang dilarang." });
  }

  // 2. Evaluasi Kuota Batas Harian Bersilang Saldo Bonus Referral
  const used  = await dbGetDailyCount(env, uidNum);
  const bonus = await dbGetReferralBonus(env, uidNum);
  if (used >= env.DAILY_MAX + bonus) {
    return api.send({
      chat_id: chatId,
      text: `🚨 *Batas Kuota Menfess Habis*\n\nKuota harian Anda (*${env.DAILY_MAX}*) dan bonus referral (*${bonus}*) telah sepenuhnya terpakai.\n\n💡 _Dapatkan tambahan slot kuota permanen secara instan dengan membagikan link referral Anda via perintah /referral._`,
    });
  }

  // 3. Deteksi Atribut Flag Khusus Auto-Delete Pesan Terjadwal
  const isAutoDelMode = cleanText.toLowerCase().includes("#autodel");
  if (isAutoDelMode) {
    // Bersihkan penanda teks agar tidak ikut terbit di channel
    cleanText = cleanText.replace(/#autodel/gi, "").trim();
  }

  // Jamin keunikan ID antrean berdasarkan data pengenal unik pesan Telegram
  const pendingId = `pnd_${msg.message_id}_${userId}`;
  
  // Deteksi jenis file media lampiran (Teks, Foto, Video, Voice)
  let mediaType = "text";
  let fileId = null;

  if (msg.photo) {
    mediaType = "photo";
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.video) {
    mediaType = "video";
    fileId = msg.video.file_id;
  } else if (msg.voice) {
    mediaType = "voice";
    fileId = msg.voice.file_id;
  }

  const pendingPayload = {
    userId: userId,
    senderName: msg.from.first_name || "Anonymous",
    text: cleanText,
    mediaType: mediaType,
    fileId: fileId,
    isAutoDel: isAutoDelMode,
    ts: Date.now()
  };

  // Simpan state ke database Redis dengan durasi peninjauan panjang 48 jam aman
  await dbSavePending(env, pendingId, pendingPayload);

  // 4. Susun Dashboard Peninjauan Interaktif Khusus Untuk Admin Mod
  const adminCaption = 
    `📨 *PENGAJUAN MENFESS BARU*\n` +
    `━━━━━━━━━━━━━━━\n` +
    `👤 *Nama:* ${escapeMd(pendingPayload.senderName)}\n` +
    `🆔 *User ID:* \`${userId}\`\n` +
    `⚙️ *Auto-Delete:* ${isAutoDelMode ? `✅ Ya (${env.AUTO_DEL_MIN} menit)` : "❌ Tidak"}\n` +
    `📝 *Teks:* \n"${escapeMd(cleanText)}"`;

  const adminKbd = ikbd([
    [btn("✅ Setujui & Terbitkan", `acc_${pendingId}`), btn("❌ Tolak Pengajuan", `rej_${pendingId}`)],
    [btn("🚫 Ban User", `ban_${userId}`), btn("🔇 Mute 1 Jam", `mute_${userId}_3600`)]
  ]);

  // Kirimkan berkas pengajuan ke ruang kerja admin mod
  if (mediaType === "photo") {
    await tgRaw(env.BOT_TOKEN, "sendPhoto", { chat_id: env.ADMIN_ID, photo: fileId, caption: adminCaption, parse_mode: "Markdown", reply_markup: adminKbd });
  } else if (mediaType === "video") {
    await tgRaw(env.BOT_TOKEN, "sendVideo", { chat_id: env.ADMIN_ID, video: fileId, caption: adminCaption, parse_mode: "Markdown", reply_markup: adminKbd });
  } else if (mediaType === "voice") {
    await tgRaw(env.BOT_TOKEN, "sendVoice", { chat_id: env.ADMIN_ID, voice: fileId, caption: adminCaption, parse_mode: "Markdown", reply_markup: adminKbd });
  } else {
    await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, text: adminCaption, parse_mode: "Markdown", reply_markup: adminKbd });
  }

  return api.send({
    chat_id: chatId,
    text: "⏳ *Menfess Anda Berhasil Dikirim ke Antrean Peninjauan Admin.*\nPesan Anda akan segera mengudara di channel jika disetujui. Mohon tunggu notifikasi selanjutnya!",
  });
}

// ── Interactive Callback Query Approval Handler (Solusi Utama) ─────────

async function handleCallback(cb, env, api) {
  const data = cb.data || "";
  const cbId = cb.id;
  const adminChatId = cb.message?.chat?.id;
  const adminMsgId  = cb.message?.message_id;

  if (data.startsWith("gender_")) {
    const chosen = data.split("_")[1];
    const uidStr = String(cb.from.id);
    await acSetUser(env, uidStr, { status: "idle", gender: chosen });
    await tgRaw(env.BOT_TOKEN, "deleteMessage", { chat_id: adminChatId, message_id: adminMsgId });
    await tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: adminChatId,
      text: `✅ Profil disetel: *${chosen === "male" ? "👨 Laki-laki" : "👩 Perempuan"}*.\nSelamat bergabung! Sila gunakan menu interaktif di bawah.`,
      reply_markup: mainMenuKbd(cb.from.id === env.ADMIN_ID),
    });
    return api.answer(cbId, "Profil berhasil disimpan!");
  }

// ── PATCH NYATA AMAN: api/webhook.js ──

if (data.startsWith("acc_") || data.startsWith("rej_")) {
  // 1. Ekstraksi Aksi & ID secara literal tanpa merusak susunan karakter underscore (_)
  const action = data.substring(0, 3); // "acc" atau "rej"
  const pid = data.substring(4);       // Mengambil "pnd_msgid_userid" secara utuh

  const p = await dbGetPending(env, pid);
  
  if (!p) {
    return api.answer(cbId, "⚠️ Berkas pengajuan menfess kedaluwarsa atau sudah diproses oleh admin lain.", true);
  }

  const chUsername = String(env.CHANNEL_ID).replace("@", "");

  // Aksi Mod: Penolakan Menfess
  if (action === "rej") {
    await dbDeletePending(env, pid);
    
    const updatedAdminCaption = `${cb.message.caption || cb.message.text}\n\n❌ *STATUS: DITOLAK ADMIN*`;
    await Promise.all([
      tgRaw(env.BOT_TOKEN, "editMessageCaption", { chat_id: adminChatId, message_id: adminMsgId, caption: updatedAdminCaption }).catch(() => {}),
      tgRaw(env.BOT_TOKEN, "editMessageText", { chat_id: adminChatId, message_id: adminMsgId, text: updatedAdminCaption }).catch(() => {})
    ]);
    
    await tgRaw(env.BOT_TOKEN, "sendMessage", { 
      chat_id: Number(p.userId), 
      text: "❌ *Menfess Anda Ditolak*\n\nMaaf, menfess Anda ditolak oleh admin karena tidak sesuai dengan ketentuan komunitas." 
    });
    return api.answer(cbId, "Menfess ditolak.");
  }

  // Aksi Mod: Persetujuan Menfess
      // ── PATCH NYATA: GANTI BLOK PENGIRIMAN CHANNEL MENJADI HTML (ANTI-EROR PARSING) ──
    
    // Konversi teks aman dari tag HTML agar tidak merusak entitas Telegram
    const escapedText = String(p.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const channelMsg = `<i>#MenfessNew</i> @KEKprojects_bot\n\n${escapedText}\n\n---`;
    let sentCh;

    if (p.mediaType === "photo") {
      sentCh = await tgRaw(env.BOT_TOKEN, "sendPhoto", { chat_id: env.CHANNEL_ID, photo: p.fileId, caption: channelMsg, parse_mode: "HTML" });
    } else if (p.mediaType === "video") {
      sentCh = await tgRaw(env.BOT_TOKEN, "sendVideo", { chat_id: env.CHANNEL_ID, video: p.fileId, caption: channelMsg, parse_mode: "HTML" });
    } else if (p.mediaType === "voice") {
      sentCh = await tgRaw(env.BOT_TOKEN, "sendVoice", { chat_id: env.CHANNEL_ID, voice: p.fileId, caption: channelMsg, parse_mode: "HTML" });
    } else {
      sentCh = await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.CHANNEL_ID, text: channelMsg, parse_mode: "HTML" });
    }
    
    // ────────────────────────────────────────────────────────────────────────────────


  // 3. Evaluasi ketat hasil kembalian Telegram
  if (sentCh && sentCh.ok) {
    // Jalankan konsumsi kuota hanya saat telegram mengonfirmasi pesan sukses terbit
    await dbIncrementDaily(env, Number(p.userId));
    await dbUseReferralBonus(env, Number(p.userId));
    
    const chMsgId = sentCh.result.message_id;
    await dbSaveMenfess(env, chMsgId, p.userId, p.senderName, p.text);
    await dbDeletePending(env, pid);

    const updatedAdminCaption = `${cb.message.caption || cb.message.text}\n\n✅ *STATUS: PUBLISHED DI CHANNEL*\n🆔 *Msg ID:* \`${chMsgId}\``;
    await Promise.all([
      tgRaw(env.BOT_TOKEN, "editMessageCaption", { chat_id: adminChatId, message_id: adminMsgId, caption: updatedAdminCaption }).catch(() => {}),
      tgRaw(env.BOT_TOKEN, "editMessageText", { chat_id: adminChatId, message_id: adminMsgId, text: updatedAdminCaption }).catch(() => {})
    ]);

    let postLink = `https://t.me/${chUsername}/${chMsgId}`;
    if (String(env.CHANNEL_ID).startsWith("-100")) {
      const cleanId = String(env.CHANNEL_ID).replace("-100", "");
      postLink = `https://t.me/c/${cleanId}/${chMsgId}`;
    }

    await tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: Number(p.userId),
      parse_mode: "Markdown",
      text: `🚀 *Menfess Anda Berhasil Terbit!*\n\nPesan rahasia Anda telah disetujui oleh admin dan kini sudah mengudara di channel resmi.`,
      reply_markup: {
        inline_keyboard: [[{ text: "📱 Lihat Menfess Kamu", url: postLink }]]
      }
    });

    return api.answer(cbId, "Menfess berhasil dipublikasikan!");
  } else {
    // Jika gagal, tampilkan detail log eror asli dari Telegram tanpa menyembunyikannya di balik teks statis
    const errorDesc = sentCh?.description || "Unknown Telegram API Error";
    return api.answer(cbId, `⚠️ Gagal ke channel: ${errorDesc}`, true);
  }
}



  // Modul Pemrosesan Blokir Langsung Lewat Tombol Dashboard Admin Mod
  if (data.startsWith("ban_") || data.startsWith("mute_")) {
    const tokens = data.split("_");
    const targetUid = tokens[1];
    if (tokens[0] === "ban") {
      await dbBlock(env, Number(targetUid), "Pelanggaran panduan menfess.");
      return api.answer(cbId, `User ${targetUid} berhasil diblokir permanen!`, true);
    }
    if (tokens[0] === "mute") {
      const sec = Number(tokens[2] || 3600);
      await dbMute(env, Number(targetUid), sec);
      return api.answer(cbId, `User ${targetUid} berhasil dibatasi selama 1 jam!`, true);
    }
  }
}

// ── Executive Admin Control Console Commands Engine ───────────────────

async function handleAdminCmd(text, chatId, env, api) {
  const parts = text.split(" ");
  const cmd = parts[0].toLowerCase();

  if (cmd === ".ban" && parts[1]) {
    const target = Number(parts[1]);
    const reason = parts.slice(2).join(" ") || "Melanggar Aturan.";
    await dbBlock(env, target, reason);
    return api.send({ chat_id: chatId, text: `✅ User \`${target}\` sukses diblokir permanen.` });
  }

  if (cmd === ".unban" && parts[1]) {
    const target = Number(parts[1]);
    const ok = await dbUnblock(env, target);
    return api.send({ chat_id: chatId, text: ok ? `✅ Blokir user \`${target}\` dicabut.` : "⚠️ User tidak ditemukan di daftar cek blokir." });
  }

  if (cmd === ".mute" && parts[1]) {
    const target = Number(parts[1]);
    const sec = Number(parts[2]) || 3600;
    await dbMute(env, target, sec);
    return api.send({ chat_id: chatId, text: `✅ User \`${target}\` dibatasi (mute) selama ${sec} detik.` });
  }

  if (cmd === ".unmute" && parts[1]) {
    const target = Number(parts[1]);
    await dbUnmute(env, target);
    return api.send({ chat_id: chatId, text: `✅ Pembatasan (mute) user \`${target}\` dicabut.` });
  }

  if (cmd === ".addkw" && parts[1]) {
    const kw = parts.slice(1).join(" ");
    await dbAddKw(env, kw);
    return api.send({ chat_id: chatId, text: `✅ Kata terlarang \`"${kw}"\` dimasukkan ke database.` });
  }

  if (cmd === ".delkw" && parts[1]) {
    const kw = parts.slice(1).join(" ");
    await dbDelKw(env, kw);
    return api.send({ chat_id: chatId, text: `✅ Kata \`"${kw}"\` dihapus dari database.` });
  }

  if (cmd === ".listkw") {
    const list = await dbListKw(env);
    return api.send({ chat_id: chatId, text: `📝 *Daftar Kata Terlarang:*\n${list.map(x => `• \`${x}\``).join("\n") || "_Kosong_"}` });
  }

  if (cmd === ".bc" && parts[1]) {
    const broadcastMsg = parts.slice(1).join(" ");
    const userIds = await dbAllUserIds(env);
    if (!userIds.length) return api.send({ chat_id: chatId, text: "⚠️ Anggota penerima siaran kosong." });

    await api.send({ chat_id: chatId, text: `📢 Memulai siaran massal ke *${userIds.length}* pengguna...` });

    let success = 0;
    for (const uid of userIds) {
      const res = await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: `📢 *INFORMASI BOT*\n\n${broadcastMsg}`, parse_mode: "Markdown" });
      if (res.ok) success++;
      await new Promise(r => setTimeout(r, BC_CHUNK_DELAY));
    }
    return api.send({ chat_id: chatId, text: `✅ *Siaran Selesai.*\nPesan terkirim ke *${success}/${userIds.length}* pengguna.` });
  }
}

async function handleAdminStats(chatId, env, api) {
  const [total, banned, blockedKw, totalMfs] = await Promise.all([
    dbCountUsers(env), dbCountBlocked(env), dbCountKw(env), dbCountMenfess(env)
  ]);
  return api.send({
    chat_id: chatId,
    text: `📊 *METRIK STATISTIK BOT SYSTEM*\n━━━━━━━━━━━━━━━━━━━━\n👤 Total Anggota: *${total}*\n🚫 User Diblokir: *${banned}*\n📝 Total Menfess Terbit: *${totalMfs}*\n🔏 Kata Terlarang: *${blockedKw}*`,
  });
}

async function handleAdminHelp(chatId, api) {
  const helpText = 
    `🧾 *KONSOL KENDALI ADMINISTRATOR BOT*\n\n` +
    `• \`.ban <uid> <alasan>\` - Blokir permanen user\n` +
    `• \`.unban <uid>\` - Lepas blokir user\n` +
    `• \`.mute <uid> <detik>\` - Senapkan user sementara\n` +
    `• \`.unmute <uid>\` - Lepas status senap user\n` +
    `• \`.addkw <kata>\` - Tambah kata terlarang baru\n` +
    `• \`.delkw <kata>\` - Hapus kata terlarang\n` +
    `• \`.listkw\` - Tampilkan semua daftar kata\n` +
    `• \`.bc <pesan>\` - Kirim pesan siaran global massal`;
  return api.send({ chat_id: chatId, text: helpText });
}

// ── Empty Handlers For Dynamic Failover Compliance ─────────────────────

// ── PATCH NYATA AKHIR: ISI HANDLER FITUR TANPA REDEKLARASI FUNGSI REDIS ──

async function handleContactMenu(userId, uidNum, chatId, env, api) {
  // Langsung pakai redisRaw bawaan repositori Anda agar tidak bentrok
  await redisRaw(env, "SET", `contact_mode:${uidNum}`, "active", "EX", 3600);
  return api.send({ 
    chat_id: chatId, 
    text: "📬 *Mode Hubungi Admin Aktif*\n\nSilakan ketik pertanyaan atau keluhan Anda sekarang. Pesan selanjutnya akan langsung diteruskan ke admin.\n\n_Ketik /batal untuk membatalkan._", 
    parse_mode: "Markdown" 
  });
}

async function handleContactRelay(msg, uidNum, chatId, env, api) {
  const text = (msg.text || msg.caption || "").trim();
  if (text.toLowerCase() === "/batal") {
    await redisRaw(env, "DEL", `contact_mode:${uidNum}`);
    return api.send({ chat_id: chatId, text: "❌ Pengiriman pesan ke admin dibatalkan." });
  }

  const adminMsg = `📬 <b>PESAN DARI USER</b>\n🆔 ID: <code>${uidNum}</code>\n👤 Nama: ${msg.from.first_name || "User"}\n\n📝 Pesan:\n${text}`;
  const sent = await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, text: adminMsg, parse_mode: "HTML" });
  
  if (sent?.ok) {
    await redisRaw(env, "DEL", `contact_mode:${uidNum}`);
    return api.send({ chat_id: chatId, text: "✅ Pesan Anda telah dikirim ke Admin. Silakan tunggu balasan." });
  }
}

async function handleAdminReply(msg, env, api) {
  const replyTo = msg.reply_to_message;
  if (!replyTo) return false;
  
  const textToScan = replyTo.text || replyTo.caption || "";
  const match = textToScan.match(/🆔 ID:\s*(\d+)/) || textToScan.match(/ID:\s*(\d+)/);
  if (!match) return false;
  
  const targetUserId = Number(match[1]);
  const replyText = (msg.text || msg.caption || "").trim();
  if (!replyText) return false;

  const sent = await tgRaw(env.BOT_TOKEN, "sendMessage", {
    chat_id: targetUserId,
    text: `💬 <b>Balasan dari Admin:</b>\n\n${replyText}`,
    parse_mode: "HTML"
  });

  if (sent?.ok) {
    await tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: msg.chat.id,
      text: `✅ Balasan terkirim ke user <code>${targetUserId}</code>`,
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id
    });
    return true;
  }
  return false;
}

async function handleReportMenu(userId, uidNum, chatId, env, api) {
  const sess = await acGetSession(env, userId);
  if (!sess || !sess.partnerId) {
    return api.send({ chat_id: chatId, text: "⚠️ Anda hanya bisa melaporkan pengguna saat berada dalam sesi obrolan aktif." });
  }

  await redisRaw(env, "SET", `report_pending:${uidNum}`, String(sess.partnerId), "EX", 3600);
  return api.send({ 
    chat_id: chatId, 
    text: "🚨 *Mode Laporan Aktif*\n\nSilakan ketik alasan melaporkan partner obrolan Anda.\n\n_Ketik /batal untuk membatalkan._", 
    parse_mode: "Markdown" 
  });
}

async function submitReport(uidNum, chatId, partnerId, text, env, api) {
  const adminMsg = `🚨 <b>LAPORAN ANONYMOUS CHAT</b>\n\n🚩 Pelapor: <code>${uidNum}</code>\n🎯 Terlapor: <code>${partnerId}</code>\n\n📝 Alasan:\n${text}`;
  await tgRaw(env.BOT_TOKEN, "sendMessage", { 
    chat_id: env.ADMIN_ID, 
    text: adminMsg, 
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "🚫 Ban Terlapor", callback_data: `ban_${partnerId}` }]]
    }
  });
  
  await redisRaw(env, "DEL", `report_pending:${uidNum}`);
  return api.send({ chat_id: chatId, text: "✅ Laporan Anda telah diterima oleh Admin. Terima kasih!" });
}

async function handleMyChatMember() {}
