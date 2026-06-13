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

const NEXT_COOLDOWN = 5000;

// ── Env ────────────────────────────────────────

function getEnv() {
  return {
    // Nama key sama dengan anonchat asli yang sudah terbukti jalan
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
}

// ── Helpers ────────────────────────────────────

function refLink(env, uid) {
  return `https://t.me/${env.BOT_USERNAME}?start=ref_${uid}`;
}

function shareUrl(link) {
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Yuk chat anonim & kirim menfess rahasia di sini! 🎉")}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit",
  }) + " WIB";
}

async function mfRemaining(env, uid) {
  const used  = await dbGetDailyCount(env, uid);
  const bonus = await dbGetReferralBonus(env, uid);
  return env.DAILY_MAX - used + bonus;
}

function mainMenuKbd(isAdmin) {
  const rows = [
    [{ text: "💌 Kirim Menfess" }, { text: "🔍 Cari Chat Anonim" }],
    [{ text: "📊 Sisa Limit Menfess" }, { text: "ℹ️ Bantuan" }],
  ];
  if (isAdmin) rows.push([{ text: "📊 Stats" }, { text: "🧾 Command Admin" }]);
  return { keyboard: rows, resize_keyboard: true, input_field_placeholder: "Pilih fitur atau ketik mfs!..." };
}

// ── Raw Telegram call (tanpa helper) ───────────

async function tgRaw(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ═══════════════════════════════════════════════
//  VERCEL ENTRY POINT
// ═══════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, status: "Combo Bot running" });
  }

  try {
    const update = req.body;
    if (!update?.update_id) return res.status(200).json({ ok: true });

    const env = getEnv();
    const api = tg(env.BOT_TOKEN);

    // Idempotency — cegah Telegram retry diproses dobel
    const updateKey = String(update.update_id);
    if (await acIsDone(env, updateKey)) return res.status(200).json({ ok: true });
    await acMarkDone(env, updateKey);

    if (update.callback_query) {
      await handleCallback(update.callback_query, env, api);
    } else if (update.message) {
      await handleMessage(update.message, env, api);
    }
  } catch (e) {
    console.error("Webhook error:", e.message, e.stack);
  }

  return res.status(200).json({ ok: true });
}

// ═══════════════════════════════════════════════
//  MESSAGE HANDLER
// ═══════════════════════════════════════════════

async function handleMessage(msg, env, api) {
  const userId = String(msg.from.id);
  const uidNum = Number(userId);
  const chatId = msg.chat.id;
  const text   = (msg.text || msg.caption || "").trim();

  // ── PRIORITAS 1: cek status anon chat dulu ──
  // Jika sedang chatting, relay SEMUA pesan kecuali system commands
  const acUser = await acGetUser(env, userId);

  if (acUser?.status === "chatting") {
    const isSysCmd = text === "/stop" || text === "/next" ||
                     text.startsWith("/stop ") || text.startsWith("/next ");
    if (!isSysCmd) {
      return handleRelay(msg, userId, chatId, acUser, env, api);
    }
  }

  // ── PRIORITAS 2: commands ───────────────────

  if (text.startsWith("/start")) return handleStart(msg, userId, uidNum, chatId, text, env, api);
  if (text === "/find" || text.startsWith("/find "))  return handleFind(userId, chatId, env, api, false);
  if (text === "/next" || text.startsWith("/next "))  return handleNext(userId, chatId, env, api);
  if (text === "/stop" || text.startsWith("/stop "))  return handleStop(userId, chatId, env, api);
  if (text === "/referral") return handleReferral(uidNum, chatId, env, api);

  // ── PRIORITAS 3: keyboard buttons ──────────

  if (text === "💌 Kirim Menfess") {
    return api.send({ chat_id: chatId, text: `💌 *Mode Menfess*\n\nKetik \`mfs!\` diikuti isi pesanmu.\n\n*Contoh:* \`mfs! Hai semuanya 😳\`\n\nMendukung teks, foto, video, dan voice note.\n📊 Batas: *${env.DAILY_MAX} menfess per hari*` });
  }
  if (text === "🔍 Cari Chat Anonim") return handleFind(userId, chatId, env, api, false);
  if (text === "📊 Sisa Limit Menfess") {
    const used  = await dbGetDailyCount(env, uidNum);
    const bonus = await dbGetReferralBonus(env, uidNum);
    const rl    = refLink(env, uidNum);
    return api.send({ chat_id: chatId, text: `📊 *Sisa Limit Menfess Hari Ini*\n\nKuota harian: *${env.DAILY_MAX - used}/${env.DAILY_MAX}* slot\nBonus referral: *${bonus}* slot\n━━━━━━━━━━━━━━━\nTotal sisa: *${env.DAILY_MAX - used + bonus}* slot`, reply_markup: ikbd([[burl("🔗 Bagikan Referral & Dapat Bonus Kuota", shareUrl(refLink(env, uidNum)))]]) });
  }
  if (text === "ℹ️ Bantuan") {
    return api.send({ chat_id: chatId, text: `📖 *Panduan Combo Bot*\n\n━━━ 💌 *MENFESS* ━━━\nKetik \`mfs!\` + pesan untuk kirim anonim ke channel.\nBatas: *${env.DAILY_MAX} menfess/hari*\n\n━━━ 🔍 *ANONYMOUS CHAT* ━━━\n/find — Cari partner chat\n/next — Ganti partner\n/stop — Keluar sesi\n\nSaat chat anonim, semua pesanmu diteruskan otomatis.\n\n━━━ 🎁 *REFERRAL* ━━━\n/referral — Dapatkan link referralmu\nAjak teman → dapat bonus kuota menfess!` });
  }

  // ── PRIORITAS 4: admin ──────────────────────

  if (text === "📊 Stats" && uidNum === env.ADMIN_ID) return handleAdminStats(chatId, env, api);
  if (text === "🧾 Command Admin" && uidNum === env.ADMIN_ID) return handleAdminHelp(chatId, api);
  if (text.startsWith(".") && uidNum === env.ADMIN_ID) return handleAdminCmd(text, chatId, env, api);

  // ── PRIORITAS 5: menfess trigger ───────────

  if (text.startsWith("mfs!") || (msg.caption || "").startsWith("mfs!")) {
    return handleMenfess(msg, userId, uidNum, chatId, env, api);
  }

  // ── Default ─────────────────────────────────

  if (acUser?.status === "searching") {
    return api.send({ chat_id: chatId, text: "🔍 Sedang mencari partner...\n/stop — Batalkan pencarian" });
  }
}

// ═══════════════════════════════════════════════
//  /start
// ═══════════════════════════════════════════════

async function handleStart(msg, userId, uidNum, chatId, text, env, api) {
  await dbRegisterUser(env, uidNum);

  // Referral
  const arg = text.split(" ")[1] || "";
  if (arg.startsWith("ref_")) {
    try {
      const refId = Number(arg.slice(4));
      if (refId !== uidNum && !(await dbHasUsedReferral(env, uidNum))) {
        await dbRecordReferral(env, uidNum, refId);
        await dbAddReferralBonus(env, uidNum, env.REF_WELCOME);
        await dbAddReferralBonus(env, refId, env.REF_BONUS);
        await api.send({ chat_id: chatId, text: `🎉 *Kamu berhasil join lewat referral!*\n\n✨ Dapat *+${env.REF_WELCOME} bonus kuota* menfess!` });
        await api.send({ chat_id: refId, text: `🎉 *Referralmu berhasil!*\n\n👤 *${msg.from.username ? "@" + msg.from.username : msg.from.first_name}* baru saja join.\n✨ Kamu dapat *+${env.REF_BONUS} bonus kuota* menfess!` });
      }
    } catch (e) { console.warn("ref err:", e.message); }
  }

  const acUser = await acGetUser(env, userId);
  if (!acUser?.gender) {
    return api.send({
      chat_id: chatId,
      text:
        "👋 *Selamat datang di Combo Bot!*\n\n" +
        "Bot ini punya 2 fitur utama:\n\n" +
        "💌 *Menfess* — Kirim pesan anonim ke channel\n" +
        "🔍 *Anonymous Chat* — Ngobrol 1-on-1 secara anonim\n\n" +
        "Sebelum mulai, pilih gendermu:",
      reply_markup: ikbd([[btn("👨 Laki-laki", "gender_male"), btn("👩 Perempuan", "gender_female")]]),
    });
  }

  return api.send({
    chat_id: chatId,
    text: "👋 *Selamat datang kembali!*\n\nPilih fitur di bawah:",
    reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
  });
}

// ═══════════════════════════════════════════════
//  ANONYMOUS CHAT
// ═══════════════════════════════════════════════

async function handleFind(userId, chatId, env, api, fromInternal) {
  const user = await acGetUser(env, userId);
  if (!user?.gender) {
    return api.send({ chat_id: chatId, text: "⚠️ Ketik /start untuk mendaftar terlebih dahulu." });
  }
  if (!fromInternal) {
    if (user.status === "chatting") {
      return api.send({ chat_id: chatId, text: "💬 Kamu sedang dalam sesi chat.\nGunakan /next untuk ganti partner atau /stop untuk keluar." });
    }
    if (user.status === "searching") {
      return api.send({ chat_id: chatId, text: "🔍 Kamu sudah dalam antrian pencarian. Tunggu sebentar..." });
    }
  }

  await acSetUser(env, userId, { ...user, status: "searching" });
  await acAddToQueue(env, userId);

  const partnerId = await acPickPartner(env, userId);
  if (!partnerId) {
    return api.send({
      chat_id: chatId,
      text:
        "🔍 *Mencari partner...*\n\n" +
        "😴 Belum ada user lain yang tersedia.\n" +
        "Kamu akan otomatis dicocokkan saat ada yang mencari.\n\n" +
        "Sambil menunggu, kamu bisa kirim menfess:\n" +
        "Ketik `mfs!` + pesan\n\n" +
        "/stop — Batalkan pencarian",
    });
  }

  // Match ditemukan
  await acRemoveFromQueue(env, userId);
  await acRemoveFromQueue(env, partnerId);

  const partner = await acGetUser(env, partnerId);
  await acSetUser(env, userId,   { ...user,    status: "chatting" });
  await acSetUser(env, partnerId,{ ...partner, status: "chatting" });
  await acSetSession(env, userId, partnerId);

  const connMsg =
    "🎉 *Partner ditemukan!*\n\n" +
    "Kamu terhubung secara anonim. Mulai ngobrol!\n" +
    "Kirim teks, foto, video, stiker, atau voice note.\n\n" +
    "⏭ /next — Ganti partner\n" +
    "🛑 /stop — Keluar sesi";

  await api.send({ chat_id: chatId,          text: connMsg });
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
    const pid    = session.partnerId;
    const pData  = await acGetUser(env, pid);
    await api.send({ chat_id: Number(pid), text: "👋 Partner kamu pergi. Ketik /find untuk mencari partner baru." });
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
    return api.send({ chat_id: chatId, text: "ℹ️ Kamu tidak sedang dalam sesi apapun.\nGunakan /find untuk mulai mencari." });
  }

  await acRemoveFromQueue(env, userId);

  const session = await acGetSession(env, userId);
  if (session) {
    const pid   = session.partnerId;
    const pData = await acGetUser(env, pid);
    await api.send({ chat_id: Number(pid), text: "👋 Partner kamu mengakhiri sesi.\nKetik /find untuk mencari partner baru." });
    if (pData) await acSetUser(env, pid, { ...pData, status: "idle" });
    await acDelSession(env, pid);
    await acDelSession(env, userId);
  }

  await acSetUser(env, userId, { ...user, status: "idle" });
  return api.send({
    chat_id: chatId,
    text: "🛑 Sesi dihentikan.\nGunakan /find atau klik tombol untuk mencari partner baru.",
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

  const pid = Number(session.partnerId);

  try {
    if (msg.text) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: pid, text: `💬 ${msg.text}` });
    } else if (msg.photo) {
      await tgRaw(env.BOT_TOKEN, "sendPhoto", {
        chat_id: pid,
        photo: msg.photo[msg.photo.length - 1].file_id,
        ...(msg.caption ? { caption: `💬 ${msg.caption}` } : {}),
      });
    } else if (msg.video) {
      await tgRaw(env.BOT_TOKEN, "sendVideo", {
        chat_id: pid,
        video: msg.video.file_id,
        ...(msg.caption ? { caption: `💬 ${msg.caption}` } : {}),
      });
    } else if (msg.voice) {
      await tgRaw(env.BOT_TOKEN, "sendVoice", { chat_id: pid, voice: msg.voice.file_id });
    } else if (msg.sticker) {
      await tgRaw(env.BOT_TOKEN, "sendSticker", { chat_id: pid, sticker: msg.sticker.file_id });
    } else if (msg.video_note) {
      await tgRaw(env.BOT_TOKEN, "sendVideoNote", { chat_id: pid, video_note: msg.video_note.file_id });
    } else if (msg.audio) {
      await tgRaw(env.BOT_TOKEN, "sendAudio", { chat_id: pid, audio: msg.audio.file_id });
    } else if (msg.document) {
      await tgRaw(env.BOT_TOKEN, "sendDocument", { chat_id: pid, document: msg.document.file_id });
    }
  } catch (e) {
    console.error("relay error:", e.message);
  }
}

// ═══════════════════════════════════════════════
//  REFERRAL
// ═══════════════════════════════════════════════

async function handleReferral(uidNum, chatId, env, api) {
  await dbRegisterUser(env, uidNum);
  const rl    = refLink(env, uidNum);
  const bonus = await dbGetReferralBonus(env, uidNum);
  const total = await dbCountReferrals(env, uidNum);
  return api.send({
    chat_id: chatId,
    text:
      `🔗 *Link Referralmu:*\n\n\`${rl}\`\n\n` +
      `👥 Total diundang: *${total} orang*\n` +
      `✨ Bonus kuota aktif: *${bonus} slot*\n\n` +
      `Setiap teman yang join lewat linkmu, kamu & dia dapat *+${env.REF_BONUS} bonus kuota* menfess!`,
    reply_markup: ikbd([[burl("🔗 Bagikan Referral", shareUrl(rl))]]),
  });
}

// ═══════════════════════════════════════════════
//  MENFESS
// ═══════════════════════════════════════════════

async function handleMenfess(msg, userId, uidNum, chatId, env, api) {
  await dbRegisterUser(env, uidNum);
  const senderName = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const text = msg.text || msg.caption || "";

  const blockInfo = await dbIsBlocked(env, uidNum);
  if (blockInfo) return api.send({ chat_id: chatId, text: `🚫 Kamu telah diblokir dari mengirim menfess.\nAlasan: *${blockInfo.reason}*\nWaktu: ${blockInfo.blocked_at}` });

  const mutedUntil = await dbIsMuted(env, uidNum);
  if (mutedUntil) return api.send({ chat_id: chatId, text: `🔇 Kamu sedang di-mute. Bisa posting lagi setelah *${fmtDate(mutedUntil)}*.` });

  const remaining = await mfRemaining(env, uidNum);
  if (remaining <= 0) {
    return api.send({ chat_id: chatId, text: `⏳ Kamu sudah mencapai batas *${env.DAILY_MAX} menfess hari ini*.\nAjak teman lewat referral untuk dapat bonus kuota! 😊`, reply_markup: ikbd([[burl("🔗 Bagikan Referral & Dapat Bonus Kuota", shareUrl(refLink(env, uidNum)))]]) });
  }

  const cleanContent = text.replace("mfs!", "💌").trim();
  if (!cleanContent) return api.send({ chat_id: chatId, text: "❌ Isi menfess tidak boleh kosong!" });

  const blockedKw = await dbContainsBlacklistedKw(env, cleanContent);
  if (blockedKw) return api.send({ chat_id: chatId, text: `❌ Menfessmu ditolak karena mengandung kata terlarang: *${blockedKw}*` });

  let mediaType = "text", fileId = null;
  if (msg.photo)      { mediaType = "photo";  fileId = msg.photo[msg.photo.length - 1].file_id; }
  else if (msg.video) { mediaType = "video";  fileId = msg.video.file_id; }
  else if (msg.voice) { mediaType = "voice";  fileId = msg.voice.file_id; }

  await dbSavePending(env, uidNum, { text: cleanContent, mediaType, fileId, senderName, triggerChatId: chatId, triggerMsgId: msg.message_id });

  const preview = cleanContent.length > 200 ? cleanContent.slice(0, 200) + "..." : cleanContent;
  return api.send({
    chat_id: chatId,
    text: `📝 *Preview Menfessmu:*\n\n${preview}\n\nPilih cara pengiriman:`,
    reply_markup: ikbd([
      [btn("✅ Kirim!", "mf_confirm")],
      [btn(`🕐 Kirim + Hapus Otomatis ${env.AUTO_DEL_MIN} Menit`, "mf_autodel")],
      [btn("❌ Batalkan", "mf_cancel")],
    ]),
  });
}

// ═══════════════════════════════════════════════
//  ADMIN
// ═══════════════════════════════════════════════

async function handleAdminStats(chatId, env, api) {
  const [tu, bl, mu, kw, mf] = await Promise.all([
    dbCountUsers(env), dbCountBlocked(env), dbCountMuted(env), dbCountKw(env), dbCountMenfess(env),
  ]);
  return api.send({ chat_id: chatId, text: `📊 *Statistik Bot*\n━━━━━━━━━━━━━━━\n👥 Total user menfess: *${tu}*\n🚫 Diblokir: *${bl}*\n🔇 Di-mute: *${mu}*\n🔤 Keyword blacklist: *${kw}*\n📨 Menfess aktif: *${mf}*` });
}

async function handleAdminHelp(chatId, api) {
  return api.send({ chat_id: chatId, text: "🧾 *Command Admin*\n━━━━━━━━━━━━━━━\n`.bl (id) (alasan)` — Blokir user\n`.unbl (id)` — Unblock user\n`.listbl` — Daftar user diblokir\n`.mute (id) (durasi) (h|d)` — Mute sementara\n`.unmute (id)` — Cabut mute\n`.reset (id)` — Reset limit harian\n`.addf (kata)` — Tambah kata terlarang\n`.delf (kata)` — Hapus kata terlarang\n`.listf` — Daftar keyword blacklist\n`.bc (pesan)` — Broadcast ke semua user\n`.stats` — Statistik bot" });
}

async function handleAdminCmd(text, chatId, env, api) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const args  = parts.slice(1);
  const s     = (t) => api.send({ chat_id: chatId, text: t });

  if (cmd === ".bl") {
    if (!args.length) return s("Usage: `.bl (id) (alasan)`");
    await dbBlock(env, Number(args[0]), args.slice(1).join(" ") || "Tidak ada alasan");
    return s(`✅ User \`${args[0]}\` diblokir.`);
  }
  if (cmd === ".unbl") {
    if (!args.length) return s("Usage: `.unbl (id)`");
    return s((await dbUnblock(env, Number(args[0]))) ? `✅ User \`${args[0]}\` di-unblock.` : `User \`${args[0]}\` tidak ada di daftar blokir.`);
  }
  if (cmd === ".listbl") {
    const rows = await dbListBlocked(env);
    if (!rows.length) return s("📋 Tidak ada user yang diblokir.");
    return s(`🚫 *Daftar User Diblokir (${rows.length}):*\n\n` + rows.map(r => `🆔 \`${r.user_id}\`\n  Alasan: ${r.reason}\n  Waktu: ${r.blocked_at}`).join("\n\n"));
  }
  if (cmd === ".mute") {
    if (args.length < 3) return s("Usage: `.mute (id) (durasi) (h|d)`");
    const until = new Date();
    const unit  = args[2].toLowerCase();
    if (unit === "h") until.setHours(until.getHours() + Number(args[1]));
    else if (unit === "d") until.setDate(until.getDate() + Number(args[1]));
    else return s("Unit tidak valid. Gunakan `h` atau `d`.");
    await dbMute(env, Number(args[0]), until);
    return s(`🔇 User \`${args[0]}\` di-mute *${args[1]} ${unit === "h" ? "jam" : "hari"}*.\nBerakhir: ${fmtDate(until.toISOString())}`);
  }
  if (cmd === ".unmute") {
    if (!args.length) return s("Usage: `.unmute (id)`");
    return s((await dbUnmute(env, Number(args[0]))) ? `✅ User \`${args[0]}\` di-unmute.` : `User \`${args[0]}\` tidak dalam kondisi mute.`);
  }
  if (cmd === ".reset") {
    if (!args.length) return s("Usage: `.reset (id)`");
    return s((await dbResetDaily(env, Number(args[0]))) ? `✅ Limit harian user \`${args[0]}\` direset.` : `ℹ️ User \`${args[0]}\` tidak punya limit aktif hari ini.`);
  }
  if (cmd === ".addf") {
    if (!args.length) return s("Usage: `.addf (kata)`");
    await dbAddKw(env, args.join(" ").toLowerCase());
    return s(`✅ Kata ditambahkan. Total: *${await dbCountKw(env)}*`);
  }
  if (cmd === ".delf") {
    if (!args.length) return s("Usage: `.delf (kata)`");
    const kw = args.join(" ").toLowerCase();
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
    for (const id of uids) {
      try { await api.send({ chat_id: id, text: `📢 *Pengumuman dari Admin:*\n\n${pesan}` }); ok++; }
      catch { fail++; }
    }
    return s(`✅ Selesai! Berhasil: ${ok} | Gagal: ${fail}`);
  }
  if (cmd === ".stats") return handleAdminStats(chatId, env, api);
}

// ═══════════════════════════════════════════════
//  CALLBACK HANDLER
// ═══════════════════════════════════════════════

async function handleCallback(query, env, api) {
  const data   = query.data;
  const userId = String(query.from.id);
  const uidNum = Number(userId);
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;

  // Gender select
  if (data === "gender_male" || data === "gender_female") {
    await api.answer(query.id);
    const existing = await acGetUser(env, userId);
    const gender   = data === "gender_male" ? "male" : "female";
    await acSetUser(env, userId, { gender, status: existing?.status || "idle", lastNext: existing?.lastNext || 0 });
    const label = gender === "male" ? "👨 Laki-laki" : "👩 Perempuan";
    return api.send({
      chat_id: chatId,
      text: `✅ Profil disimpan sebagai *${label}*\n\nSelamat datang! Pilih fitur di bawah:`,
      reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
    });
  }

  // Menfess cancel
  if (data === "mf_cancel") {
    await api.answer(query.id);
    await dbDeletePending(env, uidNum);
    return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Pengiriman menfess dibatalkan." });
  }

  // Menfess confirm
  if (data === "mf_confirm" || data === "mf_autodel") {
    await api.answer(query.id);
    const pending = await dbGetPending(env, uidNum);
    if (!pending) return api.edit({ chat_id: chatId, message_id: msgId, text: "⚠️ Sesi habis. Silakan kirim ulang menfessmu." });

    const autoDelete = data === "mf_autodel";
    let sentMsg;
    try {
      if (pending.mediaType === "text")       sentMsg = await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.CHANNEL_ID, text: pending.text });
      else if (pending.mediaType === "photo") sentMsg = await tgRaw(env.BOT_TOKEN, "sendPhoto",   { chat_id: env.CHANNEL_ID, photo: pending.fileId, caption: pending.text, has_spoiler: true });
      else if (pending.mediaType === "video") sentMsg = await tgRaw(env.BOT_TOKEN, "sendVideo",   { chat_id: env.CHANNEL_ID, video: pending.fileId, caption: pending.text, has_spoiler: true });
      else if (pending.mediaType === "voice") sentMsg = await tgRaw(env.BOT_TOKEN, "sendVoice",   { chat_id: env.CHANNEL_ID, voice: pending.fileId, caption: pending.text });
      if (!sentMsg?.ok) throw new Error(JSON.stringify(sentMsg));
    } catch (e) {
      console.error("Send to channel:", e.message);
      return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Gagal kirim ke channel. Pastikan bot sudah jadi *Admin* di channel.", parse_mode: "Markdown" });
    }

    const sentId = sentMsg.result.message_id;

    // Reaction (ignore error)
    tgRaw(env.BOT_TOKEN, "setMessageReaction", { chat_id: env.CHANNEL_ID, message_id: sentId, reaction: [{ type: "emoji", emoji: "🔥" }] }).catch(() => {});
    tgRaw(env.BOT_TOKEN, "setMessageReaction", { chat_id: pending.triggerChatId, message_id: pending.triggerMsgId, reaction: [{ type: "emoji", emoji: "❤️" }] }).catch(() => {});

    // Konsumsi kuota
    if ((await dbGetReferralBonus(env, uidNum)) > 0) await dbUseReferralBonus(env, uidNum);
    else await dbIncrementDaily(env, uidNum);

    await dbDeletePending(env, uidNum);

    const autoDeleteAt = autoDelete ? new Date(Date.now() + env.AUTO_DEL_MIN * 60 * 1000) : null;
    await dbSaveMenfess(env, sentId, uidNum, autoDeleteAt);

    const cleanChId = String(env.CHANNEL_ID).replace("-100", "");
    const link      = `https://t.me/c/${cleanChId}/${sentId}`;
    const rem       = await mfRemaining(env, uidNum);
    const autoNote  = autoDelete ? `\n⏱️ *Menfess ini akan otomatis terhapus dalam ${env.AUTO_DEL_MIN} menit.*` : "";

    await api.edit({
      chat_id: chatId, message_id: msgId,
      text: `✅ *Menfess terkirim!*\n\n🔗 ${link}\n📊 Sisa kuota: *${rem}/${env.DAILY_MAX}*${autoNote}`,
      reply_markup: ikbd([[btn("🗑️ Hapus Menfess", `mf_del_${sentId}`)], [burl("🔗 Bagikan Referral", shareUrl(refLink(env, uidNum)))]]),
      link_preview_options: { is_disabled: true },
    });

    tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_ID, parse_mode: "Markdown",
      text: `📩 *LAPORAN MENFESS*\n━━━━━━━━━━━━━━━\n👤 *Pengirim:* ${pending.senderName}\n🆔 *ID:* \`${uidNum}\`\n🔗 *Link:* [Lihat Pesan](${link})\n💬 *Isi:* ${pending.text}${autoDelete ? `\n⏱️ Auto-delete ${env.AUTO_DEL_MIN} menit` : ""}`,
    }).catch(() => {});
    return;
  }

  // Menfess delete
  if (data.startsWith("mf_del_")) {
    const delId   = Number(data.replace("mf_del_", ""));
    const menfess = await dbGetMenfess(env, delId);
    if (!menfess) return api.answer(query.id, "⚠️ Data menfess tidak ditemukan.", true);
    if (Number(menfess.user_id) !== uidNum) return api.answer(query.id, "❌ Kamu tidak bisa menghapus menfess orang lain!", true);
    try {
      await tgRaw(env.BOT_TOKEN, "deleteMessage", { chat_id: env.CHANNEL_ID, message_id: delId });
      await dbDeleteMenfess(env, delId);
      await api.answer(query.id, "✅ Menfess berhasil dihapus!");
      return api.edit({ chat_id: chatId, message_id: msgId, text: "✅ Menfessmu telah dihapus dari channel." });
    } catch {
      return api.answer(query.id, "Gagal menghapus. Pesan mungkin sudah dihapus.", true);
    }
  }

  await api.answer(query.id);
}

// ── tgRaw helper ───────────────────────────────

async function tgRaw(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
