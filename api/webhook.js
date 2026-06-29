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
const BC_CHUNK_DELAY = 50;     // delay jeda antar-pesan broadcast global (anti-rate limit)

// ── Env Validation & Settings Core ─────────────────────────────────────

const REQUIRED_ENV = [
  "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_TOKEN",
  "BOT_TOKEN",
  "CHANNEL_ID",
  "ADMIN_ID",
  "BOT_USERNAME"
];

function getEnv() {
  const env = {
    KV_URL:       process.env.UPSTASH_REDIS_URL,
    KV_TOKEN:     process.env.UPSTASH_REDIS_TOKEN,
    BOT_TOKEN:    process.env.BOT_TOKEN,
    CHANNEL_ID:   process.env.CHANNEL_ID,
    ADMIN_ID:     Number(process.env.ADMIN_ID),
    BOT_USERNAME: (process.env.BOT_USERNAME || "").replace("@", ""),
    DAILY_MAX:    Number(process.env.DAILY_MAX || 3),
    AUTO_DEL_MIN: Number(process.env.AUTO_DELETE_MINUTES || 10),
    REF_BONUS:    Number(process.env.REFERRAL_BONUS || 3),
    REF_WELCOME:  Number(process.env.REFERRAL_WELCOME || 3),
  };

  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  if (isNaN(env.ADMIN_ID) || env.ADMIN_ID === 0) {
    throw new Error("ADMIN_ID must be a numeric Telegram ID.");
  }

  return env;
}

// ── Helper Utilities ───────────────────────────────────────────────────

function refLink(env, uid) {
  return `https://t.me/${env.BOT_USERNAME}?start=ref_${uid}`;
}

function shareUrl(link) {
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Yuk chat anonim & kirim menfess rahasia di sini! 🎉")}`;
}

function escapeMd(text) {
  if (!text) return "";
  return String(text).replace(/([_*`\[])/g, "\\$1");
}

function mainMenuKbd(isAdmin) {
  const rows = [
    [{ text: "💌 Kirim Menfess" },      { text: "🔍 Cari Chat Anonim" }],
    [{ text: "📊 Sisa Limit Menfess" }, { text: "ℹ️ Bantuan" }],
    [{ text: "🚨 Laporkan User" },      { text: "📬 Hubungi Admin" }],
  ];
  if (isAdmin) {
    rows.push([{ text: "📊 Stats" }, { text: "🧾 Command Admin" }]);
  }
  return {
    keyboard: rows,
    resize_keyboard: true,
    input_field_placeholder: "Silakan pilih menu...",
  };
}

const WAITING_MSG =
  "🔍 *Nyariin partner buat kamu...*\n\n" +
  "Belum ada yang online sekarang 😴\n" +
  "Nanti otomatis nyambung kalau ada yang nyari juga!\n\n" +
  "Sambil nunggu, bisa kirim menfess dulu: `mfs!` + pesan 💌\n" +
  "/stop — batalkan pencarian";

// ── Raw Network Communications (Atomic Native Mode) ───────────────────

async function tgRaw(token, method, body) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TG_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
    });
    return await res.json();
  } catch (e) {
    const msg = e.name === "AbortError" ? `TIMEOUT (${TG_TIMEOUT_MS}ms)` : e.message;
    console.error(`tgRaw [${method}] error:`, msg);
    return { ok: false, description: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function redisRaw(env, ...args) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(env.KV_URL, {
      method:  "POST",
      headers: { Authorization: `Bearer ${env.KV_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify(args),
      signal:  ctrl.signal,
    });
    const data = await res.json();
    return data?.result ?? null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Custom Dynamic Redis Key Managers ──────────────────────────────────

async function redisGetContact(env, uid)          { return redisRaw(env, "GET", `contact_mode:${uid}`); }
async function redisSetContact(env, uid, exSec)   { await redisRaw(env, "SET", `contact_mode:${uid}`, "active", "EX", exSec || 1800); }
async function redisDelContact(env, uid)          { await redisRaw(env, "DEL", `contact_mode:${uid}`); }
async function redisSaveAdminReply(env, mid, uid) { await redisRaw(env, "SET", `admin_reply:${mid}`, String(uid), "EX", 86400); }
async function redisGetAdminReply(env, mid)       { return redisRaw(env, "GET", `admin_reply:${mid}`); }
async function redisSaveReportPending(env, uid, pid) { await redisRaw(env, "SET", `report_pending:${uid}`, String(pid), "EX", 300); }
async function redisGetReportPending(env, uid)    { return redisRaw(env, "GET", `report_pending:${uid}`); }
async function redisDelReportPending(env, uid)    { await redisRaw(env, "DEL", `report_pending:${uid}`); }

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

    // Proteksi Idempotensi (Anti Duplikasi Update Serverless)
    const updateKey = String(update.update_id);
    if (await acIsDone(env, updateKey)) return res.status(200).json({ ok: true });
    await acMarkDone(env, updateKey);

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

// ── Telegram Kicked/Block Status Tracking ──────────────────────────────

async function handleMyChatMember(update, env, api) {
  const newStatus = update.new_chat_member?.status;
  const oldStatus = update.old_chat_member?.status;
  const user      = update.from;
  if (!user) return;

  const userId    = user.id;
  const firstName = escapeMd(user.first_name || "User");
  const username  = user.username ? `@${user.username}` : "—";

  if (newStatus === "kicked") {
    try {
      const acUser  = await acGetUser(env, String(userId));
      const session = acUser?.status === "chatting" ? await acGetSession(env, String(userId)) : null;
      if (session) {
        const pid = String(session.partnerId);
        const pData = await acGetUser(env, pid);
        if (pData) await acSetUser(env, pid, { ...pData, status: "idle" });
        await acDelSession(env, pid);
        await acDelSession(env, String(userId));
        tgRaw(env.BOT_TOKEN, "sendMessage", {
          chat_id: Number(session.partnerId),
          text: "👋 Partner keluar dari sesi karena memblokir bot.\nMau cari yang baru? /find 😊",
        }).catch(() => {});
      }
      if (acUser) await acSetUser(env, String(userId), { ...acUser, status: "idle" });
      await acRemoveFromQueue(env, String(userId));
    } catch (e) {}

    tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_ID,
      parse_mode: "Markdown",
      text: `🚫 *BOT DIBLOKIR*\n\n👤 *Nama:* [${firstName}](tg://user?id=${userId})\n🆔 *User ID:* \`${userId}\`\n🏷️ *Username:* ${username}`,
    }).catch(() => {});
    return;
  }

  if (oldStatus === "kicked" && newStatus === "member") {
    tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_ID,
      parse_mode: "Markdown",
      text: `✅ *USER BUKA BLOKIR BOT*\n\n👤 *Nama:* [${firstName}](tg://user?id=${userId})\n🆔 *User ID:* \`${userId}\`\n🏷️ *Username:* ${username}`,
    }).catch(() => {});
  }
}

// ── Central Message Splitter & Router ──────────────────────────────────

async function handleMessage(msg, env, api) {
  const userId  = String(msg.from?.id);
  const uidNum  = Number(userId);
  const chatId  = msg.chat?.id;
  if (!userId || !chatId) return;

  const text    = (msg.text || msg.caption || "").trim();
  const textLow = text.toLowerCase();

  // 1. Cek Mode Input Pending Laporan User
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

  // 2. Cek Mode Hubungi Admin
  const contactMode = await redisGetContact(env, uidNum);
  if (contactMode === "active") {
    return handleContactRelay(msg, uidNum, chatId, env, api);
  }

  // 3. Ambil Status Sesi Anonymous Chat
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
      text === "📊 Sisa Limit Menfess" || text === "ℹ️ Bantuan" ||
      text === "📊 Stats"              || text === "🧾 Command Admin" ||
      (text.startsWith(".") && uidNum === env.ADMIN_ID) ||
      textLow.startsWith("mfs!");

    if (!isSysCmd) return handleRelay(msg, userId, chatId, acUser, env, api);
  }

  // 4. Struktur Perintah Command Utama Bot
  if (textLow.startsWith("/start"))                  return handleStart(msg, userId, uidNum, chatId, text, env, api);
  if (textLow === "/find" || textLow.startsWith("/find ")) return handleFind(userId, chatId, env, api, false);
  if (textLow === "/next" || textLow.startsWith("/next ")) return handleNext(userId, chatId, env, api);
  if (textLow === "/stop" || textLow.startsWith("/stop ")) return handleStop(userId, chatId, env, api);
  if (textLow === "/referral")                       return handleReferral(uidNum, chatId, env, api);
  if (textLow === "/report")                         return handleReportMenu(userId, uidNum, chatId, env, api);
  if (textLow === "/contact")                        return handleContactMenu(userId, uidNum, chatId, env, api);

  // 5. Penangan Custom Keyboard Reply Menu Text
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

  // 6. Akses Khusus Command Admin Control Panel
  if (text === "📊 Stats"         && uidNum === env.ADMIN_ID) return handleAdminStats(chatId, env, api);
  if (text === "🧾 Command Admin" && uidNum === env.ADMIN_ID) return handleAdminHelp(chatId, api);
  if (text.startsWith(".")        && uidNum === env.ADMIN_ID) return handleAdminCmd(text, chatId, env, api);

  // 7. Penanganan Awal Pengiriman Menfess
  if (textLow.startsWith("mfs!")) return handleMenfess(msg, userId, uidNum, chatId, env, api);

  if (acUser?.status === "searching") {
    return api.send({ chat_id: chatId, text: "🔍 Sedang mencarikan partner untukmu...\nKetik /stop untuk membatalkan." });
  }
}

// ── Anonymous Chat Core Engine Operations ──────────────────────────────

async function handleStart(msg, userId, uidNum, chatId, text, env, api) {
  await dbRegisterUser(env, uidNum);
  const arg = text.split(" ")[1] || "";
  
  // Validasi Alur Referral Berlapis (Anti Race Condition Check)
  if (arg.startsWith("ref_")) {
    try {
      const refId = Number(arg.slice(4));
      if (Number.isFinite(refId) && refId !== uidNum && !(await dbHasUsedReferral(env, uidNum))) {
        await dbRecordReferral(env, uidNum, refId);
        await dbAddReferralBonus(env, uidNum, env.REF_WELCOME);
        await dbAddReferralBonus(env, refId, env.REF_BONUS);
        await api.send({ chat_id: chatId, text: `🎉 Sukses masuk lewat referral! Anda mendapat +${env.REF_WELCOME} limit menfess.` });
        api.send({ chat_id: refId, text: `🎉 Teman baru bergabung via link kamu! Kamu dapat tambahan +${env.REF_BONUS} bonus kuota.` }).catch(() => {});
      }
    } catch (e) {}
  }

  const acUser = await acGetUser(env, userId);
  if (!acUser?.gender) {
    return api.send({
      chat_id: chatId,
      text: "👋 *Halo! Selamat datang! di Anon Space*\nSebelum memulai, pilih gender kamu dulu ya:",
      reply_markup: ikbd([[btn("👨 Laki-laki", "gender_male"), btn("👩 Perempuan", "gender_female")]]),
    });
  }
  return api.send({
    chat_id: chatId,
    text: "👋 Selamat datang kembali! Gunakan opsi tombol menu di bawah untuk bernavigasi.",
    reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
  });
}

async function handleFind(userId, chatId, env, api, fromInternal) {
  const user = await acGetUser(env, userId);
  if (!user?.gender) return api.send({ chat_id: chatId, text: "⚠️ Ketik /start terlebih dahulu untuk mendaftar profil." });

  if (!fromInternal) {
    if (user.status === "chatting")  return api.send({ chat_id: chatId, text: "💬 Kamu sedang terhubung dalam obrolan.\n/next — ganti partner · /stop — berhenti" });
    if (user.status === "searching") return api.send({ chat_id: chatId, text: "🔍 Sedang antre mencari partner...\n/stop — batalkan pencarian" });
  }

  await acSetUser(env, userId, { ...user, status: "searching" });
  await acAddToQueue(env, userId);

  const partnerId = await pickValidPartner(env, userId);
  if (!partnerId) return api.send({ chat_id: chatId, text: WAITING_MSG });

  const partnerUser = await acGetUser(env, partnerId);
  if (!partnerUser || partnerUser.status !== "searching") {
    await acRemoveFromQueue(env, partnerId);
    const nextId = await pickValidPartner(env, userId);
    if (!nextId) return api.send({ chat_id: chatId, text: WAITING_MSG });
    
    const nextUser = await acGetUser(env, nextId);
    if (!nextUser || nextUser.status !== "searching") {
      await acRemoveFromQueue(env, nextId);
      return api.send({ chat_id: chatId, text: WAITING_MSG });
    }
    return matchPair(env, api, userId, user, nextId, nextUser, chatId);
  }
  return matchPair(env, api, userId, user, partnerId, partnerUser, chatId);
}

async function pickValidPartner(env, excludeId) {
  const q = await acGetQueue(env);
  const candidates = q.filter(x => x !== String(excludeId));
  for (const candidate of candidates) {
    const u = await acGetUser(env, candidate);
    if (u?.gender && u?.status === "searching") return candidate;
    await acRemoveFromQueue(env, candidate);
  }
  return null;
}

async function matchPair(env, api, userId, user, partnerId, partnerUser, chatId) {
  await acRemoveFromQueue(env, userId);
  await acRemoveFromQueue(env, partnerId);
  await acSetUser(env, userId,    { ...user,        status: "chatting" });
  await acSetUser(env, partnerId, { ...partnerUser, status: "chatting" });
  await acSetSession(env, userId, partnerId);

  const msgText = "🎉 *Partner ditemukan!*\nNgobrol dimulai secara anonim.\n\n⏭ /next — ganti partner · 🛑 /stop — keluar sesi";
  await api.send({ chat_id: Number(userId),    text: msgText });
  await api.send({ chat_id: Number(partnerId), text: msgText });
}

async function handleNext(userId, chatId, env, api) {
  const user = await acGetUser(env, userId);
  if (!user) return api.send({ chat_id: chatId, text: "⚠️ Ketik /start dulu." });

  const now = Date.now();
  if (now - (user.lastNext || 0) < NEXT_COOLDOWN) {
    return api.send({ chat_id: chatId, text: `⏳ Mohon tunggu sebentar sebelum melakukan pergantian partner lagi.` });
  }

  const session = await acGetSession(env, userId);
  if (session) {
    const pid = String(session.partnerId);
    const pData = await acGetUser(env, pid);
    api.send({ chat_id: Number(pid), text: "👋 Partner meninggalkan obrolan.\nKetik /find untuk mencari baru!" }).catch(() => {});
    if (pData) await acSetUser(env, pid, { ...pData, status: "idle" });
    await acDelSession(env, pid);
    await acDelSession(env, userId);
  }

  await acRemoveFromQueue(env, userId);
  await acSetUser(env, userId, { ...user, status: "idle", lastNext: now });
  return handleFind(userId, chatId, env, api, true);
}

async function handleStop(userId, chatId, env, api) {
  const user = await acGetUser(env, userId);
  if (!user) return api.send({ chat_id: chatId, text: "⚠️ Ketik /start dulu." });

  if (user.status === "idle") {
    return api.send({ chat_id: chatId, text: "ℹ️ Kamu tidak sedang berada dalam obrolan.\nKetik /find untuk mencari partner." });
  }

  await acRemoveFromQueue(env, userId);
  const session = await acGetSession(env, userId);
  if (session) {
    const pid = String(session.partnerId);
    const pData = await acGetUser(env, pid);
    api.send({ chat_id: Number(pid), text: "👋 Partner menghentikan obrolan.\nKetik /find untuk mencari baru." }).catch(() => {});
    if (pData) await acSetUser(env, pid, { ...pData, status: "idle" });
    await acDelSession(env, pid);
    await acDelSession(env, userId);
  }
  await acSetUser(env, userId, { ...user, status: "idle" });
  return api.send({ 
    chat_id: chatId, 
    text: "🛑 Sesi dihentikan. Sampai jumpa kembali!", 
    reply_markup: mainMenuKbd(Number(userId) === env.ADMIN_ID) 
  });
}

async function handleRelay(msg, userId, chatId, acUser, env, api) {
  const session = await acGetSession(env, userId);
  if (!session) {
    await acSetUser(env, userId, { ...acUser, status: "idle" });
    return api.send({ chat_id: chatId, text: "⚠️ Sesi kedaluwarsa. Silakan cari partner ulang via /find.", reply_markup: mainMenuKbd(Number(userId) === env.ADMIN_ID) });
  }
  const pid = Number(session.partnerId);
  let chosenMethod = "sendMessage";
  let payload = { chat_id: pid };

  if (msg.text) {
    payload.text = msg.text;
  } else if (msg.photo) {
    chosenMethod = "sendPhoto";
    payload.photo = msg.photo[msg.photo.length - 1].file_id;
    payload.caption = msg.caption || "";
  } else if (msg.video) {
    chosenMethod = "sendVideo";
    payload.video = msg.video.file_id;
    payload.caption = msg.caption || "";
  } else if (msg.voice) {
    chosenMethod = "sendVoice";
    payload.voice = msg.voice.file_id;
  } else if (msg.sticker) {
    chosenMethod = "sendSticker";
    payload.sticker = msg.sticker.file_id;
  } else {
    return; 
  }

  const res = await tgRaw(env.BOT_TOKEN, chosenMethod, payload);
  if (!res.ok && (res.description?.includes("blocked") || res.description?.includes("chat not found"))) {
    const pData = await acGetUser(env, String(pid));
    if (pData) await acSetUser(env, String(pid), { ...pData, status: "idle" });
    await acDelSession(env, String(pid));
    await acDelSession(env, userId);
    await acSetUser(env, userId, { ...acUser, status: "idle" });
    await api.send({ chat_id: chatId, text: "⚠️ Partner tidak dapat dijangkau (bot diblokir olehnya). Sesi terpaksa diakhiri.", reply_markup: mainMenuKbd(Number(userId) === env.ADMIN_ID) });
  }
}

// ── Menfess Transmission & Approval Logic ──────────────────────────────

async function handleMenfess(msg, userId, uidNum, chatId, env, api) {
  // 1. Validasi Blokir & Mute
  if (await dbIsBlocked(env, uidNum)) {
    return api.send({ chat_id: chatId, text: "🛑 Akses Anda diblokir dari sistem ini karena pelanggaran." });
  }
  const muteTtl = await dbIsMuted(env, uidNum);
  if (muteTtl > 0) {
    return api.send({ chat_id: chatId, text: `⏳ Anda sedang dibatasi (mute). Sisa waktu: *${muteTtl} detik*.` });
  }

  // 2. Kalkulasi Sisa Kuota Limit Menfess
  const used  = await dbGetDailyCount(env, uidNum);
  const bonus = await dbGetReferralBonus(env, uidNum);
  if (used >= env.DAILY_MAX + bonus) {
    return api.send({
      chat_id: chatId,
      text: `⚠️ *Kuota Menfess Anda Habis!*\n\nAnda telah mencapai batas kirim menfess harian (*${env.DAILY_MAX}x/hari*).\n\n💡 Dapatkan tambahan slot kuota permanen dengan mengundang teman menggunakan link referral Anda!`,
      reply_markup: ikbd([[burl("🔗 Ambil Link Kuota Gratis", shareUrl(refLink(env, uidNum)))]]),
    });
  }

  // 3. Ekstraksi Konten & Filter Kata Kasar
  const rawText  = (msg.text || msg.caption || "");
  const baseText = rawText.replace(/^mfs!\s*/i, "").trim();
  if (!baseText && !msg.photo && !msg.video && !msg.voice) {
    return api.send({ chat_id: chatId, text: "⚠️ Konten menfess tidak terdeteksi. Silakan sertakan teks atau media setelah keyword `mfs!`." });
  }

  if (await dbContainsBlacklistedKw(env, baseText)) {
    return api.send({ chat_id: chatId, text: "⚠️ Pesan Anda dibatalkan secara otomatis karena mengandung kata sensitif/terlarang." });
  }

  // 4. Struktur Data untuk Antrean Review Admin
  const isAutoDel = baseText.toLowerCase().includes("#autodel");
  const senderName = msg.from?.first_name || "Anonymous";
  const pendingId = `p_${Date.now()}`;
  
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

  const payload = {
    pendingId, userId, senderName, text: baseText, mediaType, fileId, isAutoDel
  };

  await dbSavePending(env, pendingId, payload);

  // 5. Kirim ke Ruang Moderasi Admin
  const adminMsgBase = `📩 *MENFESS MASUK (REVIEW)*\n\n👤 *Pengirim:* [User](tg://user?id=${userId}) (\`${userId}\`)\n⚙️ *Auto-Delete:* ${isAutoDel ? "✅ Ya" : "❌ Tidak"}\n\n📝 *Isi Pesan:*\n${escapeMd(baseText)}`;
  const adminKbd = ikbd([
    [btn("✅ Setujui", `acc_${pendingId}`), btn("❌ Tolak", `rej_${pendingId}`)],
    [btn("🚫 Ban User", `ban_${userId}`), btn("⏳ Mute 1 Jam", `mute_${userId}_3600`)]
  ]);

  let sentAdmin;
  if (mediaType === "photo") {
    sentAdmin = await tgRaw(env.BOT_TOKEN, "sendPhoto", { chat_id: env.ADMIN_ID, photo: fileId, caption: adminMsgBase, parse_mode: "Markdown", reply_markup: adminKbd });
  } else if (mediaType === "video") {
    sentAdmin = await tgRaw(env.BOT_TOKEN, "sendVideo", { chat_id: env.ADMIN_ID, video: fileId, caption: adminMsgBase, parse_mode: "Markdown", reply_markup: adminKbd });
  } else if (mediaType === "voice") {
    sentAdmin = await tgRaw(env.BOT_TOKEN, "sendVoice", { chat_id: env.ADMIN_ID, voice: fileId, caption: adminMsgBase, parse_mode: "Markdown", reply_markup: adminKbd });
  } else {
    sentAdmin = await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, text: adminMsgBase, parse_mode: "Markdown", reply_markup: adminKbd });
  }

  if (sentAdmin?.ok) {
    await api.send({ chat_id: chatId, text: "⏳ *Menfess berhasil terkirim ke sistem antrean!*\nPesanmu sedang ditinjau oleh tim admin/moderator." });
  } else {
    await api.send({ chat_id: chatId, text: "❌ Terjadi kegagalan transmisi internal saat mengirim menfess ke ruang admin." });
  }
}

// ── User Interactive Report & Contact Handling ────────────────────────

async function handleReportMenu(userId, uidNum, chatId, env, api) {
  const session = await acGetSession(env, userId);
  if (!session) {
    return api.send({ chat_id: chatId, text: "⚠️ Fitur laporan hanya aktif ketika kamu terhubung atau baru saja terhubung dengan partner anonim." });
  }
  const pid = session.partnerId;
  await redisSaveReportPending(env, uidNum, pid);
  return api.send({ chat_id: chatId, text: "🚨 *Pelaporan Korban Anonim*\n\nSilakan ketik alasan pelaporan kamu secara mendetail dalam satu pesan.\nKetik /batal untuk membatalkan." });
}

async function submitReport(uidNum, chatId, partnerId, reason, env, api) {
  const adminAlert = 
    `🚨 *LAPORAN PENGGUNA BOT*\n\n` +
    `👤 *Pelapor:* [User](tg://user?id=${uidNum}) (\`${uidNum}\`)\n` +
    `🎯 *Terlapor:* [User](tg://user?id=${partnerId}) (\`${partnerId}\`)\n\n` +
    `💬 *Alasan/Bukti:*\n"${escapeMd(reason)}"`;

  const adminKbd = ikbd([
    [btn("🚫 Ban Terlapor", `ban_${partnerId}`), btn("⏳ Mute Terlapor 1 Jam", `mute_${partnerId}_3600`)],
    [btn("🧼 Bebaskan", "clear_report_view")]
  ]);

  await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, text: adminAlert, parse_mode: "Markdown", reply_markup: adminKbd });
  return api.send({ chat_id: chatId, text: "✅ Laporan pelanggaran Anda telah diteruskan ke admin. Terima kasih atas laporannya!" });
}

async function handleContactMenu(userId, uidNum, chatId, env, api) {
  await redisSetContact(env, uidNum, 1800);
  return api.send({ chat_id: chatId, text: "📬 *Hubungi Admin Hub*\n\nSemua pesan yang Anda kirimkan setelah ini (Teks/Gambar/Media) akan terkirim langsung ke admin.\nAdmin dapat membalas pesan Anda secara langsung.\n\nKetik `/stop_contact` untuk mengakhiri mode obrolan dengan admin." });
}

async function handleContactRelay(msg, uidNum, chatId, env, api) {
  const text = (msg.text || msg.caption || "").trim();
  if (text.toLowerCase() === "/stop_contact") {
    await redisDelContact(env, uidNum);
    return api.send({ chat_id: chatId, text: "❌ Keluar dari mode hubungi admin. Pesan Anda sekarang kembali normal." });
  }

  const relayHeader = `📬 *PESAN HUBUNGI ADMIN*\n\n👤 *Dari:* [User](tg://user?id=${uidNum}) (\`${uidNum}\`)`;
  let forwardMethod = "sendMessage";
  let payload = { chat_id: env.ADMIN_ID };

  if (msg.text) {
    payload.text = `${relayHeader}\n\n💬 *Pesan:*\n${escapeMd(msg.text)}`;
    payload.parse_mode = "Markdown";
  } else if (msg.photo) {
    forwardMethod = "sendPhoto";
    payload.photo = msg.photo[msg.photo.length - 1].file_id;
    payload.caption = `${relayHeader}\n\n🖼️ *Caption:* ${escapeMd(msg.caption || "—")}`;
    payload.parse_mode = "Markdown";
  } else if (msg.video) {
    forwardMethod = "sendVideo";
    payload.video = msg.video.file_id;
    payload.caption = `${relayHeader}\n\n📹 *Caption:* ${escapeMd(msg.caption || "—")}`;
    payload.parse_mode = "Markdown";
  } else if (msg.voice) {
    forwardMethod = "sendVoice";
    payload.voice = msg.voice.file_id;
    forwardMethod = "sendVoice"; 
    // Mengirim metadata pengirim sebelum menyertakan rekaman suara
    await api.send({ chat_id: env.ADMIN_ID, text: relayHeader, parse_mode: "Markdown" });
  } else {
    return;
  }

  const res = await tgRaw(env.BOT_TOKEN, forwardMethod, payload);
  if (res.ok) {
    const adminMessageId = res.result?.message_id;
    if (adminMessageId) {
      await redisSaveAdminReply(env, adminMessageId, uidNum);
    }
    await api.send({ chat_id: chatId, text: "🕊️ Pesan terkirim ke admin." });
  } else {
    await api.send({ chat_id: chatId, text: "❌ Gagal meneruskan pesan ke admin." });
  }
}

async function handleAdminReply(msg, env, api) {
  const replyToId = msg.reply_to_message?.message_id;
  if (!replyToId) return false;

  const targetUserId = await redisGetAdminReply(env, replyToId);
  if (!targetUserId) return false;

  const targetNum = Number(targetUserId);
  let method = "sendMessage";
  let payload = { chat_id: targetNum };

  if (msg.text) {
    payload.text = `💬 *Balasan dari Admin:*\n\n${msg.text}`;
  } else if (msg.photo) {
    method = "sendPhoto";
    payload.photo = msg.photo[msg.photo.length - 1].file_id;
    payload.caption = `💬 *Balasan dari Admin:* ${msg.caption || ""}`;
  } else if (msg.video) {
    method = "sendVideo";
    payload.video = msg.video.file_id;
    payload.caption = `💬 *Balasan dari Admin:* ${msg.caption || ""}`;
  } else if (msg.voice) {
    method = "sendVoice";
    payload.voice = msg.voice.file_id;
    await api.send({ chat_id: targetNum, text: "💬 *Balasan Voice Note dari Admin:*" });
  } else {
    return false;
  }

  const res = await tgRaw(env.BOT_TOKEN, method, payload);
  if (res.ok) {
    await api.send({ chat_id: env.ADMIN_ID, text: "✅ Balasan Anda berhasil diteruskan ke user." });
  } else {
    await api.send({ chat_id: env.ADMIN_ID, text: `❌ Gagal membalas user: ${res.description}` });
  }
  return true;
}

// ── Inline Callback Queries Orchestration ─────────────────────────────

async function handleCallback(cb, env, api) {
  const data = cb.data || "";
  const cbId = cb.id;
  const adminChatId = cb.message?.chat?.id;
  const adminMsgId  = cb.message?.message_id;

  if (data === "clear_report_view") {
    await tgRaw(env.BOT_TOKEN, "deleteMessage", { chat_id: adminChatId, message_id: adminMsgId });
    return api.answer(cbId, "Laporan dibersihkan.");
  }

  if (data.startsWith("gender_")) {
    const chosen = data.split("_")[1];
    const uidStr = String(cb.from.id);
    const uData  = await acGetUser(env, uidStr) || { status: "idle" };
    await acSetUser(env, uidStr, { ...uData, gender: chosen });
    await tgRaw(env.BOT_TOKEN, "deleteMessage", { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
    await tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: cb.message.chat.id,
      text: `✅ Profil disetel: *${chosen === "male" ? "👨 Laki-laki" : "👩 Perempuan"}*.\nSelamat bergabung! Sila gunakan menu interaktif di bawah.`,
      reply_markup: mainMenuKbd(cb.from.id === env.ADMIN_ID),
    });
    return api.answer(cbId, "Profil berhasil disimpan!");
  }

  // Integrasi Eksekusi Manajemen Antrean Menfess
  if (data.startsWith("acc_") || data.startsWith("rej_")) {
    const [action, pid] = data.split("_");
    const p = await dbGetPending(env, pid);
    if (!p) return api.answer(cbId, "⚠️ Berkas pengajuan menfess kedaluwarsa atau sudah diproses.", true);

    await dbDeletePending(env, pid);

    if (action === "rej") {
      await tgRaw(env.BOT_TOKEN, "editMessageLive", {}); // membersihkan inline keyboard lama
      await tgRaw(env.BOT_TOKEN, "editMessageCaption", { chat_id: adminChatId, message_id: adminMsgId, caption: `${cb.message.caption || cb.message.text}\n\n❌ *STATUS: DITOLAK ADMIN*` });
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(p.userId), text: "❌ Maaf, menfess Anda ditolak oleh admin karena tidak sesuai panduan komunitas." });
      return api.answer(cbId, "Menfess ditolak.");
    }

    // Konsumsi Kuota Secara Efektif Saat Disetujui
    await dbIncrementDaily(env, Number(p.userId));
    const usedBonus = await dbUseReferralBonus(env, Number(p.userId));

    // Kirim Hasil Menfess ke Channel Target Utama
    const channelMsg = `💌 *#MenfessNew*\n\n${escapeMd(p.text)}\n\n---`;
    let sentCh;

    if (p.mediaType === "photo") {
      sentCh = await tgRaw(env.BOT_TOKEN, "sendPhoto", { chat_id: env.CHANNEL_ID, photo: p.fileId, caption: channelMsg, parse_mode: "Markdown" });
    } else if (p.mediaType === "video") {
      sentCh = await tgRaw(env.BOT_TOKEN, "sendVideo", { chat_id: env.CHANNEL_ID, video: p.fileId, caption: channelMsg, parse_mode: "Markdown" });
    } else if (p.mediaType === "voice") {
      sentCh = await tgRaw(env.BOT_TOKEN, "sendVoice", { chat_id: env.CHANNEL_ID, voice: p.fileId, caption: channelMsg, parse_mode: "Markdown" });
    } else {
      sentCh = await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.CHANNEL_ID, text: channelMsg, parse_mode: "Markdown" });
    }

    if (sentCh?.ok) {
      const chMsgId = sentCh.result.message_id;
      await dbSaveMenfess(env, chMsgId, p.userId, p.senderName, p.text);

      // Mutasi Tampilan Dashboard Admin Mod
      const updatedAdminCaption = `${cb.message.caption || cb.message.text}\n\n✅ *STATUS: PUBLISHED DI CHANNEL*\n🆔 *Msg ID:* \`${chMsgId}\``;
      await tgRaw(env.BOT_TOKEN, "editMessageCaption", { chat_id: adminChatId, message_id: adminMsgId, caption: updatedAdminCaption });
      await tgRaw(env.BOT_TOKEN, "editMessageText", { chat_id: adminChatId, message_id: adminMsgId, text: updatedAdminCaption }).catch(() => {});

      // Kirim Notifikasi ke Pengirim
      await tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: Number(p.userId),
        text: `🚀 *Menfess Anda Berhasil Terbit!*\nLihat di channel kami.\n⚡ Sisa kuota harian Anda berkurang ${usedBonus ? "(menggunakan slot bonus referral)" : ""}.`,
      });

      // Fitur Auto-Delete Terjadwal Otomatis Berbasis Worker Terpisah / Background
      if (p.isAutoDel) {
        setTimeout(async () => {
          await tgRaw(env.BOT_TOKEN, "deleteMessage", { chat_id: env.CHANNEL_ID, message_id: chMsgId }).catch(() => {});
          await dbDeleteMenfess(env, chMsgId);
        }, env.AUTO_DEL_MIN * 60 * 1000);
      }
    } else {
      return api.answer(cbId, "⚠️ Gagal mengirim ke channel. Periksa setup hak akses bot.", true);
    }
    return api.answer(cbId, "Menfess berhasil dipublikasikan!");
  }

  // Opsi Pengendali Ban & Mute Langsung Melalui Dashboard Notifikasi Admin
  if (data.startsWith("ban_") || data.startsWith("mute_")) {
    const tokens = data.split("_");
    const targetUid = tokens[1];
    if (tokens[0] === "ban") {
      await dbBlock(env, Number(targetUid), "Pelanggaran Ketentuan Penggunaan Menfess.");
      return api.answer(cbId, `User ID ${targetUid} sukses diblokir permanen!`, true);
    }
    if (tokens[0] === "mute") {
      const sec = Number(tokens[2] || 3600);
      await dbMute(env, Number(targetUid), sec);
      return api.answer(cbId, `User ID ${targetUid} dibatasi kirim pesan selama 1 jam!`, true);
    }
  }
}

// ── Admin Command Center Engine (.command) ────────────────────────────

async function handleAdminHelp(chatId, api) {
  const h =
    "🧾 *Daftar Perintah Konsol Admin:*\n\n" +
    "`.stats` - Tampilkan statistik bot lengkap\n" +
    "`.ban <uid>` - Blokir permanen pengguna\n" +
    "`.unban <uid>` - Lepas blokir pengguna\n" +
    "`.mute <uid> <detik>` - Batasi akses pengguna sementara\n" +
    "`.unmute <uid>` - Lepas pembatasan sementara\n" +
    "`.addkw <kata>` - Masukkan kata ke daftar hitam\n" +
    "`.delkw <kata>` - Hapus kata dari daftar hitam\n" +
    "`.lskw` - Tampilkan daftar hitam kata\n" +
    "`.reset <uid>` - Reset limit harian menfess pengguna\n" +
    "`.bc <pesan>` - Siaran massal global ke seluruh pengguna";
  return api.send({ chat_id: chatId, text: h });
}

async function handleAdminStats(chatId, env, api) {
  const [total, blocked, muted, keywords, totalMfs] = await Promise.all([
    dbCountUsers(env), dbCountBlocked(env), dbCountMuted(env), dbCountKw(env), dbCountMenfess(env)
  ]);
  const s =
    `📊 *STATISTIK BOT KORPORAT*\n\n` +
    `• Total Pengguna Terdaftar: *${total}*\n` +
    `• Pengguna Diblokir: *${blocked}*\n` +
    `• Pengguna Dimute Aktif: *${muted}*\n` +
    `• Filter Kata Kasar: *${keywords} kata*\n` +
    `• Total Log Menfess Sukses: *${totalMfs}*`;
  return api.send({ chat_id: chatId, text: s });
}

async function handleAdminCmd(text, chatId, env, api) {
  const parts = text.slice(1).split(" ");
  const cmd   = parts[0].toLowerCase();
  const args  = parts.slice(1);

  if (cmd === "stats") return handleAdminStats(chatId, env, api);

  if (cmd === "ban") {
    const target = Number(args[0]);
    if (!target) return api.send({ chat_id: chatId, text: "⚠️ Format salah. Gunakan: `.ban <uid>`" });
    await dbBlock(env, target, "Diblokir oleh Administrator.");
    return api.send({ chat_id: chatId, text: `✅ Pengguna \`${target}\` telah berhasil masuk daftar blokir permanen.` });
  }

  if (cmd === "unban") {
    const target = Number(args[0]);
    if (!target) return api.send({ chat_id: chatId, text: "⚠️ Format salah. Gunakan: `.unban <uid>`" });
    const ok = await dbUnblock(env, target);
    return api.send({ chat_id: chatId, text: ok ? `✅ Pengguna \`${target}\` dibebaskan.` : "⚠️ Pengguna tidak ditemukan di daftar blokir." });
  }

  if (cmd === "mute") {
    const target = Number(args[0]);
    const sec    = Number(args[1] || 3600);
    if (!target) return api.send({ chat_id: chatId, text: "⚠️ Format salah. Gunakan: `.mute <uid> [detik]`" });
    await dbMute(env, target, sec);
    return api.send({ chat_id: chatId, text: `✅ Pengguna \`${target}\` di-mute selama ${sec} detik.` });
  }

  if (cmd === "unmute") {
    const target = Number(args[0]);
    if (!target) return api.send({ chat_id: chatId, text: "⚠️ Format salah. Gunakan: `.unmute <uid>`" });
    await dbUnmute(env, target);
    return api.send({ chat_id: chatId, text: `✅ Pengguna \`${target}\` bebas dari hukuman mute.` });
  }

  if (cmd === "addkw") {
    const kw = args.join(" ");
    if (!kw) return api.send({ chat_id: chatId, text: "⚠️ Format salah. Gunakan: `.addkw <kata>`" });
    await dbAddKw(env, kw);
    return api.send({ chat_id: chatId, text: `✅ Kata \`${kw}\` dimasukkan ke filter sensor.` });
  }

  if (cmd === "delkw") {
    const kw = args.join(" ");
    if (!kw) return api.send({ chat_id: chatId, text: "⚠️ Format salah. Gunakan: `.delkw <kata>`" });
    await dbDelKw(env, kw);
    return api.send({ chat_id: chatId, text: `✅ Kata \`${kw}\` dihapus dari filter sensor.` });
  }

  if (cmd === "lskw") {
    const list = await dbListKw(env);
    return api.send({ chat_id: chatId, text: list.length ? `🧾 *Daftar Kata Sensor:*\n\n${list.map(x => `- \`${x}\``).join("\n")}` : "ℹ️ Filter sensor kata kasar kosong." });
  }

  if (cmd === "reset") {
    const target = Number(args[0]);
    if (!target) return api.send({ chat_id: chatId, text: "⚠️ Format salah. Gunakan: `.reset <uid>`" });
    await dbResetDaily(env, target);
    return api.send({ chat_id: chatId, text: `✅ Kuota harian pengguna \`${target}\` berhasil di-reset ke nol.` });
  }

  if (cmd === "bc") {
    const broadcastMsg = args.join(" ");
    if (!broadcastMsg) return api.send({ chat_id: chatId, text: "⚠️ Format salah. Gunakan: `.bc <pesan>`" });

    const userIds = await dbAllUserIds(env);
    if (!userIds.length) return api.send({ chat_id: chatId, text: "⚠️ Anggota penerima siaran kosong." });

    await api.send({ chat_id: chatId, text: `📢 Memulai siaran massal ke *${userIds.length}* pengguna...` });

    let success = 0;
    for (const uid of userIds) {
      const res = await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: uid, text: `📢 *INFORMASI BOT*\n\n${broadcastMsg}`, parse_mode: "Markdown" });
      if (res.ok) success++;
      // Jeda asinkronus (anti rate-limit hentakan serverless cloud)
      await new Promise(r => setTimeout(r, BC_CHUNK_DELAY));
    }
    return api.send({ chat_id: chatId, text: `✅ *Siaran Selesai.*\nPesan terkirim ke *${success}/${userIds.length}* pengguna.` });
  }
}

async function handleReferral(uidNum, chatId, env, api) {
  const link  = refLink(env, uidNum);
  const count = await dbCountReferrals(env, uidNum);
  const bonus = await dbGetReferralBonus(env, uidNum);

  const refMsg = 
    `🔗 *SISTEM REFERRAL BOT*\n\n` +
    `Dapatkan keuntungan tambahan kuota menfess harian dengan mengajak teman Anda menggunakan bot ini.\n\n` +
    `• Kuota per teman masuk: *+${env.REF_BONUS} slot*\n` +
    `• Teman Anda mendapat: *+${env.REF_WELCOME} slot*\n` +
    `• Jumlah teman diundang: *${count} orang*\n` +
    `• Total akumulasi bonus Anda: *${bonus} slot*\n\n` +
    `👇 *Link Undangan Anda:* \n\`${link}\``;

  return api.send({
    chat_id: chatId,
    text: refMsg,
    reply_markup: ikbd([[burl("🚀 Bagikan Ke Teman", shareUrl(link))]]),
  });
}
