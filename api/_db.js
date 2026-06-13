// api/_db.js
// Unified database layer — Upstash Redis via HTTP REST
// Covers: Anonymous Chat + Menfess Bot

// ── Redis core ─────────────────────────────────

async function redisCmd(url, token, ...args) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    return data?.result ?? null;
  } catch (e) {
    console.error("redisCmd error:", e.message);
    return null;
  }
}

async function redisPipe(url, token, commands) {
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    });
    return await res.json();
  } catch (e) {
    console.error("redisPipe error:", e.message);
    return [];
  }
}

function r(env) { return { url: env.KV_URL, token: env.KV_TOKEN }; }

async function get(env, key) {
  const raw = await redisCmd(r(env).url, r(env).token, "GET", key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function set(env, key, value, exSec) {
  const val = typeof value === "string" ? value : JSON.stringify(value);
  if (exSec) return redisCmd(r(env).url, r(env).token, "SET", key, val, "EX", exSec);
  return redisCmd(r(env).url, r(env).token, "SET", key, val);
}

async function del(env, key) {
  return redisCmd(r(env).url, r(env).token, "DEL", key);
}

function today(env) {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
}

// ═══════════════════════════════════════════════
// ANONYMOUS CHAT
// ═══════════════════════════════════════════════

// User profile: { gender, status, lastNext }
export async function acGetUser(env, uid)       { return get(env, `user:${uid}`); }
export async function acSetUser(env, uid, data) { return set(env, `user:${uid}`, data); }

// Session: { partnerId, startedAt }
export async function acGetSession(env, uid)    { return get(env, `session:${uid}`); }
export async function acDelSession(env, uid)    { return del(env, `session:${uid}`); }

export async function acSetSession(env, u1, u2) {
  const now = Date.now();
  await redisPipe(r(env).url, r(env).token, [
    ["SET", `session:${u1}`, JSON.stringify({ partnerId: u2, startedAt: now })],
    ["SET", `session:${u2}`, JSON.stringify({ partnerId: u1, startedAt: now })],
  ]);
}

// Queue
export async function acGetQueue(env) {
  const q = await get(env, "queue");
  return Array.isArray(q) ? q : [];
}

export async function acAddToQueue(env, uid) {
  const q = await acGetQueue(env);
  if (!q.includes(String(uid))) {
    q.push(String(uid));
    await set(env, "queue", q);
  }
}

export async function acRemoveFromQueue(env, uid) {
  const q = await acGetQueue(env);
  await set(env, "queue", q.filter(x => x !== String(uid)));
}

export async function acPickPartner(env, excludeId) {
  const q = await acGetQueue(env);
  const candidates = q.filter(x => x !== String(excludeId));
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Idempotency — cegah duplicate update
export async function acIsDone(env, uid)  { return (await get(env, `done:${uid}`)) !== null; }
export async function acMarkDone(env, uid){ return set(env, `done:${uid}`, 1, 3600); }

// Stats
export async function acCountUsers(env) {
  const keys = await redisCmd(r(env).url, r(env).token, "KEYS", "user:*");
  // filter hanya user anonchat (bukan user menfess yang pakai prefix berbeda)
  return Array.isArray(keys) ? keys.filter(k => !k.includes(":") || k.split(":").length === 2).length : 0;
}

// ═══════════════════════════════════════════════
// MENFESS — USERS
// ═══════════════════════════════════════════════

export async function dbRegisterUser(env, uid) {
  await redisPipe(r(env).url, r(env).token, [
    ["SET", `mf_user:${uid}`, "1"],
    ["SADD", "mf_users_list", String(uid)],
  ]);
}

export async function dbCountUsers(env) {
  return Number(await redisCmd(r(env).url, r(env).token, "SCARD", "mf_users_list")) || 0;
}

export async function dbAllUserIds(env) {
  const res = await redisCmd(r(env).url, r(env).token, "SMEMBERS", "mf_users_list");
  return Array.isArray(res) ? res.map(Number) : [];
}

// ── Menfess: Block ─────────────────────────────

export async function dbIsBlocked(env, uid) {
  const raw = await redisCmd(r(env).url, r(env).token, "GET", `mf_blocked:${uid}`);
  return raw ? JSON.parse(raw) : null;
}

export async function dbBlock(env, uid, reason) {
  await set(env, `mf_blocked:${uid}`, { reason, blocked_at: new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) });
}

export async function dbUnblock(env, uid) {
  const exists = await redisCmd(r(env).url, r(env).token, "EXISTS", `mf_blocked:${uid}`);
  if (!exists) return false;
  await del(env, `mf_blocked:${uid}`);
  return true;
}

export async function dbListBlocked(env) {
  const keys = await redisCmd(r(env).url, r(env).token, "KEYS", "mf_blocked:*");
  if (!keys?.length) return [];
  const results = await redisPipe(r(env).url, r(env).token, keys.map(k => ["GET", k]));
  return keys.map((k, i) => ({ user_id: k.replace("mf_blocked:", ""), ...JSON.parse(results[i]?.result || "{}") }));
}

export async function dbCountBlocked(env) {
  const keys = await redisCmd(r(env).url, r(env).token, "KEYS", "mf_blocked:*");
  return Array.isArray(keys) ? keys.length : 0;
}

// ── Menfess: Mute ──────────────────────────────

export async function dbIsMuted(env, uid) {
  const raw = await redisCmd(r(env).url, r(env).token, "GET", `mf_muted:${uid}`);
  if (!raw) return null;
  if (new Date(raw) <= new Date()) { await del(env, `mf_muted:${uid}`); return null; }
  return raw;
}

export async function dbMute(env, uid, until) {
  const ttl = Math.ceil((until - new Date()) / 1000);
  await redisCmd(r(env).url, r(env).token, "SET", `mf_muted:${uid}`, until.toISOString(), "EX", ttl);
}

export async function dbUnmute(env, uid) {
  const exists = await redisCmd(r(env).url, r(env).token, "EXISTS", `mf_muted:${uid}`);
  if (!exists) return false;
  await del(env, `mf_muted:${uid}`);
  return true;
}

export async function dbCountMuted(env) {
  const keys = await redisCmd(r(env).url, r(env).token, "KEYS", "mf_muted:*");
  return Array.isArray(keys) ? keys.length : 0;
}

// ── Menfess: Daily limit ───────────────────────

export async function dbGetDailyCount(env, uid) {
  return Number(await redisCmd(r(env).url, r(env).token, "GET", `mf_daily:${uid}:${today()}`)) || 0;
}

export async function dbIncrementDaily(env, uid) {
  const key = `mf_daily:${uid}:${today()}`;
  await redisPipe(r(env).url, r(env).token, [["INCR", key], ["EXPIRE", key, 172800]]);
}

export async function dbResetDaily(env, uid) {
  const key = `mf_daily:${uid}:${today()}`;
  const exists = await redisCmd(r(env).url, r(env).token, "EXISTS", key);
  if (!exists) return false;
  await del(env, key);
  return true;
}

// ── Menfess: Keywords ──────────────────────────

export async function dbContainsBlacklistedKw(env, text) {
  const kws = await redisCmd(r(env).url, r(env).token, "SMEMBERS", "mf_kwbl");
  if (!kws?.length) return null;
  const lower = text.toLowerCase();
  for (const kw of kws) if (lower.includes(kw.toLowerCase())) return kw;
  return null;
}

export async function dbAddKw(env, kw) {
  await redisCmd(r(env).url, r(env).token, "SADD", "mf_kwbl", kw);
}

export async function dbDelKw(env, kw) {
  return Number(await redisCmd(r(env).url, r(env).token, "SREM", "mf_kwbl", kw)) > 0;
}

export async function dbListKw(env) {
  const res = await redisCmd(r(env).url, r(env).token, "SMEMBERS", "mf_kwbl");
  return Array.isArray(res) ? res.sort() : [];
}

export async function dbCountKw(env) {
  return Number(await redisCmd(r(env).url, r(env).token, "SCARD", "mf_kwbl")) || 0;
}

// ── Menfess: Menfess data ──────────────────────

export async function dbSaveMenfess(env, msgId, uid, autoDeleteAt) {
  const ttl = autoDeleteAt ? Math.ceil((autoDeleteAt - new Date()) / 1000) + 120 : 604800;
  await set(env, `mf_msg:${msgId}`, { user_id: uid, sent_at: new Date().toISOString(), auto_delete_at: autoDeleteAt?.toISOString() || null }, ttl);
}

export async function dbGetMenfess(env, msgId) {
  return get(env, `mf_msg:${msgId}`);
}

export async function dbDeleteMenfess(env, msgId) {
  await del(env, `mf_msg:${msgId}`);
}

export async function dbCountMenfess(env) {
  const keys = await redisCmd(r(env).url, r(env).token, "KEYS", "mf_msg:*");
  return Array.isArray(keys) ? keys.length : 0;
}

// ── Menfess: Pending ───────────────────────────

export async function dbSavePending(env, uid, data) {
  await set(env, `mf_pending:${uid}`, data, 300);
}

export async function dbGetPending(env, uid) {
  return get(env, `mf_pending:${uid}`);
}

export async function dbDeletePending(env, uid) {
  await del(env, `mf_pending:${uid}`);
}

// ── Menfess: Referral ──────────────────────────

export async function dbGetReferralBonus(env, uid) {
  return Number(await redisCmd(r(env).url, r(env).token, "GET", `mf_refbonus:${uid}`)) || 0;
}

export async function dbAddReferralBonus(env, uid, amount) {
  await redisCmd(r(env).url, r(env).token, "INCRBY", `mf_refbonus:${uid}`, amount);
}

export async function dbUseReferralBonus(env, uid) {
  const bonus = await dbGetReferralBonus(env, uid);
  if (bonus > 0) { await redisCmd(r(env).url, r(env).token, "DECR", `mf_refbonus:${uid}`); return true; }
  return false;
}

export async function dbHasUsedReferral(env, uid) {
  return !!(await redisCmd(r(env).url, r(env).token, "EXISTS", `mf_refused:${uid}`));
}

export async function dbRecordReferral(env, newUid, referrerId) {
  await redisPipe(r(env).url, r(env).token, [
    ["SET", `mf_refused:${newUid}`, String(referrerId)],
    ["INCR", `mf_refcount:${referrerId}`],
  ]);
}

export async function dbCountReferrals(env, uid) {
  return Number(await redisCmd(r(env).url, r(env).token, "GET", `mf_refcount:${uid}`)) || 0;
}
