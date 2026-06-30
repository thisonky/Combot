// api/_sheets.js — Google Sheets via GAS Web App
// Dipakai untuk data non-real-time: block, mute, keyword, kuota, referral, log menfess.
// Session chat aktif & queue TETAP di Redis (lihat _db.js).

const GAS_TIMEOUT_MS = 8000;

async function gasCall(env, action, payload = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GAS_TIMEOUT_MS);
  try {
    const res = await fetch(env.GAS_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action, secret: env.GAS_SECRET, ...payload }),
      signal:  ctrl.signal,
    });
    const data = await res.json();
    if (!data.ok) console.error(`GAS [${action}] error:`, data.error);
    return data;
  } catch (e) {
    const msg = e.name === "AbortError" ? `TIMEOUT (${GAS_TIMEOUT_MS}ms)` : e.message;
    console.error(`gasCall [${action}] failed:`, msg);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function todayWib() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
}

// ── Users ────────────────────────────────────────────

export async function shRegisterUser(env, uid, gender = "", username = "") {
  return gasCall(env, "register_user", { user_id: uid, gender, username });
}
export async function shGetAllUsers(env) {
  const r = await gasCall(env, "get_all_users");
  return Array.isArray(r.users) ? r.users.map(Number) : [];
}
export async function shCountUsers(env) {
  const r = await gasCall(env, "count_users");
  return Number(r.count) || 0;
}

// ── Block ────────────────────────────────────────────

export async function shBlock(env, uid, reason) {
  return gasCall(env, "block_user", { user_id: uid, reason });
}
export async function shUnblock(env, uid) {
  const r = await gasCall(env, "unblock_user", { user_id: uid });
  return !!r.removed;
}
export async function shIsBlocked(env, uid) {
  const r = await gasCall(env, "is_blocked", { user_id: uid });
  return r.blocked || null;
}
export async function shListBlocked(env) {
  const r = await gasCall(env, "list_blocked");
  return Array.isArray(r.list) ? r.list : [];
}
export async function shCountBlocked(env) {
  const r = await gasCall(env, "count_blocked");
  return Number(r.count) || 0;
}

// ── Mute ─────────────────────────────────────────────

export async function shMute(env, uid, untilDate) {
  return gasCall(env, "mute_user", { user_id: uid, until: untilDate.toISOString() });
}
export async function shUnmute(env, uid) {
  const r = await gasCall(env, "unmute_user", { user_id: uid });
  return !!r.removed;
}
export async function shIsMuted(env, uid) {
  const r = await gasCall(env, "is_muted", { user_id: uid });
  return r.until || null;
}
export async function shCountMuted(env) {
  const r = await gasCall(env, "count_muted");
  return Number(r.count) || 0;
}

// ── Keyword blacklist ────────────────────────────────

export async function shAddKw(env, kw) {
  return gasCall(env, "add_keyword", { keyword: kw });
}
export async function shDelKw(env, kw) {
  const r = await gasCall(env, "del_keyword", { keyword: kw });
  return !!r.removed;
}
export async function shListKw(env) {
  const r = await gasCall(env, "list_keywords");
  return Array.isArray(r.list) ? r.list : [];
}
export async function shCountKw(env) {
  const r = await gasCall(env, "count_keywords");
  return Number(r.count) || 0;
}
export async function shContainsBlacklistedKw(env, text) {
  const kws = await shListKw(env);
  if (!kws.length) return null;
  const lower = text.toLowerCase();
  for (const kw of kws) if (kw && lower.includes(kw.toLowerCase())) return kw;
  return null;
}

// ── Daily quota ──────────────────────────────────────

export async function shGetDailyCount(env, uid) {
  const r = await gasCall(env, "get_daily_count", { user_id: uid, date: todayWib() });
  return Number(r.count) || 0;
}
export async function shIncrementDaily(env, uid) {
  const r = await gasCall(env, "increment_daily", { user_id: uid, date: todayWib() });
  return Number(r.count) || 0;
}
export async function shResetDaily(env, uid) {
  const r = await gasCall(env, "reset_daily", { user_id: uid, date: todayWib() });
  return !!r.removed;
}

// ── Referral ─────────────────────────────────────────

export async function shGetReferralBonus(env, uid) {
  const r = await gasCall(env, "get_referral_bonus", { user_id: uid });
  return Number(r.bonus) || 0;
}
export async function shAddReferralBonus(env, uid, amount) {
  return gasCall(env, "add_referral_bonus", { user_id: uid, amount });
}
export async function shUseReferralBonus(env, uid) {
  const r = await gasCall(env, "use_referral_bonus", { user_id: uid });
  return !!r.used;
}
export async function shHasUsedReferral(env, uid) {
  const r = await gasCall(env, "has_used_referral", { user_id: uid });
  return !!r.used;
}
export async function shRecordReferral(env, newUid, referrerId) {
  return gasCall(env, "record_referral", { new_user_id: newUid, referrer_id: referrerId });
}
export async function shCountReferrals(env, uid) {
  const r = await gasCall(env, "count_referrals", { user_id: uid });
  return Number(r.count) || 0;
}

// ── Menfess log (arsip) ──────────────────────────────

export async function shSaveMenfess(env, msgId, uid, mediaType, text, autoDeleteAt) {
  return gasCall(env, "save_menfess", {
    message_id: msgId,
    sender_id:  uid,
    text,
    media_type: mediaType,
    auto_delete_at: autoDeleteAt ? autoDeleteAt.toISOString() : "",
  });
}
export async function shGetMenfess(env, msgId) {
  const r = await gasCall(env, "get_menfess", { message_id: msgId });
  return r.menfess || null;
}
export async function shDeleteMenfess(env, msgId) {
  return gasCall(env, "delete_menfess", { message_id: msgId });
}
export async function shCountMenfess(env) {
  const r = await gasCall(env, "count_menfess");
  return Number(r.count) || 0;
}
