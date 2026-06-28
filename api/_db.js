// api/_db.js — Upstash Redis via HTTP
// Mengikuti PERSIS pola anonchat asli yang sudah terbukti jalan

// ── Redis core ──
// api/_db.js — Upstash Redis via HTTP (Clean Version tanpa Statistik Berat)

// api/_db.js — Hybrid Database Layer (Redis + Google Sheets)

// Memory Cache untuk Blacklist Keyword guna menghindari Latency Google Sheets
let cacheKeywords = { data: [], expires: 0 };

async function upstashReq(env, command) {
  try {
    const res = await fetch(env.KV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    return await res.json();
  } catch (err) {
    console.error("[Redis High-Load Error]:", err.message);
    return { result: null, error: err.message };
  }
}

// Safe JSON Parser Utility
function safeJsonParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } 
  catch (e) { console.error("[Corrupted State JSON Detected]:", str); return null; }
}

// === GOOGLE SPREADSHEET BACKEND PERSISTENCE BRIDGE ===
async function syncToSpreadsheet(env, payload) {
  if (!env.SPREADSHEET_API_URL) return false;
  try {
    const res = await fetch(env.SPREADSHEET_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    const cleanText = text.trim().startsWith("%") ? decodeURIComponent(text.trim()) : text.trim();
    const parsed = JSON.parse(cleanText);
    return parsed.status === "success" || parsed.ok;
  } catch (err) {
    console.error("[Spreadsheet Sync Failed, Falling Back to Redis Only]:", err.message);
    return false;
  }
}

// === USER REGISTRY & DATA MANAGEMENT ===
export async function acGetUser(env, uid) {
  const r = await upstashReq(env, ["GET", `user:${uid}`]);
  return safeJsonParse(r.result);
}

export async function acSetUser(env, uid, obj) {
  await upstashReq(env, ["SET", `user:${uid}`, JSON.stringify(obj)]);
}

export async function dbRegisterUser(env, uid, gender, username) {
  const userObj = { uid, gender, username, isPremium: false, premiumExpire: 0, registeredAt: Date.now() };
  await acSetUser(env, uid, userObj);
  await upstashReq(env, ["SADD", "global_users_cache", String(uid)]);
  // Sinkronisasi non-blocking ke Spreadsheet untuk mengamankan registry user
  syncToSpreadsheet(env, { action: "register", uid, gender, username }).catch(() => {});
}

export async function dbAllUserIds(env) {
  const r = await upstashReq(env, ["SMEMBERS", "global_users_cache"]);
  return r.result || [];
}

export async function dbCountUsers(env) {
  const r = await upstashReq(env, ["SCARD", "global_users_cache"]);
  return r.result || 0;
}

// === ANTI-RACE CONDITION ATOMIC MATCHMAKING QUEUE (CRITICAL P0) ===
export async function acAddToQueue(env, uid) {
  await upstashReq(env, ["SADD", "chat_queue", String(uid)]);
}

export async function acRemoveFromQueue(env, uid) {
  await upstashReq(env, ["SREM", "chat_queue", String(uid)]);
}

export async function acGetQueue(env) {
  const r = await upstashReq(env, ["SMEMBERS", "chat_queue"]);
  return r.result || [];
}

// Menggunakan operasi atomik SPOP untuk mengeluarkan user dari antrean secara aman tanpa tumpang tindih
export async function acPopRandomPartner(env, myUid) {
  // Ambil 1 kandidat dari antrean menggunakan SPOP (menjamin atomisitas tingkat tinggi)
  const r = await upstashReq(env, ["SPOP", "chat_queue"]);
  const matchedUid = r.result;
  if (!matchedUid) return null;
  
  if (String(matchedUid) === String(myUid)) {
    // Jika tidak sengaja mengambil diri sendiri, masukkan kembali ke antrean
    await acAddToQueue(env, myUid);
    return null;
  }
  return matchedUid;
}

// === SESSION MANAGEMENT ===
export async function acGetSession(env, uid) {
  const r = await upstashReq(env, ["GET", `session:${uid}`]);
  return r.result;
}

export async function acSetSession(env, uid1, uid2) {
  await upstashReq(env, ["SET", `session:${uid1}`, String(uid2)]);
}

export async function acDelSession(env, uid) {
  await upstashReq(env, ["DEL", `session:${uid}`]);
}

export async function acIsDone(env, uid) {
  const r = await upstashReq(env, ["EXISTS", `lock:${uid}`]);
  return r.result === 1;
}

export async function acMarkDone(env, uid) {
  await upstashReq(env, ["SETEX", `lock:${uid}`, "2", "1"]); // Lock cooldown 2 detik
}

// === MODERATION COMPONENT (REAL-TIME STATE) ===
export async function dbIsBlocked(env, uid) { return (await upstashReq(env, ["SISMEMBER", "blocked", String(uid)])).result === 1; }
export async function dbBlock(env, uid) { await upstashReq(env, ["SADD", "blocked", String(uid)]); }
export async function dbUnblock(env, uid) { await upstashReq(env, ["SREM", "blocked", String(uid)]); }
export async function dbCountBlocked(env) { return (await upstashReq(env, ["SCARD", "blocked"])).result || 0; }

export async function dbIsMuted(env, uid) { return (await upstashReq(env, ["SISMEMBER", "muted", String(uid)])).result === 1; }
export async function dbMute(env, uid) { await upstashReq(env, ["SADD", "muted", String(uid)]); }
export async function dbUnmute(env, uid) { await upstashReq(env, ["SREM", "muted", String(uid)]); }
export async function dbCountMuted(env) { return (await upstashReq(env, ["SCARD", "muted"])).result || 0; }

export async function dbAddKw(env, kw) { await upstashReq(env, ["SADD", "keywords", kw.toLowerCase()]); cacheKeywords.expires = 0; }
export async function dbDelKw(env, kw) { await upstashReq(env, ["SREM", "keywords", kw.toLowerCase()]); cacheKeywords.expires = 0; }
export async function dbListKw(env) {
  if (Date.now() < cacheKeywords.expires) return cacheKeywords.data;
  const r = await upstashReq(env, ["SMEMBERS", "keywords"]);
  cacheKeywords.data = r.result || [];
  cacheKeywords.expires = Date.now() + 60000; // Cache memori lokal 1 menit
  return cacheKeywords.data;
}
export async function dbCountKw(env) { return (await upstashReq(env, ["SCARD", "keywords"])).result || 0; }

export async function dbContainsBlacklistedKw(env, text) {
  const list = await dbListKw(env);
  const target = text.toLowerCase();
  return list.some(kw => target.includes(kw));
}

// === TEMPORARY STATE MANAGEMENT ===
export async function dbSaveMenfess(env, msgId, obj) { await upstashReq(env, ["SETEX", `menfess:${msgId}`, "86400", JSON.stringify(obj)]); }
export async function dbGetMenfess(env, msgId) { const r = await upstashReq(env, ["GET", `menfess:${msgId}`]); return safeJsonParse(r.result); }
export async function dbDeleteMenfess(env, msgId) { await upstashReq(env, ["DEL", `menfess:${msgId}`]); }

export async function dbSavePending(env, uid, obj) { await upstashReq(env, ["SETEX", `pending:${uid}`, "300", JSON.stringify(obj)]); }
export async function dbGetPending(env, uid) { const r = await upstashReq(env, ["GET", `pending:${uid}`]); return safeJsonParse(r.result); }
export async function dbDeletePending(env, uid) { await upstashReq(env, ["DEL", `pending:${uid}`]); }

export async function dbGetReferralBonus(env, uid) { return Number((await upstashReq(env, ["GET", `ref_bonus:${uid}`])).result || 0); }
export async function dbAddReferralBonus(env, uid, num) { await upstashReq(env, ["INCRBY", `ref_bonus:${uid}`, String(num)]); }
export async function dbUseReferralBonus(env, uid) {
  const current = await dbGetReferralBonus(env, uid);
  if (current > 0) await upstashReq(env, ["DECR", `ref_bonus:${uid}`]);
}
export async function dbHasUsedReferral(env, uid) { return (await upstashReq(env, ["SISMEMBER", "used_referrals", String(uid)])).result === 1; }
export async function dbRecordReferral(env, uid, refId) {
  // Transaksi penguncian gabungan di level Redis Set
  await upstashReq(env, ["SADD", "used_referrals", String(uid)]);
  await upstashReq(env, ["SADD", `user_referrals:${refId}`, String(uid)]);
}
export async function dbCountReferrals(env, uid) { return (await upstashReq(env, ["SCARD", `user_referrals:${uid}`])).result || 0; }

export async function dbGetContactState(env, uid) { const r = await upstashReq(env, ["GET", `contact:${uid}`]); return safeJsonParse(r.result); }
export async function dbSetContactState(env, uid, obj) { await upstashReq(env, ["SETEX", `contact:${uid}`, "600", JSON.stringify(obj)]); }
export async function dbDelContactState(env, uid) { await upstashReq(env, ["DEL", `contact:${uid}`]); }

export async function dbGetAdminReply(env, uid) { const r = await upstashReq(env, ["GET", `admin_reply:${uid}`]); return safeJsonParse(r.result); }
export async function dbSetAdminReply(env, uid, targetUid) { await upstashReq(env, ["SETEX", `admin_reply:${uid}`, "600", JSON.stringify({ targetUid })]); }
export async function dbDelAdminReply(env, uid) { await upstashReq(env, ["DEL", `admin_reply:${uid}`]); }
