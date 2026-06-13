// api/webhook.js
// ╔══════════════════════════════════════════════════════╗
// ║  COMBO BOT v1.0 — Anonymous Chat + Menfess           ║
// ║  Deploy: Vercel | DB: Upstash Redis                  ║
// ╚══════════════════════════════════════════════════════╝

import { tg, ikbd, btn, burl } from "./_tg.js";
import {
  // Anon Chat
  acGetUser, acSetUser, acGetSession, acDelSession, acSetSession,
  acGetQueue, acAddToQueue, acRemoveFromQueue, acPickPartner,
  acIsDone, acMarkDone,
  // Menfess - users
  dbRegisterUser, dbCountUsers, dbAllUserIds,
  // Menfess - block/mute
  dbIsBlocked, dbBlock, dbUnblock, dbListBlocked, dbCountBlocked,
  dbIsMuted, dbMute, dbUnmute, dbCountMuted,
  // Menfess - limit
  dbGetDailyCount, dbIncrementDaily, dbResetDaily,
  // Menfess - keywords
  dbContainsBlacklistedKw, dbAddKw, dbDelKw, dbListKw, dbCountKw,
  // Menfess - menfess data
  dbSaveMenfess, dbGetMenfess, dbDeleteMenfess, dbCountMenfess,
  // Menfess - pending & referral
  dbSavePending, dbGetPending, dbDeletePending,
  dbGetReferralBonus, dbAddReferralBonus, dbUseReferralBonus,
  dbHasUsedReferral, dbRecordReferral, dbCountReferrals,
} from "./_db.js";

const NEXT_COOLDOWN = 5000; // ms

// ── Env ────────────────────────────────────────

function getEnv() {
  return {
    KV_URL:         process.env.UPSTASH_REDIS_URL,
    KV_TOKEN:       process.env.UPSTASH_REDIS_TOKEN,
    BOT_TOKEN:      process.env.BOT_TOKEN,
    CHANNEL_ID:     process.env.CHANNEL_ID,
    ADMIN_ID:       Number(process.env.ADMIN_ID),
    BOT_USERNAME:   (process.env.BOT_USERNAME || "").replace("@", ""),
    DAILY_MAX:      Number(process.env.DAILY_MAX || 3),
    AUTO_DEL_MIN:   Number(process.env.AUTO_DELETE_MINUTES || 10),
    REF_BONUS:      Number(process.env.REFERRAL_BONUS || 3),
    REF_WELCOME:    Number(process.env.REFERRAL_WELCOME || 3),
  };
}

// ── Misc helpers ───────────────────────────────

function refLink(botUsername, uid) {
  return `https://t.me/${botUsername}?start=ref_${uid}`;
}
function shareUrl(link) {
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Yuk kirim menfess rahasia atau chat anonim gratis di sini! 🎉")}`;
}
function fmtDate(iso) {
  return new Date(iso).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " WIB";
}
async function getMenfessRemaining(env, uid) {
  const used  = await dbGetDailyCount(env, uid);
  const bonus = await dbGetReferralBonus(env, uid);
  return env.DAILY_MAX - used + bonus;
}

// ── Keyboards ──────────────────────────────────

function mainMenuKbd(isAdmin) {
  if (isAdmin) {
    return {
      keyboard: [
        [{ text: "💌 Kirim Menfess" }, { text: "🔍 Cari Chat Anonim" }],
        [{ text: "📊 Stats" },          { text: "🧾 Command Admin" }],
      ],
      resize_keyboard: true,
      input_field_placeholder: "Pilih fitur atau ketik pesan...",
    };
  }
  return {
    keyboard: [
      [{ text: "💌 Kirim Menfess" },    { text: "🔍 Cari Chat Anonim" }],
      [{ text: "📊 Sisa Limit Menfess" }, { text: "ℹ️ Bantuan" }],
    ],
    resize_keyboard: true,
    input_field_placeholder: "Pilih fitur atau ketik pesan...",
  };
}

// ═══════════════════════════════════════════════
//  VERCEL HANDLER
// ═══════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true, status: "Combo Bot is running 🤖" });

  try {
    const update = req.body;
    if (!update?.update_id) return res.status(200).json({ ok: true });

    const env = getEnv();
    const api = tg(env.BOT_TOKEN);

    // Idempotency — cegah double process
    const uid = String(update.update_id);
    if (await acIsDone(env, uid)) return res.status(200).json({ ok: true });
    await acMarkDone(env, uid);

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
  const uid    = String(msg.from.id);
  const uidNum = Number(uid);
  const chatId = msg.chat.id;
  const text   = msg.text || msg.caption || "";

  // ── /start ──────────────────────────────────
  if (text.startsWith("/start")) {
    await dbRegisterUser(env, uidNum);

    // Proses referral
    const arg = text.split(" ")[1] || "";
    if (arg.startsWith("ref_")) {
      try {
        const refId = Number(arg.slice(4));
        if (refId !== uidNum && !(await dbHasUsedReferral(env, uidNum))) {
          await dbRecordReferral(env, uidNum, refId);
          await dbAddReferralBonus(env, uidNum, env.REF_WELCOME);
          await dbAddReferralBonus(env, refId, env.REF_BONUS);
          await api.send({ chat_id: chatId, text: `🎉 *Kamu berhasil join lewat referral!*\n\n✨ Dapat *+${env.REF_WELCOME} bonus kuota* menfess!\n🙏 Temanmu dapat *+${env.REF_BONUS} bonus kuota* juga.` });
          await api.send({ chat_id: refId, text: `🎉 *Referralmu berhasil!*\n\n👤 *${msg.from.username ? "@" + msg.from.username : msg.from.first_name}* baru saja join.\n✨ Kamu dapat *+${env.REF_BONUS} bonus kuota* menfess!` });
        }
      } catch (e) { console.warn("ref err:", e.message); }
    }

    // Cek apakah sudah punya profil anon chat
    const acUser = await acGetUser(env, uid);
    if (!acUser?.gender) {
      return api.send({
        chat_id: chatId,
        text:
          "👋 *Selamat datang di Combo Bot!*\n\n" +
          "Bot ini punya 2 fitur utama:\n\n" +
          "💌 *Menfess* — Kirim pesan anonim ke channel\n" +
          "🔍 *Anonymous Chat* — Ngobrol 1-on-1 dengan orang asing secara anonim\n\n" +
          "Sebelum mulai, pilih gendermu untuk fitur Anonymous Chat:",
        reply_markup: ikbd([[
          btn("👨 Laki-laki", "gender_male"),
          btn("👩 Perempuan", "gender_female"),
        ]]),
      });
    }

    return api.send({
      chat_id: chatId,
      text:
        "👋 *Selamat datang kembali!*\n\n" +
        "💌 *Menfess* — Ketik `mfs!` + pesanmu atau klik tombol\n" +
        "🔍 *Anonymous Chat* — Klik tombol atau ketik /find\n\n" +
        "Pilih fitur di bawah:",
      reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
    });
  }

  // ── /find /next /stop (Anon Chat commands) ───
  if (text.startsWith("/find"))  return handleAnonFind(uid, chatId, env, api, false);
  if (text.startsWith("/next"))  return handleAnonNext(uid, chatId, env, api);
  if (text.startsWith("/stop"))  return handleAnonStop(uid, chatId, env, api);
  if (text === "/referral")      return handleReferralCmd(uidNum, chatId, env, api);

  // ── Keyboard menu buttons ────────────────────
  if (text === "💌 Kirim Menfess") {
    return api.send({
      chat_id: chatId,
      text: `💌 *Mode Menfess*\n\nKetik \`mfs!\` diikuti isi pesanmu.\n\n*Contoh:* \`mfs! Hai semuanya 😳\`\n\nMendukung teks, foto, video, dan voice note.\n📊 Batas: *${env.DAILY_MAX} menfess per hari*`,
    });
  }

  if (text === "🔍 Cari Chat Anonim") {
    return handleAnonFind(uid, chatId, env, api, false);
  }

  if (text === "📊 Sisa Limit Menfess") {
    const used  = await dbGetDailyCount(env, uidNum);
    const bonus = await dbGetReferralBonus(env, uidNum);
    const rl    = refLink(env.BOT_USERNAME, uidNum);
    return api.send({
      chat_id: chatId,
      text:
        `📊 *Sisa Limit Menfess Hari Ini*\n\n` +
        `Kuota harian: *${env.DAILY_MAX - used}/${env.DAILY_MAX}* slot\n` +
        `Bonus referral: *${bonus}* slot\n` +
        `━━━━━━━━━━━━━━━\n` +
        `Total sisa: *${env.DAILY_MAX - used + bonus}* slot`,
      reply_markup: ikbd([[burl("🔗 Bagikan Referral & Dapat Bonus Kuota", shareUrl(rl))]]),
    });
  }

  if (text === "ℹ️ Bantuan") {
    return api.send({
      chat_id: chatId,
      text:
        "📖 *Panduan Combo Bot*\n\n" +
        "━━━ 💌 *MENFESS* ━━━\n" +
        "Ketik `mfs!` + pesan untuk kirim menfess anonim ke channel.\n" +
        "Mendukung teks, foto, video, voice note.\n" +
        `Batas: *${env.DAILY_MAX} menfess/hari*\n\n` +
        "━━━ 🔍 *ANONYMOUS CHAT* ━━━\n" +
        "/find — Cari partner chat\n" +
        "/next — Ganti partner\n" +
        "/stop — Keluar dari sesi chat\n\n" +
        "━━━ 🎁 *REFERRAL* ━━━\n" +
        "/referral — Dapatkan link referralmu\n" +
        "Ajak teman → dapat bonus kuota menfess!\n\n" +
        "Saat sedang chat anonim, semua pesanmu diteruskan ke partner secara otomatis.",
    });
  }

  // Admin buttons
  if (text === "📊 Stats" && uidNum === env.ADMIN_ID) return handleAdminStats(chatId, env, api);
  if (text === "🧾 Command Admin" && uidNum === env.ADMIN_ID) return handleAdminHelp(chatId, api);

  // Admin dot-commands
  if (text.startsWith(".") && uidNum === env.ADMIN_ID) {
    return handleAdminCmd(text, uidNum, chatId, env, api);
  }

  // ── Menfess trigger ──────────────────────────
  if (text.startsWith("mfs!") || (msg.caption || "").startsWith("mfs!")) {
    return handleMenfessTrigger(msg, uid, uidNum, chatId, text, env, api);
  }

  // ── Anonymous Chat relay ─────────────────────
  // Jika user sedang chatting, teruskan pesan ke partner
  const acUser = await acGetUser(env, uid);
  if (acUser?.status === "chatting") {
    return handleAnonRelay(msg, uid, chatId, acUser, env, api);
  }

  // Default — user tidak dalam sesi, tidak ada command yang match
  if (acUser && acUser.status === "idle") {
    // Hanya kasih hint kalau user sudah register
    return api.send({
      chat_id: chatId,
      text: "Gunakan tombol di bawah untuk memilih fitur, atau ketik `mfs!` untuk kirim menfess.",
      reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
    });
  }
}

// ═══════════════════════════════════════════════
//  ANONYMOUS CHAT HANDLERS
// ═══════════════════════════════════════════════

async function handleAnonFind(uid, chatId, env, api, fromInternal) {
  const user = await acGetUser(env, uid);
  if (!user?.gender) {
    return api.send({ chat_id: chatId, text: "⚠️ Ketik /start untuk mendaftar terlebih dahulu." });
  }
  if (!fromInternal) {
    if (user.status === "chatting") {
      return api.send({ chat_id: chatId, text: "💬 Kamu sedang dalam sesi chat.\nGunakan /next untuk ganti partner atau /stop untuk keluar." });
    }
    if (user.status === "searching") {
      return api.send({ chat_id: chatId, text: "🔍 Kamu sudah dalam antrian. Tunggu sebentar..." });
    }
  }

  await acSetUser(env, uid, { ...user, status: "searching" });
  await acAddToQueue(env, uid);

  const partnerId = await acPickPartner(env, uid);
  if (!partnerId) {
    return api.send({
      chat_id: chatId,
      text:
        "🔍 *Mencari partner...*\n\n" +
        "😴 Belum ada user lain yang tersedia.\n" +
        "Kamu akan otomatis dicocokkan saat ada yang mencari.\n\n" +
        "Sambil menunggu, kamu bisa:\n" +
        "💌 Kirim menfess dengan `mfs!` + pesan\n" +
        "/stop — Batalkan pencarian",
    });
  }

  await acRemoveFromQueue(env, uid);
  await acRemoveFromQueue(env, partnerId);

  const partner = await acGetUser(env, partnerId);
  await acSetUser(env, uid, { ...user, status: "chatting" });
  await acSetUser(env, partnerId, { ...partner, status: "chatting" });
  await acSetSession(env, uid, partnerId);

  const connectedMsg =
    "🎉 *Partner ditemukan!*\n\n" +
    "Kamu terhubung secara anonim. Mulai ngobrol!\n" +
    "Kirim teks, foto, video, stiker, atau voice note.\n\n" +
    "⏭ /next — Ganti partner\n" +
    "🛑 /stop — Keluar sesi";

  await api.send({ chat_id: chatId,  text: connectedMsg });
  await api.send({ chat_id: Number(partnerId), text: connectedMsg });
}

async function handleAnonNext(uid, chatId, env, api) {
  const user = await acGetUser(env, uid);
  if (!user) return api.send({ chat_id: chatId, text: "⚠️ Ketik /start untuk mendaftar terlebih dahulu." });

  const now = Date.now();
  if (now - (user.lastNext || 0) < NEXT_COOLDOWN) {
    const sisa = Math.ceil((NEXT_COOLDOWN - (now - (user.lastNext || 0))) / 1000);
    return api.send({ chat_id: chatId, text: `⏳ Tunggu *${sisa} detik* lagi sebelum /next.` });
  }

  const session = await acGetSession(env, uid);
  if (session) {
    const pid = session.partnerId;
    const pData = await acGetUser(env, pid);
    await api.send({ chat_id: Number(pid), text: "👋 Partner kamu pergi mencari partner baru.\nKetik /find untuk mencari partner." });
    if (pData) await acSetUser(env, pid, { ...pData, status: "idle" });
    await acDelSession(env, pid);
    await acDelSession(env, uid);
  }

  await acRemoveFromQueue(env, uid);
  await acSetUser(env, uid, { ...user, status: "idle", lastNext: now });
  return handleAnonFind(uid, chatId, env, api, true);
}

async function handleAnonStop(uid, chatId, env, api) {
  const user = await acGetUser(env, uid);
  if (!user) return api.send({ chat_id: chatId, text: "⚠️ Ketik /start untuk mendaftar terlebih dahulu." });

  if (user.status === "idle") {
    return api.send({
      chat_id: chatId,
      text: "ℹ️ Kamu tidak sedang dalam sesi apapun.\nGunakan /find untuk mulai mencari.",
    });
  }

  await acRemoveFromQueue(env, uid);

  const session = await acGetSession(env, uid);
  if (session) {
    const pid = session.partnerId;
    const pData = await acGetUser(env, pid);
    await api.send({ chat_id: Number(pid), text: "👋 Partner kamu mengakhiri sesi.\nKetik /find untuk mencari partner baru." });
    if (pData) await acSetUser(env, pid, { ...pData, status: "idle" });
    await acDelSession(env, pid);
    await acDelSession(env, uid);
  }

  await acSetUser(env, uid, { ...user, status: "idle" });
  return api.send({
    chat_id: chatId,
    text: "🛑 Sesi dihentikan.\nGunakan /find atau klik tombol untuk mencari partner baru.",
    reply_markup: mainMenuKbd(Number(uid) === env.ADMIN_ID),
  });
}

async function handleAnonRelay(msg, uid, chatId, acUser, env, api) {
  const session = await acGetSession(env, uid);
  if (!session) {
    await acSetUser(env, uid, { ...acUser, status: "idle" });
    return api.send({ chat_id: chatId, text: "⚠️ Sesi tidak ditemukan. Ketik /find untuk mulai lagi." });
  }

  const pid = Number(session.partnerId);

  try {
    if (msg.text) {
      await api.send({ chat_id: pid, text: `💬 ${msg.text}` });
    } else if (msg.photo) {
      await api.sendPhoto({ chat_id: pid, photo: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption ? `💬 ${msg.caption}` : undefined });
    } else if (msg.video) {
      await api.sendVideo({ chat_id: pid, video: msg.video.file_id, caption: msg.caption ? `💬 ${msg.caption}` : undefined });
    } else if (msg.voice) {
      await api.sendVoice({ chat_id: pid, voice: msg.voice.file_id });
    } else if (msg.sticker) {
      await api.sendSticker({ chat_id: pid, sticker: msg.sticker.file_id });
    } else if (msg.video_note) {
      await tg(env.BOT_TOKEN).call("sendVideoNote", { chat_id: pid, video_note: msg.video_note.file_id });
    } else if (msg.audio) {
      await tg(env.BOT_TOKEN).call("sendAudio", { chat_id: pid, audio: msg.audio.file_id });
    } else if (msg.document) {
      await tg(env.BOT_TOKEN).call("sendDocument", { chat_id: pid, document: msg.document.file_id });
    } else {
      await api.send({ chat_id: chatId, text: "⚠️ Tipe media ini belum didukung." });
    }
  } catch (e) {
    console.error("relay error:", e.message);
  }
}

// ═══════════════════════════════════════════════
//  MENFESS HANDLERS
// ═══════════════════════════════════════════════

async function handleMenfessTrigger(msg, uid, uidNum, chatId, text, env, api) {
  await dbRegisterUser(env, uidNum);
  const senderName = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  const blockInfo = await dbIsBlocked(env, uidNum);
  if (blockInfo) return api.send({ chat_id: chatId, text: `🚫 Kamu telah diblokir dari mengirim menfess.\nAlasan: *${blockInfo.reason}*\nWaktu: ${blockInfo.blocked_at}` });

  const mutedUntil = await dbIsMuted(env, uidNum);
  if (mutedUntil) return api.send({ chat_id: chatId, text: `🔇 Kamu sedang di-mute. Bisa posting lagi setelah *${fmtDate(mutedUntil)}*.` });

  const remaining = await getMenfessRemaining(env, uidNum);
  if (remaining <= 0) {
    const rl = refLink(env.BOT_USERNAME, uidNum);
    return api.send({ chat_id: chatId, text: `⏳ Kamu sudah mencapai batas *${env.DAILY_MAX} menfess hari ini*.\nAjak teman lewat referral untuk dapat bonus kuota! 😊`, reply_markup: ikbd([[burl("🔗 Bagikan Referral & Dapat Bonus Kuota", shareUrl(rl))]]) });
  }

  const cleanContent = text.replace("mfs!", "💌").trim();
  if (!cleanContent) return api.send({ chat_id: chatId, text: "❌ Isi menfess tidak boleh kosong!" });

  const blockedKw = await dbContainsBlacklistedKw(env, cleanContent);
  if (blockedKw) return api.send({ chat_id: chatId, text: `❌ Menfessmu ditolak karena mengandung kata terlarang: *${blockedKw}*` });

  let mediaType = "text", fileId = null;
  if (msg.photo)  { mediaType = "photo";  fileId = msg.photo[msg.photo.length - 1].file_id; }
  else if (msg.video) { mediaType = "video"; fileId = msg.video.file_id; }
  else if (msg.voice) { mediaType = "voice"; fileId = msg.voice.file_id; }

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
//  REFERRAL COMMAND
// ═══════════════════════════════════════════════

async function handleReferralCmd(uidNum, chatId, env, api) {
  await dbRegisterUser(env, uidNum);
  const rl    = refLink(env.BOT_USERNAME, uidNum);
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
//  ADMIN HANDLERS
// ═══════════════════════════════════════════════

async function handleAdminStats(chatId, env, api) {
  const [totalUsers, blocked, muted, kw, menfess] = await Promise.all([
    dbCountUsers(env), dbCountBlocked(env), dbCountMuted(env), dbCountKw(env), dbCountMenfess(env),
  ]);
  return api.send({
    chat_id: chatId,
    text:
      `📊 *Statistik Bot*\n━━━━━━━━━━━━━━━\n` +
      `👥 Total user menfess: *${totalUsers}*\n` +
      `🚫 Diblokir: *${blocked}*\n` +
      `🔇 Di-mute: *${muted}*\n` +
      `🔤 Keyword blacklist: *${kw}*\n` +
      `📨 Menfess aktif: *${menfess}*`,
  });
}

async function handleAdminHelp(chatId, api) {
  return api.send({
    chat_id: chatId,
    text:
      "🧾 *Command Admin*\n━━━━━━━━━━━━━━━\n" +
      "`.bl (id) (alasan)` — Blokir user\n" +
      "`.unbl (id)` — Unblock user\n" +
      "`.listbl` — Daftar user diblokir\n" +
      "`.mute (id) (durasi) (h|d)` — Mute sementara\n" +
      "`.unmute (id)` — Cabut mute\n" +
      "`.reset (id)` — Reset limit harian\n" +
      "`.addf (kata)` — Tambah kata terlarang\n" +
      "`.delf (kata)` — Hapus kata terlarang\n" +
      "`.listf` — Daftar keyword blacklist\n" +
      "`.bc (pesan)` — Broadcast ke semua user\n" +
      "`.stats` — Statistik bot",
  });
}

async function handleAdminCmd(text, uidNum, chatId, env, api) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const args  = parts.slice(1);
  const s = (t) => api.send({ chat_id: chatId, text: t });

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
  const uid    = String(query.from.id);
  const uidNum = Number(uid);
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;

  // ── Anon Chat: gender select ─────────────────
  if (data === "gender_male" || data === "gender_female") {
    await api.answer(query.id);
    const existing = await acGetUser(env, uid);
    const gender   = data === "gender_male" ? "male" : "female";
    await acSetUser(env, uid, { gender, status: existing?.status || "idle", lastNext: existing?.lastNext || 0 });
    const label = gender === "male" ? "👨 Laki-laki" : "👩 Perempuan";
    return api.send({
      chat_id: chatId,
      text:
        `✅ Profil disimpan sebagai *${label}*\n\n` +
        "Selamat datang di Combo Bot! Pilih fitur di bawah:",
      reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
    });
  }

  // ── Menfess: confirm/cancel ──────────────────
  if (data === "mf_cancel") {
    await api.answer(query.id);
    await dbDeletePending(env, uidNum);
    return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Pengiriman menfess dibatalkan." });
  }

  if (data === "mf_confirm" || data === "mf_autodel") {
    await api.answer(query.id);
    const pending = await dbGetPending(env, uidNum);
    if (!pending) return api.edit({ chat_id: chatId, message_id: msgId, text: "⚠️ Sesi habis. Silakan kirim ulang menfessmu." });

    const autoDelete = data === "mf_autodel";
    let sentMsg;
    try {
      if (pending.mediaType === "text")  sentMsg = await api.send({ chat_id: env.CHANNEL_ID, text: pending.text });
      else if (pending.mediaType === "photo") sentMsg = await api.sendPhoto({ chat_id: env.CHANNEL_ID, photo: pending.fileId, caption: pending.text, has_spoiler: true });
      else if (pending.mediaType === "video") sentMsg = await api.sendVideo({ chat_id: env.CHANNEL_ID, video: pending.fileId, caption: pending.text, has_spoiler: true });
      else if (pending.mediaType === "voice") sentMsg = await api.sendVoice({ chat_id: env.CHANNEL_ID, voice: pending.fileId, caption: pending.text });
      if (!sentMsg?.ok) throw new Error(JSON.stringify(sentMsg));
    } catch (e) {
      console.error("Send to channel:", e.message);
      return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Gagal kirim ke channel. Pastikan bot sudah jadi *Admin* di channel.", parse_mode: "Markdown" });
    }

    const sentId = sentMsg.result.message_id;
    api.react(env.CHANNEL_ID, sentId, "🔥").catch(() => {});
    api.react(pending.triggerChatId, pending.triggerMsgId, "❤️").catch(() => {});

    if ((await dbGetReferralBonus(env, uidNum)) > 0) await dbUseReferralBonus(env, uidNum);
    else await dbIncrementDaily(env, uidNum);

    await dbDeletePending(env, uidNum);

    const autoDeleteAt = autoDelete ? new Date(Date.now() + env.AUTO_DEL_MIN * 60 * 1000) : null;
    await dbSaveMenfess(env, sentId, uidNum, autoDeleteAt);

    const cleanChId  = String(env.CHANNEL_ID).replace("-100", "");
    const link       = `https://t.me/c/${cleanChId}/${sentId}`;
    const rem        = await getMenfessRemaining(env, uidNum);
    const rl         = refLink(env.BOT_USERNAME, uidNum);
    const autoNote   = autoDelete ? `\n⏱️ *Menfess ini akan otomatis terhapus dalam ${env.AUTO_DEL_MIN} menit.*` : "";

    await api.edit({
      chat_id: chatId, message_id: msgId,
      text: `✅ *Menfess terkirim!*\n\n🔗 ${link}\n📊 Sisa kuota: *${rem}/${env.DAILY_MAX}*${autoNote}`,
      reply_markup: ikbd([[btn("🗑️ Hapus Menfess", `mf_del_${sentId}`)], [burl("🔗 Bagikan Referral", shareUrl(rl))]]),
      link_preview_options: { is_disabled: true },
    });

    api.send({
      chat_id: env.ADMIN_ID,
      text:
        `📩 *LAPORAN MENFESS*\n━━━━━━━━━━━━━━━\n` +
        `👤 *Pengirim:* ${pending.senderName}\n` +
        `🆔 *ID:* \`${uidNum}\`\n` +
        `🔗 *Link:* [Lihat Pesan](${link})\n` +
        `💬 *Isi:* ${pending.text}` +
        (autoDelete ? `\n⏱️ Auto-delete ${env.AUTO_DEL_MIN} menit` : ""),
    }).catch(() => {});
    return;
  }

  // ── Menfess: delete ──────────────────────────
  if (data.startsWith("mf_del_")) {
    const delId   = Number(data.split("mf_del_")[1]);
    const menfess = await dbGetMenfess(env, delId);
    if (!menfess) return api.answer(query.id, "⚠️ Data menfess tidak ditemukan.", true);
    if (Number(menfess.user_id) !== uidNum) return api.answer(query.id, "❌ Kamu tidak bisa menghapus menfess orang lain!", true);
    try {
      await api.delete(env.CHANNEL_ID, delId);
      await dbDeleteMenfess(env, delId);
      await api.answer(query.id, "✅ Menfess berhasil dihapus!");
      return api.edit({ chat_id: chatId, message_id: msgId, text: "✅ Menfessmu telah dihapus dari channel." });
    } catch (e) {
      return api.answer(query.id, "Gagal menghapus. Pesan mungkin sudah dihapus.", true);
    }
  }

  await api.answer(query.id);
}
