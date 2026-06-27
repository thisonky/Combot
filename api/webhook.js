// api/webhook.js — Combo Bot v1.0 (Anonymous Chat + Menfess)
// Vercel Serverless | Upstash Redis
// api/webhook.js — Combo Bot v1.3 (Hyper-Responsive Optimized)
import { tg, ikbd, btn, burl } from "./_tg.js";
import {
  acGetUser, acSetUser, acGetSession, acDelSession, acSetSession,
  acGetQueue, acAddToQueue, acRemoveFromQueue, acPickPartner,
  acIsDone, acMarkDone,
  dbRegisterUser, dbCountUsers, dbAllUserIds,
  dbIsBlocked, dbBlock, dbUnblock, dbListBlocked, dbCountBlocked,
  dbIsMuted, dbMute, dbUnmute, dbCountMuted,
  dbContainsBlacklistedKw, dbAddKw, dbDelKw, dbListKw, dbCountKw,
  dbSaveMenfess, dbGetMenfess, dbDeleteMenfess,
  dbSavePending, dbGetPending, dbDeletePending,
  dbGetReferralBonus, dbAddReferralBonus, dbUseReferralBonus,
  dbHasUsedReferral, dbRecordReferral, dbCountReferrals,
  dbGetContactState, dbSetContactState, dbDelContactState,
  dbGetAdminReply, dbSetAdminReply, dbDelAdminReply
} from "./_db.js";

const NEXT_COOLDOWN = 5000;

// 🔥 OPTIMASI KONSEP 2: MEMORY CACHE GLOBAL DI MEMORI SERVER (MENGURANGI BEBAN REDIS DB HINGGA 99%)
let cachedKw = [];
let lastKwUpdate = 0;

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

  // 🔥 OPTIMASI KONSEP 3: FIRE & FORGET REGISTRASI (MENGHEMAT I/O DATABASE SAAT CHATTING BERLANGSUNG)
  dbRegisterUser(env, uidNum).catch(() => {});

  if (await dbIsBlocked(env, uidNum)) {
    return api.send({ chat_id: chatId, text: "❌ Kamu telah diblokir dari bot ini karena melanggar ketentuan." });
  }

  // ==========================================
  // FITUR UTUH PERINTAH ADMIN (CLEAN PANEL)
  // ==========================================
  if (uidNum === env.ADMIN_ID) {
    if (text === "/panel" || text === "/status") {
      const uCount = await dbCountUsers(env);
      const bCount = await dbCountBlocked(env);
      const mCount = await dbCountMuted(env);
      const kCount = await dbCountKw(env);

      const panelTxt = `⚙️ *PANEL KONTROL ADMIN*\n━━━━━━━━━━━━━━━\n` +
                       `👤 Total Pengguna Terdaftar: *${uCount}*\n` +
                       `🔒 Pengguna Diblokir: *${bCount}*\n` +
                       `🔇 Pengguna Dimute: *${mCount}*\n` +
                       `🚫 Kata Sensor Aktif: *${kCount}*\n\n` +
                       `🛠️ *Daftar Perintah Manajemen Admin*:\n` +
                       `• \`/bc [pesan]\` - Broadcast ke semua user + Deteksi Blokir\n` +
                       `• \`/block [ID]\` - Blokir user permanen\n` +
                       `• \`/unblock [ID]\` - Buka blokir user\n` +
                       `• \`/mute [ID]\` - Mute user\n` +
                       `• \`/unmute [ID]\` - Lepas mute user\n` +
                       `• \`/addkw [kata]\` - Tambah kata dilarang\n` +
                       `• \`/delkw [kata]\` - Hapus kata dilarang\n` +
                       `• \`/listkw\` - Tampilkan semua kata sensor`;
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
          const res = await tgRaw(env.BOT_TOKEN, "sendMessage", { 
            chat_id: Number(u), 
            text: `📢 *PENGUMUMAN ADMIN*:\n\n${bcMsg}`, 
            parse_mode: "Markdown" 
          });

          if (res.ok) {
            successBc++;
          } else if (res.description && res.description.includes("blocked by the user")) {
            const linkProfile = `[User](tg://user?id=${u})`;
            const notifyTxt = `🚫 *NOTIFIKASI BOT DIHAPUS/DIBLOKIR*\n━━━━━━━━━━━━━━━━━━━━\n👤 *Nama:* ${linkProfile}\n🆔 *User ID:* \`${u}\`\n🏷️ *Username:* _Tidak diketahui saat memblokir_`;
            
            await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, text: notifyTxt, parse_mode: "Markdown" }).catch(() => {});
          }
        } catch (e) {
          if (e.message && e.message.includes("blocked")) {
            const linkProfile = `[User](tg://user?id=${u})`;
            const notifyTxt = `🚫 *NOTIFIKASI BOT DIHAPUS/DIBLOKIR*\n━━━━━━━━━━━━━━━━━━━━\n👤 *Nama:* ${linkProfile}\n🆔 *User ID:* \`${u}\`\n🏷️ *Username:* _Tidak diketahui saat memblokir_`;
            
            await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, text: notifyTxt, parse_mode: "Markdown" }).catch(() => {});
          }
        }
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
      lastKwUpdate = 0; // Hancurkan cache agar memori diperbarui
      return api.send({ chat_id: chatId, text: `✅ Kata \`${kw}\` dimasukkan ke daftar blacklist.` });
    }
    if (text.startsWith("/delkw ")) {
      const kw = text.replace("/delkw ", "").trim();
      if (!kw) return api.send({ chat_id: chatId, text: "⚠️ Masukkan kata." });
      await dbDelKw(env, kw);
      lastKwUpdate = 0; // Hancurkan cache agar memori diperbarui
      return api.send({ chat_id: chatId, text: `🗑️ Kata \`${kw}\` dihapus dari daftar blacklist.` });
    }
    if (text === "/listkw") {
      const list = await dbListKw(env);
      if (list.length === 0) return api.send({ chat_id: chatId, text: "ℹ️ Belum ada kata kasar/sensor yang didaftarkan." });
      return api.send({ chat_id: chatId, text: `🚫 *Daftar Kata Sensor Bot*:\n\n${list.map((k, i) => `${i+1}. \`${k}\``).join("\n")}`, parse_mode: "Markdown" });
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

  // Intersept Menfess Baru
  const pending = await dbGetPending(env, uidNum);
  if (pending && pending.step === "waiting_text") {
    if (text === "/cancel" || text === "🛑 Batal") {
      await dbDeletePending(env, uidNum);
      return api.send({ chat_id: chatId, text: "❌ Pengiriman menfess dibatalkan.", reply_markup: getMainMenuKeyboard() });
    }

    const contentText = msg.text || msg.caption || "";
    if (contentText && (await dbContainsBlacklistedKw(env, contentText))) {
      return api.send({ chat_id: chatId, text: "❌ Pesanmu mengandung kata-kata yang dilarang/kasar. Harap ubah kata-katamu!" });
    }

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

  // ==========================================
  // ☕ FITUR DONATE (MEDIA VIA URL + CAPTION)
  // ==========================================
  if (text === "/donate" || text === "/donasi") {
    const donateMediaUrl = "https://ibb.co.com/627jPK1";
    const donateCaption = `☕ *Dukung Pengembangan Bot Ini* \n━━━━━━━━━━━━━━━━━\n` +
                          `Halo! Jika kamu merasa bot ini bermanfaat dan ingin membantu menjaga server tetap aktif 24 jam gratis, kamu bisa memberikan dukungan sukarela melalui:\n\n` +
                          `📟 *SCAN QR-Code* diatas atau\n` +
                          `💳 *Dana / GoPay:* \`0877xxxxxxxx\`\n\n` +
                          `Terima kasih banyak atas kebaikan dan dukunganmu! ❤️`;

    return tgRaw(env.BOT_TOKEN, "sendPhoto", {
      chat_id: chatId,
      photo: donateMediaUrl,
      caption: donateCaption,
      parse_mode: "Markdown"
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
        tgRaw(env.BOT_TOKEN, "sendMessage", {
          chat_id: referrerId,
          text: "🎉 Seseorang bergabung menggunakan link referral-mu! Kamu mendapatkan +1 Slot Bonus Menfess Auto-Delete."
        }).catch(() => {});
      }
    }

    // 🔥 Pengecekan Registrasi Ketat Hanya Terjadi di Perintah /start Saja
    await dbRegisterUser(env, uidNum).catch(() => {});

    return api.send({
      chat_id: chatId,
      text: "👋 *Selamat datang di Anon Space!*\nBot obrolan Anonymous Chat & Pengirim Menfess otomatis sekaligus.\n\nGunakan tombol di bawah untuk memulai menu navigasi.",
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
      tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: uidNum, text: "🎉 Partner ditemukan! Selamat mengobrol.\nKetik /next atau pakai tombol untuk ganti partner.", reply_markup: getChattingKeyboard() }).catch(() => {});
      tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: partnerId, text: "🎉 Partner ditemukan! Selamat mengobrol.\nKetik /next atau pakai tombol untuk ganti partner.", reply_markup: getChattingKeyboard() }).catch(() => {});
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

    tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: session, text: "🛑 Partner telah mengakhiri obrolan.", reply_markup: getMainMenuKeyboard() }).catch(() => {});
    await api.send({ chat_id: chatId, text: "🔄 Mengakhiri obrolan saat ini dan mencari yang baru..." });

    await acAddToQueue(env, uidNum);
    const partnerId = await acPickPartner(env, uidNum);
    if (partnerId) {
      await acSetSession(env, uidNum, partnerId);
      await acSetSession(env, partnerId, uidNum);
      tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: uidNum, text: "🎉 Partner ditemukan! Selamat mengobrol.", reply_markup: getChattingKeyboard() }).catch(() => {});
      tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: partnerId, text: "🎉 Partner ditemukan! Selamat mengobrol.", reply_markup: getChattingKeyboard() }).catch(() => {});
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

    tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: session, text: "🛑 Partner telah mengakhiri obrolan.", reply_markup: getMainMenuKeyboard() }).catch(() => {});
    return api.send({ chat_id: chatId, text: "🛑 Kamu keluar dari obrolan.", reply_markup: getMainMenuKeyboard() });
  }

  // Menu: Kirim Menfess
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

  // =========================================================================
  // ⚡ HIGH-PERFORMANCE CHAT RELAY (FIRE & FORGET + MEMORY CACHE CONTAINS)
  // =========================================================================
  const activeSession = await acGetSession(env, uidNum);
  if (activeSession) {
    let method = "sendMessage";
    let body = { chat_id: activeSession };

    if (msg.text) {
      // ⚡ OPTIMASI KONSEP 2: Implementasi Sensor Kata Kasar Berbasis Memory Cache Server
      const now = Date.now();
      if (now - lastKwUpdate > 60000) { 
        cachedKw = await dbListKw(env);
        lastKwUpdate = now;
      }
      const hasBadWord = cachedKw.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
      if (hasBadWord) {
        return api.send({ chat_id: chatId, text: "⚠️ Pesan diblokir otomatis karena mengandung kata dilarang." });
      }
      method = "sendMessage";
      body.text = msg.text;
    } else if (msg.photo) {
      method = "sendPhoto";
      body.photo = msg.photo[msg.photo.length - 1].file_id;
      body.caption = msg.caption;
    } else if (msg.video) {
      method = "sendVideo";
      body.video = msg.video.file_id;
      body.caption = msg.caption;
    } else if (msg.voice) {
      method = "sendVoice";
      body.voice = msg.voice.file_id;
    } else if (msg.sticker) {
      method = "sendSticker";
      body.sticker = msg.sticker.file_id;
    }

    // ⚡ OPTIMASI KONSEP 1: BYPASS WEBHOOK BLOCKING (PURE FIRE AND FORGET)
    tgRaw(env.BOT_TOKEN, method, body).then(async (res) => {
      // Alur background task mengecek status keaktifan user/blokir tanpa memotong kecepatan pengiriman pesan
      if (!res.ok && res.description && res.description.includes("blocked")) {
        await acDelSession(env, uidNum);
        await acDelSession(env, activeSession);
        
        tgRaw(env.BOT_TOKEN, "sendMessage", { 
          chat_id: chatId, 
          text: "🛑 Sesi terputus karena partner meninggalkan bot (menghapus/memblokir bot).", 
          reply_markup: getMainMenuKeyboard() 
        }).catch(() => {});

        const linkProfile = `[User](tg://user?id=${activeSession})`;
        tgRaw(env.BOT_TOKEN, "sendMessage", { 
          chat_id: env.ADMIN_ID, 
          text: `🚫 *NOTIFIKASI BOT DIBLOKIR*\n👤 *Nama:* ${linkProfile}\n🆔 *ID:* \`${activeSession}\` (Terdeteksi saat AnonChat)`, 
          parse_mode: "Markdown" 
        }).catch(() => {});
      }
    }).catch(() => {});

    return; // Langsung tutup webhook sukses 200 OK ke Telegram. Chat terkirim secepat kilat!
  }

  return api.send({ chat_id: chatId, text: "❓ Perintah tidak dimengerti atau sesi obrolan tidak aktif. Pilih menu di bawah:", reply_markup: getMainMenuKeyboard() });
}

// =========================================================================
// FITUR BAWAAN SEBELUMNYA TETAP UTUH & BERJALAN NORMAL TANPA MODIFIKASI LOGIC
// =========================================================================
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

async function submitReport(uidNum, pending, autoDelete, env, api) {
  try {
    let method = "sendMessage";
    let body = {
      chat_id: env.CHANNEL_ID,
      parse_mode: "Markdown"
    };
    const defaultTail = `\n\n━━━━━━━━━━━━━━━\n💌 _Menfess dikirim melalui @KEKprojects_bot_`;

    if (pending.mediaType === "text") {
      method = "sendMessage";
      body.text = `"${pending.text}"${defaultTail}`;
    } else {
      const captionText = pending.caption ? `"${pending.caption}"`;
      body.caption = `${captionText}${defaultTail}`;
      
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
    
    // Tentukan format link berdasarkan jenis CHANNEL_ID (Username vs ID Angka)
    let link = "";
    const channelStr = String(env.CHANNEL_ID).trim();
    
    if (channelStr.startsWith("-100")) {
      // Jika menggunakan ID Angka (Channel Publik/Privat), gunakan format c/ (Dibutuhkan t.me/c/ID_TANPA_MINUS_100/ID_PESAN)
      const cleanId = channelStr.replace("-100", "");
      link = `https://t.me/c/${cleanId}/${sentId}`;
    } else {
      // Jika menggunakan Username (misal: @channel_kamu atau channel_kamu)
      const cleanUsername = channelStr.replace("@", "");
      link = `https://t.me/${cleanUsername}/${sentId}`;
    }

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
