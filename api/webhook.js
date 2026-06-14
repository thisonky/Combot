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
  const textLow = text.toLowerCase(); // untuk perbandingan case-insensitive

  // ── PRIORITAS 1: cek status anon chat dulu ──
  const acUser = await acGetUser(env, userId);

  if (acUser?.status === "chatting") {
    const isSysCmd = textLow === "/stop" || textLow === "/next" ||
                     textLow.startsWith("/stop ") || textLow.startsWith("/next ");
    if (!isSysCmd) {
      return handleRelay(msg, userId, chatId, acUser, env, api);
    }
  }

  // ── PRIORITAS 2: slash commands ────────────

  if (textLow.startsWith("/start")) return handleStart(msg, userId, uidNum, chatId, text, env, api);
  if (textLow === "/find" || textLow.startsWith("/find "))  return handleFind(userId, chatId, env, api, false);
  if (textLow === "/next" || textLow.startsWith("/next "))  return handleNext(userId, chatId, env, api);
  if (textLow === "/stop" || textLow.startsWith("/stop "))  return handleStop(userId, chatId, env, api);
  if (textLow === "/referral") return handleReferral(uidNum, chatId, env, api);

  // ── PRIORITAS 3: keyboard buttons ──────────

  if (text === "💌 Kirim Menfess") {
    return api.send({
      chat_id: chatId,
      text:
        "💌 *Kirim Menfess*\n\n" +
        "Menfess adalah pesan anonim yang akan dikirim ke channel tanpa identitasmu.\n\n" +
        "📝 *Cara kirim:*\n" +
        "Ketik `mfs!` diikuti isi pesanmu, lalu kirim.\n\n" +
        "✏️ *Contoh:*\n" +
        "`mfs! Hai semua, aku mau nembak seseorang nih 😳`\n\n" +
        "📎 *Media yang bisa dikirim:*\n" +
        "• Teks biasa\n" +
        "• Foto 🖼️ (tampil sebagai spoiler)\n" +
        "• Video 🎥 (tampil sebagai spoiler)\n" +
        "• Voice note 🎙️\n\n" +
        `📊 Kuota kamu: *${env.DAILY_MAX} menfess per hari*\n` +
        "Kuota bisa bertambah lewat referral! 🎁",
    });
  }

  if (text === "🔍 Cari Chat Anonim") return handleFind(userId, chatId, env, api, false);

  if (text === "📊 Sisa Limit Menfess") {
    const used  = await dbGetDailyCount(env, uidNum);
    const bonus = await dbGetReferralBonus(env, uidNum);
    const sisa  = env.DAILY_MAX - used + bonus;
    const rl    = refLink(env, uidNum);
    return api.send({
      chat_id: chatId,
      text:
        "📊 *Sisa Limit Menfessmu Hari Ini*\n\n" +
        `🗓️ Kuota harian: *${env.DAILY_MAX - used}* dari *${env.DAILY_MAX}* slot\n` +
        `🎁 Bonus referral: *${bonus}* slot\n` +
        "━━━━━━━━━━━━━━━━━\n" +
        `✨ Total sisa: *${sisa} slot*\n\n` +
        (sisa <= 0
          ? "😴 Kuotamu habis hari ini. Kembali lagi besok ya!\nAtau ajak teman untuk dapat bonus kuota gratis 👇"
          : `Kamu masih bisa kirim *${sisa} menfess* lagi hari ini!\nMau nambah kuota? Ajak teman lewat referral 👇`),
      reply_markup: ikbd([[burl("🔗 Bagikan & Dapat Bonus Kuota", shareUrl(rl))]]),
    });
  }

  if (text === "ℹ️ Bantuan") {
    return api.send({
      chat_id: chatId,
      text:
        "📖 *Panduan Lengkap Combo Bot*\n\n" +
        "━━━ 💌 *MENFESS* ━━━\n" +
        "Kirim pesan anonim ke channel tanpa ketahuan siapa kamu!\n\n" +
        "• Ketik `mfs!` + pesanmu lalu kirim\n" +
        "• Bot akan tampilkan preview sebelum dikirim\n" +
        "• Kamu bisa pilih kirim biasa atau auto-hapus\n" +
        `• Batas: *${env.DAILY_MAX} menfess per hari*\n\n` +
        "━━━ 🔍 *ANONYMOUS CHAT* ━━━\n" +
        "Ngobrol 1-on-1 dengan orang asing secara anonim!\n\n" +
        "• /find — Mulai cari partner ngobrol\n" +
        "• /next — Ganti ke partner lain\n" +
        "• /stop — Keluar dari sesi chat\n\n" +
        "_Saat chat anonim aktif, semua pesanmu otomatis diteruskan ke partner._\n\n" +
        "━━━ 🎁 *REFERRAL* ━━━\n" +
        "Ajak teman dan dapat bonus kuota menfess gratis!\n\n" +
        "• /referral — Lihat link & statistik referralmu\n" +
        `• Setiap teman yang join: kamu & dia dapat *+${env.REF_BONUS} bonus kuota*`,
    });
  }

  // ── PRIORITAS 4: admin ──────────────────────

  if (text === "📊 Stats" && uidNum === env.ADMIN_ID) return handleAdminStats(chatId, env, api);
  if (text === "🧾 Command Admin" && uidNum === env.ADMIN_ID) return handleAdminHelp(chatId, api);
  if (text.startsWith(".") && uidNum === env.ADMIN_ID) return handleAdminCmd(text, chatId, env, api);

  // ── PRIORITAS 5: menfess trigger (case-insensitive) ─

  const rawText    = msg.text || "";
  const rawCaption = msg.caption || "";
  const isMenfess  = rawText.toLowerCase().startsWith("mfs!") ||
                     rawCaption.toLowerCase().startsWith("mfs!");
  if (isMenfess) {
    return handleMenfess(msg, userId, uidNum, chatId, env, api);
  }

  // ── Default ─────────────────────────────────

  if (acUser?.status === "searching") {
    return api.send({
      chat_id: chatId,
      text: "🔍 Lagi nyari partner buat ngobrol nih...\n\nMau batalkan pencarian? Ketik /stop",
    });
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
        "👋 *Halo! Selamat datang di Combo Bot!* 🎉\n\n" +
        "Bot ini hadir dengan 2 fitur seru buat kamu yang suka jaga privasi:\n\n" +
        "💌 *Menfess* — Kirim pesan anonim ke channel, tanpa ada yang tahu kamu siapa!\n\n" +
        "🔍 *Anonymous Chat* — Ngobrol bebas 1-on-1 dengan orang asing secara anonim. Asik buat kenalan!\n\n" +
        "Sebelum mulai, boleh tau kamu gender apa? 😊",
      reply_markup: ikbd([[btn("👨 Laki-laki", "gender_male"), btn("👩 Perempuan", "gender_female")]]),
    });
  }

  return api.send({
    chat_id: chatId,
    text:
      "👋 *Halo, selamat datang kembali!* 😊\n\n" +
      "Mau ngapain hari ini?\n" +
      "💌 Kirim menfess atau 🔍 nyari teman ngobrol anonim?\n\n" +
      "Pilih dari tombol di bawah ya!",
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
      return api.send({ chat_id: chatId, text: "💬 Kamu lagi ngobrol sama seseorang nih!\n\nKalau mau ganti partner, ketik /next.\nKalau mau keluar dari sesi, ketik /stop." });
    }
    if (user.status === "searching") {
      return api.send({ chat_id: chatId, text: "🔍 Kamu udah masuk antrian pencarian kok!\nSabar ya, lagi nyariin partner buat kamu 😄\n\nMau batal? Ketik /stop" });
    }
  }

  await acSetUser(env, userId, { ...user, status: "searching" });
  await acAddToQueue(env, userId);

  const partnerId = await acPickPartner(env, userId);
  if (!partnerId) {
    return api.send({
      chat_id: chatId,
      text:
        "🔍 *Lagi nyariin partner buat kamu...*\n\n" +
        "😴 Kayaknya belum ada yang online sekarang.\n" +
        "Tenang, kamu bakal otomatis dicocokkan begitu ada yang nyari juga!\n\n" +
        "Sambil nunggu, kamu bisa kirim menfess dulu:\n" +
        "Ketik `mfs!` + pesanmu 💌\n\n" +
        "Mau batalkan pencarian? Ketik /stop",
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
    "🎉 *Yeay, partner ditemukan!*\n\n" +
    "Kamu sekarang terhubung secara anonim.\n" +
    "Yuk mulai ngobrol! Identitasmu tetap rahasia 🤫\n\n" +
    "Bisa kirim teks, foto, video, stiker, atau voice note.\n\n" +
    "⏭ /next — Ganti ke partner lain\n" +
    "🛑 /stop — Keluar dari sesi chat";

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
    await api.send({ chat_id: Number(pid), text: "👋 Partner kamu cabut nih. Dia lagi nyari partner baru.\n\nKamu juga mau cari partner baru? Ketik /find 😊" });
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
    await api.send({ chat_id: Number(pid), text: "👋 Partner kamu memutuskan untuk keluar dari sesi.\n\nTenang, mungkin next time ketemu yang lebih seru!\nMau cari partner baru? Ketik /find 😊" });
    if (pData) await acSetUser(env, pid, { ...pData, status: "idle" });
    await acDelSession(env, pid);
    await acDelSession(env, userId);
  }

  await acSetUser(env, userId, { ...user, status: "idle" });
  return api.send({
    chat_id: chatId,
    text:
      "🛑 *Sesi chat diakhiri.*\n\n" +
      "Makasih udah ngobrol ya! Semoga menyenangkan 😊\n\n" +
      "Mau cari partner baru? Klik tombol di bawah atau ketik /find",
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
  const rawText = msg.text || msg.caption || "";

  const blockInfo = await dbIsBlocked(env, uidNum);
  if (blockInfo) return api.send({ chat_id: chatId, text: `🚫 *Aduuh, kamu kena blokir nih...*\n\nAlasan: _${blockInfo.reason}_\nWaktu: ${blockInfo.blocked_at}\n\nKalau merasa salah, hubungi admin ya.` });

  const mutedUntil = await dbIsMuted(env, uidNum);
  if (mutedUntil) return api.send({ chat_id: chatId, text: `🔇 *Kamu lagi kena mute nih...*\n\nBisa kirim menfess lagi setelah:\n*${fmtDate(mutedUntil)}*\n\nSabar ya! 😊` });

  const remaining = await mfRemaining(env, uidNum);
  if (remaining <= 0) {
    return api.send({
      chat_id: chatId,
      text:
        `⏳ *Waduh, kuota menfessmu habis nih!*\n\n` +
        `Kamu sudah kirim *${env.DAILY_MAX} menfess* hari ini.\n` +
        "Tenang, kuota bakal diisi ulang besok! 🌙\n\n" +
        "💡 *Tips:* Ajak teman join lewat link referralmu dan dapat bonus kuota gratis! 🎁",
      reply_markup: ikbd([[burl("🔗 Bagikan Referral & Dapat Bonus Kuota", shareUrl(refLink(env, uidNum)))]]),
    });
  }

  // Hapus trigger case-insensitive (mfs!, Mfs!, MFS!, dll)
  const cleanContent = rawText.replace(/^mfs!/i, "💌").trim();
  if (!cleanContent || cleanContent === "💌") return api.send({ chat_id: chatId, text: "❌ Isi menfessnya kosong nih!\n\nCoba ketik lagi ya, contoh:\n`mfs! Hai semuanya 😊`" });

  const blockedKw = await dbContainsBlacklistedKw(env, cleanContent);
  if (blockedKw) return api.send({ chat_id: chatId, text: `❌ *Menfessmu tidak bisa dikirim* karena mengandung kata yang tidak diperbolehkan.\n\nCoba edit pesanmu dan kirim ulang ya! 😊` });

  let mediaType = "text", fileId = null;
  if (msg.photo)      { mediaType = "photo";  fileId = msg.photo[msg.photo.length - 1].file_id; }
  else if (msg.video) { mediaType = "video";  fileId = msg.video.file_id; }
  else if (msg.voice) { mediaType = "voice";  fileId = msg.voice.file_id; }

  await dbSavePending(env, uidNum, { text: cleanContent, mediaType, fileId, senderName, triggerChatId: chatId, triggerMsgId: msg.message_id });

  const preview = cleanContent.length > 200 ? cleanContent.slice(0, 200) + "..." : cleanContent;
  return api.send({
    chat_id: chatId,
    text:
      `📝 *Preview Menfessmu:*\n\n` +
      `${preview}\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `Pastikan sudah sesuai sebelum dikirim ya!\n` +
      `Pilih cara pengiriman:`,
    reply_markup: ikbd([
      [btn("✅ Kirim Sekarang!", "mf_confirm")],
      [btn(`⏱️ Kirim + Auto-Hapus ${env.AUTO_DEL_MIN} Menit`, "mf_autodel")],
      [btn("❌ Batal", "mf_cancel")],
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
      text:
        `✅ Oke, profil kamu disimpan sebagai *${label}* ya!\n\n` +
        "Sekarang kamu bisa mulai eksplorasi fitur-fiturnya 🎉\n" +
        "Pilih dari tombol di bawah:",
      reply_markup: mainMenuKbd(uidNum === env.ADMIN_ID),
    });
  }

  // Menfess cancel
  if (data === "mf_cancel") {
    await api.answer(query.id);
    await dbDeletePending(env, uidNum);
    return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Oke, menfess dibatalkan.\n\nMau kirim yang lain? Ketik `mfs!` + pesanmu kapan saja!" });
  }

  // Menfess confirm
  if (data === "mf_confirm" || data === "mf_autodel") {
    await api.answer(query.id);
    const pending = await dbGetPending(env, uidNum);
    if (!pending) return api.edit({ chat_id: chatId, message_id: msgId, text: "⚠️ Sesinya udah habis nih. Coba ketik ulang menfessmu ya!" });

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
      return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Aduh, gagal kirim ke channel nih!\n\nPastikan bot sudah jadi *Admin* di channel dengan izin posting ya.", parse_mode: "Markdown" });
    }

    const sentId = sentMsg.result.message_id;

    tgRaw(env.BOT_TOKEN, "setMessageReaction", { chat_id: env.CHANNEL_ID, message_id: sentId, reaction: [{ type: "emoji", emoji: "🔥" }] }).catch(() => {});
    tgRaw(env.BOT_TOKEN, "setMessageReaction", { chat_id: pending.triggerChatId, message_id: pending.triggerMsgId, reaction: [{ type: "emoji", emoji: "❤️" }] }).catch(() => {});

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
      text:
        `✅ *Menfessmu berhasil terkirim!* 🎉\n\n` +
        `🔗 Lihat di channel: ${link}\n` +
        `📊 Sisa kuota hari ini: *${rem} slot*` +
        autoNote,
      reply_markup: ikbd([
        [btn("🗑️ Hapus Menfess Ini", `mf_del_${sentId}`)],
        [burl("🔗 Ajak Teman & Dapat Bonus Kuota", shareUrl(refLink(env, uidNum)))],
      ]),
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
    if (Number(menfess.user_id) !== uidNum) return api.answer(query.id, "❌ Itu bukan menfessmu, jadi nggak bisa dihapus ya!", true);
    try {
      await tgRaw(env.BOT_TOKEN, "deleteMessage", { chat_id: env.CHANNEL_ID, message_id: delId });
      await dbDeleteMenfess(env, delId);
      await api.answer(query.id, "✅ Menfess berhasil dihapus!");
      return api.edit({ chat_id: chatId, message_id: msgId, text: "✅ Menfessmu sudah dihapus dari channel!\n\nMau kirim yang baru? Ketik `mfs!` + pesanmu." });
    } catch {
      return api.answer(query.id, "Gagal menghapus. Pesan mungkin sudah dihapus.", true);
    }
  }

  await api.answer(query.id);
}

// ── tgRaw helper ───────────────────────────────


