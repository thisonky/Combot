// api/webhook.js — Combo Bot v1.0 (Anonymous Chat + Menfess)
// Vercel Serverless | Upstash Redis

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

const NEXT_COOLDOWN  = 5000;   // ms
const TG_TIMEOUT_MS  = 8000;   // timeout per Telegram API call
const BC_CHUNK_DELAY = 50;     // ms between broadcast messages to avoid rate limit

// ── Env validation ─────────────────────────────────────────────
// Fail fast at request time if required vars are missing.
// Vercel won't show missing env errors otherwise.

const REQUIRED_ENV = ["UPSTASH_REDIS_URL","UPSTASH_REDIS_TOKEN","BOT_TOKEN","CHANNEL_ID","ADMIN_ID","BOT_USERNAME"];

function getEnv() {
  const env = {
    KV_URL:       process.env.UPSTASH_REDIS_URL,
    KV_TOKEN:     process.env.UPSTASH_REDIS_TOKEN,
    BOT_TOKEN:    process.env.BOT_TOKEN,
    CHANNEL_ID:   process.env.CHANNEL_ID,          // kept as string for Telegram
    ADMIN_ID:     Number(process.env.ADMIN_ID),
    BOT_USERNAME: (process.env.BOT_USERNAME || "").replace("@", ""),
    DAILY_MAX:    Number(process.env.DAILY_MAX || 3),
    AUTO_DEL_MIN: Number(process.env.AUTO_DELETE_MINUTES || 10),
    REF_BONUS:    Number(process.env.REFERRAL_BONUS || 3),
    REF_WELCOME:  Number(process.env.REFERRAL_WELCOME || 3),
  };

  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
  if (isNaN(env.ADMIN_ID) || env.ADMIN_ID === 0) throw new Error("ADMIN_ID must be a valid numeric Telegram user ID");

  return env;
}

// ── Helpers ─────────────────────────────────────────────────────

function refLink(env, uid)  { return `https://t.me/${env.BOT_USERNAME}?start=ref_${uid}`; }
function shareUrl(link)     { return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Yuk chat anonim & kirim menfess rahasia di sini! 🎉")}`; }

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit",
      year: "numeric", hour: "2-digit", minute: "2-digit",
    }) + " WIB";
  } catch { return String(iso); }
}

async function mfRemaining(env, uid) {
  const [used, bonus] = await Promise.all([dbGetDailyCount(env, uid), dbGetReferralBonus(env, uid)]);
  return env.DAILY_MAX - used + bonus;
}

// Escape Markdown legacy special chars from free-form user input
function escapeMd(text) {
  if (!text) return "";
  return String(text).replace(/([_*`[])/g, "\\$1");
}

function mainMenuKbd(isAdmin) {
  const rows = [
    [{ text: "💌 Kirim Menfess" },      { text: "🔍 Cari Chat Anonim" }],
    [{ text: "📊 Sisa Limit Menfess" }, { text: "ℹ️ Bantuan" }],
    [{ text: "🚨 Laporkan User" },      { text: "📬 Hubungi Admin" }],
  ];
  if (isAdmin) rows.push([{ text: "📊 Stats" }, { text: "🧾 Command Admin" }]);
  return { keyboard: rows, resize_keyboard: true, input_field_placeholder: "Pilih fitur atau ketik mfs!..." };
}

// Reusable waiting-for-partner message (was copy-pasted 3x before)
const WAITING_MSG =
  "🔍 *Nyariin partner buat kamu...*\n\n" +
  "Belum ada yang online sekarang 😴\n" +
  "Nanti otomatis nyambung kalau ada yang nyari juga!\n\n" +
  "Sambil nunggu, bisa kirim menfess dulu: `mfs!` + pesan 💌\n" +
  "/stop — batalkan pencarian";

// ── Raw Telegram call with timeout ──────────────────────────────

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

// ── Redis helpers for local state (contact/report) ──────────────

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
    console.error("redisRaw error:", e.name === "AbortError" ? "TIMEOUT" : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function redisGetContact(env, uid)         { return redisRaw(env, "GET", `contact_mode:${uid}`); }
async function redisSetContact(env, uid, exSec)  { await redisRaw(env, "SET", `contact_mode:${uid}`, "active", "EX", exSec || 1800); }
async function redisDelContact(env, uid)         { await redisRaw(env, "DEL", `contact_mode:${uid}`); }
async function redisSaveAdminReply(env, mid, uid){ await redisRaw(env, "SET", `admin_reply:${mid}`, String(uid), "EX", 86400); }
async function redisGetAdminReply(env, mid)      { return redisRaw(env, "GET", `admin_reply:${mid}`); }
async function redisSaveReportPending(env, uid, pid) { await redisRaw(env, "SET", `report_pending:${uid}`, String(pid), "EX", 300); }
async function redisGetReportPending(env, uid)   { return redisRaw(env, "GET", `report_pending:${uid}`); }
async function redisDelReportPending(env, uid)   { await redisRaw(env, "DEL", `report_pending:${uid}`); }

// ════════════════════════════════════════════════════════════════
//  VERCEL ENTRY POINT
// ════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, status: "Combo Bot running" });
  }

  // Always return 200 to Telegram — never let errors cause retries
  try {
    const update = req.body;
    if (!update?.update_id) return res.status(200).json({ ok: true });

    const env = getEnv();
    const api = tg(env.BOT_TOKEN);

    // Idempotency: block Telegram retries from processing twice
    const updateKey = String(update.update_id);
    if (await acIsDone(env, updateKey)) return res.status(200).json({ ok: true });
    await acMarkDone(env, updateKey);

    if (update.callback_query) {
      await handleCallback(update.callback_query, env, api);
    } else if (update.my_chat_member) {
      await handleMyChatMember(update.my_chat_member, env, api);
    } else if (update.message) {
      const msg = update.message;
      // Admin replying to a forwarded user message → relay back to user
      // Only if: from admin, is a reply, NOT a dot-command (those run as admin commands)
      const isAdminContactReply =
        msg.from?.id === env.ADMIN_ID &&
        msg.reply_to_message != null &&
        !(msg.text || "").startsWith(".");

      if (isAdminContactReply) {
        const handled = await handleAdminReply(msg, env, api);
        if (handled) return res.status(200).json({ ok: true });
        // If no mapping found, fall through to normal handleMessage
      }

      await handleMessage(msg, env, api);
    }
  } catch (e) {
    // Log but never propagate — Telegram must always get 200
    console.error("Webhook error:", e.message, e.stack);
  }

  return res.status(200).json({ ok: true });
}

// ════════════════════════════════════════════════════════════════
//  MY CHAT MEMBER — user blokir/buka blokir bot
// ════════════════════════════════════════════════════════════════

async function handleMyChatMember(update, env, api) {
  const newStatus = update.new_chat_member?.status;
  const oldStatus = update.old_chat_member?.status;
  const user      = update.from;
  if (!user) return;

  const userId    = user.id;
  const firstName = escapeMd(user.first_name || "User");
  const username  = user.username ? `@${user.username}` : "—";

  if (newStatus === "kicked") {
    // Clean up any active session/queue state
    try {
      const acUser  = await acGetUser(env, String(userId));
      const session = acUser?.status === "chatting" ? await acGetSession(env, String(userId)) : null;
      if (session) {
        const pid = String(session.partnerId);
        const pData = await acGetUser(env, pid);
        if (pData) await acSetUser(env, pid, { ...pData, status: "idle" });
        await acDelSession(env, pid);
        await acDelSession(env, String(userId));
        // notify partner — fire and forget
        tgRaw(env.BOT_TOKEN, "sendMessage", {
          chat_id: Number(session.partnerId),
          text: "👋 Partner keluar dari sesi.\nMau cari yang baru? /find 😊",
        }).catch(() => {});
      }
      if (acUser) await acSetUser(env, String(userId), { ...acUser, status: "idle" });
      await acRemoveFromQueue(env, String(userId));
    } catch (e) {
      console.error("my_chat_member cleanup:", e.message);
    }

    tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_ID,
      parse_mode: "Markdown",
      text:
        `🚫 *BOT DIBLOKIR*\n\n` +
        `👤 *Nama:* [${firstName}](tg://user?id=${userId})\n` +
        `🆔 *User ID:* \`${userId}\`\n` +
        `🏷️ *Username:* ${username}\n\n` +
        `_Klik nama di atas untuk buka profil Telegram user._`,
    }).catch(e => console.error("blocked notify:", e.message));
    return;
  }

  if (oldStatus === "kicked" && newStatus === "member") {
    tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_ID,
      parse_mode: "Markdown",
      text:
        `✅ *USER BUKA BLOKIR BOT*\n\n` +
        `👤 *Nama:* [${firstName}](tg://user?id=${userId})\n` +
        `🆔 *User ID:* \`${userId}\`\n` +
        `🏷️ *Username:* ${username}`,
    }).catch(e => console.error("unblocked notify:", e.message));
  }
}

// ════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ════════════════════════════════════════════════════════════════

async function handleMessage(msg, env, api) {
  const userId  = String(msg.from?.id);
  const uidNum  = Number(userId);
  const chatId  = msg.chat?.id;
  if (!userId || !chatId) return;

  const text    = (msg.text || msg.caption || "").trim();
  const textLow = text.toLowerCase();

  // ── PRIORITY 0: cross-context state must win over chatting relay ──
  // report_pending and contact_mode are entered from within a chat session.
  // If checked after the chatting relay, free-form text (report reason,
  // admin message) would be forwarded to the chat partner instead.

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
    return; // sticker/photo during pending report — silently ignore
  }

  const contactMode = await redisGetContact(env, uidNum);
  if (contactMode === "active") {
    return handleContactRelay(msg, uidNum, chatId, env, api);
  }

  // ── PRIORITY 1: anon chat relay for non-system messages ──────────
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

  // ── PRIORITY 2: slash commands ───────────────────────────────────
  if (textLow.startsWith("/start"))                          return handleStart(msg, userId, uidNum, chatId, text, env, api);
  if (textLow === "/find"  || textLow.startsWith("/find ")) return handleFind(userId, chatId, env, api, false);
  if (textLow === "/next"  || textLow.startsWith("/next ")) return handleNext(userId, chatId, env, api);
  if (textLow === "/stop"  || textLow.startsWith("/stop ")) return handleStop(userId, chatId, env, api);
  if (textLow === "/referral")  return handleReferral(uidNum, chatId, env, api);
  if (textLow === "/report")    return handleReportMenu(userId, uidNum, chatId, env, api);
  if (textLow === "/contact")   return handleContactMenu(userId, uidNum, chatId, env, api);

  // ── PRIORITY 3: keyboard buttons ─────────────────────────────────
  if (text === "💌 Kirim Menfess") {
    return api.send({
      chat_id: chatId,
      text:
        "💌 *Kirim Menfess*\n\n" +
        "Ketik `mfs!` + pesanmu, lalu kirim.\n" +
        "_Contoh:_ `mfs! Hai semua 😜`\n\n" +
        "Bisa kirim teks, foto, video, atau voice note.\n" +
        `📊 Kuota: *${env.DAILY_MAX}x/hari* — bisa nambah lewat referral 🎁`,
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
      text:
        "📊 *Sisa Limit Menfess*\n\n" +
        `Harian: *${env.DAILY_MAX - used}/${env.DAILY_MAX}* · Bonus: *${bonus}*\n` +
        `✨ Total sisa: *${sisa} slot*\n\n` +
        (sisa <= 0 ? "Habis hari ini, balik lagi besok ya! 😴" : `Masih bisa kirim *${sisa}x* lagi hari ini!`) +
        "\nAjak teman → dapat bonus kuota gratis 👇",
      reply_markup: ikbd([[burl("🔗 Bagikan & Dapat Bonus Kuota", shareUrl(refLink(env, uidNum)))]]),
    });
  }

  if (text === "ℹ️ Bantuan") {
    return api.send({
      chat_id: chatId,
      text:
        "📖 *Panduan Combo Bot*\n\n" +
        "💌 *Menfess*\n" +
        `Ketik \`mfs!\` + pesan → kirim anonim ke channel. Batas ${env.DAILY_MAX}x/hari.\n\n` +
        "🔍 *Anonymous Chat*\n" +
        "/find · /next · /stop\n\n" +
        "🚨 *Laporan* — /report\n" +
        "Laporkan partner saat chat anonim.\n\n" +
        "📬 *Hubungi Admin* — /contact\n" +
        "Kirim pesan ke admin secara anonim.\n\n" +
        "🎁 *Referral* — /referral\n" +
        `Ajak teman → kamu & dia dapat +${env.REF_BONUS} bonus kuota!`,
    });
  }

  // ── PRIORITY 4: admin ─────────────────────────────────────────────
  if (text === "📊 Stats"         && uidNum === env.ADMIN_ID) return handleAdminStats(chatId, env, api);
  if (text === "🧾 Command Admin" && uidNum === env.ADMIN_ID) return handleAdminHelp(chatId, api);
  if (text.startsWith(".")        && uidNum === env.ADMIN_ID) return handleAdminCmd(text, chatId, env, api);

  // ── PRIORITY 5: menfess trigger (case-insensitive) ────────────────
  const rawText    = msg.text    || "";
  const rawCaption = msg.caption || "";
  if (rawText.toLowerCase().startsWith("mfs!") || rawCaption.toLowerCase().startsWith("mfs!")) {
    return handleMenfess(msg, userId, uidNum, chatId, env, api);
  }

  // ── Default ───────────────────────────────────────────────────────
  if (acUser?.status === "searching") {
    return api.send({ chat_id: chatId, text: "🔍 Lagi nyari partner...\n\nMau batalkan pencarian? Ketik /stop" });
  }
}

// ════════════════════════════════════════════════════════════════
//  /start
// ════════════════════════════════════════════════════════════════

async function handleStart(msg, userId, uidNum, chatId, text, env, api) {
  await dbRegisterUser(env, uidNum);

  const arg = text.split(" ")[1] || "";
  if (arg.startsWith("ref_")) {
    try {
      const refId = Number(arg.slice(4));
      if (Number.isFinite(refId) && refId !== uidNum && !(await dbHasUsedReferral(env, uidNum))) {
        await dbRecordReferral(env, uidNum, refId);
        await dbAddReferralBonus(env, uidNum, env.REF_WELCOME);
        await dbAddReferralBonus(env, refId, env.REF_BONUS);
        await api.send({ chat_id: chatId, text: `🎉 *Kamu berhasil join lewat referral!*\n\n✨ Dapat *+${env.REF_WELCOME} bonus kuota* menfess!` });
        // Fire-and-forget notify referrer
        api.send({ chat_id: refId, text: `🎉 *Referralmu berhasil!*\n\n👤 *${msg.from.username ? "@" + msg.from.username : escapeMd(msg.from.first_name)}* baru saja join.\n✨ Kamu dapat *+${env.REF_BONUS} bonus kuota* menfess!` }).catch(() => {});
      }
    } catch (e) { console.warn("ref err:", e.message); }
  }

  const acUser = await acGetUser(env, userId);
  if (!acUser?.gender) {
    return api.send({
      chat_id: chatId,
      text:
        "👋 *Halo! Selamat datang di Anon Space!*\n\n" +
        "💌 *Menfess* — Kirim pesan anonim ke channel\n" +
        "🔍 *Anonymous Chat* — Ngobrol secara anonim\n\n" +
        "Sebelum mulai, pilih gendermu dulu ya 😊",
      reply_markup: ikbd([[btn("👨 Laki-laki", "gender_male"), btn("👩 Perempuan", "gender_female")]]),
    });
  }

  return api.send({
    chat_id: chatId,
    text: "👋 *Halo, welcome back!* 😄\n\nMau ngapain hari ini? Pilih dari tombol di bawah!",
    reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
  });
}

// ════════════════════════════════════════════════════════════════
//  ANONYMOUS CHAT
// ════════════════════════════════════════════════════════════════

async function handleFind(userId, chatId, env, api, fromInternal) {
  const user = await acGetUser(env, userId);
  if (!user?.gender) {
    return api.send({ chat_id: chatId, text: "⚠️ Ketik /start untuk mendaftar terlebih dahulu." });
  }
  if (!fromInternal) {
    if (user.status === "chatting")  return api.send({ chat_id: chatId, text: "💬 Kamu lagi ngobrol nih!\n/next — ganti partner · /stop — keluar" });
    if (user.status === "searching") return api.send({ chat_id: chatId, text: "🔍 Masih nyariin partner, sabar ya 😄\n/stop — batalkan" });
  }

  await acSetUser(env, userId, { ...user, status: "searching" });
  await acAddToQueue(env, userId);

  // Try to find a valid partner, skipping stale entries
  const partnerId = await pickValidPartner(env, userId);
  if (!partnerId) {
    return api.send({ chat_id: chatId, text: WAITING_MSG });
  }

  const partnerUser = await acGetUser(env, partnerId);
  // Double-check: partner must still be searching (race condition guard)
  if (!partnerUser || !partnerUser.gender || partnerUser.status !== "searching") {
    await acRemoveFromQueue(env, partnerId);
    // One retry with cleaned queue
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

// Pick a partner, removing any stale entries encountered
async function pickValidPartner(env, excludeId) {
  const q = await acGetQueue(env);
  const candidates = q.filter(x => x !== String(excludeId));
  for (const candidate of candidates) {
    const u = await acGetUser(env, candidate);
    if (u?.gender && u?.status === "searching") return candidate;
    // Stale entry — remove it
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

  const connMsg =
    "🎉 *Yeay, ketemu partner!*\n\n" +
    "Kamu terhubung secara anonim. Mulai ngobrol! 🤫\n\n" +
    "⏭ /next — ganti partner · 🛑 /stop — keluar";

  await api.send({ chat_id: Number(userId),    text: connMsg });
  await api.send({ chat_id: Number(partnerId), text: connMsg });
}

async function handleNext(userId, chatId, env, api) {
  const user = await acGetUser(env, userId);
  if (!user) return api.send({ chat_id: chatId, text: "⚠️ Ketik /start untuk mendaftar terlebih dahulu." });

  const now = Date.now();
  if (now - (user.lastNext || 0) < NEXT_COOLDOWN) {
    const sisa = Math.ceil((NEXT_COOLDOWN - (now - (user.lastNext || 0))) / 1000);
    return api.send({ chat_id: chatId, text: `⏳ Tunggu *${sisa} detik* lagi sebelum /next.` });
  }

  const session = await acGetSession(env, userId);
  if (session) {
    const pid   = String(session.partnerId);
    const pData = await acGetUser(env, pid);
    api.send({ chat_id: Number(pid), text: "👋 Partner cabut, lagi cari yang baru.\nMau cari juga? /find 😊" }).catch(() => {});
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
  if (!user) return api.send({ chat_id: chatId, text: "⚠️ Ketik /start untuk mendaftar terlebih dahulu." });

  if (user.status === "idle") {
    return api.send({ chat_id: chatId, text: "ℹ️ Kamu lagi nggak di sesi manapun.\nKetik /find buat mulai cari partner!" });
  }

  await acRemoveFromQueue(env, userId);

  const session = await acGetSession(env, userId);
  if (session) {
    const pid   = String(session.partnerId);
    const pData = await acGetUser(env, pid);
    api.send({ chat_id: Number(pid), text: "👋 Partner keluar dari sesi.\nMau cari yang baru? /find 😊" }).catch(() => {});
    if (pData) await acSetUser(env, pid, { ...pData, status: "idle" });
    await acDelSession(env, pid);
    await acDelSession(env, userId);
  }

  await acSetUser(env, userId, { ...user, status: "idle" });
  return api.send({
    chat_id: chatId,
    text: "🛑 Sesi selesai. Makasih udah ngobrol! 😊\n\nMau cari lagi? /find",
    reply_markup: mainMenuKbd(Number(userId) === env.ADMIN_ID),
  });
}

async function handleRelay(msg, userId, chatId, acUser, env, api) {
  const session = await acGetSession(env, userId);
  if (!session) {
    await acSetUser(env, userId, { ...acUser, status: "idle" });
    return api.send({
      chat_id: chatId,
      text: "⚠️ Sesi telah berakhir. Ketik /find untuk mencari partner baru.",
      reply_markup: mainMenuKbd(Number(userId) === env.ADMIN_ID),
    });
  }

  const pid    = Number(session.partnerId);
  const pidStr = String(session.partnerId);

  async function terminateSession() {
    const pData = await acGetUser(env, pidStr);
    if (pData) await acSetUser(env, pidStr, { ...pData, status: "idle" });
    await acDelSession(env, pidStr);
    await acDelSession(env, userId);
    await acSetUser(env, userId, { ...acUser, status: "idle" });
    await api.send({
      chat_id: chatId,
      text:
        "⚠️ *Partner tidak bisa dijangkau.*\n\n" +
        "Kemungkinan partner memblokir bot atau akunnya bermasalah.\n" +
        "Sesi otomatis diakhiri.\n\n" +
        "Ketik /find untuk cari partner baru!",
      reply_markup: mainMenuKbd(Number(userId) === env.ADMIN_ID),
    });
  }

  async function sendToPartner(method, body) {
    const result = await tgRaw(env.BOT_TOKEN, method, { chat_id: pid, ...body });
    if (!result.ok) {
      const desc = (result.description || "").toLowerCase();
      const isUnreachable =
        result.error_code === 403 || result.error_code === 404 ||
        desc.includes("blocked") || desc.includes("user not found") ||
        desc.includes("chat not found") || desc.includes("deactivated");
      if (isUnreachable) { await terminateSession(); return false; }
    }
    return true;
  }

  try {
    if      (msg.text)       await sendToPartner("sendMessage",  { text: `💬 ${msg.text}` });
    else if (msg.photo)      await sendToPartner("sendPhoto",    { photo: msg.photo[msg.photo.length - 1].file_id, ...(msg.caption ? { caption: `💬 ${msg.caption}` } : {}) });
    else if (msg.video)      await sendToPartner("sendVideo",    { video: msg.video.file_id, ...(msg.caption ? { caption: `💬 ${msg.caption}` } : {}) });
    else if (msg.voice)      await sendToPartner("sendVoice",    { voice: msg.voice.file_id });
    else if (msg.sticker)    await sendToPartner("sendSticker",  { sticker: msg.sticker.file_id });
    else if (msg.video_note) await sendToPartner("sendVideoNote",{ video_note: msg.video_note.file_id });
    else if (msg.audio)      await sendToPartner("sendAudio",    { audio: msg.audio.file_id });
    else if (msg.document)   await sendToPartner("sendDocument", { document: msg.document.file_id });
  } catch (e) {
    console.error("relay error:", e.message);
    await api.send({ chat_id: chatId, text: "⚠️ Gagal mengirim pesan. Coba lagi." });
  }
}

// ════════════════════════════════════════════════════════════════
//  REFERRAL
// ════════════════════════════════════════════════════════════════

async function handleReferral(uidNum, chatId, env, api) {
  await dbRegisterUser(env, uidNum);
  const rl    = refLink(env, uidNum);
  const [bonus, total] = await Promise.all([dbGetReferralBonus(env, uidNum), dbCountReferrals(env, uidNum)]);
  return api.send({
    chat_id: chatId,
    text:
      `🔗 *Link Referralmu:*\n\n\`${rl}\`\n\n` +
      `👥 Diundang: *${total} orang* · ✨ Bonus aktif: *${bonus} slot*\n\n` +
      `Ajak teman → kamu & dia dapat *+${env.REF_BONUS} bonus kuota* menfess!`,
    reply_markup: ikbd([[burl("🔗 Bagikan Referral", shareUrl(rl))]]),
  });
}

// ════════════════════════════════════════════════════════════════
//  MENFESS
// ════════════════════════════════════════════════════════════════

async function handleMenfess(msg, userId, uidNum, chatId, env, api) {
  await dbRegisterUser(env, uidNum);
  const senderName = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || "User");
  const rawText    = msg.text    || "";
  const rawCaption = msg.caption || "";

  // Run guard checks in parallel where safe
  const [blockInfo, mutedUntil, remaining] = await Promise.all([
    dbIsBlocked(env, uidNum),
    dbIsMuted(env, uidNum),
    mfRemaining(env, uidNum),
  ]);

  if (blockInfo) return api.send({ chat_id: chatId, text: `🚫 Kamu diblokir dari menfess.\nAlasan: _${escapeMd(blockInfo.reason)}_\n\nAda pertanyaan? /contact` });
  if (mutedUntil) return api.send({ chat_id: chatId, text: `🔇 Kamu lagi kena mute.\nBisa kirim lagi setelah *${fmtDate(mutedUntil)}* 😊` });
  if (remaining <= 0) {
    return api.send({
      chat_id: chatId,
      text: `⏳ Kuota habis! Sudah kirim *${env.DAILY_MAX}x* hari ini.\nBalik lagi besok, atau ajak teman buat bonus kuota gratis! 🎁`,
      reply_markup: ikbd([[burl("🔗 Bagikan Referral & Dapat Bonus", shareUrl(refLink(env, uidNum)))]]),
    });
  }

  const cleanContent = (rawText || rawCaption).replace(/^mfs!/i, "💌").trim();
  if (!cleanContent || cleanContent === "💌") {
    return api.send({ chat_id: chatId, text: "❌ Isi menfessnya kosong!\nContoh: `mfs! Hai semuanya 😊`" });
  }

  const blockedKw = await dbContainsBlacklistedKw(env, cleanContent);
  if (blockedKw) return api.send({ chat_id: chatId, text: "❌ Menfessmu mengandung kata yang nggak diperbolehkan.\nEdit dulu ya, lalu kirim ulang! 😊" });

  let mediaType = "text", fileId = null;
  if      (msg.photo) { mediaType = "photo"; fileId = msg.photo[msg.photo.length - 1].file_id; }
  else if (msg.video) { mediaType = "video"; fileId = msg.video.file_id; }
  else if (msg.voice) { mediaType = "voice"; fileId = msg.voice.file_id; }

  await dbSavePending(env, uidNum, { text: cleanContent, mediaType, fileId, senderName, triggerChatId: chatId, triggerMsgId: msg.message_id });

  const preview = cleanContent.length > 200 ? cleanContent.slice(0, 200) + "..." : cleanContent;
  return api.send({
    chat_id: chatId,
    text: `📝 *Preview Menfessmu:*\n\n${preview}\n\nSudah oke? Pilih cara kirim:`,
    reply_markup: ikbd([
      [btn("✅ Kirim Sekarang!", "mf_confirm")],
      [btn(`⏱️ Kirim + Auto-Hapus ${env.AUTO_DEL_MIN} Menit`, "mf_autodel")],
      [btn("❌ Batal", "mf_cancel")],
    ]),
  });
}

// ════════════════════════════════════════════════════════════════
//  REPORT & CONTACT ADMIN
// ════════════════════════════════════════════════════════════════

async function handleReportMenu(userId, uidNum, chatId, env, api) {
  const acUser  = await acGetUser(env, userId);
  const session = acUser?.status === "chatting" ? await acGetSession(env, userId) : null;

  if (session) {
    return api.send({
      chat_id: chatId,
      text: "🚨 *Laporkan Partner*\n\nPilih alasan laporanmu — identitasmu tetap anonim! 😊",
      reply_markup: ikbd([
        [btn("🔞 Konten Tidak Pantas",       `rpt_konten_${session.partnerId}`)],
        [btn("🤬 Kata-kata Kasar / Bullying", `rpt_kasar_${session.partnerId}`)],
        [btn("🧟 Spam / Iklan",               `rpt_spam_${session.partnerId}`)],
        [btn("😰 Pelecehan / Ancaman",        `rpt_pelecehan_${session.partnerId}`)],
        [btn("📝 Alasan Lain",                `rpt_lain_${session.partnerId}`)],
        [btn("❌ Batal",                      "rpt_cancel")],
      ]),
    });
  }

  return api.send({
    chat_id: chatId,
    text: "🚨 Fitur laporan aktif saat kamu sedang dalam sesi Anonymous Chat.\n\nMau hubungi admin langsung?",
    reply_markup: ikbd([[btn("📬 Hubungi Admin", "contact_start")]]),
  });
}

async function submitReport(uidNum, chatId, partnerId, reason, env, api) {
  const now = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  await tgRaw(env.BOT_TOKEN, "sendMessage", {
    chat_id:    env.ADMIN_ID,
    parse_mode: "Markdown",
    text:
      "🚨 *LAPORAN USER MASUK*\n" +
      "━━━━━━━━━━━━━━━━━━\n" +
      `👤 *Pelapor ID:* \`${uidNum}\`\n` +
      `🎯 *Dilaporkan ID:* \`${partnerId}\`\n` +
      `📋 *Alasan:* ${escapeMd(reason)}\n` +
      `🕐 *Waktu:* ${now}\n` +
      "━━━━━━━━━━━━━━━━━━\n" +
      `\`.bl ${partnerId} [alasan]\` — Blokir\n` +
      `\`.mute ${partnerId} 24 h\` — Mute 24 jam`,
  });
  return api.send({
    chat_id: chatId,
    text: "✅ Laporan terkirim! Makasih ya, admin akan segera tindaklanjuti.\n\n/next — ganti partner · /stop — keluar",
  });
}

async function handleContactMenu(userId, uidNum, chatId, env, api) {
  return api.send({
    chat_id: chatId,
    text:
      "📬 *Hubungi Admin*\n\n" +
      "Kirim pesan apapun ke admin — identitasmu tetap anonim.\n" +
      "Admin bisa membalas langsung lewat bot ini! 😊",
    reply_markup: ikbd([
      [btn("✉️ Mulai Kirim Pesan", "contact_start")],
      [btn("❌ Batal",             "contact_cancel")],
    ]),
  });
}

async function handleContactRelay(msg, uidNum, chatId, env, api) {
  const text = (msg.text || "").trim();

  if (text === "/selesai" || text === "/batal") {
    await redisDelContact(env, uidNum);
    return api.send({ chat_id: chatId, text: "✅ Sesi kontak selesai. Makasih! 😊", reply_markup: mainMenuKbd(false) });
  }

  // /stop: exit contact mode AND terminate any active chat session
  if (text.toLowerCase() === "/stop") {
    await redisDelContact(env, uidNum);
    return handleStop(String(uidNum), chatId, env, api);
  }

  const now    = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const header = `📬 *PESAN DARI USER*\n━━━━━━━━━━━━━━━━━━\n👤 ID: \`${uidNum}\`\n🕐 ${now}\n━━━━━━━━━━━━━━━━━━\n`;
  let adminMsgResult;

  try {
    if      (msg.text)     { adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendMessage",  { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + escapeMd(msg.text) }); }
    else if (msg.photo)    { await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + "📷 _[Foto]_" }); adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendPhoto",    { chat_id: env.ADMIN_ID, photo: msg.photo[msg.photo.length-1].file_id, caption: msg.caption ? `💬 ${msg.caption}` : undefined }); }
    else if (msg.video)    { await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + "🎥 _[Video]_" }); adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendVideo",    { chat_id: env.ADMIN_ID, video: msg.video.file_id, caption: msg.caption ? `💬 ${msg.caption}` : undefined }); }
    else if (msg.voice)    { await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + "🎙️ _[Voice]_" }); adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendVoice",    { chat_id: env.ADMIN_ID, voice: msg.voice.file_id }); }
    else if (msg.sticker)  { await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + "🎭 _[Stiker]_" }); adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendSticker",  { chat_id: env.ADMIN_ID, sticker: msg.sticker.file_id }); }
    else if (msg.document) { await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + "📄 _[Dokumen]_" }); adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendDocument", { chat_id: env.ADMIN_ID, document: msg.document.file_id, caption: msg.caption ? `💬 ${msg.caption}` : undefined }); }
    else { return api.send({ chat_id: chatId, text: "⚠️ Tipe media ini belum didukung. Coba kirim teks, foto, video, atau voice note ya!" }); }

    if (adminMsgResult?.ok && adminMsgResult?.result?.message_id) {
      await redisSaveAdminReply(env, adminMsgResult.result.message_id, uidNum);
    }
    await api.send({ chat_id: chatId, text: "✅ Terkirim! Admin akan balas kalau diperlukan.\nLanjut kirim atau /selesai untuk keluar." });
  } catch (e) {
    console.error("contact relay:", e.message);
    await api.send({ chat_id: chatId, text: "❌ Gagal mengirim pesan. Coba lagi ya!" });
  }
}

// Returns true if message was handled as admin→user relay, false if no mapping
async function handleAdminReply(msg, env, api) {
  const repliedMsgId = msg.reply_to_message?.message_id;
  if (!repliedMsgId) return false;

  const targetUserId = await redisGetAdminReply(env, repliedMsgId);
  if (!targetUserId) return false; // no mapping, process as normal message

  const tuid = Number(targetUserId);
  try {
    if      (msg.text)     await tgRaw(env.BOT_TOKEN, "sendMessage",  { chat_id: tuid, parse_mode: "Markdown", text: `📩 *Balasan dari Admin:*\n\n${escapeMd(msg.text)}` });
    else if (msg.photo)    await tgRaw(env.BOT_TOKEN, "sendPhoto",    { chat_id: tuid, photo: msg.photo[msg.photo.length-1].file_id, caption: msg.caption ? `📩 *Balasan Admin:* ${escapeMd(msg.caption)}` : "📩 *Balasan dari Admin*", parse_mode: "Markdown" });
    else if (msg.video)    await tgRaw(env.BOT_TOKEN, "sendVideo",    { chat_id: tuid, video: msg.video.file_id, caption: msg.caption ? `📩 *Balasan Admin:* ${escapeMd(msg.caption)}` : "📩 *Balasan dari Admin*", parse_mode: "Markdown" });
    else if (msg.voice)    { await tgRaw(env.BOT_TOKEN, "sendVoice",  { chat_id: tuid, voice: msg.voice.file_id }); await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: tuid, text: "📩 _(voice note dari Admin)_", parse_mode: "Markdown" }); }
    else if (msg.sticker)  await tgRaw(env.BOT_TOKEN, "sendSticker",  { chat_id: tuid, sticker: msg.sticker.file_id });
    else if (msg.document) await tgRaw(env.BOT_TOKEN, "sendDocument", { chat_id: tuid, document: msg.document.file_id, caption: msg.caption ? `📩 *Balasan Admin:* ${escapeMd(msg.caption)}` : "📩 *Balasan dari Admin*", parse_mode: "Markdown" });
    else return false; // unsupported type, fall through

    api.send({ chat_id: env.ADMIN_ID, text: `✅ Balasanmu berhasil dikirim ke user \`${targetUserId}\`` }).catch(() => {});
    return true;
  } catch (e) {
    console.error("admin reply:", e.message);
    api.send({ chat_id: env.ADMIN_ID, text: `❌ Gagal kirim balasan ke user \`${targetUserId}\`. Mungkin sudah blokir bot.` }).catch(() => {});
    return true; // still handled, don't reprocess as message
  }
}

// ════════════════════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════════════════════

async function handleAdminStats(chatId, env, api) {
  const [tu, bl, mu, kw, mf] = await Promise.all([
    dbCountUsers(env), dbCountBlocked(env), dbCountMuted(env), dbCountKw(env), dbCountMenfess(env),
  ]);
  return api.send({ chat_id: chatId, text: `📊 *Statistik Bot*\n━━━━━━━━━━━━━━━\n👥 Total user: *${tu}*\n🚫 Diblokir: *${bl}*\n🔇 Di-mute: *${mu}*\n🔤 Keyword blacklist: *${kw}*\n📨 Menfess aktif: *${mf}*` });
}

async function handleAdminHelp(chatId, api) {
  return api.send({ chat_id: chatId, text: "🧾 *Command Admin*\n━━━━━━━━━━━━━━━\n`.bl (id) (alasan)` — Blokir user\n`.unbl (id)` — Unblock user\n`.listbl` — Daftar user diblokir\n`.mute (id) (durasi) (h|d)` — Mute sementara\n`.unmute (id)` — Cabut mute\n`.reset (id)` — Reset limit harian\n`.addf (kata)` — Tambah kata terlarang\n`.delf (kata)` — Hapus kata terlarang\n`.listf` — Daftar keyword blacklist\n`.bc (pesan)` — Broadcast ke semua user\n`.stats` — Statistik bot\n`.flushqueue` — Bersihkan antrian pencarian" });
}

async function handleAdminCmd(text, chatId, env, api) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const args  = parts.slice(1);
  const s     = (t) => api.send({ chat_id: chatId, text: t });

  if (cmd === ".bl") {
    if (!args.length) return s("Usage: `.bl (id) (alasan)`");
    const uid = Number(args[0]);
    if (!Number.isFinite(uid) || uid <= 0) return s("❌ User ID tidak valid.");
    await dbBlock(env, uid, args.slice(1).join(" ") || "Tidak ada alasan");
    return s(`✅ User \`${uid}\` diblokir.`);
  }

  if (cmd === ".unbl") {
    if (!args.length) return s("Usage: `.unbl (id)`");
    const uid = Number(args[0]);
    if (!Number.isFinite(uid) || uid <= 0) return s("❌ User ID tidak valid.");
    return s((await dbUnblock(env, uid)) ? `✅ User \`${uid}\` di-unblock.` : `User \`${uid}\` tidak ada di daftar blokir.`);
  }

  if (cmd === ".listbl") {
    const rows = await dbListBlocked(env);
    if (!rows.length) return s("📋 Tidak ada user yang diblokir.");
    return s(`🚫 *Daftar User Diblokir (${rows.length}):*\n\n` + rows.map(r => `🆔 \`${r.user_id}\`\n  Alasan: ${r.reason}\n  Waktu: ${r.blocked_at}`).join("\n\n"));
  }

  if (cmd === ".mute") {
    if (args.length < 3) return s("Usage: `.mute (id) (durasi) (h|d)`");
    const uid      = Number(args[0]);
    const duration = Number(args[1]);
    const unit     = args[2].toLowerCase();
    if (!Number.isFinite(uid) || uid <= 0)            return s("❌ User ID tidak valid.");
    if (!Number.isFinite(duration) || duration <= 0)  return s("❌ Durasi harus berupa angka positif.");
    if (unit !== "h" && unit !== "d")                 return s("❌ Unit tidak valid. Gunakan `h` (jam) atau `d` (hari).");
    const until = new Date();
    if (unit === "h") until.setHours(until.getHours() + duration);
    else              until.setDate(until.getDate() + duration);
    await dbMute(env, uid, until);
    return s(`🔇 User \`${uid}\` di-mute *${duration} ${unit === "h" ? "jam" : "hari"}*.\nBerakhir: ${fmtDate(until.toISOString())}`);
  }

  if (cmd === ".unmute") {
    if (!args.length) return s("Usage: `.unmute (id)`");
    const uid = Number(args[0]);
    if (!Number.isFinite(uid) || uid <= 0) return s("❌ User ID tidak valid.");
    return s((await dbUnmute(env, uid)) ? `✅ User \`${uid}\` di-unmute.` : `User \`${uid}\` tidak dalam kondisi mute.`);
  }

  if (cmd === ".reset") {
    if (!args.length) return s("Usage: `.reset (id)`");
    const uid = Number(args[0]);
    if (!Number.isFinite(uid) || uid <= 0) return s("❌ User ID tidak valid.");
    return s((await dbResetDaily(env, uid)) ? `✅ Limit harian user \`${uid}\` direset.` : `ℹ️ User \`${uid}\` tidak punya limit aktif hari ini.`);
  }

  if (cmd === ".addf") {
    if (!args.length) return s("Usage: `.addf (kata)`");
    const kw = args.join(" ").toLowerCase().trim();
    if (kw.length < 2) return s("❌ Kata terlalu pendek (min 2 karakter).");
    await dbAddKw(env, kw);
    return s(`✅ Kata ditambahkan. Total: *${await dbCountKw(env)}*`);
  }

  if (cmd === ".delf") {
    if (!args.length) return s("Usage: `.delf (kata)`");
    const kw = args.join(" ").toLowerCase().trim();
    return s((await dbDelKw(env, kw)) ? `✅ Kata *${kw}* dihapus.` : `Kata *${kw}* tidak ada di blacklist.`);
  }

  if (cmd === ".listf") {
    const kws = await dbListKw(env);
    if (!kws.length) return s("📋 Blacklist keyword kosong.");
    return s(`📋 *Keyword Blacklist (${kws.length}):*\n\n` + kws.map(k => `• ${k}`).join("\n"));
  }

  if (cmd === ".bc") {
    if (!args.length) return s("Usage: `.bc (pesan)`");
    const pesan = args.join(" ");
    const uids  = await dbAllUserIds(env);
    await s(`📢 Broadcast ke ${uids.length} user...`);
    let ok = 0, fail = 0;
    // Chunked with small delay to avoid TG rate limit (30 msg/sec global)
    for (const id of uids) {
      try {
        await api.send({ chat_id: id, text: `📢 *Pengumuman dari Admin:*\n\n${pesan}` });
        ok++;
      } catch { fail++; }
      if (ok % 20 === 0) await new Promise(r => setTimeout(r, BC_CHUNK_DELAY));
    }
    return s(`✅ Selesai! Berhasil: ${ok} | Gagal: ${fail}`);
  }

  if (cmd === ".stats")      return handleAdminStats(chatId, env, api);

  if (cmd === ".flushqueue") {
    const q = await acGetQueue(env);
    await redisRaw(env, "DEL", "queue");
    return s(`✅ Queue dibersihkan. ${q.length} entri dihapus.`);
  }
}

// ════════════════════════════════════════════════════════════════
//  CALLBACK HANDLER
// ════════════════════════════════════════════════════════════════

async function handleCallback(query, env, api) {
  // Guard: query.message can be null for inline keyboard in channels or expired messages
  if (!query.message?.chat?.id) {
    return api.answer(query.id).catch(() => {});
  }

  const data   = query.data || "";
  const userId = String(query.from.id);
  const uidNum = Number(userId);
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;

  // ── Report ──────────────────────────────────────────────────────

  if (data === "rpt_cancel") {
    await api.answer(query.id, "Laporan dibatalkan.");
    return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Laporan dibatalkan." });
  }

  if (data.startsWith("rpt_")) {
    await api.answer(query.id);
    const parts     = data.split("_");
    // format: rpt_{alasan}_{partnerId}  — user IDs are numeric so no underscore in partnerId
    const alasan    = parts[1];
    const partnerId = parts[2];

    if (!alasan || !partnerId) return; // malformed callback, ignore

    if (alasan === "lain") {
      await redisSaveReportPending(env, uidNum, partnerId);
      return api.edit({ chat_id: chatId, message_id: msgId, text: "📝 *Ketik alasan laporanmu*\n\nCeritakan singkat apa yang terjadi.\n_/batal untuk batalkan_" });
    }

    const alasanMap = { konten: "Konten Tidak Pantas 🔞", kasar: "Kata-kata Kasar / Bullying 🤬", spam: "Spam / Iklan Tidak Diinginkan 🧟", pelecehan: "Pelecehan / Ancaman 😰" };
    const reason    = alasanMap[alasan] || alasan;
    await submitReport(uidNum, chatId, partnerId, reason, env, api);
    return api.edit({ chat_id: chatId, message_id: msgId, text: "✅ Laporan terkirim! Terima kasih." });
  }

  // ── Contact ─────────────────────────────────────────────────────

  if (data === "contact_cancel") {
    await api.answer(query.id, "Dibatalkan.");
    return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Dibatalkan." });
  }

  if (data === "contact_start") {
    await api.answer(query.id);
    await redisSetContact(env, uidNum, 1800);
    return api.edit({
      chat_id: chatId, message_id: msgId,
      text: "✉️ *Mode Hubungi Admin Aktif*\n\nKirim pesan apapun — diteruskan ke admin secara anonim.\n_Aktif 30 menit · ketik /selesai untuk keluar_",
    });
  }

  // ── Gender select ────────────────────────────────────────────────

  if (data === "gender_male" || data === "gender_female") {
    await api.answer(query.id);
    const existing = await acGetUser(env, userId);
    const gender   = data === "gender_male" ? "male" : "female";
    await acSetUser(env, userId, { gender, status: existing?.status || "idle", lastNext: existing?.lastNext || 0 });
    const label = gender === "male" ? "👨 Laki-laki" : "👩 Perempuan";
    return api.send({
      chat_id: chatId,
      text: `✅ Disimpan sebagai *${label}*! Selamat datang 🎉\nPilih fitur di bawah:`,
      reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
    });
  }

  // ── Menfess ──────────────────────────────────────────────────────

  if (data === "mf_cancel") {
    await api.answer(query.id);
    await dbDeletePending(env, uidNum);
    return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Menfess dibatalkan. Ketik `mfs!` lagi kapan aja!" });
  }

  if (data === "mf_confirm" || data === "mf_autodel") {
    await api.answer(query.id);
    const pending = await dbGetPending(env, uidNum);
    if (!pending) return api.edit({ chat_id: chatId, message_id: msgId, text: "⚠️ Sesi habis, coba kirim ulang ya!" });

    const autoDelete = data === "mf_autodel";
    let sentMsg;
    try {
      if      (pending.mediaType === "text")  sentMsg = await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.CHANNEL_ID, text: pending.text });
      else if (pending.mediaType === "photo") sentMsg = await tgRaw(env.BOT_TOKEN, "sendPhoto",   { chat_id: env.CHANNEL_ID, photo: pending.fileId, caption: pending.text, has_spoiler: true });
      else if (pending.mediaType === "video") sentMsg = await tgRaw(env.BOT_TOKEN, "sendVideo",   { chat_id: env.CHANNEL_ID, video: pending.fileId, caption: pending.text, has_spoiler: true });
      else if (pending.mediaType === "voice") sentMsg = await tgRaw(env.BOT_TOKEN, "sendVoice",   { chat_id: env.CHANNEL_ID, voice: pending.fileId, caption: pending.text });
      if (!sentMsg?.ok) throw new Error(sentMsg?.description || "Send failed");
    } catch (e) {
      console.error("Send to channel:", e.message);
      return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Gagal kirim ke channel. Pastikan bot sudah jadi *Admin* di channel ya!", parse_mode: "Markdown" });
    }

    const sentId = sentMsg.result.message_id;

    // Fire-and-forget reactions
    tgRaw(env.BOT_TOKEN, "setMessageReaction", { chat_id: env.CHANNEL_ID, message_id: sentId, reaction: [{ type: "emoji", emoji: "🔥" }] }).catch(() => {});
    tgRaw(env.BOT_TOKEN, "setMessageReaction", { chat_id: pending.triggerChatId, message_id: pending.triggerMsgId, reaction: [{ type: "emoji", emoji: "❤️" }] }).catch(() => {});

    // Consume quota: referral bonus first, then daily
    if ((await dbGetReferralBonus(env, uidNum)) > 0) await dbUseReferralBonus(env, uidNum);
    else await dbIncrementDaily(env, uidNum);

    await dbDeletePending(env, uidNum);

    const autoDeleteAt = autoDelete ? new Date(Date.now() + env.AUTO_DEL_MIN * 60 * 1000) : null;
    await dbSaveMenfess(env, sentId, uidNum, autoDeleteAt);

    const cleanChId = String(env.CHANNEL_ID).replace("-100", "");
    const link      = `https://t.me/c/${cleanChId}/${sentId}`;
    const rem       = await mfRemaining(env, uidNum);
    const autoNote  = autoDelete ? `\n⏱️ _Auto-hapus dalam ${env.AUTO_DEL_MIN} menit_` : "";

    await api.edit({
      chat_id: chatId, message_id: msgId,
      text: `✅ *Menfess terkirim!* 🎉\n\n🔗 ${link}\n📊 Sisa kuota: *${rem} slot*${autoNote}`,
      reply_markup: ikbd([[btn("🗑️ Hapus Menfess", `mf_del_${sentId}`)], [burl("🔗 Ajak Teman & Dapat Bonus", shareUrl(refLink(env, uidNum)))]]),
      link_preview_options: { is_disabled: true },
    });

    // Fire-and-forget admin report
    tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_ID, parse_mode: "Markdown",
      text: `📩 *LAPORAN MENFESS*\n━━━━━━━━━━━━━━━\n👤 *Pengirim:* ${escapeMd(pending.senderName)}\n🆔 *ID:* \`${uidNum}\`\n🔗 *Link:* [Lihat Pesan](${link})\n💬 *Isi:* ${escapeMd(pending.text)}${autoDelete ? `\n⏱️ Auto-delete ${env.AUTO_DEL_MIN} menit` : ""}`,
    }).catch(() => {});
    return;
  }

  if (data.startsWith("mf_del_")) {
    const delId   = Number(data.replace("mf_del_", ""));
    if (!Number.isFinite(delId)) return api.answer(query.id, "⚠️ Data tidak valid.", true);
    const menfess = await dbGetMenfess(env, delId);
    if (!menfess)                          return api.answer(query.id, "⚠️ Data menfess tidak ditemukan.", true);
    if (Number(menfess.user_id) !== uidNum) return api.answer(query.id, "❌ Itu bukan menfessmu!", true);
    try {
      await tgRaw(env.BOT_TOKEN, "deleteMessage", { chat_id: env.CHANNEL_ID, message_id: delId });
      await dbDeleteMenfess(env, delId);
      await api.answer(query.id, "✅ Menfess berhasil dihapus!");
      return api.edit({ chat_id: chatId, message_id: msgId, text: "✅ Menfessmu sudah dihapus dari channel!" });
    } catch {
      return api.answer(query.id, "Gagal menghapus. Pesan mungkin sudah dihapus.", true);
    }
  }

  // Unknown callback — always answer to prevent loading spinner
  await api.answer(query.id);
}
