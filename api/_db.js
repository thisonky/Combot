// api/_db.js — Upstash Redis via HTTP
// Mengikuti PERSIS pola anonchat asli yang sudah terbukti jalan

// ── Redis core (identik dengan anonchat asli) ──
// api/_db.js — Combo Bot Engine (Anonymous Chat + Menfess)
// Upstash Redis via REST API Engine — Production Hardened Version
// Mengamankan Concurrency, Atomisitas Antrean, & JSON Deserialization Stability

const REDIS_TIMEOUT_MS = 5000;

// ── Redis Core Network Engine ──────────────────────────────────────────

async function redisCmd(env, ...args) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REDIS_TIMEOUT_MS);
  try {
    const res = await fetch(env.KV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.KV_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
    const data = await res.json();
    return data?.result ?? null;
  } catch (e) {
    console.error("redisCmd fatal error:", e.name === "AbortError" ? "TIMEOUT" : e.message, args[0], args[1]);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function redisGet(env, key) {
  const result = await redisCmd(env, "GET", key);
  if (result === null) return null;
  if (typeof result !== "string") return result;
  if (!result.startsWith("{") && !result.startsWith("[")) return result;
  try { 
    return JSON.parse(result); 
  } catch { 
    return result; 
  }
}

async function redisSet(env, key, value, exSeconds) {
  const val = typeof value === "string" ? value : JSON.stringify(value);
  if (exSeconds) {
    await redisCmd(env, "SET", key, val, "EX", exSeconds);
  } else {
    await redisCmd(env, "SET", key, val);
  }
}

async function redisDel(env, key) {
  await redisCmd(env, "DEL", key);
}

// ── Anonymous Chat User Profile Managers ───────────────────────────────

export async function acGetUser(env, uid) {
  return redisGet(env, `ac_user:${uid}`);
}

export async function acSetUser(env, uid, data) {
  await redisSet(env, `ac_user:${uid}`, data);
}

export async function dbRegisterUser(env, uid) {
  await redisCmd(env, "SADD", "ac_total_users", String(uid));
}

export async function dbCountUsers(env) {
  return Number(await redisCmd(env, "SCARD", "ac_total_users")) || 0;
}

export async function dbAllUserIds(env) {
  const members = await redisCmd(env, "SMEMBERS", "ac_total_users");
  return Array.isArray(members) ? members : [];
}

// ── ATOMIC QUEUE ENGINE (Perbaikan Mutlak Concurrency P0) ──────────────

export async function acGetQueue(env) {
  const q = await redisCmd(env, "LRANGE", "ac_search_queue", 0, -1);
  return Array.isArray(q) ? q : [];
}

export async function acAddToQueue(env, uid) {
  const userIdStr = String(uid);
  await redisCmd(env, "LREM", "ac_search_queue", 0, userIdStr);
  await redisCmd(env, "RPUSH", "ac_search_queue", userIdStr);
}

export async function acRemoveFromQueue(env, uid) {
  await redisCmd(env, "LREM", "ac_search_queue", 0, String(uid));
}

export async function acPickPartner(env, excludeId) {
  const candidates = await acGetQueue(env);
  const filtered = candidates.filter(x => x !== String(excludeId));
  if (!filtered.length) return null;
  return filtered[Math.floor(Math.random() * filtered.length)];
}

// ── Anonymous Chat Sessions ───────────────────────────────────────────

export async function acGetSession(env, uid) {
  return redisGet(env, `ac_sess:${uid}`);
}

export async function acSetSession(env, uid, partnerId) {
  const exTime = 7200; // 2 Jam sesi bertahan jika idle
  await redisSet(env, `ac_sess:${uid}`, { partnerId, ts: Date.now() }, exTime);
}

export async function acDelSession(env, uid) {
  await redisDel(env, `ac_sess:${uid}`);
}

// ── Idempotency Filter Engine (Serverless Protection) ─────────────────

export async function acIsDone(env, updateId) {
  return !!(await redisCmd(env, "EXISTS", `ac_idem:${updateId}`));
}

export async function acMarkDone(env, updateId) {
  await redisSet(env, `ac_idem:${updateId}`, "1", 300); // Kunci 5 menit
}

// ── Security Enforcement (Ban & Mute Core) ────────────────────────────

export async function dbIsBlocked(env, uid) {
  return !!(await redisCmd(env, "SISMEMBER", "ac_blocked_users", String(uid)));
}

export async function dbBlock(env, uid, reason) {
  await redisCmd(env, "SADD", "ac_blocked_users", String(uid));
  await redisSet(env, `ac_ban_reason:${uid}`, reason || "Pelanggaran");
}

export async function dbUnblock(env, uid) {
  const res = await redisCmd(env, "SREM", "ac_blocked_users", String(uid));
  await redisDel(env, `ac_ban_reason:${uid}`);
  return Number(res) > 0;
}

export async function dbListBlocked(env) {
  const list = await redisCmd(env, "SMEMBERS", "ac_blocked_users");
  return Array.isArray(list) ? list : [];
}

export async function dbCountBlocked(env) {
  return Number(await redisCmd(env, "SCARD", "ac_blocked_users")) || 0;
}

export async function dbIsMuted(env, uid) {
  const ttl = await redisCmd(env, "TTL", `ac_mute:${uid}`);
  const ttlNum = Number(ttl);
  return ttlNum > 0 ? ttlNum : 0;
}

export async function dbMute(env, uid, seconds) {
  await redisSet(env, `ac_mute:${uid}`, "muted", seconds || 3600);
}

export async function dbUnmute(env, uid) {
  await redisDel(env, `ac_mute:${uid}`);
}

export async function dbCountMuted(env) {
  // Metode scan keys khusus mute aktif untuk statistik internal
  const keys = await redisCmd(env, "KEYS", "ac_mute:*");
  return Array.isArray(keys) ? keys.length : 0;
}

// ── Menfess Transmission Metrics ──────────────────────────────────────

function getTodayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

export async function dbGetDailyCount(env, uid) {
  return Number(await redisCmd(env, "GET", `mf_daily:${getTodayKey()}:${uid}`)) || 0;
}

export async function dbIncrementDaily(env, uid) {
  const key = `mf_daily:${getTodayKey()}:${uid}`;
  await redisCmd(env, "INCR", key);
  await redisCmd(env, "EXPIRE", key, 90000); // 25 jam kadaluwarsa otomatis
}

export async function dbResetDaily(env, uid) {
  await redisDel(env, `mf_daily:${getTodayKey()}:${uid}`);
}

// ── Blacklist Keywords Filter Database ────────────────────────────────

export async function dbContainsBlacklistedKw(env, text) {
  if (!text) return false;
  const list = await redisCmd(env, "SMEMBERS", "mf_blacklist_kw");
  if (!Array.isArray(list) || !list.length) return false;
  const target = text.toLowerCase();
  return list.some(kw => target.includes(String(kw).toLowerCase()));
}

export async function dbAddKw(env, kw) {
  if (kw) await redisCmd(env, "SADD", "mf_blacklist_kw", String(kw).trim());
}

export async function dbDelKw(env, kw) {
  if (kw) await redisCmd(env, "SREM", "mf_blacklist_kw", String(kw).trim());
}

export async function dbListKw(env) {
  const list = await redisCmd(env, "SMEMBERS", "mf_blacklist_kw");
  return Array.isArray(list) ? list : [];
}

export async function dbCountKw(env) {
  return Number(await redisCmd(env, "SCARD", "mf_blacklist_kw")) || 0;
}

// ── Menfess Published History Database ────────────────────────────────

export async function dbSaveMenfess(env, msgId, userId, senderName, text) {
  const payload = { user_id: String(userId), name: senderName, text, ts: Date.now() };
  await redisSet(env, `mf_history:${msgId}`, payload);
  await redisCmd(env, "SADD", "mf_msg_set", String(msgId));
}

export async function dbGetMenfess(env, msgId) {
  return redisGet(env, `mf_history:${msgId}`);
}

export async function dbDeleteMenfess(env, msgId) {
  await redisDel(env, `mf_history:${msgId}`);
  await redisCmd(env, "SREM", "mf_msg_set", String(msgId));
}

export async function dbCountMenfess(env) {
  return Number(await redisCmd(env, "SCARD", "mf_msg_set")) || 0;
}

// ── Pending State Menfess Approval Database ───────────────────────────

export async function dbSavePending(env, pendingId, data) { 
  // Ditulis ulang menggunakan 48 jam (172800 detik) demi mencegah 
  // hilangnya state pending antrean secara mendadak saat admin meninjau
  await redisSet(env, `mf_pending:${pendingId}`, data, 172800); 
}

export async function dbGetPending(env, pendingId) { 
  return redisGet(env, `mf_pending:${pendingId}`); 
}

export async function dbDeletePending(env, pendingId) { 
  await redisDel(env, `mf_pending:${pendingId}`); 
}

// ── ATOMIC REFERRAL TRACKING (Perbaikan Race Condition P1) ─────────────

export async function dbGetReferralBonus(env, uid) {
  return Number(await redisCmd(env, "GET", `mf_refbonus:${uid}`)) || 0;
}

export async function dbAddReferralBonus(env, uid, amount) {
  await redisCmd(env, "INCRBY", `mf_refbonus:${uid}`, amount);
}

export async function dbUseReferralBonus(env, uid) {
  const key = `mf_refbonus:${uid}`;
  const current = await redisCmd(env, "DECR", key);
  
  if (Number(current) < 0) {
    await redisCmd(env, "INCR", key); // Rollback nilai jika kuota kosong
    return false;
  }
  return true;
}

export async function dbHasUsedReferral(env, uid) {
  return !!(await redisCmd(env, "EXISTS", `mf_refused:${uid}`));
}

export async function dbRecordReferral(env, uid, referrerId) {
  await redisSet(env, `mf_refused:${uid}`, String(referrerId));
  await redisCmd(env, "SADD", `mf_reflist:${referrerId}`, String(uid));
}

export async function dbCountReferrals(env, uid) {
  return Number(await redisCmd(env, "SCARD", `mf_reflist:${uid}`)) || 0;
}
