// api/_db.js — Upstash Redis via HTTP REST
// Production-hardened: timeout, safe JSON parse, SCARD-based counters
//
// Strategi hybrid: Redis tetap jadi PRIMARY untuk semua data yang dibaca
// di jalur kritis (real-time, per-request user) — block/mute/kuota/referral check,
// session & queue anon chat. GAS Sheets jadi SECONDARY/arsip permanen,
// ditulis paralel (fire-and-forget) tiap kali ada perubahan, supaya:
//   1. Kalau GAS down/lambat, bot tetap jalan normal (tidak nunggu GAS)
//   2. Data tetap punya histori permanen di Spreadsheet untuk dilihat manual
//   3. Beban baca-tulis Redis bisa dipantau, tapi tidak hilang fungsinya

import {
  shRegisterUser, shBlock, shUnblock, shMute, shUnmute,
  shAddKw, shDelKw, shAddReferralBonus, shUseReferralBonus, shRecordReferral,
  shSaveMenfess, shDeleteMenfess,
} from "./_sheets.js";

const REDIS_TIMEOUT_MS = 5000;

// ── Redis core ──────────────────────────────────────────────────

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

// ══════════════════════════════════════════════════════════
// ANONYMOUS CHAT
// ══════════════════════════════════════════════════════════

export async function acGetUser(env, uid) { return redisGet(env, `user:${uid}`); }

export async function acSetUser(env, uid, data) {
  await redisSet(env, `user:${uid}`, data);
  // Maintain status index sets so admin can count searching/chatting users
  // without scanning every user:{id} key (no KEYS command needed).
  const id = String(uid);
  if (data?.status === "searching") {
    await redisCmd(env, "SADD", "ac_searching_set", id);
    await redisCmd(env, "SREM", "ac_chatting_set", id);
  } else if (data?.status === "chatting") {
    await redisCmd(env, "SADD", "ac_chatting_set", id);
    await redisCmd(env, "SREM", "ac_searching_set", id);
  } else {
    // idle or any other status — remove from both index sets
    await redisCmd(env, "SREM", "ac_searching_set", id);
    await redisCmd(env, "SREM", "ac_chatting_set", id);
  }
}

// Jumlah user yang sedang aktif mencari partner (status: searching)
export async function acCountSearching(env) {
  return Number(await redisCmd(env, "SCARD", "ac_searching_set")) || 0;
}

// Jumlah user yang sedang dalam sesi chat aktif (status: chatting)
// Dibagi 2 karena setiap pasangan chatting tercatat sebagai 2 entry (kedua user)
export async function acCountChattingUsers(env) {
  return Number(await redisCmd(env, "SCARD", "ac_chatting_set")) || 0;
}

export async function acCountActiveSessions(env) {
  const chattingUsers = await acCountChattingUsers(env);
  return Math.floor(chattingUsers / 2);
}

export async function acGetSession(env, uid)    { return redisGet(env, `session:${uid}`); }
export async function acDelSession(env, uid)    { return redisDel(env, `session:${uid}`); }

export async function acSetSession(env, u1, u2) {
  const now = Date.now();
  // Write both session directions — if one fails, other side has stale session
  // TTL 24h covers any reasonable chat session
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

// Idempotency: mark update_id as processed, TTL 1h
export async function acIsDone(env, uid)   { return (await redisGet(env, `done:${uid}`)) !== null; }
export async function acMarkDone(env, uid) { return redisSet(env, `done:${uid}`, 1, 3600); }

// ══════════════════════════════════════════════════════════
// MENFESS — prefix "mf_" agar tidak tabrakan dengan anon chat
// ══════════════════════════════════════════════════════════

export async function dbRegisterUser(env, uid, gender = "", username = "") {
  await redisSet(env, `mf_user:${uid}`, "1");
  await redisCmd(env, "SADD", "mf_users_list", String(uid));
  if (env.GAS_URL) shRegisterUser(env, uid, gender, username).catch(e => console.error("shRegisterUser sync failed:", e.message));
}

export async function dbCountUsers(env) {
  return Number(await redisCmd(env, "SCARD", "mf_users_list")) || 0;
}

export async function dbAllUserIds(env) {
  const r = await redisCmd(env, "SMEMBERS", "mf_users_list");
  return Array.isArray(r) ? r.map(Number) : [];
}

// ── Block ────────────────────────────────────────────────

// ── Block ────────────────────────────────────────────────
// Redis = cache cepat untuk dibaca tiap kali user kirim menfess (real-time check)
// GAS Sheets = source of truth permanen, ditulis paralel tiap kali admin block/unblock

export async function dbIsBlocked(env, uid) {
  return redisGet(env, `mf_blocked:${uid}`);
}

export async function dbBlock(env, uid, reason) {
  const blockedAt = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  await redisSet(env, `mf_blocked:${uid}`, { reason, blocked_at: blockedAt });
  await redisCmd(env, "SADD", "mf_blocked_set", String(uid));
  // Tulis ke Sheets di background — tidak menunggu, tidak menggagalkan aksi kalau GAS lambat
  if (env.GAS_URL) shBlock(env, uid, reason).catch(e => console.error("shBlock sync failed:", e.message));
}

export async function dbUnblock(env, uid) {
  const exists = await redisCmd(env, "EXISTS", `mf_blocked:${uid}`);
  if (!exists) return false;
  await redisDel(env, `mf_blocked:${uid}`);
  await redisCmd(env, "SREM", "mf_blocked_set", String(uid));
  if (env.GAS_URL) shUnblock(env, uid).catch(e => console.error("shUnblock sync failed:", e.message));
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

// ── Mute ─────────────────────────────────────────────────

export async function dbIsMuted(env, uid) {
  const raw = await redisGet(env, `mf_muted:${uid}`);
  if (!raw) return null;
  // raw is a string (ISO date) — check if still in the future
  const until = new Date(typeof raw === "string" ? raw : String(raw));
  if (isNaN(until.getTime()) || until <= new Date()) {
    await redisDel(env, `mf_muted:${uid}`);
    await redisCmd(env, "SREM", "mf_muted_set", String(uid));
    return null;
  }
  return raw;
}

export async function dbMute(env, uid, until) {
  const ttl = Math.ceil((until - new Date()) / 1000);
  if (ttl <= 0) return; // do nothing if already expired
  // Store raw ISO string, not JSON, so redisGet doesn't try to parse as object
  await redisCmd(env, "SET", `mf_muted:${uid}`, until.toISOString(), "EX", ttl);
  await redisCmd(env, "SADD", "mf_muted_set", String(uid));
  if (env.GAS_URL) shMute(env, uid, until).catch(e => console.error("shMute sync failed:", e.message));
}

export async function dbUnmute(env, uid) {
  const exists = await redisCmd(env, "EXISTS", `mf_muted:${uid}`);
  if (!exists) return false;
  await redisDel(env, `mf_muted:${uid}`);
  await redisCmd(env, "SREM", "mf_muted_set", String(uid));
  if (env.GAS_URL) shUnmute(env, uid).catch(e => console.error("shUnmute sync failed:", e.message));
  return true;
}

export async function dbCountMuted(env) {
  const members = await redisCmd(env, "SMEMBERS", "mf_muted_set");
  if (!Array.isArray(members) || !members.length) return 0;
  const checks = await Promise.all(members.map(uid => redisCmd(env, "EXISTS", `mf_muted:${uid}`)));
  // Prune expired entries from set asynchronously (don't block count)
  const expired = members.filter((_, i) => !checks[i]);
  if (expired.length) {
    Promise.all(expired.map(uid => redisCmd(env, "SREM", "mf_muted_set", uid))).catch(() => {});
  }
  return checks.filter(Boolean).length;
}

// ── Daily limit ───────────────────────────────────────────

export async function dbGetDailyCount(env, uid) {
  return Number(await redisCmd(env, "GET", `mf_daily:${uid}:${todayWib()}`)) || 0;
}

export async function dbIncrementDaily(env, uid) {
  const key = `mf_daily:${uid}:${todayWib()}`;
  await redisCmd(env, "INCR", key);
  await redisCmd(env, "EXPIRE", key, 172800); // 2 days
}

export async function dbResetDaily(env, uid) {
  const key = `mf_daily:${uid}:${todayWib()}`;
  const exists = await redisCmd(env, "EXISTS", key);
  if (!exists) return false;
  await redisDel(env, key);
  return true;
}

// ── Keywords ──────────────────────────────────────────────

export async function dbContainsBlacklistedKw(env, text) {
  const kws = await redisCmd(env, "SMEMBERS", "mf_kwbl");
  if (!Array.isArray(kws) || !kws.length) return null;
  const lower = text.toLowerCase();
  for (const kw of kws) {
    if (kw && lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

export async function dbAddKw(env, kw) {
  await redisCmd(env, "SADD", "mf_kwbl", kw);
  if (env.GAS_URL) shAddKw(env, kw).catch(e => console.error("shAddKw sync failed:", e.message));
}
export async function dbDelKw(env, kw) {
  const removed = Number(await redisCmd(env, "SREM", "mf_kwbl", kw)) > 0;
  if (env.GAS_URL) shDelKw(env, kw).catch(e => console.error("shDelKw sync failed:", e.message));
  return removed;
}
export async function dbListKw(env)     { const r = await redisCmd(env, "SMEMBERS", "mf_kwbl"); return Array.isArray(r) ? r.filter(Boolean).sort() : []; }
export async function dbCountKw(env)    { return Number(await redisCmd(env, "SCARD", "mf_kwbl")) || 0; }

// ── Menfess data ──────────────────────────────────────────
// Redis: hanya untuk menfess yang masih aktif (perlu TTL untuk auto-delete timer)
// GAS Sheets: arsip permanen semua menfess (untuk riwayat, tidak ada TTL)

export async function dbSaveMenfess(env, msgId, uid, autoDeleteAt, mediaType = "text", text = "") {
  const ttl = autoDeleteAt ? Math.ceil((autoDeleteAt - new Date()) / 1000) + 120 : 604800;
  await redisCmd(env, "SET", `mf_msg:${msgId}`,
    JSON.stringify({
      user_id: uid,
      sent_at: new Date().toISOString(),
      auto_delete_at: autoDeleteAt?.toISOString() || null,
    }),
    "EX", ttl
  );
  await redisCmd(env, "SADD", "mf_msg_set", String(msgId));
  if (env.GAS_URL) shSaveMenfess(env, msgId, uid, mediaType, text, autoDeleteAt).catch(e => console.error("shSaveMenfess sync failed:", e.message));
}

export async function dbGetMenfess(env, msgId)    { return redisGet(env, `mf_msg:${msgId}`); }

export async function dbDeleteMenfess(env, msgId) {
  await redisDel(env, `mf_msg:${msgId}`);
  await redisCmd(env, "SREM", "mf_msg_set", String(msgId));
  if (env.GAS_URL) shDeleteMenfess(env, msgId).catch(e => console.error("shDeleteMenfess sync failed:", e.message));
}

export async function dbCountMenfess(env) {
  return Number(await redisCmd(env, "SCARD", "mf_msg_set")) || 0;
}

// ── Pending menfess ───────────────────────────────────────

export async function dbSavePending(env, uid, data) { await redisSet(env, `mf_pending:${uid}`, data, 300); }
export async function dbGetPending(env, uid)        { return redisGet(env, `mf_pending:${uid}`); }
export async function dbDeletePending(env, uid)     { await redisDel(env, `mf_pending:${uid}`); }

// ── Referral ──────────────────────────────────────────────

export async function dbGetReferralBonus(env, uid) {
  return Number(await redisCmd(env, "GET", `mf_refbonus:${uid}`)) || 0;
}

export async function dbAddReferralBonus(env, uid, amount) {
  await redisCmd(env, "INCRBY", `mf_refbonus:${uid}`, amount);
  if (env.GAS_URL) shAddReferralBonus(env, uid, amount).catch(e => console.error("shAddReferralBonus sync failed:", e.message));
}

export async function dbUseReferralBonus(env, uid) {
  const bonus = await dbGetReferralBonus(env, uid);
  if (bonus > 0) {
    await redisCmd(env, "DECR", `mf_refbonus:${uid}`);
    if (env.GAS_URL) shUseReferralBonus(env, uid).catch(e => console.error("shUseReferralBonus sync failed:", e.message));
    return true;
  }
  return false;
}

export async function dbHasUsedReferral(env, uid) {
  return !!(await redisCmd(env, "EXISTS", `mf_refused:${uid}`));
}

export async function dbRecordReferral(env, newUid, referrerId) {
  await redisCmd(env, "SET", `mf_refused:${newUid}`, String(referrerId));
  await redisCmd(env, "INCR", `mf_refcount:${referrerId}`);
  if (env.GAS_URL) shRecordReferral(env, newUid, referrerId).catch(e => console.error("shRecordReferral sync failed:", e.message));
}

export async function dbCountReferrals(env, uid) {
  return Number(await redisCmd(env, "GET", `mf_refcount:${uid}`)) || 0;
}

// ══════════════════════════════════════════════════════════
// DATABASE RESET — untuk dipakai admin setelah update kode
// ══════════════════════════════════════════════════════════

// FLUSHDB menghapus SEMUA key di database Redis yang dipakai bot ini.
// Aman dipakai karena instance Upstash didedikasikan khusus untuk bot —
// command ini didukung resmi oleh Upstash REST API.
export async function dbFlushAll(env) {
  const result = await redisCmd(env, "FLUSHDB");
  return result === "OK" || result === true;
}
