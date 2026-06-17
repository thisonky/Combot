// ================================================================
// FITUR REPORT & CONTACT ADMIN
// Tambahkan kode ini ke webhook.js yang sudah ada
// ================================================================
//
// ADA 2 FITUR:
//
// 1. /report  — Laporkan partner saat sedang anon chat
//               User pilih alasan → laporan masuk ke admin
//
// 2. /contact — Hubungi admin langsung lewat bot
//               Semua pesan diteruskan ke admin (2 arah)
//               Admin bisa balas dan user terima balasannya
//
// ================================================================
//
// CARA INTEGRASI:
//
// LANGKAH 1 — Tambah di _db.js (bagian paling bawah):
//   Salin semua fungsi dari blok "=== TAMBAH KE _db.js ==="
//
// LANGKAH 2 — Tambah di webhook.js:
//   a. Import fungsi DB baru di bagian import _db.js
//   b. Tambah handler /report dan /contact di handleMessage
//   c. Tambah case callback di handleCallback
//   d. Salin fungsi-fungsi handler dari blok "=== TAMBAH KE webhook.js ==="
//
// LANGKAH 3 — Update keyboard menu:
//   Tambah tombol "🚨 Report" dan "📬 Hubungi Admin"
//
// ================================================================




// ════════════════════════════════════════════════════════════════
// === TAMBAH KE _db.js (bagian paling bawah file) ===
// ════════════════════════════════════════════════════════════════

/*

// ── Contact Admin Session ──────────────────────
// Menyimpan state user yang sedang dalam mode contact admin
// contact_state:{uid} → { mode: "contact", startedAt }

export async function dbGetContactState(env, uid) {
  return redisGet(env, `contact_state:${uid}`);
}

export async function dbSetContactState(env, uid, data) {
  // Simpan selama 24 jam
  await redisSet(env, `contact_state:${uid}`, data, 86400);
}

export async function dbDelContactState(env, uid) {
  await redisDel(env, `contact_state:${uid}`);
}

// ── Admin Reply Session ────────────────────────
// Saat admin mau reply ke user tertentu
// admin_reply:{adminId} → { targetUid }

export async function dbGetAdminReply(env, adminId) {
  return redisGet(env, `admin_reply:${adminId}`);
}

export async function dbSetAdminReply(env, adminId, targetUid) {
  await redisSet(env, `admin_reply:${adminId}`, { targetUid }, 3600);
}

export async function dbDelAdminReply(env, adminId) {
  await redisDel(env, `admin_reply:${adminId}`);
}

*/




// ════════════════════════════════════════════════════════════════
// === TAMBAH KE webhook.js ===
// ════════════════════════════════════════════════════════════════


// ── LANGKAH 2a: Import baru ──────────────────────────────────
// Tambahkan baris ini ke bagian import dari _db.js yang sudah ada:
//
//   dbGetContactState, dbSetContactState, dbDelContactState,
//   dbGetAdminReply, dbSetAdminReply, dbDelAdminReply,


// ── LANGKAH 2b: Tambah di handleMessage ─────────────────────
// Tambahkan SEBELUM baris "// ── Default ───" di handleMessage:
//
//   if (textLow === "/report")  return handleReport(userId, uidNum, chatId, env, api);
//   if (textLow === "/contact") return handleContact(userId, uidNum, chatId, env, api);
//   if (text === "🚨 Report Partner")   return handleReport(userId, uidNum, chatId, env, api);
//   if (text === "📬 Hubungi Admin")    return handleContact(userId, uidNum, chatId, env, api);
//
// Tambahkan SEBELUM baris "// ── Default ───" juga:
//   const contactState = await dbGetContactState(env, userId);
//   if (contactState?.mode === "contact") {
//     return handleContactRelay(msg, userId, uidNum, chatId, env, api);
//   }
//
// Untuk admin, tambahkan SEBELUM "// ── PRIORITAS 5: menfess trigger":
//   if (uidNum === env.ADMIN_ID) {
//     const adminReply = await dbGetAdminReply(env, env.ADMIN_ID);
//     if (adminReply?.targetUid) {
//       return handleAdminReplyRelay(msg, chatId, adminReply.targetUid, env, api);
//     }
//   }


// ── LANGKAH 2c: Tambah di handleCallback ────────────────────
// Tambahkan SEBELUM baris "await api.answer(query.id);" di paling bawah handleCallback:
//
//   if (data.startsWith("report_reason_")) return handleReportReason(query, data, userId, uidNum, chatId, msgId, env, api);
//   if (data === "report_cancel")          return handleReportCancel(query, chatId, msgId, api);
//   if (data.startsWith("admin_reply_"))   return handleAdminReplyStart(query, data, uidNum, chatId, msgId, env, api);
//   if (data === "admin_reply_cancel")     return handleAdminReplyCancel(query, uidNum, chatId, msgId, env, api);


// ── LANGKAH 2d: Salin semua fungsi di bawah ini ke webhook.js ─


// ── LANGKAH 3: Update mainMenuKbd ───────────────────────────
// Ubah fungsi mainMenuKbd menjadi:
//
// function mainMenuKbd(isAdmin) {
//   const rows = [
//     [{ text: "💌 Kirim Menfess" },     { text: "🔍 Cari Chat Anonim" }],
//     [{ text: "📊 Sisa Limit Menfess" }, { text: "ℹ️ Bantuan" }],
//     [{ text: "🚨 Report Partner" },     { text: "📬 Hubungi Admin" }],
//   ];
//   if (isAdmin) rows.push([{ text: "📊 Stats" }, { text: "🧾 Command Admin" }]);
//   return { keyboard: rows, resize_keyboard: true, input_field_placeholder: "Pilih fitur atau ketik mfs!..." };
// }




// ════════════════════════════════════════════════════════════════
// FUNGSI-FUNGSI HANDLER — Salin semua ke webhook.js
// ════════════════════════════════════════════════════════════════


// ── /report — Laporkan partner ───────────────────────────────

async function handleReport(userId, uidNum, chatId, env, api) {
  // Cek apakah sedang dalam sesi anon chat
  const acUser = await acGetUser(env, userId);
  const session = await acGetSession(env, userId);

  if (!session || acUser?.status !== "chatting") {
    return api.send({
      chat_id: chatId,
      text:
        "🚨 *Laporan Partner*\n\n" +
        "Fitur ini hanya bisa digunakan saat kamu sedang dalam sesi Anonymous Chat.\n\n" +
        "Kamu tidak sedang dalam sesi chat saat ini.\n" +
        "Mulai dulu dengan klik 🔍 *Cari Chat Anonim* atau ketik /find",
    });
  }

  return api.send({
    chat_id: chatId,
    text:
      "🚨 *Laporkan Partner*\n\n" +
      "Pilih alasan laporan kamu:\n\n" +
      "Laporanmu akan langsung diteruskan ke admin untuk ditindaklanjuti.\n" +
      "_Identitasmu tetap anonim saat melapor._",
    reply_markup: ikbd([
      [btn("🔞 Konten tidak pantas / vulgar", "report_reason_konten")],
      [btn("🤬 Kata-kata kasar / harassment", "report_reason_kasar")],
      [btn("🤖 Spam / bot / flood", "report_reason_spam")],
      [btn("🎭 Penipuan / prank berbahaya", "report_reason_penipuan")],
      [btn("⚠️ Lainnya", "report_reason_lainnya")],
      [btn("❌ Batal", "report_cancel")],
    ]),
  });
}

async function handleReportReason(query, data, userId, uidNum, chatId, msgId, env, api) {
  await api.answer(query.id);

  const acUser  = await acGetUser(env, userId);
  const session = await acGetSession(env, userId);

  // Double check — session masih ada
  if (!session || acUser?.status !== "chatting") {
    return api.edit({
      chat_id: chatId, message_id: msgId,
      text: "⚠️ Sesi chat sudah berakhir, laporan tidak dapat dikirim.",
    });
  }

  const reasonMap = {
    report_reason_konten:   "🔞 Konten tidak pantas / vulgar",
    report_reason_kasar:    "🤬 Kata-kata kasar / harassment",
    report_reason_spam:     "🤖 Spam / bot / flood",
    report_reason_penipuan: "🎭 Penipuan / prank berbahaya",
    report_reason_lainnya:  "⚠️ Lainnya",
  };

  const reason      = reasonMap[data] || "Tidak diketahui";
  const reportedUid = session.partnerId;
  const reportTime  = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

  // Kirim laporan ke admin
  await tgRaw(env.BOT_TOKEN, "sendMessage", {
    chat_id: env.ADMIN_ID,
    parse_mode: "Markdown",
    text:
      "🚨 *LAPORAN USER BARU*\n" +
      "━━━━━━━━━━━━━━━━━━\n" +
      `👤 *Pelapor ID:* \`${uidNum}\`\n` +
      `🎯 *Dilaporkan ID:* \`${reportedUid}\`\n` +
      `📋 *Alasan:* ${reason}\n` +
      `🕐 *Waktu:* ${reportTime}\n` +
      "━━━━━━━━━━━━━━━━━━\n" +
      "_Keduanya sedang dalam sesi Anonymous Chat saat laporan dibuat._",
    reply_markup: ikbd([
      [btn(`🔇 Mute user ${reportedUid}`, `admin_mute_${reportedUid}`)],
      [btn(`🚫 Blokir user ${reportedUid}`, `admin_block_${reportedUid}`)],
      [btn("✅ Tandai Selesai", "admin_report_done")],
    ]),
  });

  return api.edit({
    chat_id: chatId, message_id: msgId,
    text:
      "✅ *Laporan berhasil dikirim!*\n\n" +
      `📋 Alasan: _${reason}_\n\n` +
      "Terima kasih sudah melapor. Admin akan segera menindaklanjuti.\n\n" +
      "Kamu bisa lanjut ngobrol atau keluar dengan /stop",
  });
}

async function handleReportCancel(query, chatId, msgId, api) {
  await api.answer(query.id);
  return api.edit({
    chat_id: chatId, message_id: msgId,
    text: "❌ Laporan dibatalkan.\n\nKalau ada masalah lagi, ketik /report kapan saja.",
  });
}


// ── /contact — Hubungi admin ─────────────────────────────────

async function handleContact(userId, uidNum, chatId, env, api) {
  // Jika admin yang buka, tampilkan info berbeda
  if (uidNum === env.ADMIN_ID) {
    return api.send({
      chat_id: chatId,
      text:
        "📬 *Mode Contact Admin*\n\n" +
        "Kamu adalah admin. Fitur ini untuk user menghubungi kamu.\n\n" +
        "Saat ada pesan masuk dari user lewat /contact, kamu akan menerima notifikasi dengan tombol *Balas*.\n" +
        "Klik tombol *Balas* untuk mulai membalas pesan user tersebut.",
    });
  }

  // Set user ke mode contact
  await dbSetContactState(env, userId, { mode: "contact", startedAt: Date.now() });

  return api.send({
    chat_id: chatId,
    text:
      "📬 *Hubungi Admin*\n\n" +
      "Kamu sekarang terhubung dengan admin.\n" +
      "Kirimkan pesan, pertanyaan, atau keluhan kamu — admin akan membalasnya!\n\n" +
      "_Identitasmu tetap anonim. Admin tidak tahu siapa kamu sebenarnya._\n\n" +
      "Ketik /exitcontact untuk keluar dari mode ini.",
    reply_markup: {
      keyboard: [[{ text: "🚪 Keluar dari Mode Contact" }]],
      resize_keyboard: true,
    },
  });
}

async function handleContactRelay(msg, userId, uidNum, chatId, env, api) {
  const text = (msg.text || "").trim();

  // Cek jika user mau keluar
  if (text.toLowerCase() === "/exitcontact" || text === "🚪 Keluar dari Mode Contact") {
    await dbDelContactState(env, userId);
    return api.send({
      chat_id: chatId,
      text: "👋 Kamu sudah keluar dari mode Contact Admin.\n\nSemoga masalahmu terselesaikan ya! 😊",
      reply_markup: mainMenuKbd(false),
    });
  }

  // Relay pesan ke admin
  const senderLabel = msg.from.username ? `@${msg.from.username}` : `User #${uidNum}`;

  try {
    if (msg.text) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_ID,
        parse_mode: "Markdown",
        text:
          `📬 *Pesan dari User (Contact Admin)*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 *ID User:* \`${uidNum}\`\n` +
          `💬 *Pesan:*\n${msg.text}`,
        reply_markup: ikbd([
          [btn(`💬 Balas ke User ${uidNum}`, `admin_reply_${uidNum}`)],
        ]),
      });
    } else if (msg.photo) {
      await tgRaw(env.BOT_TOKEN, "sendPhoto", {
        chat_id: env.ADMIN_ID,
        photo: msg.photo[msg.photo.length - 1].file_id,
        caption:
          `📬 *Foto dari User (Contact Admin)*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 *ID User:* \`${uidNum}\`` +
          (msg.caption ? `\n💬 *Caption:* ${msg.caption}` : ""),
        parse_mode: "Markdown",
        reply_markup: ikbd([[btn(`💬 Balas ke User ${uidNum}`, `admin_reply_${uidNum}`)]]),
      });
    } else if (msg.video) {
      await tgRaw(env.BOT_TOKEN, "sendVideo", {
        chat_id: env.ADMIN_ID,
        video: msg.video.file_id,
        caption:
          `📬 *Video dari User (Contact Admin)*\n` +
          `👤 *ID User:* \`${uidNum}\`` +
          (msg.caption ? `\n💬 ${msg.caption}` : ""),
        parse_mode: "Markdown",
        reply_markup: ikbd([[btn(`💬 Balas ke User ${uidNum}`, `admin_reply_${uidNum}`)]]),
      });
    } else if (msg.voice) {
      await tgRaw(env.BOT_TOKEN, "sendVoice", {
        chat_id: env.ADMIN_ID,
        voice: msg.voice.file_id,
        caption: `📬 Voice note dari User \`${uidNum}\``,
        parse_mode: "Markdown",
        reply_markup: ikbd([[btn(`💬 Balas ke User ${uidNum}`, `admin_reply_${uidNum}`)]]),
      });
    } else if (msg.document) {
      await tgRaw(env.BOT_TOKEN, "sendDocument", {
        chat_id: env.ADMIN_ID,
        document: msg.document.file_id,
        caption: `📬 Dokumen dari User \`${uidNum}\``,
        parse_mode: "Markdown",
        reply_markup: ikbd([[btn(`💬 Balas ke User ${uidNum}`, `admin_reply_${uidNum}`)]]),
      });
    } else {
      return api.send({
        chat_id: chatId,
        text: "⚠️ Tipe pesan ini belum didukung. Coba kirim teks, foto, video, voice note, atau dokumen.",
      });
    }

    // Konfirmasi ke user
    await api.send({
      chat_id: chatId,
      text: "✅ Pesanmu sudah dikirim ke admin!\n\nTunggu balasan ya. Ketik /exitcontact untuk keluar.",
    });

  } catch (e) {
    console.error("contact relay error:", e.message);
    await api.send({
      chat_id: chatId,
      text: "⚠️ Gagal mengirim pesan. Coba lagi ya!",
    });
  }
}


// ── Admin Reply ──────────────────────────────────────────────

async function handleAdminReplyStart(query, data, uidNum, chatId, msgId, env, api) {
  await api.answer(query.id);

  // Hanya admin yang bisa pakai ini
  if (uidNum !== env.ADMIN_ID) {
    return api.answer(query.id, "❌ Bukan admin!", true);
  }

  // Ambil target user ID dari callback data: admin_reply_{uid}
  const targetUid = data.replace("admin_reply_", "");
  await dbSetAdminReply(env, env.ADMIN_ID, targetUid);

  return api.send({
    chat_id: chatId,
    text:
      `💬 *Mode Balas ke User \`${targetUid}\`*\n\n` +
      "Ketik pesanmu sekarang — akan langsung diteruskan ke user tersebut.\n\n" +
      "Klik tombol di bawah atau ketik /cancelreply untuk batal.",
    reply_markup: ikbd([[btn("❌ Batal Balas", "admin_reply_cancel")]]),
  });
}

async function handleAdminReplyRelay(msg, chatId, targetUid, env, api) {
  const text = (msg.text || "").trim();

  if (text.toLowerCase() === "/cancelreply") {
    await dbDelAdminReply(env, env.ADMIN_ID);
    return api.send({
      chat_id: chatId,
      text: "❌ Balasan dibatalkan.",
    });
  }

  try {
    if (msg.text) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: Number(targetUid),
        parse_mode: "Markdown",
        text: `📬 *Balasan dari Admin:*\n\n${msg.text}`,
      });
    } else if (msg.photo) {
      await tgRaw(env.BOT_TOKEN, "sendPhoto", {
        chat_id: Number(targetUid),
        photo: msg.photo[msg.photo.length - 1].file_id,
        caption: `📬 *Balasan dari Admin*${msg.caption ? `\n\n${msg.caption}` : ""}`,
        parse_mode: "Markdown",
      });
    } else if (msg.video) {
      await tgRaw(env.BOT_TOKEN, "sendVideo", {
        chat_id: Number(targetUid),
        video: msg.video.file_id,
        caption: `📬 *Balasan dari Admin*${msg.caption ? `\n\n${msg.caption}` : ""}`,
        parse_mode: "Markdown",
      });
    } else if (msg.voice) {
      await tgRaw(env.BOT_TOKEN, "sendVoice", {
        chat_id: Number(targetUid),
        voice: msg.voice.file_id,
      });
    } else if (msg.document) {
      await tgRaw(env.BOT_TOKEN, "sendDocument", {
        chat_id: Number(targetUid),
        document: msg.document.file_id,
        caption: "📬 *Balasan dari Admin*",
        parse_mode: "Markdown",
      });
    }

    // Konfirmasi ke admin
    await api.send({
      chat_id: chatId,
      text: `✅ Pesanmu sudah dikirim ke User \`${targetUid}\`!\n\nKetik lagi untuk kirim pesan lanjutan, atau /cancelreply untuk selesai.`,
    });

  } catch (e) {
    console.error("admin reply error:", e.message);
    await api.send({
      chat_id: chatId,
      text: `⚠️ Gagal kirim ke User \`${targetUid}\`. Mungkin user sudah blokir bot.`,
    });
    // Auto clear jika gagal
    await dbDelAdminReply(env, env.ADMIN_ID);
  }
}

async function handleAdminReplyCancel(query, uidNum, chatId, msgId, env, api) {
  await api.answer(query.id);
  await dbDelAdminReply(env, env.ADMIN_ID);
  return api.edit({
    chat_id: chatId, message_id: msgId,
    text: "❌ Balasan dibatalkan.",
  });
}


// ════════════════════════════════════════════════════════════════
// RINGKASAN INTEGRASI
// ════════════════════════════════════════════════════════════════
//
// File yang perlu diubah:
//
// 1. _db.js  → Tambah 5 fungsi (uncomment blok komentar di atas)
//
// 2. webhook.js → 4 langkah (lihat LANGKAH 2a-d dan LANGKAH 3 di atas)
//
// 3. Fungsi baru di webhook.js (salin dari file ini):
//    - handleReport()
//    - handleReportReason()
//    - handleReportCancel()
//    - handleContact()
//    - handleContactRelay()
//    - handleAdminReplyStart()
//    - handleAdminReplyRelay()
//    - handleAdminReplyCancel()
//
// ════════════════════════════════════════════════════════════════
