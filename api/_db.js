// api/_db.js — Upstash Redis via HTTP
// Mengikuti PERSIS pola anonchat asli yang sudah terbukti jalan

// ── Redis core (identik dengan anonchat asli) ──

// api/_db.js — Upstash Redis via HTTP
// Production Hardened Edition — Bagian 1 dari 2
// Mengikuti PERSIS pola asli yang terbukti jalan dengan penguatan struktur data

const REDIS_TIMEOUT_MS = 5000;

// ── Redis Core Engine ──────────────────────────────────────────────────

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
    console.error("redisCmd error:", e.name === "AbortError" ? "TIMEOUT" : e.message, args[0], args[1]);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function redisGet(env, key) {
  const result = await redisCmd(env, "GET", key);
  if (result === null) return null;
  if (typeof result !== "string") return result;
  try { return JSON.parse(result); } catch { return result; }
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

function todayWib() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
}

// ── Anonymous Chat Engine (Atomic Native Flow) ──────────────────────────

export async function acGetUser(env, uid)       { return redisGet(env, `user:${uid}`); }
export async function acSetUser(env, uid, data) { return redisSet(env, `user:${uid}`, data); }

export async function acGetSession(env, uid)    { return redisGet(env, `session:${uid}`); }
export async function acDelSession(env, uid)    { return redisDel(env, `session:${uid}`); }

export async function acSetSession(env, u1, u2) {
  const now = Date.now();
  await redisSet(env, `session:${u1}`, { partnerId: u2, startedAt: now }, 86400);
  await redisSet(env, `session:${u2}`, { partnerId: u1, startedAt: now }, 86400);
}

export async function acGetQueue(env) {
  const q = await redisGet(env, "queue");
  return Array.isArray(q) ? q : [];
}

export async function acAddToQueue(env, uid) {
  const q = await acGetQueue(env);
  if (!q.includes(String(uid))) {
    q.push(String(uid));
    await redisSet(env, "queue", q);
  }
}

export async function acRemoveFromQueue(env, uid) {
  const q = await acGetQueue(env);
  const next = q.filter(x => x !== String(uid));
  await redisSet(env, "queue", next);
}

export async function acPickPartner(env, excludeId) {
  const q = await acGetQueue(env);
  const candidates = q.filter(x => x !== String(excludeId));
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export async function acIsDone(env, uid)   { return (await redisGet(env, `done:${uid}`)) !== null; }
export async function acMarkDone(env, uid) { return redisSet(env, `done:${uid}`, 1, 3600); }

// ── Menfess System User Registration & Stats ──────────────────────────

export async function dbRegisterUser(env, uid) {
  await redisSet(env, `mf_user:${uid}`, "1");
  await redisCmd(env, "SADD", "mf_users_list", String(uid));
}

export async function dbCountUsers(env) {
  return Number(await redisCmd(env, "SCARD", "mf_users_list")) || 0;
}

export async function dbAllUserIds(env) {
  const r = await redisCmd(env, "SMEMBERS", "mf_users_list");
  return Array.isArray(r) ? r.map(Number) : [];
}

// ── Block & Mute System ────────────────────────────────────────────────

export async function dbIsBlocked(env, uid) {
  return redisGet(env, `mf_blocked:${uid}`);
}

export async function dbBlock(env, uid, reason) {
  await redisSet(env, `mf_blocked:${uid}`, {
    reason,
    blocked_at: new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }),
  });
  await redisCmd(env, "SADD", "mf_blocked_set", String(uid));
}

export async function dbUnblock(env, uid) {
  const exists = await redisCmd(env, "EXISTS", `mf_blocked:${uid}`);
  if (!exists) return false;
  await redisDel(env, `mf_blocked:${uid}`);
  await redisCmd(env, "SREM", "mf_blocked_set", String(uid));
  return true;
}

export async function dbListBlocked(env) {
  const members = await redisCmd(env, "SMEMBERS", "mf_blocked_set");
  if (!Array.isArray(members) || !members.length) return [];
  const results = await Promise.all(members.map(uid => redisGet(env, `mf_blocked:${uid}`)));
  return members
    .map((uid, i) => results[i] ? { user_id: uid, ...results[i] } : null)
    .filter(Boolean);
}

export async function dbCountBlocked(env) {
  return Number(await redisCmd(env, "SCARD", "mf_blocked_set")) || 0;
}

export async function dbIsMuted(env, uid) {
  const exp = await redisCmd(env, "TTL", `mf_muted:${uid}`);
  return exp > 0 ? exp : 0;
}

export async function dbMute(env, uid, seconds) {
  await redisSet(env, `mf_muted:${uid}`, "1", seconds);
  await redisCmd(env, "SADD", "mf_muted_set", String(uid));
}

export async function dbUnmute(env, uid) {
  await redisDel(env, `mf_muted:${uid}`);
  await redisCmd(env, "SREM", "mf_muted_set", String(uid));
}

export async function dbCountMuted(env) {
  const members = await redisCmd(env, "SMEMBERS", "mf_muted_set");
  if (!Array.isArray(members) || !members.length) return 0;
  let activeCount = 0;
  for (const uid of members) {
    const ttl = await redisCmd(env, "TTL", `mf_muted:${uid}`);
    if (ttl <= 0) {
      await redisCmd(env, "SREM", "mf_muted_set", uid);
    } else {
      activeCount++;
    }
  }
  return activeCount;
}

// ── Daily Counter Menfess Limit ────────────────────────────────────────

export async function dbGetDailyCount(env, uid) {
  return Number(await redisCmd(env, "GET", `mf_daily:${todayWib()}:${uid}`)) || 0;
}

export async function dbIncrementDaily(env, uid) {
  const key = `mf_daily:${todayWib()}:${uid}`;
  await redisCmd(env, "INCR", key);
  await redisCmd(env, "EXPIRE", key, 172800); // Masa aktif 48 jam safe backup
}

export async function dbResetDaily(env, uid) {
  await redisDel(env, `mf_daily:${todayWib()}:${uid}`);
}

// ── Blacklist Word Filter ──────────────────────────────────────────────

export async function dbContainsBlacklistedKw(env, text) {
  if (!text) return false;
  const kws = await redisCmd(env, "SMEMBERS", "mf_blacklist_kw");
  if (!Array.isArray(kws) || !kws.length) return false;
  const lowered = text.toLowerCase();
  return kws.some(kw => lowered.includes(kw.toLowerCase()));
}

export async function dbAddKw(env, kw) { await redisCmd(env, "SADD", "mf_blacklist_kw", kw.trim()); }
export async function dbDelKw(env, kw) { await redisCmd(env, "SREM", "mf_blacklist_kw", kw.trim()); }
export async function dbListKw(env)    { return (await redisCmd(env, "SMEMBERS", "mf_blacklist_kw")) || []; }
export async function dbCountKw(env)   { return Number(await redisCmd(env, "SCARD", "mf_blacklist_kw")) || 0; }

// ── Menfess Crud Data Log ──────────────────────────────────────────────

export async function dbSaveMenfess(env, msgId, userId, senderName, text) {
  await redisSet(env, `mf_msg:${msgId}`, { user_id: userId, senderName, text, created_at: Date.now() }, 604800); // Log aktif 7 hari
  await redisCmd(env, "SADD", "mf_msg_set", String(msgId));
}

export async function dbGetMenfess(env, msgId) { return redisGet(env, `mf_msg:${msgId}`); }

export async function dbDeleteMenfess(env, msgId) {
  await redisDel(env, `mf_msg:${msgId}`);
  await redisCmd(env, "SREM", "mf_msg_set", String(msgId));
}

export async function dbCountMenfess(env) {
  return Number(await redisCmd(env, "SCARD", "mf_msg_set")) || 0;
}

// ── Pending State Menfess Approval ─────────────────────────────────────

export async function dbSavePending(env, uid, data) { await redisSet(env, `mf_pending:${uid}`, data, 172800); }
export async function dbGetPending(env, uid)        { return redisGet(env, `mf_pending:${uid}`); }
export async function dbDeletePending(env, uid)     { await redisDel(env, `mf_pending:${uid}`); }

// ── Referral System Core ────────────────────────────────────────────────

export async function dbGetReferralBonus(env, uid) {
  return Number(await redisCmd(env, "GET", `mf_refbonus:${uid}`)) || 0;
}

export async function dbAddReferralBonus(env, uid, amount) {
  await redisCmd(env, "INCRBY", `mf_refbonus:${uid}`, amount);
}

export async function dbUseReferralBonus(env, uid) {
  const bonus = await dbGetReferralBonus(env, uid);
  if (bonus > 0) {
    await redisCmd(env, "DECR", `mf_refbonus:${uid}`);
    return true;
  }
  return false;
}

export async function dbHasUsedReferral(env, uid) {
  return !!(await redisCmd(env, "EXISTS", `mf_refused:${uid}`));
}

export async function dbRecordReferral(env, uid, referrerId) {
  await redisSet(env, `mf_refused:${uid}`, String(referrerId));
  await redisCmd(env, "SADD", `mf_referrals_list:${referrerId}`, String(uid));
}

export async function dbCountReferrals(env, uid) {
  return Number(await redisCmd(env, "SCARD", `mf_referrals_list:${uid}`)) || 0;
}

