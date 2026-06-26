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
    [{ text: "🚨 Laporkan User" }, { text: "📬 Hubungi Admin" }],
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
//  MY CHAT MEMBER — deteksi user blokir/unblokir bot
// ═══════════════════════════════════════════════

async function handleMyChatMember(update, env, api) {
  const oldStatus = update.old_chat_member?.status;
  const newStatus = update.new_chat_member?.status;
  const user      = update.from;
  if (!user) return;

  const userId    = user.id;
  const firstName = (user.first_name || "User").replace(/([_*`[])/g, "\\$1");
  const username  = user.username ? `@${user.username}` : "—";

  // kicked = user memblokir bot
  if (newStatus === "kicked") {
    // Bersihkan state user di Redis kalau masih aktif
    try {
      const acUser  = await acGetUser(env, String(userId));
      const session = acUser?.status === "chatting"
        ? await acGetSession(env, String(userId))
        : null;

      if (session) {
        // Putus sesi partner juga
        const partnerData = await acGetUser(env, String(session.partnerId));
        if (partnerData) {
          await acSetUser(env, String(session.partnerId), { ...partnerData, status: "idle" });
        }
        await acDelSession(env, String(session.partnerId));
        await acDelSession(env, String(userId));

        // Notifikasi partner bahwa sesi terputus
        try {
          await tgRaw(env.BOT_TOKEN, "sendMessage", {
            chat_id: Number(session.partnerId),
            text: "👋 Partner keluar dari sesi.\nMau cari yang baru? /find 😊",
          });
        } catch {}
      }

      if (acUser) await acSetUser(env, String(userId), { ...acUser, status: "idle" });
      await acRemoveFromQueue(env, String(userId));
    } catch (e) {
      console.error("my_chat_member cleanup error:", e.message);
    }

    // Notifikasi admin
    try {
      await tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_ID,
        parse_mode: "Markdown",
        text:
          `🚫 *BOT DIBLOKIR*\n\n` +
          `👤 *Nama:* [${firstName}](tg://user?id=${userId})\n` +
          `🆔 *User ID:* \`${userId}\`\n` +
          `🏷️ *Username:* ${username}\n\n` +
          `_Klik nama di atas untuk buka profil Telegram user._`,
      });
    } catch (e) {
      console.error("my_chat_member admin notify error:", e.message);
    }
    return;
  }

  // member = user yang sebelumnya blokir, sekarang buka blokir / start bot lagi
  if (oldStatus === "kicked" && newStatus === "member") {
    try {
      await tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_ID,
        parse_mode: "Markdown",
        text:
          `✅ *USER BUKA BLOKIR BOT*\n\n` +
          `👤 *Nama:* [${firstName}](tg://user?id=${userId})\n` +
          `🆔 *User ID:* \`${userId}\`\n` +
          `🏷️ *Username:* ${username}`,
      });
    } catch (e) {
      console.error("my_chat_member unblock notify error:", e.message);
    }
  }
}


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
    } else if (update.my_chat_member) {
      await handleMyChatMember(update.my_chat_member, env, api);
    } else if (update.message) {
      // Cek apakah ini pesan dari admin yang me-reply pesan user
      // PENTING: kalau isinya command admin (diawali "."), JANGAN diteruskan
      // sebagai balasan ke user — biarkan diproses sebagai command biasa
      const isAdminReply =
        update.message.from.id === env.ADMIN_ID &&
        update.message.reply_to_message &&
        !(update.message.text || "").startsWith(".");

      if (isAdminReply) {
        await handleAdminReply(update.message, env, api);
        return res.status(200).json({ ok: true }); // stop di sini, jangan diproses ulang
      }

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

  // ── PRIORITAS 0: cek state lintas-konteks dulu ──
  // Report-pending dan contact-mode HARUS dicek paling awal, sebelum cek
  // status chatting. Soalnya kedua state ini bisa aktif justru SAAT user
  // sedang chatting (laporkan partner / hubungi admin saat chat berlangsung).
  // Kalau dicek belakangan, teks bebas yang diketik user (alasan report,
  // pesan ke admin) malah ke-relay duluan ke partner chat.

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
    // Kalau pesan tanpa teks (misal stiker/foto saat report pending), abaikan saja
    return;
  }

  const contactMode = await redisGetContact(env, uidNum);
  if (contactMode === "active") {
    return handleContactRelay(msg, uidNum, chatId, env, api);
  }

  // ── PRIORITAS 1: cek status anon chat dulu ──
  const acUser = await acGetUser(env, userId);

  if (acUser?.status === "chatting") {
    // Semua command slash dan tombol menu yang harus tetap diproses bot
    // meski user sedang dalam sesi chat anonim
    const isSysCmd =
      textLow === "/stop"      || textLow.startsWith("/stop ") ||
      textLow === "/next"      || textLow.startsWith("/next ") ||
      textLow === "/find"      || textLow.startsWith("/find ") ||
      textLow === "/report"    ||
      textLow === "/contact"   ||
      textLow === "/referral"  ||
      textLow === "/start"     || textLow.startsWith("/start ") ||
      text === "🚨 Laporkan User"    ||
      text === "📬 Hubungi Admin"    ||
      text === "💌 Kirim Menfess"    ||
      text === "🔍 Cari Chat Anonim" ||
      text === "📊 Sisa Limit Menfess" ||
      text === "ℹ️ Bantuan"          ||
      text === "📊 Stats"            ||
      text === "🧾 Command Admin"    ||
      (text.startsWith(".") && uidNum === env.ADMIN_ID) ||
      textLow.startsWith("mfs!");
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
  if (textLow === "/report")   return handleReportMenu(userId, uidNum, chatId, env, api);
  if (textLow === "/contact")  return handleContactMenu(userId, uidNum, chatId, env, api);

  // ── PRIORITAS 3: keyboard buttons ──────────

  if (text === "💌 Kirim Menfess") {
    return api.send({
      chat_id: chatId,
      text:
        "💌 *Kirim Menfess*\n\n" +
        "Ketik `mfs!` + pesanmu, lalu kirim.\n" +
        "_Contoh:_ `mfs! Hai semua 😳`\n\n" +
        "Bisa kirim teks, foto, video, atau voice note.\n" +
        `📊 Kuota: *${env.DAILY_MAX}x/hari* — bisa nambah lewat referral 🎁`,
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
        "📊 *Sisa Limit Menfess*\n\n" +
        `Harian: *${env.DAILY_MAX - used}/${env.DAILY_MAX}* · Bonus: *${bonus}*\n` +
        `✨ Total sisa: *${sisa} slot*\n\n` +
        (sisa <= 0 ? "Habis hari ini, balik lagi besok ya! 😴" : `Masih bisa kirim *${sisa}x* lagi hari ini!`) +
        "\nAjak teman → dapat bonus kuota gratis 👇",
      reply_markup: ikbd([[burl("🔗 Bagikan & Dapat Bonus Kuota", shareUrl(rl))]]),
    });
  }

  if (text === "🚨 Laporkan User") return handleReportMenu(userId, uidNum, chatId, env, api);
  if (text === "📬 Hubungi Admin") return handleContactMenu(userId, uidNum, chatId, env, api);

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
        "👋 *Halo! Selamat datang di Combo Bot!*\n\n" +
        "💌 *Menfess* — Kirim pesan anonim ke channel\n" +
        "🔍 *Anonymous Chat* — Ngobrol 1-on-1 secara anonim\n\n" +
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
      return api.send({ chat_id: chatId, text: "💬 Kamu lagi ngobrol nih!\n/next — ganti partner · /stop — keluar" });
    }
    if (user.status === "searching") {
      return api.send({ chat_id: chatId, text: "🔍 Masih nyariin partner buat kamu, sabar ya 😄\n/stop — batalkan" });
    }
  }

  await acSetUser(env, userId, { ...user, status: "searching" });
  await acAddToQueue(env, userId);

  const partnerId = await acPickPartner(env, userId);
  if (!partnerId) {
    return api.send({
      chat_id: chatId,
      text:
        "🔍 *Nyariin partner buat kamu...*\n\n" +
        "Belum ada yang online sekarang 😴\n" +
        "Nanti otomatis nyambung kalau ada yang nyari juga!\n\n" +
        "Sambil nunggu, bisa kirim menfess dulu: `mfs!` + pesan 💌\n" +
        "/stop — batalkan pencarian",
    });
  }

  // Verifikasi partner masih dalam queue dan masih status searching
  // (anti race condition: cegah double session kalau dua user match bersamaan)
  const partnerUser = await acGetUser(env, partnerId);
  if (!partnerUser || partnerUser.status !== "searching") {
    // Partner sudah di-claim oleh request lain, coba lagi dari queue baru
    await acRemoveFromQueue(env, partnerId); // bersihkan kalau stale
    return api.send({
      chat_id: chatId,
      text: "🔍 *Masih nyariin...*\n\nHampir ketemu, tunggu sebentar lagi ya! 😄",
    });
  }

  // Match ditemukan — tandai keduanya segera sebelum request lain bisa claim
  await acRemoveFromQueue(env, userId);
  await acRemoveFromQueue(env, partnerId);

  const partner = partnerUser; // sudah di-fetch saat verifikasi di atas
  await acSetUser(env, userId,   { ...user,    status: "chatting" });
  await acSetUser(env, partnerId,{ ...partner, status: "chatting" });
  await acSetSession(env, userId, partnerId);

  const connMsg =
    "🎉 *Yeay, ketemu partner!*\n\n" +
    "Kamu terhubung secara anonim. Mulai ngobrol! 🤫\n\n" +
    "⏭ /next — ganti partner · 🛑 /stop — keluar";

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
    await api.send({ chat_id: Number(pid), text: "👋 Partner cabut, lagi cari yang baru.\nMau cari juga? /find 😊" });
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
    const pid   = session.partnerId;
    const pData = await acGetUser(env, pid);
    await api.send({ chat_id: Number(pid), text: "👋 Partner keluar dari sesi.\nMau cari yang baru? /find 😊" });
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

  const pid = Number(session.partnerId);
  const pidStr = String(session.partnerId);

  // Deteksi partner tidak bisa dijangkau (blokir bot / akun dihapus)
  // dan otomatis putus sesi kedua user
  async function terminateSession(reason) {
    const partnerData = await acGetUser(env, pidStr);
    if (partnerData) await acSetUser(env, pidStr, { ...partnerData, status: "idle" });
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

  // Wrapper kirim ke partner — return false jika partner tidak bisa dijangkau
  async function sendToPartner(method, body) {
    const result = await tgRaw(env.BOT_TOKEN, method, { chat_id: pid, ...body });
    if (!result.ok) {
      const desc = (result.description || "").toLowerCase();
      const isUnreachable =
        result.error_code === 403 ||
        result.error_code === 404 ||
        desc.includes("blocked") ||
        desc.includes("user not found") ||
        desc.includes("chat not found") ||
        desc.includes("deactivated");
      if (isUnreachable) {
        await terminateSession();
        return false;
      }
    }
    return true;
  }

  try {
    if (msg.text) {
      await sendToPartner("sendMessage", { text: `💬 ${msg.text}` });
    } else if (msg.photo) {
      await sendToPartner("sendPhoto", {
        photo: msg.photo[msg.photo.length - 1].file_id,
        ...(msg.caption ? { caption: `💬 ${msg.caption}` } : {}),
      });
    } else if (msg.video) {
      await sendToPartner("sendVideo", {
        video: msg.video.file_id,
        ...(msg.caption ? { caption: `💬 ${msg.caption}` } : {}),
      });
    } else if (msg.voice) {
      await sendToPartner("sendVoice", { voice: msg.voice.file_id });
    } else if (msg.sticker) {
      await sendToPartner("sendSticker", { sticker: msg.sticker.file_id });
    } else if (msg.video_note) {
      await sendToPartner("sendVideoNote", { video_note: msg.video_note.file_id });
    } else if (msg.audio) {
      await sendToPartner("sendAudio", { audio: msg.audio.file_id });
    } else if (msg.document) {
      await sendToPartner("sendDocument", { document: msg.document.file_id });
    }
  } catch (e) {
    console.error("relay error:", e.message);
    await api.send({ chat_id: chatId, text: "⚠️ Gagal mengirim pesan. Coba lagi." });
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
      `👥 Diundang: *${total} orang* · ✨ Bonus aktif: *${bonus} slot*\n\n` +
      `Ajak teman → kamu & dia dapat *+${env.REF_BONUS} bonus kuota* menfess!`,
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
  if (blockInfo) return api.send({ chat_id: chatId, text: `🚫 Kamu diblokir dari menfess.\nAlasan: _${blockInfo.reason}_\n\nAda pertanyaan? /contact` });

  const mutedUntil = await dbIsMuted(env, uidNum);
  if (mutedUntil) return api.send({ chat_id: chatId, text: `🔇 Kamu lagi kena mute.\nBisa kirim lagi setelah *${fmtDate(mutedUntil)}* 😊` });

  const remaining = await mfRemaining(env, uidNum);
  if (remaining <= 0) {
    return api.send({
      chat_id: chatId,
      text:
        `⏳ Kuota habis! Sudah kirim *${env.DAILY_MAX}x* hari ini.\n` +
        "Balik lagi besok, atau ajak teman buat bonus kuota gratis! 🎁",
      reply_markup: ikbd([[burl("🔗 Bagikan Referral & Dapat Bonus", shareUrl(refLink(env, uidNum)))]]),
    });
  }

  const cleanContent = (rawText || rawCaption).replace(/^mfs!/i, "💌").trim();
  if (!cleanContent || cleanContent === "💌") return api.send({ chat_id: chatId, text: "❌ Isi menfessnya kosong!\nContoh: `mfs! Hai semuanya 😊`" });

  const blockedKw = await dbContainsBlacklistedKw(env, cleanContent);
  if (blockedKw) return api.send({ chat_id: chatId, text: "❌ Menfessmu mengandung kata yang nggak diperbolehkan.\nEdit dulu ya, lalu kirim ulang! 😊" });

  let mediaType = "text", fileId = null;
  if (msg.photo)      { mediaType = "photo";  fileId = msg.photo[msg.photo.length - 1].file_id; }
  else if (msg.video) { mediaType = "video";  fileId = msg.video.file_id; }
  else if (msg.voice) { mediaType = "voice";  fileId = msg.voice.file_id; }

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

// ═══════════════════════════════════════════════
//  REPORT & CONTACT ADMIN
// ═══════════════════════════════════════════════

// Redis helper sederhana untuk report/contact (reuse pattern dari _db.js)
async function redisRaw(env, ...args) {
  try {
    const res = await fetch(env.KV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    return data?.result ?? null;
  } catch { return null; }
}

async function redisGetContact(env, uid) {
  return redisRaw(env, "GET", `contact_mode:${uid}`);
}
async function redisSetContact(env, uid, exSec) {
  await redisRaw(env, "SET", `contact_mode:${uid}`, "active", "EX", exSec || 1800);
}
async function redisDelContact(env, uid) {
  await redisRaw(env, "DEL", `contact_mode:${uid}`);
}
// Mapping: message_id di chat admin → user_id pengirim (untuk admin bisa balas)
async function redisSaveAdminReply(env, adminMsgId, userId) {
  await redisRaw(env, "SET", `admin_reply:${adminMsgId}`, String(userId), "EX", 86400);
}
async function redisGetAdminReply(env, adminMsgId) {
  return redisRaw(env, "GET", `admin_reply:${adminMsgId}`);
}
// State user sedang mengisi alasan report custom
async function redisSaveReportPending(env, uid, partnerId) {
  await redisRaw(env, "SET", `report_pending:${uid}`, String(partnerId), "EX", 300);
}
async function redisGetReportPending(env, uid) {
  return redisRaw(env, "GET", `report_pending:${uid}`);
}
async function redisDelReportPending(env, uid) {
  await redisRaw(env, "DEL", `report_pending:${uid}`);
}

// ── METODE 1: Report User ──────────────────────

async function handleReportMenu(userId, uidNum, chatId, env, api) {
  const acUser  = await acGetUser(env, userId);
  const session = acUser?.status === "chatting" ? await acGetSession(env, userId) : null;

  if (session) {
    return api.send({
      chat_id: chatId,
      text:
        "🚨 *Laporkan Partner*\n\n" +
        "Pilih alasan laporanmu — identitasmu tetap anonim! 😊",
      reply_markup: ikbd([
        [btn("🔞 Konten Tidak Pantas", `rpt_konten_${session.partnerId}`)],
        [btn("🤬 Kata-kata Kasar / Bullying", `rpt_kasar_${session.partnerId}`)],
        [btn("🧟 Spam / Iklan", `rpt_spam_${session.partnerId}`)],
        [btn("😰 Pelecehan / Ancaman", `rpt_pelecehan_${session.partnerId}`)],
        [btn("📝 Alasan Lain", `rpt_lain_${session.partnerId}`)],
        [btn("❌ Batal", "rpt_cancel")],
      ]),
    });
  }

  return api.send({
    chat_id: chatId,
    text: "🚨 Fitur laporan aktif saat kamu sedang dalam sesi Anonymous Chat.\n\nMau hubungi admin langsung?",
    reply_markup: ikbd([[btn("📬 Hubungi Admin", "contact_start")]]),
  });
}

// Escape karakter spesial Markdown LEGACY (bukan MarkdownV2) agar teks bebas
// dari user tidak merusak format atau bikin Telegram API menolak pesan
// (error "can't parse entities"). Markdown legacy cuma butuh escape: _ * ` [
function escapeMd(text) {
  if (!text) return text;
  return String(text).replace(/([_*`[])/g, "\\$1");
}

async function submitReport(uidNum, chatId, partnerId, reason, env, api) {
  const now = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  await tgRaw(env.BOT_TOKEN, "sendMessage", {
    chat_id: env.ADMIN_ID,
    parse_mode: "Markdown",
    text:
      "🚨 *LAPORAN USER MASUK*\n" +
      "━━━━━━━━━━━━━━━━━━\n" +
      `👤 *Pelapor ID:* \`${uidNum}\`\n` +
      `🎯 *Dilaporkan ID:* \`${partnerId}\`\n` +
      `📋 *Alasan:* ${escapeMd(reason)}\n` +
      `🕐 *Waktu:* ${now}\n` +
      "━━━━━━━━━━━━━━━━━━\n" +
      "_Tindakan yang bisa dilakukan:_\n" +
      `\`.bl ${partnerId} [alasan]\` — Blokir user\n` +
      `\`.mute ${partnerId} 24 h\` — Mute 24 jam`,
  });
  await api.send({
    chat_id: chatId,
    text:
      "✅ Laporan terkirim! Makasih ya, admin akan segera tindaklanjuti.\n\n" +
      "/next — ganti partner · /stop — keluar",
  });
}

// ── METODE 2: Hubungi Admin ────────────────────

async function handleContactMenu(userId, uidNum, chatId, env, api) {
  return api.send({
    chat_id: chatId,
    text:
      "📬 *Hubungi Admin*\n\n" +
      "Kirim pesan apapun ke admin — identitasmu tetap anonim.\n" +
      "Admin bisa membalas langsung lewat bot ini! 😊",
    reply_markup: ikbd([
      [btn("✉️ Mulai Kirim Pesan", "contact_start")],
      [btn("❌ Batal", "contact_cancel")],
    ]),
  });
}

async function handleContactRelay(msg, uidNum, chatId, env, api) {
  const text = (msg.text || "").trim();

  // User mau keluar dari mode contact
  if (text === "/selesai" || text === "/batal") {
    await redisDelContact(env, uidNum);
    return api.send({
      chat_id: chatId,
      text: "✅ Sesi kontak selesai. Makasih! 😊",
      reply_markup: mainMenuKbd(false),
    });
  }

  // /stop: hapus contact mode dulu, lalu lanjut handleStop
  // supaya sesi chat anonim (kalau aktif) juga ikut diputus
  if (text.toLowerCase() === "/stop") {
    await redisDelContact(env, uidNum);
    return handleStop(String(uidNum), chatId, env, api);
  }

  const now = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const header = `📬 *PESAN DARI USER*\n━━━━━━━━━━━━━━━━━━\n👤 ID: \`${uidNum}\`\n🕐 ${now}\n━━━━━━━━━━━━━━━━━━\n`;
  let adminMsgResult;

  try {
    if (msg.text) {
      adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.ADMIN_ID,
        parse_mode: "Markdown",
        text: header + escapeMd(msg.text),
      });
    } else if (msg.photo) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + "📷 _[Foto]_" });
      adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendPhoto", {
        chat_id: env.ADMIN_ID,
        photo: msg.photo[msg.photo.length - 1].file_id,
        caption: msg.caption ? `💬 ${msg.caption}` : undefined,
      });
    } else if (msg.video) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + "🎥 _[Video]_" });
      adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendVideo", {
        chat_id: env.ADMIN_ID,
        video: msg.video.file_id,
        caption: msg.caption ? `💬 ${msg.caption}` : undefined,
      });
    } else if (msg.voice) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + "🎙️ _[Voice Note]_" });
      adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendVoice", { chat_id: env.ADMIN_ID, voice: msg.voice.file_id });
    } else if (msg.sticker) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + "🎭 _[Stiker]_" });
      adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendSticker", { chat_id: env.ADMIN_ID, sticker: msg.sticker.file_id });
    } else if (msg.document) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_ID, parse_mode: "Markdown", text: header + "📄 _[Dokumen]_" });
      adminMsgResult = await tgRaw(env.BOT_TOKEN, "sendDocument", {
        chat_id: env.ADMIN_ID,
        document: msg.document.file_id,
        caption: msg.caption ? `💬 ${msg.caption}` : undefined,
      });
    } else {
      return api.send({ chat_id: chatId, text: "⚠️ Tipe media ini belum didukung. Coba kirim teks, foto, video, atau voice note ya!" });
    }

    // Simpan mapping message_id → user_id agar admin bisa reply
    if (adminMsgResult?.ok && adminMsgResult?.result?.message_id) {
      await redisSaveAdminReply(env, adminMsgResult.result.message_id, uidNum);
    }

    await api.send({
      chat_id: chatId,
      text: "✅ Terkirim! Admin akan balas kalau diperlukan.\nLanjut kirim atau /selesai untuk keluar.",
    });

  } catch (e) {
    console.error("contact relay error:", e.message);
    await api.send({ chat_id: chatId, text: "❌ Gagal mengirim pesan. Coba lagi ya!" });
  }
}

// Admin me-reply pesan user → bot teruskan balasan ke user
async function handleAdminReply(msg, env, api) {
  const repliedMsgId = msg.reply_to_message?.message_id;
  if (!repliedMsgId) return;

  const targetUserId = await redisGetAdminReply(env, repliedMsgId);
  if (!targetUserId) return; // bukan pesan dari user, abaikan

  try {
    if (msg.text) {
      await tgRaw(env.BOT_TOKEN, "sendMessage", {
        chat_id: Number(targetUserId),
        parse_mode: "Markdown",
        text: `📩 *Balasan dari Admin:*\n\n${escapeMd(msg.text)}`,
      });
    } else if (msg.photo) {
      await tgRaw(env.BOT_TOKEN, "sendPhoto", {
        chat_id: Number(targetUserId),
        photo: msg.photo[msg.photo.length - 1].file_id,
        caption: msg.caption ? `📩 *Balasan Admin:* ${msg.caption}` : "📩 *Balasan dari Admin*",
        parse_mode: "Markdown",
      });
    } else if (msg.video) {
      await tgRaw(env.BOT_TOKEN, "sendVideo", {
        chat_id: Number(targetUserId),
        video: msg.video.file_id,
        caption: msg.caption ? `📩 *Balasan Admin:* ${msg.caption}` : "📩 *Balasan dari Admin*",
        parse_mode: "Markdown",
      });
    } else if (msg.voice) {
      await tgRaw(env.BOT_TOKEN, "sendVoice", { chat_id: Number(targetUserId), voice: msg.voice.file_id });
      await tgRaw(env.BOT_TOKEN, "sendMessage", { chat_id: Number(targetUserId), text: "📩 _(voice note dari Admin)_", parse_mode: "Markdown" });
    } else if (msg.sticker) {
      await tgRaw(env.BOT_TOKEN, "sendSticker", { chat_id: Number(targetUserId), sticker: msg.sticker.file_id });
    } else if (msg.document) {
      await tgRaw(env.BOT_TOKEN, "sendDocument", {
        chat_id: Number(targetUserId),
        document: msg.document.file_id,
        caption: msg.caption ? `📩 *Balasan Admin:* ${msg.caption}` : "📩 *Balasan dari Admin*",
        parse_mode: "Markdown",
      });
    } else {
      return; // tipe lain diabaikan
    }

    await api.send({ chat_id: env.ADMIN_ID, text: `✅ Balasanmu berhasil dikirim ke user \`${targetUserId}\`` });

  } catch (e) {
    console.error("admin reply error:", e.message);
    await api.send({ chat_id: env.ADMIN_ID, text: `❌ Gagal mengirim balasan ke user \`${targetUserId}\`. User mungkin sudah memblokir bot.` });
  }
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

  // ── Report callbacks ─────────────────────────

  if (data === "rpt_cancel") {
    await api.answer(query.id, "Laporan dibatalkan.");
    return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Laporan dibatalkan." });
  }

  if (data.startsWith("rpt_")) {
    await api.answer(query.id);
    // Format: rpt_{alasan}_{partnerId}
    const parts      = data.split("_");
    const alasan     = parts[1];
    const partnerId  = parts[2];

    if (alasan === "lain") {
      await redisSaveReportPending(env, uidNum, partnerId);
      return api.edit({
        chat_id: chatId, message_id: msgId,
        text: "📝 *Ketik alasan laporanmu*\n\nCeritakan singkat apa yang terjadi.\n_/batal untuk batalkan_",
      });
    }

    // Alasan preset
    const alasanMap = {
      konten:    "Konten Tidak Pantas 🔞",
      kasar:     "Kata-kata Kasar / Bullying 🤬",
      spam:      "Spam / Iklan Tidak Diinginkan 🧟",
      pelecehan: "Pelecehan / Ancaman 😰",
    };
    const reason = alasanMap[alasan] || alasan;
    await submitReport(uidNum, chatId, partnerId, reason, env, api);
    return api.edit({ chat_id: chatId, message_id: msgId, text: "✅ Laporan terkirim! Terima kasih." });
  }

  // ── Contact callbacks ────────────────────────

  if (data === "contact_cancel") {
    await api.answer(query.id, "Dibatalkan.");
    return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Dibatalkan." });
  }

  if (data === "contact_start") {
    await api.answer(query.id);
    await redisSetContact(env, uidNum, 1800);
    return api.edit({
      chat_id: chatId, message_id: msgId,
      text:
        "✉️ *Mode Hubungi Admin Aktif*\n\n" +
        "Kirim pesan apapun — diteruskan ke admin secara anonim.\n" +
        "_Aktif 30 menit · ketik /selesai untuk keluar_",
    });
  }

  // Gender select
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

  // Menfess cancel
  if (data === "mf_cancel") {
    await api.answer(query.id);
    await dbDeletePending(env, uidNum);
    return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Menfess dibatalkan. Ketik `mfs!` lagi kapan aja!" });
  }

  // Menfess confirm
  if (data === "mf_confirm" || data === "mf_autodel") {
    await api.answer(query.id);
    const pending = await dbGetPending(env, uidNum);
    if (!pending) return api.edit({ chat_id: chatId, message_id: msgId, text: "⚠️ Sesi habis, coba kirim ulang ya!" });

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
      return api.edit({ chat_id: chatId, message_id: msgId, text: "❌ Gagal kirim ke channel. Pastikan bot sudah jadi *Admin* di channel ya!", parse_mode: "Markdown" });
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
    const autoNote  = autoDelete ? `\n⏱️ _Auto-hapus dalam ${env.AUTO_DEL_MIN} menit_` : "";

    await api.edit({
      chat_id: chatId, message_id: msgId,
      text: `✅ *Menfess terkirim!* 🎉\n\n🔗 ${link}\n📊 Sisa kuota: *${rem} slot*${autoNote}`,
      reply_markup: ikbd([
        [btn("🗑️ Hapus Menfess", `mf_del_${sentId}`)],
        [burl("🔗 Ajak Teman & Dapat Bonus", shareUrl(refLink(env, uidNum)))],
      ]),
      link_preview_options: { is_disabled: true },
    });

    tgRaw(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.ADMIN_ID, parse_mode: "Markdown",
      text: `📩 *LAPORAN MENFESS*\n━━━━━━━━━━━━━━━\n👤 *Pengirim:* ${pending.senderName}\n🆔 *ID:* \`${uidNum}\`\n🔗 *Link:* [Lihat Pesan](${link})\n💬 *Isi:* ${escapeMd(pending.text)}${autoDelete ? `\n⏱️ Auto-delete ${env.AUTO_DEL_MIN} menit` : ""}`,
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
      return api.edit({ chat_id: chatId, message_id: msgId, text: "✅ Menfessmu sudah dihapus dari channel!" });
    } catch {
      return api.answer(query.id, "Gagal menghapus. Pesan mungkin sudah dihapus.", true);
    }
  }

  await api.answer(query.id);
}


