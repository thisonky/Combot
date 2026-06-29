// api/_tg.js
// Production Hardened - Tanpa Merubah Fitur Inti & 100% Utuh

export function tg(token) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, body = {}) {
    try {
      const res = await fetch(`${base}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) console.error(`TG [${method}]:`, JSON.stringify(data));
      return data;
    } catch (e) {
      console.error(`TG fetch error [${method}]:`, e.message);
      return { ok: false };
    }
  }

  return {
    send:       (p)           => call("sendMessage", { parse_mode: "Markdown", ...p }),
    sendHtml:   (p)           => call("sendMessage", { parse_mode: "HTML", ...p }),
    edit:       (p)           => call("editMessageText", { parse_mode: "Markdown", ...p }),
    answer:     (id, txt, al) => call("answerCallbackQuery", { callback_query_id: id, ...(txt ? { text: txt } : {}), ...(al ? { show_alert: true } : {}) }),
    sendPhoto:  (p)           => call("sendPhoto", p),
    sendVideo:  (p)           => call("sendVideo", p),
    sendVoice:  (p)           => call("sendVoice", p),
    sendSticker:(p)           => call("sendSticker", p),
    fwd:        (p)           => call("forwardMessage", p),
    copyMsg:    (p)           => call("copyMessage", p),
    delete:     (chat, msg)   => call("deleteMessage", { chat_id: chat, message_id: msg }),
    react:      (chat, msg, emoji) => call("setMessageReaction", { chat_id: chat, message_id: msg, reaction: [{ type: "emoji", emoji }] }),
    setWebhook: (url, secret) => call("setWebhook", { url, secret_token: secret }),
  };
}

export function ikbd(rows) { return { inline_keyboard: rows }; }
export function btn(text, data) { return { text, callback_data: data }; }
export function burl(text, url) { return { text, url }; }
