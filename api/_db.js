// api/_db.js — Upstash Redis via HTTP
// Mengikuti PERSIS pola anonchat asli yang sudah terbukti jalan

// ── Redis core (identik dengan anonchat asli) ──

async function redisCmd(env, ...args) {
  try {
    const res = await fetch(env.KV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.KV_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    return data?.result ?? null;
  } catch (e) {
    console.error("redisCmd error:", e.message);
    return null;
  }
}

async function redisGet(env, key) {
  const result = await redisCmd(env, "GET", key);
  if (result === null) return null;
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

// ══════════════════════════════════════════
// ANONYMOUS CHAT — persis sama dengan asli
// ══════════════════════════════════════════

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
  await redisSet(env, "queue", q.filter(x => x !== String(uid)));
}

export async function acPickPartner(env, excludeId) {
  const q = await acGetQueue(env);
  const candidates = q.filter(x => x !== String(excludeId));
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export async function acIsDone(env, uid)  { return (await redisGet(env, `done:${uid}`)) !== null; }
export async function acMarkDone(env, uid){ return redisSet(env, `done:${uid}`, 1, 3600); }

// ══════════════════════════════════════════
// MENFESS — prefix "mf_" agar tidak tabrakan
// ══════════════════════════════════════════

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

// Block
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

// Mute
export async function dbIsMuted(env, uid) {
  const raw = await redisGet(env, `mf_muted:${uid}`);
  if (!raw) return null;
  if (new Date(raw) <= new Date()) { await redisDel(env, `mf_muted:${uid}`); return null; }
  return raw;
}
export async function dbMute(env, uid, until) {
  const ttl = Math.ceil((until - new Date()) / 1000);
  await redisCmd(env, "SET", `mf_muted:${uid}`, until.toISOString(), "EX", ttl);
  await redisCmd(env, "SADD", "mf_muted_set", String(uid));
}
export async function dbUnmute(env, uid) {
  const exists = await redisCmd(env, "EXISTS", `mf_muted:${uid}`);
  if (!exists) return false;
  await redisDel(env, `mf_muted:${uid}`);
  await redisCmd(env, "SREM", "mf_muted_set", String(uid));
  return true;
}
export async function dbCountMuted(env) {
  // Count members in set whose mute key still exists (not expired)
  const members = await redisCmd(env, "SMEMBERS", "mf_muted_set");
  if (!Array.isArray(members) || !members.length) return 0;
  const checks = await Promise.all(members.map(uid => redisCmd(env, "EXISTS", `mf_muted:${uid}`)));
  // Clean up expired members from set
  const expired = members.filter((_, i) => !checks[i]);
  if (expired.length) {
    await Promise.all(expired.map(uid => redisCmd(env, "SREM", "mf_muted_set", uid)));
  }
  return checks.filter(Boolean).length;
}

// Daily limit
export async function dbGetDailyCount(env, uid) {
  return Number(await redisCmd(env, "GET", `mf_daily:${uid}:${todayWib()}`)) || 0;
}
export async function dbIncrementDaily(env, uid) {
  const key = `mf_daily:${uid}:${todayWib()}`;
  await redisCmd(env, "INCR", key);
  await redisCmd(env, "EXPIRE", key, 172800);
}
export async function dbResetDaily(env, uid) {
  const key = `mf_daily:${uid}:${todayWib()}`;
  const exists = await redisCmd(env, "EXISTS", key);
  if (!exists) return false;
  await redisDel(env, key);
  return true;
}

// Keywords
export async function dbContainsBlacklistedKw(env, text) {
  const kws = await redisCmd(env, "SMEMBERS", "mf_kwbl");
  if (!Array.isArray(kws) || !kws.length) return null;
  const lower = text.toLowerCase();
  for (const kw of kws) if (lower.includes(kw.toLowerCase())) return kw;
  return null;
}
export async function dbAddKw(env, kw)  { await redisCmd(env, "SADD", "mf_kwbl", kw); }
export async function dbDelKw(env, kw)  { return Number(await redisCmd(env, "SREM", "mf_kwbl", kw)) > 0; }
export async function dbListKw(env)     { const r = await redisCmd(env, "SMEMBERS", "mf_kwbl"); return Array.isArray(r) ? r.sort() : []; }
export async function dbCountKw(env)    { return Number(await redisCmd(env, "SCARD", "mf_kwbl")) || 0; }

// Menfess data
export async function dbSaveMenfess(env, msgId, uid, autoDeleteAt) {
  const ttl = autoDeleteAt ? Math.ceil((autoDeleteAt - new Date()) / 1000) + 120 : 604800;
  await redisCmd(env, "SET", `mf_msg:${msgId}`,
    JSON.stringify({ user_id: uid, sent_at: new Date().toISOString(), auto_delete_at: autoDeleteAt?.toISOString() || null }),
    "EX", ttl
  );
  await redisCmd(env, "SADD", "mf_msg_set", String(msgId));
}
export async function dbGetMenfess(env, msgId)    { return redisGet(env, `mf_msg:${msgId}`); }
export async function dbDeleteMenfess(env, msgId) {
  await redisDel(env, `mf_msg:${msgId}`);
  await redisCmd(env, "SREM", "mf_msg_set", String(msgId));
}
export async function dbCountMenfess(env) {
  return Number(await redisCmd(env, "SCARD", "mf_msg_set")) || 0;
}

// Pending
export async function dbSavePending(env, uid, data) { await redisSet(env, `mf_pending:${uid}`, data, 300); }
export async function dbGetPending(env, uid)        { return redisGet(env, `mf_pending:${uid}`); }
export async function dbDeletePending(env, uid)     { await redisDel(env, `mf_pending:${uid}`); }

// Referral
export async function dbGetReferralBonus(env, uid) {
  return Number(await redisCmd(env, "GET", `mf_refbonus:${uid}`)) || 0;
}
export async function dbAddReferralBonus(env, uid, amount) {
  await redisCmd(env, "INCRBY", `mf_refbonus:${uid}`, amount);
}
export async function dbUseReferralBonus(env, uid) {
  const bonus = await dbGetReferralBonus(env, uid);
  if (bonus > 0) { await redisCmd(env, "DECR", `mf_refbonus:${uid}`); return true; }
  return false;
}
export async function dbHasUsedReferral(env, uid) {
  return !!(await redisCmd(env, "EXISTS", `mf_refused:${uid}`));
}
export async function dbRecordReferral(env, newUid, referrerId) {
  await redisCmd(env, "SET", `mf_refused:${newUid}`, String(referrerId));
  await redisCmd(env, "INCR", `mf_refcount:${referrerId}`);
}
export async function dbCountReferrals(env, uid) {
  return Number(await redisCmd(env, "GET", `mf_refcount:${uid}`)) || 0;
}
