// api/_db.js — Upstash Redis via HTTP
// Mengikuti PERSIS pola anonchat asli yang sudah terbukti jalan

// ── Redis core (identik dengan anonchat asli) ──

// api/_db.js — Upstash Redis via HTTP
// Mengikuti PERSIS pola anonchat asli yang sudah terbukti jalan

// ── Redis core ──

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
  try { return JSON.parse(result); } catch { return result; }\n}

async function redisSet(env, key, value, exSeconds) {
  const val = typeof value === \"string\" ? value : JSON.stringify(value);
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

// ── Anonymous Chat ──
export async function acGetUser(env, uid) { return redisGet(env, `ac_user:${uid}`); }
export async function acSetUser(env, uid, data) { await redisSet(env, `ac_user:${uid}`, data); }
export async function acGetSession(env, uid) { return redisGet(env, `ac_sess:${uid}`); }
export async function acSetSession(env, uid, partnerId) { await redisSet(env, `ac_sess:${uid}`, String(partnerId)); }
export async function acDelSession(env, uid) { await redisDel(env, `ac_sess:${uid}`); }
export async function acGetQueue(env) { return await redisCmd(env, "LRANGE", "ac_queue", 0, -1) || []; }
export async function acAddToQueue(env, uid) { await redisCmd(env, "RPUSH", "ac_queue", String(uid)); }
export async function acRemoveFromQueue(env, uid) { await redisCmd(env, "LREM", "ac_queue", 0, String(uid)); }
export async function acPickPartner(env, uid) {
  const queue = await acGetQueue(env);
  const filtered = queue.filter(id => String(id) !== String(uid));
  if (filtered.length === 0) return null;
  const partnerId = filtered[0];
  await acRemoveFromQueue(env, partnerId);
  return String(partnerId);
}
export async function acIsDone(env, uid) { return !!(await redisCmd(env, "EXISTS", `ac_done:${uid}`)); }
export async function acMarkDone(env, uid) { await redisSet(env, `ac_done:${uid}`, "1", 5); }

// ── General DB & Admin ──
export async function dbRegisterUser(env, uid) { await redisCmd(env, "SADD", "all_users", String(uid)); }
export async function dbCountUsers(env) { return Number(await redisCmd(env, "SCARD", "all_users")) || 0; }
export async function dbAllUserIds(env) { return await redisCmd(env, "SMEMBERS", "all_users") || []; }

export async function dbIsBlocked(env, uid) { return !!(await redisCmd(env, "SISMEMBER", "blocked_users", String(uid))); }
export async function dbBlock(env, uid) { await redisCmd(env, "SADD", "blocked_users", String(uid)); }
export async function dbUnblock(env, uid) { await redisCmd(env, "SREM", "blocked_users", String(uid)); }
export async function dbListBlocked(env) { return await redisCmd(env, "SMEMBERS", "blocked_users") || []; }
export async function dbCountBlocked(env) { return Number(await redisCmd(env, "SCARD", "blocked_users")) || 0; }

export async function dbIsMuted(env, uid) { return !!(await redisCmd(env, "SISMEMBER", "muted_users", String(uid))); }
export async function dbMute(env, uid) { await redisCmd(env, "SADD", "muted_users", String(uid)); }
export async function dbUnmute(env, uid) { await redisCmd(env, "SREM", "muted_users", String(uid)); }
export async function dbCountMuted(env) { return Number(await redisCmd(env, "SCARD", "muted_users")) || 0; }

export async function dbGetDailyCount(env) { const d = todayWib(); return Number(await redisCmd(env, "GET", `daily_msg:${d}`)) || 0; }
export async function dbIncrementDaily(env) { const d = todayWib(); await redisCmd(env, "INCR", `daily_msg:${d}`); await redisCmd(env, "EXPIRE", `daily_msg:${d}`, 172800); }
export async function dbResetDaily(env) { const d = todayWib(); await redisDel(env, `daily_msg:${d}`); }

export async function dbContainsBlacklistedKw(env, text) {
  const kws = await redisCmd(env, "SMEMBERS", "blacklist_keywords") || [];
  const t = String(text).toLowerCase();
  return kws.some(k => t.includes(String(k).toLowerCase()));
}
export async function dbAddKw(env, kw) { await redisCmd(env, "SADD", "blacklist_keywords", String(kw).trim()); }
export async function dbDelKw(env, kw) { await redisCmd(env, "SREM", "blacklist_keywords", String(kw).trim()); }
export async function dbListKw(env) { return await redisCmd(env, "SMEMBERS", "blacklist_keywords") || []; }
export async function dbCountKw(env) { return Number(await redisCmd(env, "SCARD", "blacklist_keywords")) || 0; }

// ── Menfess ──
export async function dbSaveMenfess(env, msgId, data) {
  await redisSet(env, `mf_msg:${msgId}`, data, 604800);
  await redisCmd(env, "INCR", "mf_total_count");
}
export async function dbGetMenfess(env, msgId) { return redisGet(env, `mf_msg:${msgId}`); }
export async function dbDeleteMenfess(env, msgId) { await redisDel(env, `mf_msg:${msgId}`); }
export async function dbCountMenfess(env) {
  return Number(await redisCmd(env, "GET", "mf_total_count")) || 0;
}

// ── Pending ──
export async function dbSavePending(env, uid, data) { await redisSet(env, `mf_pending:${uid}`, data, 300); }
export async function dbGetPending(env, uid)        { return redisGet(env, `mf_pending:${uid}`); }
export async function dbDeletePending(env, uid)     { await redisDel(env, `mf_pending:${uid}`); }

// ── Referral ──
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
export async function dbRecordReferral(env, uid, refId) {
  await redisCmd(env, "SET", `mf_refused:${uid}`, String(refId));
  await redisCmd(env, "SADD", `mf_referrals_list:${refId}`, String(uid));
}
export async function dbCountReferrals(env, uid) {
  return Number(await redisCmd(env, "SCARD", `mf_referrals_list:${uid}`)) || 0;
}

// ── Contact Admin & Admin Reply Session ──
export async function dbGetContactState(env, uid) { return redisGet(env, `contact_state:${uid}`); }
export async function dbSetContactState(env, uid, data) { await redisSet(env, `contact_state:${uid}`, data, 86400); }
export async function dbDelContactState(env, uid) { await redisDel(env, `contact_state:${uid}`); }
export async function dbGetAdminReply(env, adminId) { return redisGet(env, `admin_reply:${adminId}`); }
export async function dbSetAdminReply(env, adminId, targetUid) { await redisSet(env, `admin_reply:${adminId}`, { targetUid }, 3600); }
export async function dbDelAdminReply(env, adminId) { await redisDel(env, `admin_reply:${adminId}`); }
