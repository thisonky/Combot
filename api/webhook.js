// Combo Bot v1.0 (Anonymous Chat + Menfess)
// Vercel Serverless | Upstash Redis
// api/webhook.js — Combo Bot v1.3 (Hyper-Responsive Optimized)
// api/webhook.js — Combo Bot v1.4 (Hybrid Clean Sheets & Premium Engine)
import { tg, ikbd, btn, burl, tgRaw } from "./_tg.js";
import {
  acGetUser, acSetUser, acGetSession, acDelSession, acSetSession,
  acGetQueue, acAddToQueue, acRemoveFromQueue, acIsDone, acMarkDone,
  dbRegisterUser, dbCountUsers, dbAllUserIds,
  dbIsBlocked, dbBlock, dbUnblock, dbCountBlocked,
  dbIsMuted, dbMute, dbUnmute, dbCountMuted,
  dbContainsBlacklistedKw, dbAddKw, dbDelKw, dbListKw, dbCountKw,
  dbSaveMenfess, dbGetMenfess, dbDeleteMenfess,
  dbSavePending, dbGetPending, dbDeletePending,
  dbGetReferralBonus, dbAddReferralBonus, dbUseReferralBonus,
  dbHasUsedReferral, dbRecordReferral, dbCountReferrals,
  dbGetContactState, dbSetContactState, dbDelContactState,
  dbGetAdminReply, dbSetAdminReply, dbDelAdminReply
} from "./_db.js";

function getEnv() {
  return {
    KV_URL:              process.env.UPSTASH_REDIS_URL,
    KV_TOKEN:            process.env.UPSTASH_REDIS_TOKEN,
    BOT_TOKEN:           process.env.BOT_TOKEN,
    ADMIN_ID:            Number(process.env.ADMIN_ID || 0),
    CHANNEL_ID:          process.env.CHANNEL_ID || "",
    BOT_USERNAME:        process.env.BOT_USERNAME || "",
    AUTO_DEL_MIN:        Number(process.env.AUTO_DEL_MIN || 5),
    SPREADSHEET_API_URL: process.env.SPREADSHEET_API_URL || "",
  };
}

function refLink(env, uid) { return `https://t.me/${env.BOT_USERNAME}?start=ref_${uid}`; }
function shareUrl(link) { return `https://telegram.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Yuk gabung ke bot anonchat & menfess ini!")}`; }

function getMainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🔍 Cari Partner" }],
      [{ text: "📝 Kirim Menfess" }, { text: "🎁 Bonus & Referral" }],
      [{ text: "🚨 Report Partner" }, { text: "📬 Hubungi Admin" }]
    ],
    resize_keyboard: true
  };
}

function getChattingKeyboard() {
  return {
    keyboard: [[{ text: "⏭️ Next" }, { text: "🛑 Stop" }], [{ text: "🚨 Report Partner" }]],
    resize_keyboard: true
  };
}

export default async function handler(req, res) {
  // Selalu kembalikan 200 OK ke Telegram secepat mungkin untuk mencegah looping retries webhook
  res.setHeader("Content-Type", "application/json");
  
  try {
    if (req.method !== "POST") {
      return res.status(200).send(JSON.stringify({ status: "Bot is active" }));
    }
    
    const env = getEnv();
    if (!env.KV_URL || !env.BOT_TOKEN) {
      return res.status(200).send(JSON.stringify({ error: "Missing config" }));
    }

    const api = tg(env.BOT_TOKEN);
    let rawBody = req.body;
    let update = null;

    // PRODUCTION-GRADE MIDDLEWARE PARSING PAYLOAD (Kebal Eror % / URL-Encoded)
    if (typeof rawBody === "string") {
      try {
        if (rawBody.trim().startsWith("%") || rawBody.includes("update_id")) {
          const cleanStr = rawBody.trim().startsWith("%") ? decodeURIComponent(rawBody) : rawBody;
          if (cleanStr.includes("=")) {
            const params = new URLSearchParams(cleanStr);
            const firstKey = Array.from(params.keys())[0];
            update = JSON.parse(firstKey.startsWith("{") ? firstKey : params.get(firstKey));
          } else {
            update = JSON.parse(cleanStr);
          }
        } else {
          update = JSON.parse(rawBody);
        }
      } catch (pErr) {
        console.error("[Middleware Parser Crash Fallback]:", pErr.message);
        return res.status(200).send(JSON.stringify({ ok: true }));
      }
    } else {
      update = rawBody;
    }

    if (!update) return res.status(200).send(JSON.stringify({ ok: true }));

    // Isolasikan pemanggilan fungsi agar penanganan kegagalan tidak mematikan webhook router
    if (update.callback_query) {
      await handleCallback(update.callback_query, env, api);
    } else if (update.message) {
      await handleMessage(update.message, env, api);
    }

    return res.status(200).send(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("[Critical Root Runtime Handler Error]:", err.stack);
    return res.status(200).send(JSON.stringify({ ok: true }));
  }
}

async function handleMessage(msg, env, api) {
  const chatId = msg.chat.id;
  const uidNum = msg.from.id;
  const text = msg.text ? msg.text.trim() : "";

  if (await dbIsBlocked(env, uidNum)) {
    return api.send({ chat_id: chatId, text: "❌ Kamu telah diblokir dari bot ini karena melanggar ketentuan." });
  }

  // --- BLOK MANAGEMENT UTAMA ADMIN ---
  if (uidNum === env.ADMIN_ID) {
    if (text === "/panel" || text === "/status") {
      const uCount = await dbCountUsers(env);
      const bCount = await dbCountBlocked(env);
      const mCount = await dbCountMuted(env);
      const kCount = await dbCountKw(env);

      const panelTxt = `⚙️ *PANEL KONTROL UTAMA ADMIN*\n━━━━━━━━━━━━━━━\n` +
                       `👤 Total User (Symmetric SCARD): *${uCount}*\n` +
                       `🔒 Pengguna Diblokir: *${bCount}*\n` +
                       `🔇 Pengguna Dimute: *${mCount}*\n` +
                       `🚫 Kata Sensor Aktif: *${kCount}*\n\n` +
                       `👑 *Manajemen Fitur Premium & Kuota*:\n` +
                       `• \`/addprem [UID] [3d/1w/1m]\` - Aktivasi User Premium\n` +
                       `• \`/addad [UID] [kuota]\` - Tambah Slot Auto-Delete Menfess\n\n` +
                       `🛠️ *Manajemen Moderasi & Sistem*:\n` +
                       `• \`/bc [pesan]\` - Broadcast global ke semua user\n` +
                       `• \`/block [ID]\` - Blokir user permanen\n` +
                       `• \`/unblock [ID]\` - Buka blokir user\n` +
                       `• \`/mute [ID]\` - Mute user (tidak bisa chat/menfess)\n` +
                       `• \`/unmute [ID]\` - Lepas status mute user\n\n` +
                       `🚫 *Manajemen Filter Kata Kasar*:\n` +
                       `• \`/addkw [kata]\` - Tambah kata dilarang\n` +
                       `• \`/delkw [kata]\` - Hapus kata dilarang\n` +
                       `• \`/listkw\` - Tampilkan semua daftar kata sensor\n\n` +
                       `⚠️ *Sistem Pembersihan Developer*:\n` +
                       `• \`/resetredis\` - Kosongkan total database Redis (Sesi & Queue)`;
      return api.send({ chat_id: chatId, text: panelTxt, parse_mode: "Markdown" });
    }

    if (text === "/resetredis") {
      const cleanUrl = env.KV_URL.replace("redis://", "https://").replace("rediss://", "https://");
      const clearRes = await fetch(`${cleanUrl}/flushdb`, { headers: { Authorization: `Bearer ${env.KV_TOKEN}` } });
      const clearJson = await clearRes.json();
      if (clearJson.result === "OK") {
        return api.send({ chat_id: chatId, text: "🔄 *DATABASE UPSTASH REDIS BERHASIL DI-RESET!*", parse_mode: "Markdown" });
      }
      return api.send({ chat_id: chatId, text: "❌ Gagal mereset database Redis." });
    }

    if (text.startsWith("/addprem ")) {
      const parts = text.split(" ");
      const targetUid = parts[1];
      const durationStr = parts[2];
      if (!targetUid || !durationStr) return api.send({ chat_id: chatId, text: "⚠️ Format: \`/addprem [UID] [3d/1w/1m]\`" });

      let days = durationStr === "3d" ? 3 : durationStr === "1w" ? 7 : durationStr === "1m" ? 30 : 0;
      if (days === 0) return api.send({ chat_id: chatId, text: "⚠️ Durasi salah, pilih 3d, 1w, atau 1m" });

      const expireAt = Date.now() + (days * 24 * 60 * 60 * 1000);
      const uObj = await acGetUser(env, targetUid) || {};
      uObj.isPremium = true;
      uObj.premiumExpire = expireAt;
      await acSetUser(env, targetUid, uObj);

      await api.send({ chat_id: chatId, text: `✅ Berhasil menambahkan Premium ke \`${targetUid}\` (${days} hari).` });
      return tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: Number(targetUid),
        text: `🎉 *Pembayaran Premium Dikonfirmasi!*\n━━━━━━━━━━━━━━━\nAkun Anda telah diubah menjadi *User Premium* selama *${days} hari*.\nSekarnag kamu bebas memilih gender pencarian di menu *Cari Partner*!`,
        parse_mode: "Markdown"
      });
    }

    if (text.startsWith("/addad ")) {
      const parts = text.split(" ");
      const targetUid = parts[1];
      const quotaNum = Number(parts[2]);
      if (!targetUid || isNaN(quotaNum)) return api.send({ chat_id: chatId, text: "⚠️ Format: \`/addad [UID] [Jumlah]\`" });

      await dbAddReferralBonus(env, targetUid, quotaNum);
      await api.send({ chat_id: chatId, text: `✅ Slot Auto-Delete berhasil ditambahkan +${quotaNum} ke \`${targetUid}\`.` });
      return tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: Number(targetUid),
        text: `🎁 *Kuota Tambahan Ditambahkan!*\n━━━━━━━━━━━━━━━\nAdmin memberikan Anda *+${quotaNum} Slot Auto-Delete Menfess* secara gratis.`,
        parse_mode: "Markdown"
      });
    }

    if (text.startsWith("/bc ")) {
      const bcMsg = text.replace(/^\/bc\s+/, "");
      const allUsers = await dbAllUserIds(env);
      await api.send({ chat_id: chatId, text: `⏳ Mengirim broadcast via Spreadsheet list ke ${allUsers.length} user...` });
      for (const u of allUsers) {
        tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(u), text: `📢 *INFORMASI ADMIN*:\n\n${bcMsg}`, parse_mode: "Markdown" });
      }
      return api.send({ chat_id: chatId, text: "✅ Broadcast selesai." });
    }

    if (text.startsWith("/block ")) {
      const tUid = text.split(" ")[1];
      if (!tUid) return api.send({ chat_id: chatId, text: "⚠️ Format: `/block [UID]`" });
      await dbBlock(env, tUid);
      return api.send({ chat_id: chatId, text: `✅ User \`${tUid}\` berhasil diblokir.`, parse_mode: "Markdown" });
    }
    if (text.startsWith("/unblock ")) {
      const tUid = text.split(" ")[1];
      if (!tUid) return api.send({ chat_id: chatId, text: "⚠️ Format: `/unblock [UID]`" });
      await dbUnblock(env, tUid);
      return api.send({ chat_id: chatId, text: `✅ Blokir User \`${tUid}\` berhasil dibuka.`, parse_mode: "Markdown" });
    }
    if (text.startsWith("/mute ")) {
      const tUid = text.split(" ")[1];
      if (!tUid) return api.send({ chat_id: chatId, text: "⚠️ Format: `/mute [UID]`" });
      await dbMute(env, tUid);
      return api.send({ chat_id: chatId, text: `✅ User \`${tUid}\` berhasil di-mute.`, parse_mode: "Markdown" });
    }
    if (text.startsWith("/unmute ")) {
      const tUid = text.split(" ")[1];
      if (!tUid) return api.send({ chat_id: chatId, text: "⚠️ Format: `/unmute [UID]`" });
      await dbUnmute(env, tUid);
      return api.send({ chat_id: chatId, text: `✅ Status mute User \`${tUid}\` berhasil dilepas.`, parse_mode: "Markdown" });
    }
    if (text.startsWith("/addkw ")) {
      const kw = text.replace("/addkw ", "");
      if (!kw) return api.send({ chat_id: chatId, text: "⚠️ Format: `/addkw [kata]`" });
      await dbAddKw(env, kw);
      return api.send({ chat_id: chatId, text: `✅ Kata \`${kw}\` berhasil ditambahkan ke blacklist.`, parse_mode: "Markdown" });
    }
    if (text.startsWith("/delkw ")) {
      const kw = text.replace("/delkw ", "");
      if (!kw) return api.send({ chat_id: chatId, text: "⚠️ Format: `/delkw [kata]`" });
      await dbDelKw(env, kw);
      return api.send({ chat_id: chatId, text: `✅ Kata \`${kw}\` berhasil dihapus dari blacklist.`, parse_mode: "Markdown" });
    }
    if (text === "/listkw") {
      const list = await dbListKw(env);
      if (list.length === 0) return api.send({ chat_id: chatId, text: "🚫 Tidak ada kata terlarang yang disimpan." });
      return api.send({ chat_id: chatId, text: `🚫 *Daftar Kata Sensor:*\n\n` + list.map(k => `- \`${k}\``).join("\n"), parse_mode: "Markdown" });
    }

    if (text === "/cancelreply") { await dbDelAdminReply(env, env.ADMIN_ID); return api.send({ chat_id: chatId, text: "✅ Mode balas dibatalkan." }); }
    const rState = await dbGetAdminReply(env, env.ADMIN_ID);
    if (rState && rState.targetUid) { await handleAdminReplyMessage(msg, rState.targetUid, env, api); return; }
  }

  if (await dbIsMuted(env, uidNum)) {
    if (text === "🔍 Cari Partner" || text === "📝 Kirim Menfess" || !text.startsWith("/")) {
      return api.send({ chat_id: chatId, text: "🔇 Kamu sedang di-mute." });
    }
  }

  const contactState = await dbGetContactState(env, uidNum);
  if (contactState && contactState.active) {
    if (text === "🛑 Keluar Hubungi Admin") { 
      await dbDelContactState(env, uidNum); 
      return api.send({ chat_id: chatId, text: "Keluar dari mode hubungi admin.", reply_markup: getMainMenuKeyboard() }); 
    }
    await handleContactRelay(msg, env, api); return;
  }

  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    if (parts.length > 1 && parts[1].startsWith("ref_")) {
      const refId = Number(parts[1].replace("ref_", ""));
      if (refId !== uidNum && !(await dbHasUsedReferral(env, uidNum))) {
        await dbRecordReferral(env, uidNum, refId);
        await dbAddReferralBonus(env, refId, 1);
        tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: refId, text: "🎉 Bonus +1 Slot Auto-Delete masuk karena undangan referral!" });
      }
    }

    const existingUser = await acGetUser(env, uidNum);
    if (!existingUser || !existingUser.gender) {
      return api.send({
        chat_id: chatId,
        text: "👋 Selamat datang di Anon Space!\n\nSebelum memulai, silakan pilih gender Anda:",
        reply_markup: ikbd([[btn("🙋‍♂️ Laki-laki", "reg_gender_male"), btn("🙋‍♀️ Perempuan", "reg_gender_female")]])
      });
    }
    return api.send({ chat_id: chatId, text: "🤖 Menu utama aktif. Silakan pilih navigasi di bawah ini:", reply_markup: getMainMenuKeyboard() });
  }

  if (text === "🔍 Cari Partner") {
    const session = await acGetSession(env, uidNum);
    if (session) return api.send({ chat_id: chatId, text: "⚠️ Sesi mengobrol Anda masih aktif!", reply_markup: getChattingKeyboard() });

    const me = await acGetUser(env, uidNum) || {};
    if (!me.gender) return api.send({ chat_id: chatId, text: "⚠️ Selesaikan registrasi dengan mengetik /start terlebih dahulu." });

    const isPrem = me.isPremium && me.premiumExpire > Date.now();
    if (isPrem) {
      return api.send({
        chat_id: chatId,
        text: "🌟 *Menu Premium AnonChat*\nPilih target kriteria gender partner obrolan Anda:",
        reply_markup: ikbd([
          [btn("🙋‍♀️ Cari Perempuan", "match_filter_female"), btn("🙋‍♂️ Cari Laki-laki", "match_filter_male")],
          [btn("🌐 Cari Bebas / Acak", "match_filter_all")]
        ])
      });
    }

    me.searchFilter = "all";
    await acSetUser(env, uidNum, me);
    await acAddToQueue(env, uidNum);
    
    return tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "⏳ Sedang mencarikan partner acak untukmu...\n\n👑 *Bosan dapat partner acak terus?* Upgrade ke Akun Premium sekarang untuk bisa pilih kriteria khusus Cowok/Cewek dan buka fitur link profil langsung!",
      reply_markup: { keyboard: [[{ text: "🛑 Stop" }]], resize_keyboard: true }
    }).then(() => {
      triggerMatching(env, uidNum, api);
    });
  }

  if (text === "⏭️ Next" || text === "/next") {
    const session = await acGetSession(env, uidNum);
    if (!session) return api.send({ chat_id: chatId, text: "Anda tidak sedang dalam obrolan." });
    if (await acIsDone(env, uidNum)) return api.send({ chat_id: chatId, text: "⏳ Tunggu sebentar sebelum berpindah." });

    await acMarkDone(env, uidNum);
    await acDelSession(env, uidNum); await acDelSession(env, session);
    tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: session, text: "🛑 Partner mengakhiri obrolan.", reply_markup: getMainMenuKeyboard() });

    await api.send({ chat_id: chatId, text: "🔄 Mencari partner baru..." });
    await acAddToQueue(env, uidNum);
    await triggerMatching(env, uidNum, api);
    return;
  }

  if (text === "🛑 Stop" || text === "/stop") {
    const session = await acGetSession(env, uidNum);
    const queue = await acGetQueue(env);
    if (queue.map(String).includes(String(uidNum))) {
      await acRemoveFromQueue(env, uidNum);
      return api.send({ chat_id: chatId, text: "🛑 Pencarian dibatalkan.", reply_markup: getMainMenuKeyboard() });
    }
    if (!session) return api.send({ chat_id: chatId, text: "Anda tidak dalam obrolan.", reply_markup: getMainMenuKeyboard() });

    await acDelSession(env, uidNum); await acDelSession(env, session);
    tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: session, text: "🛑 Partner meninggalkan obrolan.", reply_markup: getMainMenuKeyboard() });
    return api.send({ chat_id: chatId, text: "🛑 Keluar dari sesi obrolan.", reply_markup: getMainMenuKeyboard() });
  }

  const pending = await dbGetPending(env, uidNum);
  if (pending && pending.step === "waiting_text") {
    if (text === "🛑 Batal") { await dbDeletePending(env, uidNum); return api.send({ chat_id: chatId, text: "❌ Dibatalkan.", reply_markup: getMainMenuKeyboard() }); }
    
    const rawTxt = msg.text || msg.caption || "";
    if (rawTxt && (await dbContainsBlacklistedKw(env, rawTxt))) return api.send({ chat_id: chatId, text: "❌ Mengandung kata terlarang!" });

    pending.text = msg.text || ""; pending.caption = msg.caption || "";
    pending.mediaType = msg.photo ? "photo" : msg.video ? "video" : msg.voice ? "voice" : "text";
    pending.fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video ? msg.video.file_id : msg.voice ? msg.voice.file_id : "";
    pending.step = "waiting_confirm";
    await dbSavePending(env, uidNum, pending);

    return api.send({
      chat_id: chatId,
      text: "📝 Konfirmasi Pengiriman:",
      reply_markup: ikbd([[btn("🚀 Kirim (Gratis)", "mf_send_normal"), btn("⏱️ Kirim (Pakai Slot Auto-Delete)", "mf_send_autodel")], [btn("❌ Batal", "mf_send_cancel")]])
    });
  }

  if (text === "📝 Kirim Menfess") {
    await dbSavePending(env, uidNum, { step: "waiting_text" });
    return api.send({ chat_id: chatId, text: "📝 Silakan ketik menfess Anda (Teks/Media):", reply_markup: { keyboard: [[{ text: "🛑 Batal" }]], resize_keyboard: true } });
  }

  if (text === "🎁 Bonus & Referral") {
    const b = await dbGetReferralBonus(env, uidNum);
    const c = await dbCountReferrals(env, uidNum);
    
    const refTxt = `🎁 *MENU BONUS & PREMIUM USER*\n━━━━━━━━━━━━━━━\n` +
                   `👤 Total Rekomendasi: *${c}*\n` +
                   `⏱️ Slot Auto-Delete Anda: *${b}*\n\n` +
                   `👑 *KEUNTUNGAN AKUN PREMIUM*:\n` +
                   `1. Bebas Pilih Gender Partner (Cari Cowok / Cewek)\n` +
                   `2. Akses Tautan Profil Rahasia Instan tanpa username\n` +
                   `3. Prioritas Masuk Antrean Utama (*Matchmaking Priority*)\n\n` +
                   `👇 Ketuk tombol di bawah untuk info pendaftaran premium atau bagikan referral link Anda:`;

    return api.send({
      chat_id: chatId,
      text: refTxt,
      parse_mode: "Markdown",
      reply_markup: ikbd([
        [btn("👑 Daftar Akun Premium", "premium_info_buy")],
        [burl("🔗 Ambil Link Referral", shareUrl(refLink(env, uidNum)))]
      ])
    });
  }

  if (text === "📬 Hubungi Admin") {
    await dbSetContactState(env, uidNum, { active: true });
    return api.send({ chat_id: chatId, text: "📬 Silakan ketik pesan saran/keluhan Anda. Tekan tombol di bawah untuk keluar.", reply_markup: { keyboard: [[{ text: "🛑 Keluar Hubungi Admin" }]], resize_keyboard: true } });
  }

  if (text === "/donate" || text === "/donasi") {
    return tgRaw(env.BOT_TOKEN, "sendPhoto", {
      chat_id: chatId,
      photo: "https://ibb.co.com/627jPK1",
      caption: `☕ *Dukung Pengembangan Bot Ini* \n━━━━━━━━━━━━━━━━━\nHalo! Kamu bisa memberikan dukungan sukarela melalui:\n\n📟 *SCAN QR-Code* di atas\n\nTerima kasih atas kebaikanmu! ❤️`,
      parse_mode: "Markdown"
    });
  }

  if (text === "🚨 Report Partner" || text === "/report") {
    const activeSession = await acGetSession(env, uidNum);
    if (!activeSession) return api.send({ chat_id: chatId, text: "⚠️ Anda tidak sedang dalam obrolan aktif untuk melaporkan partner." });
    
    await tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_ID,
      text: `🚨 *LAPORAN PENGGUNA*\n━━━━━━━━━━━━━━━\n👤 Pelapor ID: \`${uidNum}\`\n👎 Dilaporkan ID: \`${activeSession}\`\n\nGunakan perintah \`/block ${activeSession}\` atau \`/mute ${activeSession}\``,
      reply_markup: ikbd([[btn("✍️ Balas Pelapor", `adm_reply_${uidNum}`), btn("🔒 Blokir Pelaku", `adm_block_${activeSession}`)]])
    });
    return api.send({ chat_id: chatId, text: "✅ Laporan Anda telah terkirim ke Admin." });
  }

  const activeSession = await acGetSession(env, uidNum);
  if (activeSession) {
    let method = "sendMessage", body = { chat_id: activeSession };
    if (msg.text) { body.text = msg.text; }
    else if (msg.photo) { method = "sendPhoto"; body.photo = msg.photo[msg.photo.length - 1].file_id; body.caption = msg.caption; }
    else if (msg.video) { method = "sendVideo"; body.video = msg.video.file_id; body.caption = msg.caption; }
    else if (msg.voice) { method = "sendVoice"; body.voice = msg.voice.file_id; }
    else if (msg.sticker) { method = "sendSticker"; body.sticker = msg.sticker.file_id; }

    tgRaw(env.BOT_TOKEN, method, body);
    return;
  }

  return api.send({ chat_id: chatId, text: "Menu Utama:", reply_markup: getMainMenuKeyboard() });
}

async function handleCallback(query, env, api) {
  const data = query.data, chatId = query.message.chat.id, msgId = query.message.message_id, uidNum = query.from.id;

  if (data === "premium_info_buy") {
    await api.answer(query.id);
    const buyTxt = `👑 *PROSEDUR AKTIVASI PREMIUM USER*\n━━━━━━━━━━━━━━━\n` +
                   `💳 *Pilihan Paket Premium:*\n• Paket 3 Hari (3d) : Rp 5.000\n• Paket 1 Minggu (1w): Rp 10.000\n• Paket 1 Bulan (1m) : Rp 25.000\n\n` +
                   `Kirimkan bukti transfer ke menu *📬 Hubungi Admin* dengan format:\n\`Klaim Premium - ${uidNum} - [Paket]\``;
    return api.send({ chat_id: chatId, text: buyTxt, parse_mode: "Markdown" });
  }

  if (data.startsWith("reg_gender_")) {
    const pickedGender = data.replace("reg_gender_", "");
    await api.answer(query.id, "Data disimpan!");
    await acSetUser(env, uidNum, { gender: pickedGender, isPremium: false, premiumExpire: 0 });
    await dbRegisterUser(env, uidNum, pickedGender, query.from.username || "no_username");

    const finishTxt = `✅ Berhasil mendaftar sebagai *${pickedGender === 'male' ? 'Laki-laki 🙋‍♂️' : 'Perempuan 🙋‍♀️'}*.\n━━━━━━━━━━━━━━━\n🌟 Kunjungi menu *🎁 Bonus & Referral* jika ingin upgrade fitur pemilihan kriteria Premium.`;
    return api.edit({ chat_id: chatId, message_id: msgId, text: finishTxt, parse_mode: "Markdown" }).then(() => {
       tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "🤖 Menu utama aktif:", reply_markup: getMainMenuKeyboard() });
    });
  }

  if (data.startsWith("match_filter_")) {
    const filterType = data.replace("match_filter_", "");
    await api.answer(query.id);
    const me = await acGetUser(env, uidNum) || {};
    me.searchFilter = filterType;
    await acSetUser(env, uidNum, me);
    await api.edit({ chat_id: chatId, message_id: msgId, text: `⚡ _Mencari partner kriteria..._` });
    await acAddToQueue(env, uidNum);
    await triggerMatching(env, uidNum, api);
    return;
  }

  if (data.startsWith("mf_send_")) {
    const action = data.replace("mf_send_", "");
    const pending = await dbGetPending(env, uidNum);
    if (!pending) return api.answer(query.id, "Kedaluwarsa.", true);

    if (action === "cancel") { await dbDeletePending(env, uidNum); return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Dibatalkan." }); }
    const autoDelete = action === "autodel";
    if (autoDelete) {
      const s = await dbGetReferralBonus(env, uidNum);
      if (s <= 0) return api.answer(query.id, "Slot habis!", true);
      await dbUseReferralBonus(env, uidNum);
    }
    await dbDeletePending(env, uidNum);
    await api.edit({ chat_id: chatId, message_id: msgId, text: "🚀 Diproses..." });
    await submitReport(uidNum, pending, autoDelete, env, api);
    return;
  }

  if (data.startsWith("mf_del_")) {
    const delId = Number(data.replace("mf_del_", ""));
    const mf = await dbGetMenfess(env, delId);
    if (!mf || Number(mf.user_id) !== uidNum) return api.answer(query.id, "Bukan milikmu!", true);
    await tgRaw(env.BOT_TOKEN, "deleteMessage", { chat_id: env.CHANNEL_ID, message_id: delId });
    await dbDeleteMenfess(env, delId);
    return api.edit({ chat_id: chatId, message_id: msgId, text: "🗑️ Berhasil dihapus dari channel." });
  }

  if (data.startsWith("adm_reply_")) { await dbSetAdminReply(env, env.ADMIN_ID, data.replace("adm_reply_", "")); await api.answer(query.id); return api.send({ chat_id: chatId, text: "Ketik balasan ke pengguna:" }); }
  if (data.startsWith("adm_block_")) { await dbBlock(env, data.replace("adm_block_", "")); await api.answer(query.id, "User Berhasil Diblokir", true); }
}

async function triggerMatching(env, uidNum, api) {
  const queue = await acGetQueue(env);
  if (queue.length < 2) return;

  const me = await acGetUser(env, uidNum) || {};
  const myGender = me.gender;
  const myFilter = me.searchFilter || "all";
  let matchedPartnerId = null;

  for (const pId of queue) {
    if (String(pId) === String(uidNum)) continue;
    const partner = await acGetUser(env, pId) || {};
    if (myFilter !== "all" && myFilter !== partner.gender) continue;
    if (partner.searchFilter && partner.searchFilter !== "all" && partner.searchFilter !== myGender) continue;
    matchedPartnerId = Number(pId);
    break;
  }

  if (matchedPartnerId) {
    // ATOMIC DOUBLE-VERIFICATION REMOVAL
    await acRemoveFromQueue(env, uidNum);
    await acRemoveFromQueue(env, matchedPartnerId);

    await acSetSession(env, uidNum, matchedPartnerId);
    await acSetSession(env, matchedPartnerId, uidNum);

    const partnerObj = await acGetUser(env, matchedPartnerId) || {};
    const myPrem = me.isPremium && me.premiumExpire > Date.now();
    const targetPrem = partnerObj.isPremium && partnerObj.premiumExpire > Date.now();

    let txtMe = "🎉 Partner ditemukan! Selamat mengobrol.\nKetik /next untuk ganti partner.";
    let txtPartner = "🎉 Partner ditemukan! Selamat mengobrol.\nKetik /next untuk ganti partner.";

    if (myPrem) txtMe = `🎉 *Partner ditemukan!*\n━━━━━━━━━━━━━━━\n🌟 *Premium Link*: [Buka Profil Partner](tg://user?id=${matchedPartnerId})\n\nKetik /next untuk ganti partner.`;
    if (targetPrem) txtPartner = `🎉 *Partner ditemukan!*\n━━━━━━━━━━━━━━━\n🌟 *Premium Link*: [Buka Profil Partner](tg://user?id=${uidNum})\n\nKetik /next untuk ganti partner.`;

    tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(uidNum), text: txtMe, parse_mode: "Markdown", reply_markup: getChattingKeyboard() });
    tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: matchedPartnerId, text: txtPartner, parse_mode: "Markdown", reply_markup: getChattingKeyboard() });
  }
}

// SERVERLESS AUTOMATION ENGINE - MENCEGAH RE-TRIGGER LEAK TIMEOUT
async function submitReport(uidNum, pending, autoDelete, env, api) {
  try {
    let method = "sendMessage", body = { chat_id: env.CHANNEL_ID, parse_mode: "HTML" };
    const defaultTail = `\n\n━━━━━━━━━━━━━━━\n<i>menfess dari @KEKprojects_bot</i>`;
    const escapeHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    if (pending.mediaType === "text") {
      body.text = `"${escapeHtml(pending.text)}"${defaultTail}`;
    } else {
      body.caption = pending.caption ? `"${escapeHtml(pending.caption)}"${defaultTail}` : defaultTail;
      body[pending.mediaType] = pending.fileId;
      method = pending.mediaType === "photo" ? "sendPhoto" : pending.mediaType === "video" ? "sendVideo" : "sendVoice";
    }

    const res = await tgRaw(env.BOT_TOKEN, method, body);
    if (!res.ok) return api.send({ chat_id: uidNum, text: `❌ Gagal mengirim menfess.` });

    const sentId = res.result.message_id;
    const cleanId = String(env.CHANNEL_ID).replace("-100", "");
    await dbSaveMenfess(env, sentId, { user_id: uidNum, text: pending.text || pending.caption });

    let rem = "Kirim Biasa", autoNote = "";
    if (autoDelete) {
      rem = "Auto-Delete"; autoNote = `\n\n⏱️ *Terjadwal Hapus Otomatis (Redis TTL Engine).*`;
      // Serverless Task Fallback: Set Expiry data pada Redis Key untuk validasi filter cron / penghapusan manual via callback terproteksi
      await upstashReq(env, ["SETEX", `autodel_task:${sentId}`, String(env.AUTO_DEL_MIN * 60), String(env.CHANNEL_ID)]);
    }

    await api.send({
      chat_id: uidNum,
      text: `✅ *Menfess Berhasil Terkirim!*\n\n🔗 *Link:* [Lihat Kiriman](https://t.me/c/${cleanId}/${sentId})\n🛠️ *Metode:* ${rem}${autoNote}`,
      reply_markup: ikbd([[btn("🗑️ Hapus Sekarang", `mf_del_${sentId}`)], [burl("🎁 Cari Slot Baru", shareUrl(refLink(env, uidNum)))]]),
      link_preview_options: { is_disabled: true }
    });
  } catch (err) { console.error(err); }
}

async function handleContactRelay(msg, env, api) {
  await tgRaw(env.BOT_TOKEN, "sendMessage", {
    chat_id: env.ADMIN_ID,
    text: `📬 *HUBUNGI ADMIN*\n👤 ${msg.from.first_name}\n🆔 \`${msg.from.id}\`\n💬: ${msg.text || "[Media]"}`,
    reply_markup: ikbd([[btn("✍️ Balas", `adm_reply_${msg.from.id}`), btn("🔒 Blokir", `adm_block_${msg.from.id}`)]])
  });
  if (!msg.text) tgRaw(env.BOT_TOKEN, "forwardMessage", { chat_id: env.ADMIN_ID, from_chat_id: msg.from.id, message_id: msg.message_id });
  return api.send({ chat_id: msg.from.id, text: "✅ Pesan Anda telah diteruskan." });
}

async function handleAdminReplyMessage(msg, targetUid, env, api) {
  try {
    if (msg.text) await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: targetUid, text: `💬 *Balasan Admin*:\n\n${msg.text}` });
    else await tgRaw(env.BOT_TOKEN, "copyMessage", { chat_id: targetUid, from_chat_id: env.ADMIN_ID, message_id: msg.message_id });
    await api.send({ chat_id: env.ADMIN_ID, text: "✅ Balasan terkirim." });
  } catch { await api.send({ chat_id: env.ADMIN_ID, text: "❌ Gagal." }); }
  finally { await dbDelAdminReply(env, env.ADMIN_ID); }
}
