// api/webhook.js — Combo Bot v1.0 (Anonymous Chat + Menfess)
// Vercel Serverless | Upstash Redis

// api/webhook.js — Combo Bot v1.0 (Anonymous Chat + Menfess + Report & Contact)
// api/webhook.js — Combo Bot v1.1 (AnonChat + Menfess Bebas Media Tanpa Paksa Target + Fitur Admin Utuh)
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
  dbGetContactState, dbSetContactState, dbDelContactState,
  dbGetAdminReply, dbSetAdminReply, dbDelAdminReply
} from "./_db.js";

const NEXT_COOLDOWN = 5000;

function getEnv() {
  return {
    KV_URL:       process.env.UPSTASH_REDIS_URL,
    KV_TOKEN:     process.env.UPSTASH_REDIS_TOKEN,
    BOT_TOKEN:    process.env.BOT_TOKEN,
    ADMIN_ID:     Number(process.env.ADMIN_ID || 0),
    CHANNEL_ID:   process.env.CHANNEL_ID || "",
    BOT_USERNAME: process.env.BOT_USERNAME || "",
    AUTO_DEL_MIN: Number(process.env.AUTO_DEL_MIN || 5),
  };
}

function refLink(env, uid) {
  return `https://t.me/${env.BOT_USERNAME}?start=ref_${uid}`;
}

function shareUrl(link) {
  return `https://telegram.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Yuk gabung ke bot anonchat & menfess ini! Seru banget bisa ngobrol rahasia.")}`;
}

async function tgRaw(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.json();
}

function getMainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🔍 Cari Partner" }],
      [{ text: "📝 Kirim Menfess" }, { text: "🎁 Bonus & Referral" }],
      [{ text: "🚨 Report Partner" }, { text: "📬 Hubungi Admin" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function getChattingKeyboard() {
  return {
    keyboard: [
      [{ text: "⏭️ Next" }, { text: "🛑 Stop" }],
      [{ text: "🚨 Report Partner" }]
    ],
    resize_keyboard: true
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).send("Bot is running safely.");
    }

    const env = getEnv();
    if (!env.KV_URL || !env.BOT_TOKEN) {
      console.error("Missing configuration env variables.");
      return res.status(200).json({ ok: true });
    }

    const api = tg(env.BOT_TOKEN);
    const update = req.body;

    if (update.callback_query) {
      await handleCallback(update.callback_query, env, api);
      return res.status(200).json({ ok: true });
    }

    if (!update.message) {
      return res.status(200).json({ ok: true });
    }

    await handleMessage(update.message, env, api);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Critical webhook runtime exception:", err.message);
    return res.status(200).json({ ok: true });
  }
}

async function handleMessage(msg, env, api) {
  const chatId = msg.chat.id;
  const uidNum = msg.from.id;
  const text = msg.text ? msg.text.trim() : "";

  await dbRegisterUser(env, uidNum);

  if (await dbIsBlocked(env, uidNum)) {
    return api.send({ chat_id: chatId, text: "❌ Kamu telah diblokir dari bot ini karena melanggar ketentuan." });
  }

  // ==========================================
  // FITUR UTUH PERINTAH ADMIN
  // ==========================================
  if (uidNum === env.ADMIN_ID) {
    if (text === "/panel" || text === "/status") {
      const uCount = await dbCountUsers(env);
      const bCount = await dbCountBlocked(env);
      const mCount = await dbCountMuted(env);
      const dCount = await dbGetDailyCount(env);
      const kCount = await dbCountKw(env);
      const mfCount = await dbCountMenfess(env);

      const panelTxt = `⚙️ *PANEL KONTROL ADMIN COMBO BOT*\n━━━━━━━━━━━━━━━\n` +
                       `👤 Total Pengguna Terdaftar: *${uCount}*\n` +
                       `📝 Total Menfess Terkirim: *${mfCount}*\n` +
                       `💬 Pesan AnonChat Hari Ini: *${dCount}*\n` +
                       `🔒 Pengguna Diblokir: *${bCount}*\n` +
                       `🔇 Pengguna Dimute: *${mCount}*\n` +
                       `🚫 Kata Sensor Aktif: *${kCount}*\n\n` +
                       `🛠️ *Daftar Perintah Manajemen Admin*:\n` +
                       `• \`/bc [pesan]\` - Broadcast teks ke semua user\n` +
                       `• \`/block [ID]\` - Blokir user permanen\n` +
                       `• \`/unblock [ID]\` - Buka blokir user\n` +
                       `• \`/mute [ID]\` - Mute user (tidak bisa kirim pesan/menfess)\n` +
                       `• \`/unmute [ID]\` - Lepas status mute user\n` +
                       `• \`/addkw [kata]\` - Tambah kata dilarang\n` +
                       `• \`/delkw [kata]\` - Hapus kata dilarang\n` +
                       `• \`/listkw\` - Tampilkan semua kata sensor\n` +
                       `• \`/resetdaily\` - Reset hitungan pesan harian`;
      return api.send({ chat_id: chatId, text: panelTxt, parse_mode: "Markdown" });
    }

    if (text.startsWith("/bc ") || text.startsWith("/broadcast ")) {
      const bcMsg = text.replace(/^\/(bc|broadcast)\s+/, "");
      if (!bcMsg) return api.send({ chat_id: chatId, text: "⚠️ Format salah. Contoh: \`/bc Halo semuanya\`" });
      const allUsers = await dbAllUserIds(env);
      let successBc = 0;
      await api.send({ chat_id: chatId, text: `⏳ Memulai proses broadcast ke ${allUsers.length} pengguna...` });
      for (const u of allUsers) {
        try {
          const res = await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(u), text: `📢 *PENGUMUMAN ADMIN*:\n\n${bcMsg}`, parse_mode: "Markdown" });
          if (res.ok) successBc++;
        } catch {}
      }
      return api.send({ chat_id: chatId, text: `✅ Broadcast selesai. Pesan berhasil terkirim ke *${successBc}* pengguna.` });
    }

    if (text.startsWith("/block ")) {
      const target = text.split(" ")[1];
      if (!target) return api.send({ chat_id: chatId, text: "⚠️ Masukkan ID User. Contoh: \`/block 123456\`" });
      await dbBlock(env, target);
      return api.send({ chat_id: chatId, text: `🔒 User \`${target}\` berhasil diblokir.` });
    }
    if (text.startsWith("/unblock ")) {
      const target = text.split(" ")[1];
      if (!target) return api.send({ chat_id: chatId, text: "⚠️ Masukkan ID User. Contoh: \`/unblock 123456\`" });
      await dbUnblock(env, target);
      return api.send({ chat_id: chatId, text: `🔓 Blokir User \`${target}\` berhasil dibuka.` });
    }

    if (text.startsWith("/mute ")) {
      const target = text.split(" ")[1];
      if (!target) return api.send({ chat_id: chatId, text: "⚠️ Masukkan ID User. Contoh: \`/mute 123456\`" });
      await dbMute(env, target);
      return api.send({ chat_id: chatId, text: `🔇 User \`${target}\` berhasil dimute.` });
    }
    if (text.startsWith("/unmute ")) {
      const target = text.split(" ")[1];
      if (!target) return api.send({ chat_id: chatId, text: "⚠️ Masukkan ID User. Contoh: \`/unmute 123456\`" });
      await dbUnmute(env, target);
      return api.send({ chat_id: chatId, text: `🔊 Status mute User \`${target}\` dicabut.` });
    }

    if (text.startsWith("/addkw ")) {
      const kw = text.replace("/addkw ", "").trim();
      if (!kw) return api.send({ chat_id: chatId, text: "⚠️ Masukkan kata." });
      await dbAddKw(env, kw);
      return api.send({ chat_id: chatId, text: `✅ Kata \`${kw}\` dimasukkan ke daftar blacklist.` });
    }
    if (text.startsWith("/delkw ")) {
      const kw = text.replace("/delkw ", "").trim();
      if (!kw) return api.send({ chat_id: chatId, text: "⚠️ Masukkan kata." });
      await dbDelKw(env, kw);
      return api.send({ chat_id: chatId, text: `🗑️ Kata \`${kw}\` dihapus dari daftar blacklist.` });
    }
    if (text === "/listkw") {
      const list = await dbListKw(env);
      if (list.length === 0) return api.send({ chat_id: chatId, text: "ℹ️ Belum ada kata kasar/sensor yang didaftarkan." });
      return api.send({ chat_id: chatId, text: `🚫 *Daftar Kata Sensor Bot*:\n\n${list.map((k, i) => `${i+1}. \`${k}\``).join("\n")}`, parse_mode: "Markdown" });
    }

    if (text === "/resetdaily") {
      await dbResetDaily(env);
      return api.send({ chat_id: chatId, text: "🔄 Statistik hitungan pesan harian berhasil di-reset menjadi 0." });
    }

    if (text === "/cancelreply") {
      await dbDelAdminReply(env, env.ADMIN_ID);
      return api.send({ chat_id: chatId, text: "✅ Mode balasan dibatalkan.", reply_markup: getMainMenuKeyboard() });
    }

    const replyState = await dbGetAdminReply(env, env.ADMIN_ID);
    if (replyState && replyState.targetUid) {
      await handleAdminReplyMessage(msg, replyState.targetUid, env, api);
      return;
    }
  }

  // Proteksi Mute
  if (await dbIsMuted(env, uidNum)) {
    if (text === "🔍 Cari Partner" || text === "📝 Kirim Menfess" || (!text.startsWith("/") && !["🛑 Keluar Hubungi Admin", "🛑 Batal"].includes(text))) {
      return api.send({ chat_id: chatId, text: "🔇 Akun kamu sedang dalam status dibisukan (mute) oleh admin karena pelanggaran ringan." });
    }
  }

  // Mode Hubungi Admin
  const contactState = await dbGetContactState(env, uidNum);
  if (contactState && contactState.active) {
    if (text === "/cancelcontact" || text === "🛑 Keluar Hubungi Admin") {
      await dbDelContactState(env, uidNum);
      return api.send({ chat_id: chatId, text: "✅ Keluar dari mode Hubungi Admin.", reply_markup: getMainMenuKeyboard() });
    }
    await handleContactRelay(msg, env, api);
    return;
  }

  // ====================================================
  // ⭐ INTERSEPT MENFESS BARU: BEBAS MEDIA & TANPA TARGET ⭐
  // ====================================================
  const pending = await dbGetPending(env, uidNum);
  if (pending && pending.step === "waiting_text") {
    if (text === "/cancel" || text === "🛑 Batal") {
      await dbDeletePending(env, uidNum);
      return api.send({ chat_id: chatId, text: "❌ Pengiriman menfess dibatalkan.", reply_markup: getMainMenuKeyboard() });
    }

    // Cek Sensor kata kasar pada teks atau caption media
    const contentText = msg.text || msg.caption || "";
    if (contentText && (await dbContainsBlacklistedKw(env, contentText))) {
      return api.send({ chat_id: chatId, text: "❌ Pesanmu mengandung kata-kata yang dilarang/kasar. Harap ubah kata-katamu!" });
    }

    // Mengamankan data media apa pun yang dikirim oleh user
    pending.text = msg.text || "";
    pending.caption = msg.caption || "";
    
    if (msg.photo) {
      pending.mediaType = "photo";
      pending.fileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.video) {
      pending.mediaType = "video";
      pending.fileId = msg.video.file_id;
    } else if (msg.voice) {
      pending.mediaType = "voice";
      pending.fileId = msg.voice.file_id;
    } else {
      pending.mediaType = "text";
    }

    pending.step = "waiting_confirm";
    await dbSavePending(env, uidNum, pending);

    // Kirimkan feedback pratinjau langsung ke user sebelum dilempar ke channel
    await api.send({ chat_id: chatId, text: "📝 *Konfirmasi Pengiriman Menfess*:\n\nPesan ekspresi Anda siap diterbitkan. Silakan tentukan opsi pengiriman di bawah ini:" });
    
    return api.send({
      chat_id: chatId,
      text: "Silakan pilih salah satu metode:",
      reply_markup: ikbd([
        [btn("🚀 Kirim Biasa (Gratis)", "mf_send_normal"), btn("⏱️ Kirim + Auto-Delete (1 Slot)", "mf_send_autodel")],
        [btn("❌ Batalkan Pengiriman", "mf_send_cancel")]
      ])
    });
  }

  // Start & Deep Linking Referral
  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    if (parts.length > 1 && parts[1].startsWith("ref_")) {
      const referrerId = Number(parts[1].replace("ref_", ""));
      if (referrerId !== uidNum && !(await dbHasUsedReferral(env, uidNum))) {
        await dbRecordReferral(env, uidNum, referrerId);
        await dbAddReferralBonus(env, referrerId, 1);
        await tgRaw(env.BOT_TOKEN, "sendMessage", {
          chat_id: referrerId,
          text: "🎉 Seseorang bergabung menggunakan link referral-mu! Kamu mendapatkan +1 Slot Bonus Menfess Auto-Delete."
        }).catch(() => {});
      }
    }

    return api.send({
      chat_id: chatId,
      text: "👋 *Selamat datang di Anon Space!* Bot obrolan Anonymous Chat & Pengirim Menfess otomatis sekaligus.\n\nGunakan tombol di bawah untuk memulai menu navigasi.",
      reply_markup: getMainMenuKeyboard()
    });
  }

  // Menu: Cari Partner
  if (text === "🔍 Cari Partner") {
    const session = await acGetSession(env, uidNum);
    if (session) return api.send({ chat_id: chatId, text: "⚠️ Kamu sedang berada dalam obrolan aktif!", reply_markup: getChattingKeyboard() });

    await acAddToQueue(env, uidNum);
    await api.send({ chat_id: chatId, text: "⏳ Sedang mencarikan partner mengobrol untukmu... mohon tunggu.", reply_markup: { keyboard: [[{ text: "🛑 Stop" }]], resize_keyboard: true } });

    const partnerId = await acPickPartner(env, uidNum);
    if (partnerId) {
      await acSetSession(env, uidNum, partnerId);
      await acSetSession(env, partnerId, uidNum);
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: uidNum, text: "🎉 Partner ditemukan! Selamat mengobrol.\nKetik /next atau pakai tombol untuk ganti partner.", reply_markup: getChattingKeyboard() });
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: partnerId, text: "🎉 Partner ditemukan! Selamat mengobrol.\nKetik /next atau pakai tombol untuk ganti partner.", reply_markup: getChattingKeyboard() });
    }
    return;
  }

  // Next / Stop Flow Anon Chat
  if (text === "⏭️ Next" || text === "/next") {
    const session = await acGetSession(env, uidNum);
    if (!session) return api.send({ chat_id: chatId, text: "Kamu tidak sedang dalam obrolan.", reply_markup: getMainMenuKeyboard() });

    if (await acIsDone(env, uidNum)) {
      return api.send({ chat_id: chatId, text: "⏳ Mohon tunggu beberapa detik sebelum mencari partner lagi." });
    }
    await acMarkDone(env, uidNum);

    await acDelSession(env, uidNum);
    await acDelSession(env, session);

    await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: session, text: "🛑 Partner telah mengakhiri obrolan.", reply_markup: getMainMenuKeyboard() });
    await api.send({ chat_id: chatId, text: "🔄 Mengakhiri obrolan saat ini dan mencari yang baru..." });

    await acAddToQueue(env, uidNum);
    const partnerId = await acPickPartner(env, uidNum);
    if (partnerId) {
      await acSetSession(env, uidNum, partnerId);
      await acSetSession(env, partnerId, uidNum);
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: uidNum, text: "🎉 Partner ditemukan! Selamat mengobrol.", reply_markup: getChattingKeyboard() });
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: partnerId, text: "🎉 Partner ditemukan! Selamat mengobrol.", reply_markup: getChattingKeyboard() });
    }
    return;
  }

  if (text === "🛑 Stop" || text === "/stop") {
    const session = await acGetSession(env, uidNum);
    const queue = await acGetQueue(env);

    if (queue.map(String).includes(String(uidNum))) {
      await acRemoveFromQueue(env, uidNum);
      return api.send({ chat_id: chatId, text: "🛑 Pencarian dibatalkan.", reply_markup: getMainMenuKeyboard() });
    }

    if (!session) return api.send({ chat_id: chatId, text: "Kamu tidak sedang dalam obrolan.", reply_markup: getMainMenuKeyboard() });

    await acDelSession(env, uidNum);
    await acDelSession(env, session);

    await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: session, text: "🛑 Partner telah mengakhiri obrolan.", reply_markup: getMainMenuKeyboard() });
    return api.send({ chat_id: chatId, text: "🛑 Kamu keluar dari obrolan.", reply_markup: getMainMenuKeyboard() });
  }

  // Menu: Kirim Menfess (Sekarang mendukung teks & media bebas)
  if (text === "📝 Kirim Menfess") {
    await dbSavePending(env, uidNum, { step: "waiting_text", senderName: msg.from.first_name || "Anonymous" });
    return api.send({
      chat_id: chatId,
      text: "📝 Silakan kirimkan ekspresi menfess kamu.\n\nBisa berupa *Teks biasa*, atau *Media (Foto / Video / Voice Note)* baik menggunakan caption ataupun kosongan:",
      reply_markup: { keyboard: [[{ text: "🛑 Batal" }]], resize_keyboard: true }
    });
  }

  // Menu: Bonus & Referral
  if (text === "🎁 Bonus & Referral") {
    const bonus = await dbGetReferralBonus(env, uidNum);
    const totalRef = await dbCountReferrals(env, uidNum);
    return api.send({
      chat_id: chatId,
      text: `🎁 *Menu Bonus & Referral*\n━━━━━━━━━━━━━━━\n👤 Total Ajakan: *${totalRef} orang*\n⏱️ Slot Auto-Delete: *${bonus} slot*\n\nSebarkan link tautan ini untuk mendapatkan slot bonus menfess auto-delete gratis!`,
      reply_markup: ikbd([[burl("🔗 Ajak Teman & Dapat Bonus", shareUrl(refLink(env, uidNum)))]])
    });
  }

  // Menu: Report Partner
  if (text === "🚨 Report Partner" || text === "/report") {
    const session = await acGetSession(env, uidNum);
    if (!session) {
      return api.send({ chat_id: chatId, text: "⚠️ Kamu hanya bisa melaporkan partner ketika sedang terhubung dalam Anonymous Chat saja." });
    }
    return handleReportMenu(chatId, api);
  }

  // Menu: Hubungi Admin
  if (text === "📬 Hubungi Admin" || text === "/contact") {
    await dbSetContactState(env, uidNum, { active: true });
    return api.send({
      chat_id: chatId,
      text: "📬 *Mode Hubungi Admin Aktif*\n\nSilakan ketik keluhan, kritik, atau saran kamu di sini. Semua pesan teks/media akan otomatis diteruskan ke admin.\n\nKetik /cancelcontact atau klik tombol di bawah untuk kembali ke menu utama.",
      reply_markup: { keyboard: [[{ text: "🛑 Keluar Hubungi Admin" }]], resize_keyboard: true }
    });
  }

  // Relay Chat Biasa Jika Sedang Terhubung Anon Chat
  const activeSession = await acGetSession(env, uidNum);
  if (activeSession) {
    await dbIncrementDaily(env);
    if (msg.text) {
      if (await dbContainsBlacklistedKw(env, text)) {
        return api.send({ chat_id: chatId, text: "⚠️ Pesan diblokir otomatis karena mengandung kata dilarang." });
      }
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: activeSession, text: msg.text });
    } else {
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await tgRaw(env.BOT_TOKEN, "sendPhoto", { chat_id: activeSession, photo: fileId, caption: msg.caption });
      } else if (msg.video) {
        await tgRaw(env.BOT_TOKEN, "sendVideo", { chat_id: activeSession, video: msg.video.file_id, caption: msg.caption });
      } else if (msg.voice) {
        await tgRaw(env.BOT_TOKEN, "sendVoice", { chat_id: activeSession, voice: msg.voice.file_id });
      } else if (msg.sticker) {
        await tgRaw(env.BOT_TOKEN, "sendSticker", { chat_id: activeSession, sticker: msg.sticker.file_id });
      }
    }
    return;
  }

  return api.send({ chat_id: chatId, text: "❓ Perintah tidak dimengerti atau sesi obrolan tidak aktif. Pilih menu di bawah:", reply_markup: getMainMenuKeyboard() });
}

// ── Callback Query Logic ──
async function handleCallback(query, env, api) {
  const data = query.data;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const uidNum = query.from.id;

  if (data.startsWith("rep_")) {
    const reason = data.replace("rep_", "");
    const session = await acGetSession(env, uidNum);
    await api.answer(query.id, "✅ Laporan berhasil dikirim ke admin.");
    await api.edit({ chat_id: chatId, message_id: msgId, text: "✅ Terima kasih! Laporan Anda telah diteruskan ke pihak admin untuk ditinjau." });
    if (session) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_ID,
        text: `🚨 *LAPORAN ANONYMOUS CHAT*\n━━━━━━━━━━━━━━━\n👤 *Pelapor:* \`${uidNum}\`\n🎯 *Terlapor:* \`${session}\`\n⚠️ *Alasan:* ${reason}`
      }).catch(() => {});
    }
    return;
  }

  if (data.startsWith("mf_send_")) {
    const action = data.replace("mf_send_", "");
    const pending = await dbGetPending(env, uidNum);
    if (!pending) return api.answer(query.id, "⚠️ Sesi kedaluwarsa. Silakan ulangi.", true);

    if (action === "cancel") {
      await dbDeletePending(env, uidNum);
      await api.answer(query.id, "❌ Dibatalkan.");
      return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Pengiriman Menfess dibatalkan." });
    }

    const autoDelete = action === "autodel";
    if (autoDelete) {
      const slots = await dbGetReferralBonus(env, uidNum);
      if (slots <= 0) {
        return api.answer(query.id, "❌ Slot Auto-Delete Anda habis! Silakan gunakan opsi Kirim Biasa atau cari referral.", true);
      }
      await dbUseReferralBonus(env, uidNum);
    }

    await dbDeletePending(env, uidNum);
    await api.answer(query.id, "🚀 Menfess Anda sedang diproses!");
    await api.edit({ chat_id: chatId, message_id: msgId, text: "🚀 Menfess berhasil dikirim ke antrean server!" });

    await submitReport(uidNum, pending, autoDelete, env, api);
    return;
  }

  if (data.startsWith("mf_del_")) {
    const delId = Number(data.replace("mf_del_", ""));
    const menfess = await dbGetMenfess(env, delId);
    if (!menfess) return api.answer(query.id, "⚠️ Data menfess tidak ditemukan.", true);
    if (Number(menfess.user_id) !== uidNum) return api.answer(query.id, "❌ Ini bukan menfess milik Anda!", true);

    await tgRaw(env.BOT_TOKEN, "deleteMessage", { chat_id: env.CHANNEL_ID, message_id: delId }).catch(() => {});
    await dbDeleteMenfess(env, delId);
    await api.answer(query.id, "🗑️ Menfess berhasil dihapus dari channel.");
    return api.edit({ chat_id: chatId, message_id: msgId, text: "🗑️ Menfess Anda telah sukses dihapus dari channel." });
  }

  if (data.startsWith("adm_reply_")) {
    const targetUid = data.replace("adm_reply_", "");
    await dbSetAdminReply(env, env.ADMIN_ID, targetUid);
    await api.answer(query.id);
    return api.send({
      chat_id: chatId,
      text: `✍️ *Mode Balas Aktif*\n\nSilakan ketik pesan balasan untuk User \`${targetUid}\`. Ketik /cancelreply untuk batal.`
    });
  }

  if (data.startsWith("adm_block_")) {
    const targetUid = data.replace("adm_block_", "");
    await dbBlock(env, targetUid);
    await api.answer(query.id, `🔒 User ${targetUid} diblokir.`, true);
    return api.edit({ chat_id: chatId, message_id: msgId, text: `🔒 User \`${targetUid}\` berhasil diblokir.` });
  }
}

// Sub-handlers Fitur Report & Kontak Admin
function handleReportMenu(chatId, api) {
  return api.send({
    chat_id: chatId,
    text: "🚨 *Laporkan Partner*\n\nPilih alasan utama Anda melaporkan partner saat ini:",
    reply_markup: ikbd([
      [btn("🔞 Konten Seksual / Porno", "rep_pornografi"), btn("💸 Penipuan / Spam", "rep_spam")],
      [btn("🤬 Toksik / Kata Kasar", "rep_toxic"), btn("🎭 Akun Palsu / Hode", "rep_fake")]
    ])
  });
}

async function handleContactRelay(msg, env, api) {
  const uidNum = msg.from.id;
  const name = msg.from.first_name || "Anonymous";

  await tgRaw(env.BOT_TOKEN, "sendMessage", {
    chat_id: env.ADMIN_ID,
    text: `📬 *PESAN HUBUNGI ADMIN*\n━━━━━━━━━━━━━━━\n👤 *Pengirim:* ${name}\n🆔 *ID:* \`${uidNum}\`\n💬 *Isi:* ${msg.text || "[Media / File]"}`,
    reply_markup: ikbd([
      [btn("✍️ Balas User", `adm_reply_${uidNum}`), btn("🔒 Blokir User", `adm_block_${uidNum}`)]
    ])
  });

  if (!msg.text) {
    await tgRaw(env.BOT_TOKEN, "forwardMessage", { chat_id: env.ADMIN_ID, from_chat_id: uidNum, message_id: msg.message_id }).catch(() => {});
  }
  return api.send({ chat_id: uidNum, text: "✅ Pesan Anda telah diteruskan ke admin. Tunggu balasan jika diperlukan." });
}

async function handleAdminReplyMessage(msg, targetUid, env, api) {
  try {
    if (msg.text) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: targetUid, text: `💬 *Balasan dari Admin*:\n\n${msg.text}` });
    } else {
      await tgRaw(env.BOT_TOKEN, "copyMessage", { chat_id: targetUid, from_chat_id: env.ADMIN_ID, message_id: msg.message_id });
    }
    await api.send({ chat_id: env.ADMIN_ID, text: `✅ Balasan sukses dikirim ke User \`${targetUid}\`!` });
  } catch (e) {
    await api.send({ chat_id: env.ADMIN_ID, text: `❌ Gagal mengirim ke User \`${targetUid}\`. Bot mungkin diblokir.` });
  } finally {
    await dbDelAdminReply(env, env.ADMIN_ID);
  }
}

// ── Modifikasi Eksekusi Pengiriman Berbagai Jenis Media Ke Channel Tanpa Target Mandatori ──
async function submitReport(uidNum, pending, autoDelete, env, api) {
  try {
    let method = "sendMessage";
    let body = { chat_id: env.CHANNEL_ID };
    const defaultTail = `\n━━━━━━━━━━━━━━━\n⏱️ _Dikirim secara anonim_`;

    if (pending.mediaType === "text") {
      method = "sendMessage";
      body.text = `📩 *MENFESS BARU*\n━━━━━━━━━━━━━━━\n💬 *Pesan:*\n"${pending.text}"${defaultTail}`;
    } else {
      const captionText = pending.caption ? `💬 *Pesan:*\n"${pending.caption}"` : `💬 *Pesan:* _[Tanpa Keterangan]_`;
      body.caption = `📩 *MENFESS BARU*\n━━━━━━━━━━━━━━━\n${captionText}${defaultTail}`;
      
      if (pending.mediaType === "photo") {
        method = "sendPhoto";
        body.photo = pending.fileId;
      } else if (pending.mediaType === "video") {
        method = "sendVideo";
        body.video = pending.fileId;
      } else if (pending.mediaType === "voice") {
        method = "sendVoice";
        body.voice = pending.fileId;
      }
    }

    const res = await tgRaw(env.BOT_TOKEN, method, body);
    if (!res.ok) {
      return api.send({ chat_id: uidNum, text: `❌ Gagal mengirim menfess ke channel. Error: ${res.description || "Unknown"}` });
    }

    const sentId = res.result.message_id;
    const link = `https://t.me/${String(env.CHANNEL_ID).replace("@", "")}/${sentId}`;
    await dbSaveMenfess(env, sentId, { user_id: uidNum, text: pending.text || pending.caption, timestamp: Date.now() });

    let rem = "Kirim Biasa";
    let autoNote = "";
    if (autoDelete) {
      rem = "Auto-Delete";
      autoNote = `\n\n⏱️ *Catatan:* Pesan ini diatur otomatis terhapus dalam waktu ${env.AUTO_DEL_MIN} menit.`;
      setTimeout(async () => {
        await tgRaw(env.BOT_TOKEN, "deleteMessage", { chat_id: env.CHANNEL_ID, message_id: sentId }).catch(() => {});
        await dbDeleteMenfess(env, sentId);
      }, env.AUTO_DEL_MIN * 60 * 1000);
    }

    await api.send({
      chat_id: uidNum,
      text: `✅ *Menfess Berhasil Terkirim!*\n\n🔗 *Link:* [Lihat Pesan Anda Di Sini](${link})\n🛠️ *Metode:* ${rem}${autoNote}`,
      reply_markup: ikbd([
        [btn("🗑️ Hapus Menfess", `mf_del_${sentId}`)],
        [burl("🔗 Ajak Teman & Dapat Bonus", shareUrl(refLink(env, uidNum)))],
      ]),
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error("Error submitting menfess request:", err.message);
  }
}
