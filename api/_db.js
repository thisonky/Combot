// api/_db.js — Upstash Redis via HTTP
// Mengikuti PERSIS pola anonchat asli yang sudah terbukti jalan

// ── Redis core ──
// api/_db.js — Upstash Redis via HTTP (Clean Version tanpa Statistik Berat)

// api/_db.js — Hybrid Database Layer (Redis + Google Sheets)

// Memory Cache untuk Blacklist Keyword guna menghindari Latency Google Sheets
let localKwCache = { data: [], expiresAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 Menit

async function upstashReq(env, command) {
  try {
    const res = await fetch(`${env.KV_URL}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    return await res.json();
  } catch (err) {
    console.error("[Upstash Redis Error]:", err.message);
    return { result: null, error: err.message };
  }
}

// === ENGINE ANONCHAT ATOMIK (Mencegah Race Condition / Double Match) ===
export async function acGetUser(env, uid) {
  const r = await upstashReq(env, ["GET", `user:${uid}`]);
  return r.result ? JSON.parse(r.result) : null;
}
export async function acSetUser(env, uid, obj) {
  await upstashReq(env, ["SET", `user:${uid}`, JSON.stringify(obj)]);
}
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

// Menggunakan Redis SET (SADD/SREM) untuk Antrean yang Dijamin Atomik secara Skala Distribusi
export async function acGetQueue(env) {
  const r = await upstashReq(env, ["SMEMBERS", "chat_queue"]);
  return r.result || [];
}
export async function acAddToQueue(env, uid) {
  await upstashReq(env, ["SADD", "chat_queue", String(uid)]);
}
export async function acRemoveFromQueue(env, uid) {
  await upstashReq(env, ["SREM", "chat_queue", String(uid)]);
}

// Mekanisme Lock Next State Menggunakan Expiry (Idempotent Token)
export async function acIsDone(env, uid) {
  const r = await upstashReq(env, ["EXISTS", `lock_next:${uid}`]);
  return r.result === 1;
}
export async function acMarkDone(env, uid) {
  await upstashReq(env, ["SETEX", `lock_next:${uid}`, "3", "1"]); // lock 3 detik
}

// === DATABASE GOOGLE SPREADSHEET BRIDGE INTEGRATION ===
async function sheetReq(env, payload) {
  if (!env.SPREADSHEET_API_URL) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s strict timeout
    const res = await fetch(env.SPREADSHEET_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const text = await res.text();
    const cleanText = text.trim().startsWith("%") ? decodeURIComponent(text.trim()) : text.trim();
    return JSON.parse(cleanText);
  } catch (err) {
    console.error("[Spreadsheet API Failure Fallback]:", err.message);
    return null;
  }
}

export async function dbRegisterUser(env, uid, gender, username) {
  await sheetReq(env, { action: "register", uid, gender, username });
  await upstashReq(env, ["SADD", "global_users", String(uid)]);
}
export async function dbCountUsers(env) {
  const r = await upstashReq(env, ["SCARD", "global_users"]);
  return r.result || 0;
}
export async function dbAllUserIds(env) {
  const r = await upstashReq(env, ["SMEMBERS", "global_users"]);
  return r.result || [];
}

// === BLOCK, MUTE, KEYWORD MODERASI LAYER ===
export async function dbIsBlocked(env, uid) { return (await upstashReq(env, ["SISMEMBER", "blocked_users", String(uid)])).result === 1; }
export async function dbBlock(env, uid) { await upstashReq(env, ["SADD", "blocked_users", String(uid)]); }
export async function dbUnblock(env, uid) { await upstashReq(env, ["SREM", "blocked_users", String(uid)]); }
export async function dbCountBlocked(env) { return (await upstashReq(env, ["SCARD", "blocked_users"])).result || 0; }

export async function dbIsMuted(env, uid) { return (await upstashReq(env, ["SISMEMBER", "muted_users", String(uid)])).result === 1; }
export async function dbMute(env, uid) { await upstashReq(env, ["SADD", "muted_users", String(uid)]); }
export async function dbUnmute(env, uid) { await upstashReq(env, ["SREM", "muted_users", String(uid)]); }
export async function dbCountMuted(env) { return (await upstashReq(env, ["SCARD", "muted_users"])).result || 0; }

export async function dbAddKw(env, kw) { await upstashReq(env, ["SADD", "blacklist_keywords", kw.toLowerCase()]); localKwCache.expiresAt = 0; }
export async function dbDelKw(env, kw) { await upstashReq(env, ["SREM", "blacklist_keywords", kw.toLowerCase()]); localKwCache.expiresAt = 0; }
export async function dbListKw(env) {
  if (Date.now() < localKwCache.expiresAt) return localKwCache.data;
  const r = await upstashReq(env, ["SMEMBERS", "blacklist_keywords"]);
  localKwCache.data = r.result || [];
  localKwCache.expiresAt = Date.now() + CACHE_TTL_MS;
  return localKwCache.data;
}
export async function dbCountKw(env) { return (await upstashReq(env, ["SCARD", "blacklist_keywords"])).result || 0; }

export async function dbContainsBlacklistedKw(env, text) {
  const list = await dbListKw(env);
  const target = text.toLowerCase();
  return list.some(kw => target.includes(kw));
}

// === TEMPORARY STATE MANAGER (MENFESS, REFERRAL, CONTACT ADMIN) ===
export async function dbSaveMenfess(env, msgId, obj) { await upstashReq(env, ["SETEX", `menfess:${msgId}`, "86400", JSON.stringify(obj)]); }
export async function dbGetMenfess(env, msgId) { const r = await upstashReq(env, ["GET", `menfess:${msgId}`]); return r.result ? JSON.parse(r.result) : null; }
export async function dbDeleteMenfess(env, msgId) { await upstashReq(env, ["DEL", `menfess:${msgId}`]); }

export async function dbSavePending(env, uid, obj) { await upstashReq(env, ["SETEX", `pending:${uid}`, "600", JSON.stringify(obj)]); }
export async function dbGetPending(env, uid) { const r = await upstashReq(env, ["GET", `pending:${uid}`]); return r.result ? JSON.parse(r.result) : null; }
export async function dbDeletePending(env, uid) { await upstashReq(env, ["DEL", `pending:${uid}`]); }

export async function dbGetReferralBonus(env, uid) { return Number((await upstashReq(env, ["GET", `ref_bonus:${uid}`])).result || 0); }
export async function dbAddReferralBonus(env, uid, num) { await upstashReq(env, ["INCRBY", `ref_bonus:${uid}`, String(num)]); }
export async function dbUseReferralBonus(env, uid) {
  const current = await dbGetReferralBonus(env, uid);
  if (current > 0) await upstashReq(env, ["DECR", `ref_bonus:${uid}`]);
}
export async function dbHasUsedReferral(env, uid) { return (await upstashReq(env, ["SISMEMBER", "used_referrals", String(uid)])).result === 1; }
export async function dbRecordReferral(env, uid, refId) {
  await upstashReq(env, ["SADD", "used_referrals", String(uid)]);
  await upstashReq(env, ["SADD", `user_referrals:${refId}`, String(uid)]);
}
export async function dbCountReferrals(env, uid) { return (await upstashReq(env, ["SCARD", `user_referrals:${uid}`])).result || 0; }

export async function dbGetContactState(env, uid) { const r = await upstashReq(env, ["GET", `contact:${uid}`]); return r.result ? JSON.parse(r.result) : null; }
export async function dbSetContactState(env, uid, obj) { await upstashReq(env, ["SETEX", `contact:${uid}`, "1800", JSON.stringify(obj)]); }
export async function dbDelContactState(env, uid) { await upstashReq(env, ["DEL", `contact:${uid}`]); }

export async function dbGetAdminReply(env, uid) { const r = await upstashReq(env, ["GET", `admin_reply:${uid}`]); return r.result ? JSON.parse(r.result) : null; }
export async function dbSetAdminReply(env, uid, targetUid) { await upstashReq(env, ["SETEX", `admin_reply:${uid}`, "600", JSON.stringify({ targetUid })]); }
export async function dbDelAdminReply(env, uid) { await upstashReq(env, ["DEL", `admin_reply:${uid}`]); }
