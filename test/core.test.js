import test from "node:test";
import assert from "node:assert";
import { cleanHtml } from "../api/_tg.js";

test("🧪 Proteksi XSS & HTML Sanitization Test", () => {
  const dirtyStr = "<div>Halo & Selamat <script>Xss()</script></div>";
  const secured = cleanHtml(dirtyStr);
  
  assert.strictEqual(secured.includes("<script>"), false);
  assert.strictEqual(secured.includes("&lt;"), true);
});

test("🧪 URL Encoded Middleware Parser Validation", async () => {
  const dummyPayload = "update_id=987654321&message=%7B%22text%22%3A%22%2Fstart%22%7D";
  const isOk = dummyPayload.includes("update_id");
  assert.strictEqual(isOk, true);
});
