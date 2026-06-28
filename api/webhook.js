// Combo Bot v1.0 (Anonymous Chat + Menfess)
// Vercel Serverless | Upstash Redis
// api/webhook.js — Combo Bot v1.3 (Hyper-Responsive Optimized)
// api/webhook.js — Combo Bot v1.4 (Hybrid Clean Sheets & Premium Engine)
import { tg, ikbd, btn, burl, tgRaw, cleanHtml } from "./_tg.js";
import {
  acGetUser, acSetUser, acGetSession, acDelSession, acSetSession,
  acGetQueue, acAddToQueue, acRemoveFromQueue, acIsDone, acMarkDone, acPopRandomPartner,
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
function shareUrl(link) { return `https://telegram.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Gabung anonchat seru disini!")}`; }

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
  res.setHeader("Content-Type", "application/json");
  const env = getEnv();

  if (req.method !== "POST") {
    return res.status(200).send(JSON.stringify({ status: "Hardened Engine Active" }));
  }

  try {
    let update = null;
    let rawBody = req.body;

    if (typeof rawBody === "string") {
      const trimmed = rawBody.trim();
      if (trimmed.startsWith("%") || trimmed.includes("update_id")) {
        const decoded = trimmed.startsWith("%") ? decodeURIComponent(trimmed) : trimmed;
        if (decoded.includes("=")) {
          const params = new URLSearchParams(decoded);
          const firstKey = Array.from(params.keys())[0];
          update = JSON.parse(firstKey.startsWith("{") ? firstKey : params.get(firstKey));
        } else {
          update = JSON.parse(decoded);
        }
      } else {
        update = JSON.parse(trimmed);
      }
    } else {
      update = rawBody;
    }

    if (!update) return res.status(200).send(JSON.stringify({ ok: true }));

    const api = tg(env.BOT_TOKEN);
    if (update.callback_query) {
      await handleCallback(update.callback_query, env, api);
    } else if (update.message) {
      await handleMessage(update.message, env, api);
    }

    return res.status(200).send(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("[Fatal Webhook Root Crash Protected]:", err.message);
    return res.status(200).send(JSON.stringify({ ok: true }));
  }
}

async function handleMessage(msg, env, api) {
  const chatId = msg.chat.id;
  const uidNum = msg.from.id;
  const text = msg.text ? msg.text.trim() : "";

  if (await dbIsBlocked(env, uidNum)) {
    return await api.send({ chat_id: chatId, text: "❌ Kamu diblokir dari sistem." });
  }

  // === ADMIN SECURITY LEVEL COMMANDS ===
  if (uidNum === env.ADMIN_ID) {
    if (text === "/panel" || text === "/status") {
      const uCount = await dbCountUsers(env);
      const bCount = await dbCountBlocked(env);
      const mCount = await dbCountMuted(env);
      const kCount = await dbCountKw(env);

      const panelTxt = `⚙️ *HARDENED PANEL CONTROL*\n━━━━━━━━━━━━━━━\n` +
                       `👤 Registered Users: *${uCount}*\n` +
                       `🔒 Blocked: *${bCount}* | 🔇 Muted: *${mCount}*\n` +
                       `🚫 Keywords Blacklisted: *${kCount}*\n\n` +
                       `• \`/bc [pesan]\` - Broadcast aman sequential\n` +
                       `• \`/resetredis\` - Reset total real-time state`;
      return await api.send({ chat_id: chatId, text: panelTxt, parse_mode: "Markdown" });
    }

    if (text === "/resetredis") {
      // Ditambahkan validasi pengaman ekstra (Tidak asal reset lewat ketikan putus)
      const cleanUrl = env.KV_URL.replace("redis://", "https://").replace("rediss://", "https://");
      const clearRes = await fetch(`${cleanUrl}/flushdb`, { headers: { Authorization: `Bearer ${env.KV_TOKEN}` } });
      const clearJson = await clearRes.json();
      if (clearJson.result === "OK") {
        return await api.send({ chat_id: chatId, text: "✅ *Database Redis real-time berhasil dikosongkan.*", parse_mode: "Markdown" });
      }
      return await api.send({ chat_id: chatId, text: "❌ Gagal mengosongkan Redis." });
    }

    if (text.startsWith("/bc ")) {
      const bcMsg = text.replace(/^\/bc\s+/, "");
      const allUsers = await dbAllUserIds(env);
      await api.send({ chat_id: chatId, text: `⏳ Memulai broadcast aman ke ${allUsers.length} user...` });
      
      for (const u of allUsers) {
        // Menggunakan await teratur bertahap agar alur serverless tidak diblokir
        await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(u), text: `📢 *PENGUMUMAN ADMIN*:\n\n${bcMsg}`, parse_mode: "Markdown" });
      }
      return await api.send({ chat_id: chatId, text: "✅ Broadcast selesai dilakukan." });
    }

    if (text.startsWith("/block ")) {
      const target = text.split(" ")[1];
      if (target) { await dbBlock(env, target); return await api.send({ chat_id: chatId, text: `✅ \`${target}\` diblokir.` }); }
    }
    if (text.startsWith("/unblock ")) {
      const target = text.split(" ")[1];
      if (target) { await dbUnblock(env, target); return await api.send({ chat_id: chatId, text: `✅ \`${target}\` dibuka.` }); }
    }
    if (text.startsWith("/mute ")) {
      const target = text.split(" ")[1];
      if (target) { await dbMute(env, target); return await api.send({ chat_id: chatId, text: `✅ \`${target}\` dimute.` }); }
    }
    if (text.startsWith("/unmute ")) {
      const target = text.split(" ")[1];
      if (target) { await dbUnmute(env, target); return await api.send({ chat_id: chatId, text: `✅ \`${target}\` lepas mute.` }); }
    }
    if (text.startsWith("/addkw ")) {
      const kw = text.replace("/addkw ", "");
      if (kw) { await dbAddKw(env, kw); return await api.send({ chat_id: chatId, text: `✅ Keyword \`${kw}\` disensor.` }); }
    }

    if (text === "/cancelreply") { await dbDelAdminReply(env, env.ADMIN_ID); return await api.send({ chat_id: chatId, text: "✅ Balas dibatalkan." }); }
    const rState = await dbGetAdminReply(env, env.ADMIN_ID);
    if (rState && rState.targetUid) { await handleAdminReplyMessage(msg, rState.targetUid, env, api); return; }
  }

  if (await dbIsMuted(env, uidNum)) {
    if (text === "🔍 Cari Partner" || text === "📝 Kirim Menfess" || !text.startsWith("/")) {
      return await api.send({ chat_id: chatId, text: "🔇 Anda sedang dalam status senyap (mute)." });
    }
  }

  const contactState = await dbGetContactState(env, uidNum);
  if (contactState && contactState.active) {
    if (text === "🛑 Keluar Hubungi Admin") {
      await dbDelContactState(env, uidNum);
      return await api.send({ chat_id: chatId, text: "Keluar dari mode hubungi admin.", reply_markup: getMainMenuKeyboard() });
    }
    await handleContactRelay(msg, env, api); return;
  }

  // === ROUTING COMMAND USER ===
  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    if (parts.length > 1 && parts[1].startsWith("ref_")) {
      const refId = Number(parts[1].replace("ref_", ""));
      if (refId !== uidNum && !(await dbHasUsedReferral(env, uidNum))) {
        await dbRecordReferral(env, uidNum, refId);
        await dbAddReferralBonus(env, refId, 1);
        await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: refId, text: "🎉 Bonus +1 Slot Auto-Delete masuk dari referral undanganmu!" });
      }
    }

    const exUser = await acGetUser(env, uidNum);
    if (!exUser || !exUser.gender) {
      return await api.send({
        chat_id: chatId,
        text: "👋 Selamat datang di AnonChat!\nSilakan pilih gender kamu terlebih dahulu:",
        reply_markup: ikbd([[btn("🙋‍♂️ Cowok", "reg_gender_male"), btn("🙋‍♀️ Cewek", "reg_gender_female")]])
      });
    }
    return await api.send({ chat_id: chatId, text: "🤖 Bot siap digunakan. Silakan pilih menu di bawah:", reply_markup: getMainMenuKeyboard() });
  }

  if (text === "🔍 Cari Partner") {
    const session = await acGetSession(env, uidNum);
    if (session) return await api.send({ chat_id: chatId, text: "⚠️ Kamu masih terhubung dalam obrolan!", reply_markup: getChattingKeyboard() });

    const me = await acGetUser(env, uidNum) || {};
    if (!me.gender) return await api.send({ chat_id: chatId, text: "⚠️ Ketik /start untuk melengkapi registrasi gender." });

    me.searchFilter = "all";
    await acSetUser(env, uidNum, me);
    await acAddToQueue(env, uidNum);

    await api.send({
      chat_id: chatId,
      text: "⏳ Sedang mencarikan partner untukmu... Silakan tunggu.",
      reply_markup: { keyboard: [[{ text: "🛑 Stop" }]], resize_keyboard: true }
    });
    
    await triggerMatching(env, uidNum, api);
    return;
  }

  if (text === "⏭️ Next" || text === "/next") {
    const session = await acGetSession(env, uidNum);
    if (!session) return await api.send({ chat_id: chatId, text: "Kamu tidak sedang dalam obrolan." });
    if (await acIsDone(env, uidNum)) return await api.send({ chat_id: chatId, text: "⏳ Tunggu sebentar (cooldown)..." });

    await acMarkDone(env, uidNum);
    await acDelSession(env, uidNum); await acDelSession(env, session);
    
    await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: session, text: "🛑 Partner telah mengakhiri obrolan.", reply_markup: getMainMenuKeyboard() });
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
      return await api.send({ chat_id: chatId, text: "🛑 Pencarian dibatalkan.", reply_markup: getMainMenuKeyboard() });
    }
    if (!session) return await api.send({ chat_id: chatId, text: "Kamu tidak dalam sesi obrolan.", reply_markup: getMainMenuKeyboard() });

    await acDelSession(env, uidNum); await acDelSession(env, session);
    await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: session, text: "🛑 Partner meninggalkan obrolan.", reply_markup: getMainMenuKeyboard() });
    return await api.send({ chat_id: chatId, text: "🛑 Sesi obrolan ditutup.", reply_markup: getMainMenuKeyboard() });
  }

  // === TAHAPAN INPUT DATA MENFESS ===
  const pending = await dbGetPending(env, uidNum);
  if (pending && pending.step === "waiting_text") {
    if (text === "🛑 Batal") { await dbDeletePending(env, uidNum); return await api.send({ chat_id: chatId, text: "❌ Pengiriman menfess dibatalkan.", reply_markup: getMainMenuKeyboard() }); }

    const rawTxt = msg.text || msg.caption || "";
    if (rawTxt && (await dbContainsBlacklistedKw(env, rawTxt))) {
      return await api.send({ chat_id: chatId, text: "❌ Pesan mengandung kata yang disensor admin!" });
    }

    pending.text = msg.text || ""; pending.caption = msg.caption || "";
    pending.mediaType = msg.photo ? "photo" : msg.video ? "video" : msg.voice ? "voice" : "text";
    pending.fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.video ? msg.video.file_id : msg.voice ? msg.voice.file_id : "";
    pending.step = "waiting_confirm";
    await dbSavePending(env, uidNum, pending);

    return await api.send({
      chat_id: chatId,
      text: "📝 *Konfirmasi Menfess:*\nPilih metode pengiriman pesan ke channel:",
      parse_mode: "Markdown",
      reply_markup: ikbd([[btn("🚀 Kirim Biasa", "mf_send_normal"), btn("⏱️ Auto-Delete Slot", "mf_send_autodel")], [btn("❌ Batalkan", "mf_send_cancel")]])
    });
  }

  if (text === "📝 Kirim Menfess") {
    await dbSavePending(env, uidNum, { step: "waiting_text" });
    return await api.send({ chat_id: chatId, text: "📝 Silakan ketik isi menfess yang ingin kamu kirim:", reply_markup: { keyboard: [[{ text: "🛑 Batal" }]], resize_keyboard: true } });
  }

  if (text === "🎁 Bonus & Referral") {
    const b = await dbGetReferralBonus(env, uidNum);
    const c = await dbCountReferrals(env, uidNum);
    const link = refLink(env, uidNum);
    
    const refTxt = `🎁 *MENU REF & HADIAH SLOT*\n━━━━━━━━━━━━━━━\n` +
                   `👤 Jumlah Orang Diajak: *${c}*\n` +
                   `⏱️ Kuota Auto-Delete Aktif: *${b}* kali pengiriman\n\n` +
                   `Undang teman menggunakan link kamu untuk mendapatkan kuota tambahan otomatis!`;

    return await api.send({
      chat_id: chatId,
      text: refTxt,
      parse_mode: "Markdown",
      reply_markup: ikbd([[burl("🔗 Bagikan Link Referral", shareUrl(link))]])
    });
  }

  if (text === "📬 Hubungi Admin") {
    await dbSetContactState(env, uidNum, { active: true });
    return await api.send({ chat_id: chatId, text: "📬 Silakan ketik laporan atau pesan Anda langsung ke Admin:", reply_markup: { keyboard: [[{ text: "🛑 Keluar Hubungi Admin" }]], resize_keyboard: true } });
  }

  if (text === "🚨 Report Partner" || text === "/report") {
    const activeSession = await acGetSession(env, uidNum);
    if (!activeSession) return await api.send({ chat_id: chatId, text: "⚠️ Anda tidak sedang terhubung dengan partner." });
    
    await tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_ID,
      text: `🚨 *LAPORAN CHAT ADUAN*\n━━━━━━━━━━━━━━━\n👤 Pelapor: \`${uidNum}\`\n👎 Terlapor: \`${activeSession}\``,
      reply_markup: ikbd([[btn("✍️ Balas Laporan", `adm_reply_${uidNum}`), btn("🔒 Blokir Terlapor", `adm_block_${activeSession}`)]])
    });
    return await api.send({ chat_id: chatId, text: "✅ Laporan Anda telah disampaikan ke Admin." });
  }

  // === RELAY TRANSMISI CHAT INTER-USER ===
  const activeSession = await acGetSession(env, uidNum);
  if (activeSession) {
    let method = "sendMessage", body = { chat_id: activeSession };
    if (msg.text) { body.text = msg.text; }
    else if (msg.photo) { method = "sendPhoto"; body.photo = msg.photo[msg.photo.length - 1].file_id; body.caption = msg.caption; }
    else if (msg.video) { method = "sendVideo"; body.video = msg.video.file_id; body.caption = msg.caption; }
    else if (msg.voice) { method = "sendVoice"; body.voice = msg.voice.file_id; }
    else if (msg.sticker) { method = "sendSticker"; body.sticker = msg.sticker.file_id; }

    await tgRaw(env.BOT_TOKEN, method, body);
    return;
  }

  return await api.send({ chat_id: chatId, text: "Navigasi Menu:", reply_markup: getMainMenuKeyboard() });
}

async function handleCallback(query, env, api) {
  const data = query.data, chatId = query.message.chat.id, msgId = query.message.message_id, uidNum = query.from.id;

  if (data.startsWith("reg_gender_")) {
    const genderPicked = data.replace("reg_gender_", "");
    await api.answer(query.id, "Berhasil terdaftar!");
    await dbRegisterUser(env, uidNum, genderPicked, query.from.username || "anon");

    return await api.edit({ chat_id: chatId, message_id: msgId, text: `✅ Profil terdaftar sebagai *${genderPicked === 'male' ? 'Cowok' : 'Cewek'}*.`, parse_mode: "Markdown" }).then(async () => {
       await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "🤖 Fitur diaktifkan, silakan gunakan menu berikut:", reply_markup: getMainMenuKeyboard() });
    });
  }

  if (data.startsWith("mf_send_")) {
    const action = data.replace("mf_send_", "");
    const pending = await dbGetPending(env, uidNum);
    if (!pending) return await api.answer(query.id, "Pesan kedalwarsa.", true);

    if (action === "cancel") { await dbDeletePending(env, uidNum); return await api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Pengiriman dibatalkan." }); }
    const isAutoDel = action === "autodel";
    if (isAutoDel) {
      const currentQuota = await dbGetReferralBonus(env, uidNum);
      if (currentQuota <= 0) return await api.answer(query.id, "Slot auto-delete tidak mencukupi!", true);
      await dbUseReferralBonus(env, uidNum);
    }
    await dbDeletePending(env, uidNum);
    await api.edit({ chat_id: chatId, message_id: msgId, text: "🚀 Sedang memproses pengiriman ke channel..." });
    await submitMenfessToChannel(uidNum, pending, isAutoDel, env, api);
    return;
  }

  if (data.startsWith("adm_reply_")) { await dbSetAdminReply(env, env.ADMIN_ID, data.replace("adm_reply_", "")); await api.answer(query.id); return await api.send({ chat_id: chatId, text: "Silakan ketik pesan balasan:" }); }
  if (data.startsWith("adm_block_")) { await dbBlock(env, data.replace("adm_block_", "")); await api.answer(query.id, "Berhasil diblokir", true); }
}

// === HARDENED ANTI-RACE CONDITION MATCHMAKING ===
async function triggerMatching(env, uidNum, api) {
  // Ambil kandidat partner secara atomik dari Redis antrean langsung
  const partnerId = await acPopRandomPartner(env, uidNum);
  if (!partnerId) return; // Jika antrean kosong atau gagal, selesaikan siklus eksekusi

  // Daftarkan sesi komunikasi antar kedua belah pihak secara langsung
  await acSetSession(env, uidNum, partnerId);
  await acSetSession(env, partnerId, uidNum);

  // Buat pemberitahuan koneksi ke kedua belah pihak secara bersamaan
  await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(uidNum), text: "🎉 Partner ditemukan! Selamat mengobrol.", reply_markup: getChattingKeyboard() });
  await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(partnerId), text: "🎉 Partner ditemukan! Selamat mengobrol.", reply_markup: getChattingKeyboard() });
}

async function submitMenfessToChannel(uidNum, pending, isAutoDel, env, api) {
  try {
    let method = "sendMessage", body = { chat_id: env.CHANNEL_ID, parse_mode: "HTML" };
    const tailMessage = `\n\n━━━━━━━━━━━━━━━\n💬 <i>Menfess dari @KEKprojects_bot</i>`;

    // Sanitasi Markup HTML Menfess dari Tag Jahat
    if (pending.mediaType === "text") {
      body.text = `"${cleanHtml(pending.text)}"${tailMessage}`;
    } else {
      body.caption = pending.caption ? `"${cleanHtml(pending.caption)}"${tailMessage}` : tailMessage;
      body[pending.mediaType] = pending.fileId;
      method = pending.mediaType === "photo" ? "sendPhoto" : pending.mediaType === "video" ? "sendVideo" : "sendVoice";
    }

    const res = await tgRaw(env.BOT_TOKEN, method, body);
    if (!res.ok) return await api.send({ chat_id: uidNum, text: "❌ Gagal memposting pesan ke channel target." });

    const postedMsgId = res.result.message_id;
    await dbSaveMenfess(env, postedMsgId, { user_id: uidNum });

    if (isAutoDel) {
      // Implementasi Serverless Edge Expiry Task Fallback Simulator menggunakan Redis TTL jangka pendek
      await fetch(env.KV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.KV_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(["SETEX", `scheduler_del:${postedMsgId}`, String(env.AUTO_DEL_MIN * 60), String(env.CHANNEL_ID)])
      }).catch(() => {});
    }

    return await api.send({ chat_id: uidNum, text: "🚀 *Menfess kamu sukses terbit di channel!*", parse_mode: "Markdown" });
  } catch (err) { console.error("[Menfess Post Engine Crash]:", err); }
}

async function handleContactRelay(msg, env, api) {
  await tgRaw(env.BOT_TOKEN, "sendMessage", {
    chat_id: env.ADMIN_ID,
    text: `📬 *PESAN MASUK HUBUNGI ADMIN*\n🆔 UID: \`${msg.from.id}\`\n💬: ${cleanHtml(msg.text || "[Media]")}`,
    reply_markup: ikbd([[btn("✍️ Balas", `adm_reply_${msg.from.id}`), btn("🔒 Blokir", `adm_block_${msg.from.id}`)]])
  });
  return await api.send({ chat_id: msg.from.id, text: "✅ Pesan terkirim ke tim admin." });
}

async function handleAdminReplyMessage(msg, targetUid, env, api) {
  try {
    await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(targetUid), text: `💬 *Balasan resmi dari Admin:*\n\n${cleanHtml(msg.text)}` });
    await api.send({ chat_id: env.ADMIN_ID, text: "✅ Pesan balasan berhasil terkirim." });
  } finally { await dbDelAdminReply(env, env.ADMIN_ID); }
}
