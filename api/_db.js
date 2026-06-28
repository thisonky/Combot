// api/_db.js — Upstash Redis via HTTP
// Mengikuti PERSIS pola anonchat asli yang sudah terbukti jalan

// ── Redis core ──
// api/_db.js — Upstash Redis via HTTP (Clean Version tanpa Statistik Berat)

// api/_db.js — Hybrid Database Layer (Redis + Google Sheets)

// --- FUNGSI MURNI REDIS (Untuk Data Real-time & Sesi Chatting) ---
async function redisRaw(env, cmd, ...args) {
  const r = await fetch(`${env.KV_URL}/${cmd}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${env.KV_TOKEN}` }
  });
  return r.json();
}

export async function acGetUser(env, uid) {
  const res = await redisRaw(env, "get", `user:${uid}`);
  return res.result ? JSON.parse(res.result) : null;
}

export async function acSetUser(env, uid, obj) {
  await redisRaw(env, "set", `user:${uid}`, JSON.stringify(obj));
}

export async function acGetSession(env, uid) {
  const res = await redisRaw(env, "get", `sess:${uid}`);
  return res.result || null;
}

export async function acSetSession(env, uid, targetUid) {
  await redisRaw(env, "set", `sess:${uid}`, String(targetUid));
}

export async function acDelSession(env, uid) {
  await redisRaw(env, "del", `sess:${uid}`);
}

export async function acGetQueue(env) {
  const res = await redisRaw(env, "lrange", "chat_queue", "0", "-1");
  return res.result || [];
}

export async function acAddToQueue(env, uid) {
  await acRemoveFromQueue(env, uid); // Hindari duplikat di antrean
  await redisRaw(env, "rpush", "chat_queue", String(uid));
}

export async function acRemoveFromQueue(env, uid) {
  await redisRaw(env, "lrem", "chat_queue", "0", String(uid));
}

export async function acIsDone(env, uid) {
  const res = await redisRaw(env, "exists", `cooldown:${uid}`);
  return res.result === 1;
}

export async function acMarkDone(env, uid) {
  await redisRaw(env, "set", `cooldown:${uid}`, "1", "EX", "5");
}

// --- FUNGSI PRIVILEGE ADMIN (Mute / Block di Redis) ---
export async function dbIsBlocked(env, uid)  { const r = await redisRaw(env, "sismember", "blocked_users", String(uid)); return r.result === 1; }
export async function dbBlock(env, uid)      { await redisRaw(env, "sadd", "blocked_users", String(uid)); }
export async function dbUnblock(env, uid)    { await redisRaw(env, "srem", "blocked_users", String(uid)); }
export async function dbCountBlocked(env)    { const r = await redisRaw(env, "scard", "blocked_users"); return r.result || 0; }

export async function dbIsMuted(env, uid)    { const r = await redisRaw(env, "sismember", "muted_users", String(uid)); return r.result === 1; }
export async function dbMute(env, uid)       { await redisRaw(env, "sadd", "muted_users", String(uid)); }
export async function dbUnmute(env, uid)     { await redisRaw(env, "srem", "muted_users", String(uid)); }
export async function dbCountMuted(env)      { const r = await redisRaw(env, "scard", "muted_users"); return r.result || 0; }

// --- FUNGSI PENYARINGAN KATA (Blacklist Keywords) ---
export async function dbContainsBlacklistedKw(env, text) {
  const r = await redisRaw(env, "smembers", "blacklisted_keywords");
  const list = r.result || [];
  return list.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
}
export async function dbAddKw(env, kw)   { await redisRaw(env, "sadd", "blacklisted_keywords", kw.trim()); }
export async function dbDelKw(env, kw)   { await redisRaw(env, "srem", "blacklisted_keywords", kw.trim()); }
export async function dbListKw(env)      { const r = await redisRaw(env, "smembers", "blacklisted_keywords"); return r.result || []; }
export async function dbCountKw(env)     { const r = await redisRaw(env, "scard", "blacklisted_keywords"); return r.result || 0; }

// --- DATA TEMPORER (Pending State & Admin Relay) ---
export async function dbSavePending(env, uid, obj)   { await redisRaw(env, "set", `pending:${uid}`, JSON.stringify(obj), "EX", "600"); }
export async function dbGetPending(env, uid)         { const r = await redisRaw(env, "get", `pending:${uid}`); return r.result ? JSON.parse(r.result) : null; }
export async function dbDeletePending(env, uid)      { await redisRaw(env, "del", `pending:${uid}`); }

export async function dbGetReferralBonus(env, uid)   { const r = await redisRaw(env, "get", `quota:${uid}`); return Number(r.result || 0); }
export async function dbAddReferralBonus(env, uid, n) { await redisRaw(env, "incrby", `quota:${uid}`, String(n)); }
export async function dbUseReferralBonus(env, uid)   { await redisRaw(env, "decr", `quota:${uid}`); }

export async function dbHasUsedReferral(env, uid)    { const r = await redisRaw(env, "get", `has_ref:${uid}`); return r.result !== null; }
export async function dbRecordReferral(env, uid, by) { await redisRaw(env, "set", `has_ref:${uid}`, String(by)); }
export async function dbCountReferrals(env, uid)    { const r = await redisRaw(env, "get", `ref_count:${uid}`); return Number(r.result || 0); }

export async function dbGetContactState(env, uid)    { const r = await redisRaw(env, "get", `contact:${uid}`); return r.result ? JSON.parse(r.result) : null; }
export async function dbSetContactState(env, uid, o) { await redisRaw(env, "set", `contact:${uid}`, JSON.stringify(o), "EX", "1800"); }
export async function dbDelContactState(env, uid)    { await redisRaw(env, "del", `contact:${uid}`); }

export async function dbGetAdminReply(env, uid)      { const r = await redisRaw(env, "get", `adm_reply:${uid}`); return r.result ? JSON.parse(r.result) : null; }
export async function dbSetAdminReply(env, uid, t)   { await redisRaw(env, "set", `adm_reply:${uid}`, JSON.stringify({ targetUid: t }), "EX", "600"); }
export async function dbDelAdminReply(env, uid)      { await redisRaw(env, "del", `adm_reply:${uid}`); }

// --- DATA PERSISTEN STRATEGIS DIALIHKAN KE GOOGLE SPREADSHEET (Hemat RAM Redis) ---
async function callSpreadsheet(env, bodyObj) {
  if (!env.SPREADSHEET_API_URL) return { ok: false };
  try {
    const res = await fetch(env.SPREADSHEET_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj)
    });
    return await res.json();
  } catch (e) {
    console.error("Spreadsheet API Connection Error:", e.message);
    return { ok: false };
  }
}

export async function dbRegisterUser(env, uid, gender = "unknown", username = "") {
  // Disimpan ke Spreadsheet agar storage Redis 0% terbebani
  await callSpreadsheet(env, { action: "register_user", user_id: uid, gender, username });
}

export async function dbSaveMenfess(env, msgId, data) {
  // Menfess bertambah tanpa limit, Spreadsheet adalah storage gratis terbaik
  await callSpreadsheet(env, { action: "save_menfess", message_id: msgId, sender_id: data.user_id, text: data.text });
  // Cadangan sementara di Redis untuk fitur pencocokan hapus instan (auto expired 1 hari)
  await redisRaw(env, "set", `mf_owner:${msgId}`, String(data.user_id), "EX", "86400");
}

export async function dbGetMenfess(env, msgId) {
  const r = await redisRaw(env, "get", `mf_owner:${msgId}`);
  return r.result ? { user_id: r.result } : null;
}

export async function dbDeleteMenfess(env, msgId) {
  await redisRaw(env, "del", `mf_owner:${msgId}`);
}

export async function dbAllUserIds(env) {
  // Broadcast menarik ribuan ID dari Spreadsheet tanpa menyentuh perintah SCAN/KEYS di Redis
  const res = await callSpreadsheet(env, { action: "get_all_users" });
  return res.ok ? res.users : [];
}

export async function dbCountUsers(env) {
  const res = await callSpreadsheet(env, { action: "get_all_users" });
  return res.ok ? res.users.length : 0;
}
