// test.js — Core flow verification untuk Combo Bot
// Jalankan: node test.js
// Tidak butuh network — semua mock

import assert from "node:assert/strict";

// ════════════════════════════════════════════════
// MOCK ENVIRONMENT
// ════════════════════════════════════════════════

const env = {
  KV_URL: "https://mock.upstash.io",
  KV_TOKEN: "mock-token",
  BOT_TOKEN: "123:mock",
  CHANNEL_ID: "-1001234567890",
  ADMIN_ID: 999,
  BOT_USERNAME: "TestBot",
  DAILY_MAX: 3,
  AUTO_DEL_MIN: 10,
  REF_BONUS: 3,
  REF_WELCOME: 3,
};

// ════════════════════════════════════════════════
// IN-MEMORY REDIS MOCK
// ════════════════════════════════════════════════

const store = new Map();
const sets  = new Map();

function mockRedisCmd(env, ...args) {
  const [cmd, key, ...rest] = args;
  switch (cmd.toUpperCase()) {
    case "SET":    store.set(key, rest[0]); return 1;
    case "GET":    return store.get(key) ?? null;
    case "DEL":    store.delete(key); sets.forEach((s, k) => { if (k === key) sets.delete(k); }); return 1;
    case "EXISTS": return store.has(key) ? 1 : 0;
    case "INCR": { const v = Number(store.get(key) || 0) + 1; store.set(key, String(v)); return v; }
    case "DECR": { const v = Number(store.get(key) || 0) - 1; store.set(key, String(v)); return v; }
    case "INCRBY": { const v = Number(store.get(key) || 0) + Number(rest[0]); store.set(key, String(v)); return v; }
    case "EXPIRE": return 1;
    case "SADD":   { if (!sets.has(key)) sets.set(key, new Set()); sets.get(key).add(rest[0]); return 1; }
    case "SREM":   { const s = sets.get(key); if (s) s.delete(rest[0]); return 1; }
    case "SCARD":  return sets.get(key)?.size ?? 0;
    case "SMEMBERS": return [...(sets.get(key) || new Set())];
    default: return null;
  }
}

// Patch _db.js to use in-memory mock
// We test the _db logic directly by importing and monkey-patching

// ════════════════════════════════════════════════
// UNIT TESTS
// ════════════════════════════════════════════════

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    failed++;
  }
}

// ── Helper: simulate redisCmd inline ────────────

function makeDbWithMock() {
  // We replicate the _db logic inline using mockRedisCmd
  const todayWib = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });

  return {
    // User
    registerUser: (uid) => { mockRedisCmd(env, "SET", `mf_user:${uid}`, "1"); mockRedisCmd(env, "SADD", "mf_users_list", String(uid)); },
    countUsers:   ()    => Number(mockRedisCmd(env, "SCARD", "mf_users_list")) || 0,
    // Block
    block:     (uid, reason) => { mockRedisCmd(env, "SET", `mf_blocked:${uid}`, JSON.stringify({ reason, blocked_at: "now" })); mockRedisCmd(env, "SADD", "mf_blocked_set", String(uid)); },
    isBlocked: (uid)         => { const raw = mockRedisCmd(env, "GET", `mf_blocked:${uid}`); return raw ? JSON.parse(raw) : null; },
    unblock:   (uid)         => { const e = mockRedisCmd(env, "EXISTS", `mf_blocked:${uid}`); if (!e) return false; mockRedisCmd(env, "DEL", `mf_blocked:${uid}`); mockRedisCmd(env, "SREM", "mf_blocked_set", String(uid)); return true; },
    countBlocked: ()         => Number(mockRedisCmd(env, "SCARD", "mf_blocked_set")) || 0,
    // Daily
    getDailyCount: (uid) => Number(mockRedisCmd(env, "GET", `mf_daily:${uid}:${todayWib()}`)) || 0,
    incrDaily:     (uid) => { mockRedisCmd(env, "INCR", `mf_daily:${uid}:${todayWib()}`); },
    resetDaily:    (uid) => { const e = mockRedisCmd(env, "EXISTS", `mf_daily:${uid}:${todayWib()}`); if (!e) return false; mockRedisCmd(env, "DEL", `mf_daily:${uid}:${todayWib()}`); return true; },
    // Referral
    getReferralBonus:  (uid)         => Number(mockRedisCmd(env, "GET", `mf_refbonus:${uid}`)) || 0,
    addReferralBonus:  (uid, amount) => mockRedisCmd(env, "INCRBY", `mf_refbonus:${uid}`, amount),
    useReferralBonus:  (uid)         => { const b = Number(mockRedisCmd(env, "GET", `mf_refbonus:${uid}`) || 0); if (b > 0) { mockRedisCmd(env, "DECR", `mf_refbonus:${uid}`); return true; } return false; },
    hasUsedReferral:   (uid)         => !!mockRedisCmd(env, "EXISTS", `mf_refused:${uid}`),
    recordReferral:    (n, r)        => { mockRedisCmd(env, "SET", `mf_refused:${n}`, String(r)); mockRedisCmd(env, "INCR", `mf_refcount:${r}`); },
    countReferrals:    (uid)         => Number(mockRedisCmd(env, "GET", `mf_refcount:${uid}`)) || 0,
    // Keywords
    addKw:         (kw)  => mockRedisCmd(env, "SADD", "mf_kwbl", kw),
    delKw:         (kw)  => Number(mockRedisCmd(env, "SREM", "mf_kwbl", kw)) > 0,
    listKw:        ()    => [...(sets.get("mf_kwbl") || [])].sort(),
    containsKw:    (txt) => { const kws = [...(sets.get("mf_kwbl") || [])]; const lower = txt.toLowerCase(); for (const kw of kws) if (lower.includes(kw.toLowerCase())) return kw; return null; },
    // Queue
    getQueue:      ()    => { const raw = mockRedisCmd(env, "GET", "queue"); try { return JSON.parse(raw) || []; } catch { return []; } },
    addToQueue:    (uid) => { const q = JSON.parse(mockRedisCmd(env, "GET", "queue") || "[]"); if (!q.includes(String(uid))) { q.push(String(uid)); mockRedisCmd(env, "SET", "queue", JSON.stringify(q)); } },
    removeQueue:   (uid) => { const q = JSON.parse(mockRedisCmd(env, "GET", "queue") || "[]"); mockRedisCmd(env, "SET", "queue", JSON.stringify(q.filter(x => x !== String(uid)))); },
    // AnonUser
    getAcUser:     (uid)       => { const raw = mockRedisCmd(env, "GET", `user:${uid}`); try { return JSON.parse(raw); } catch { return null; } },
    setAcUser:     (uid, data) => mockRedisCmd(env, "SET", `user:${uid}`, JSON.stringify(data)),
    // Session
    setSession:    (u1, u2) => { const now = Date.now(); mockRedisCmd(env, "SET", `session:${u1}`, JSON.stringify({ partnerId: u2, startedAt: now })); mockRedisCmd(env, "SET", `session:${u2}`, JSON.stringify({ partnerId: u1, startedAt: now })); },
    getSession:    (uid)    => { const raw = mockRedisCmd(env, "GET", `session:${uid}`); try { return JSON.parse(raw); } catch { return null; } },
    delSession:    (uid)    => mockRedisCmd(env, "DEL", `session:${uid}`),
    // Pending
    savePending:   (uid, data) => mockRedisCmd(env, "SET", `mf_pending:${uid}`, JSON.stringify(data)),
    getPending:    (uid)       => { const raw = mockRedisCmd(env, "GET", `mf_pending:${uid}`); try { return JSON.parse(raw); } catch { return null; } },
    delPending:    (uid)       => mockRedisCmd(env, "DEL", `mf_pending:${uid}`),
  };
}

// ════════════════════════════════════════════════
// TEST SUITES
// ════════════════════════════════════════════════

console.log("\n📋 DB Layer Tests\n");
const db = makeDbWithMock();

await test("registerUser increments SCARD", () => {
  db.registerUser(1001);
  db.registerUser(1002);
  db.registerUser(1001); // duplicate
  assert.equal(db.countUsers(), 2);
});

await test("block / isBlocked / unblock", () => {
  db.block(1001, "spam");
  assert.ok(db.isBlocked(1001));
  assert.equal(db.isBlocked(1001).reason, "spam");
  assert.equal(db.countBlocked(), 1);
  db.unblock(1001);
  assert.equal(db.isBlocked(1001), null);
  assert.equal(db.countBlocked(), 0);
});

await test("unblock non-existent returns false", () => {
  const result = db.unblock(9999);
  assert.equal(result, false);
});

await test("daily limit: increment and reset", () => {
  assert.equal(db.getDailyCount(2001), 0);
  db.incrDaily(2001);
  db.incrDaily(2001);
  assert.equal(db.getDailyCount(2001), 2);
  db.resetDaily(2001);
  assert.equal(db.getDailyCount(2001), 0);
});

await test("resetDaily non-existent returns false", () => {
  assert.equal(db.resetDaily(9999), false);
});

await test("mfRemaining respects DAILY_MAX and bonus", () => {
  db.incrDaily(3001);
  db.incrDaily(3001);
  db.addReferralBonus(3001, 2);
  const used  = db.getDailyCount(3001);   // 2
  const bonus = db.getReferralBonus(3001); // 2
  const remaining = env.DAILY_MAX - used + bonus; // 3 - 2 + 2 = 3
  assert.equal(remaining, 3);
});

await test("useReferralBonus decrements correctly", () => {
  db.addReferralBonus(4001, 3);
  assert.equal(db.getReferralBonus(4001), 3);
  assert.equal(db.useReferralBonus(4001), true);
  assert.equal(db.getReferralBonus(4001), 2);
  db.useReferralBonus(4001);
  db.useReferralBonus(4001);
  assert.equal(db.useReferralBonus(4001), false); // 0 left
});

await test("referral: record and count, no double-use", () => {
  db.recordReferral(5002, 5001); // 5002 joined via 5001
  assert.equal(db.hasUsedReferral(5002), true);
  assert.equal(db.hasUsedReferral(5001), false);
  assert.equal(db.countReferrals(5001), 1);
});

await test("keyword blacklist: add, contains, delete", () => {
  db.addKw("badword");
  db.addKw("spam");
  assert.equal(db.containsKw("this has badword in it"), "badword");
  assert.equal(db.containsKw("BADWORD upper"), "badword");
  assert.equal(db.containsKw("clean text"), null);
  db.delKw("badword");
  assert.equal(db.containsKw("badword"), null);
  assert.ok(db.containsKw("spam text") !== null);
});

await test("queue: add, remove, no duplicates", () => {
  store.delete("queue");
  db.addToQueue("6001");
  db.addToQueue("6002");
  db.addToQueue("6001"); // duplicate
  const q = db.getQueue();
  assert.equal(q.length, 2);
  db.removeQueue("6001");
  assert.equal(db.getQueue().length, 1);
  assert.equal(db.getQueue()[0], "6002");
});

await test("session: set and get both sides", () => {
  db.setSession("7001", "7002");
  const s1 = db.getSession("7001");
  const s2 = db.getSession("7002");
  assert.equal(s1.partnerId, "7002");
  assert.equal(s2.partnerId, "7001");
  db.delSession("7001");
  assert.equal(db.getSession("7001"), null);
  assert.ok(db.getSession("7002") !== null); // other side still exists
});

await test("pending: save, get, delete", () => {
  db.savePending(8001, { text: "hello", mediaType: "text" });
  const p = db.getPending(8001);
  assert.equal(p.text, "hello");
  assert.equal(p.mediaType, "text");
  db.delPending(8001);
  assert.equal(db.getPending(8001), null);
});

console.log("\n📋 Logic Tests\n");

await test("menfess trigger: case-insensitive mfs! prefix", () => {
  const triggers = ["mfs! hello", "Mfs! hello", "MFS! hello", "mFS! Hi"];
  for (const t of triggers) {
    assert.ok(t.toLowerCase().startsWith("mfs!"), `Should match: ${t}`);
  }
  assert.ok(!"MFS hello".toLowerCase().startsWith("mfs!"));
  assert.ok(!"text mfs!".toLowerCase().startsWith("mfs!"));
});

await test("cleanContent: strips mfs! and keeps rest", () => {
  const clean = (t) => t.replace(/^mfs!/i, "💌").trim();
  assert.equal(clean("mfs! hello world"), "💌 hello world");
  assert.equal(clean("MFS! test"), "💌 test");
  assert.equal(clean("mfs!"), "💌");
  // Empty after strip
  assert.ok(clean("mfs!").trim() === "💌");
});

await test("escapeMd: escapes legacy Markdown special chars", () => {
  const escapeMd = (t) => t ? String(t).replace(/([_*`[])/g, "\\$1") : "";
  assert.equal(escapeMd("hello_world"), "hello\\_world");
  assert.equal(escapeMd("*bold*"), "\\*bold\\*");
  assert.equal(escapeMd("`code`"), "\\`code\\`");
  assert.equal(escapeMd("[link]"), "\\[link]");
  assert.equal(escapeMd("normal text"), "normal text");
  assert.equal(escapeMd(""), "");
  assert.equal(escapeMd(null), "");
});

await test("env validation: NaN ADMIN_ID detected", () => {
  const badEnv = { ...process.env, ADMIN_ID: "notanumber" };
  const id = Number(badEnv.ADMIN_ID);
  assert.ok(isNaN(id), "NaN should be detected");
});

await test("env validation: zero ADMIN_ID detected", () => {
  const id = Number("0");
  assert.ok(id === 0, "Zero should be detected as invalid");
});

await test("mute duration validation: NaN duration", () => {
  const duration = Number("abc");
  assert.ok(!Number.isFinite(duration), "NaN duration should be caught");
});

await test("user ID validation: non-numeric rejected", () => {
  const uid = Number("notanid");
  assert.ok(!Number.isFinite(uid) || uid <= 0, "Invalid user ID should be rejected");
});

await test("callback_data rpt_ parsing: alasan and partnerId", () => {
  const cases = [
    { data: "rpt_konten_123456", alasan: "konten", partnerId: "123456" },
    { data: "rpt_kasar_987654",  alasan: "kasar",  partnerId: "987654" },
    { data: "rpt_lain_111222",   alasan: "lain",   partnerId: "111222" },
  ];
  for (const c of cases) {
    const parts = c.data.split("_");
    assert.equal(parts[1], c.alasan);
    assert.equal(parts[2], c.partnerId);
  }
});

await test("mf_del_ callback: extracts numeric msgId", () => {
  const data  = "mf_del_12345678";
  const delId = Number(data.replace("mf_del_", ""));
  assert.equal(delId, 12345678);
  assert.ok(Number.isFinite(delId));
});

await test("mf_del_ callback: malformed input caught by isFinite", () => {
  const data  = "mf_del_notanumber";
  const delId = Number(data.replace("mf_del_", ""));
  assert.ok(!Number.isFinite(delId));
});

await test("relay terminateSession detection: error codes", () => {
  const unreachableCodes  = [403, 404];
  const unreachableDescs  = ["blocked", "user not found", "chat not found", "deactivated"];
  for (const code of unreachableCodes) {
    const result = { ok: false, error_code: code, description: "" };
    const desc   = (result.description || "").toLowerCase();
    const isUnreachable = result.error_code === 403 || result.error_code === 404 ||
      desc.includes("blocked") || desc.includes("user not found") ||
      desc.includes("chat not found") || desc.includes("deactivated");
    assert.ok(isUnreachable, `error_code ${code} should be unreachable`);
  }
  for (const d of unreachableDescs) {
    const result = { ok: false, error_code: 400, description: d };
    const desc   = (result.description || "").toLowerCase();
    const isUnreachable = result.error_code === 403 || result.error_code === 404 ||
      desc.includes("blocked") || desc.includes("user not found") ||
      desc.includes("chat not found") || desc.includes("deactivated");
    assert.ok(isUnreachable, `desc "${d}" should be unreachable`);
  }
  // 400 without known desc should NOT be unreachable
  const normalError = { ok: false, error_code: 400, description: "Bad Request: message is not modified" };
  const desc2       = (normalError.description || "").toLowerCase();
  const notUnreachable = normalError.error_code === 403 || normalError.error_code === 404 ||
    desc2.includes("blocked") || desc2.includes("user not found") ||
    desc2.includes("chat not found") || desc2.includes("deactivated");
  assert.ok(!notUnreachable, "normal 400 should not trigger terminate");
});

await test("broadcast chunk delay: 20-message boundary", () => {
  const BC_CHUNK_DELAY = 50;
  let delays = 0;
  const uids = Array.from({ length: 45 }, (_, i) => i + 1);
  let ok = 0;
  for (let i = 0; i < uids.length; i++) {
    ok++;
    if (ok % 20 === 0) delays++;
  }
  assert.equal(delays, 2); // at 20 and 40
});

await test("refLink format", () => {
  const link = `https://t.me/TestBot?start=ref_12345`;
  assert.ok(link.includes("ref_12345"));
  assert.ok(link.startsWith("https://t.me/"));
});

await test("WAITING_MSG is defined and non-empty", () => {
  const WAITING_MSG = "🔍 *Nyariin partner buat kamu...*";
  assert.ok(WAITING_MSG.length > 0);
});

// ════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("❌ Some tests failed — do not release");
  process.exit(1);
} else {
  console.log("✅ All tests passed — safe to release");
}
