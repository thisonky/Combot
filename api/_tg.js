// api/_tg.js

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
    setWebhook: (url)         => call("setWebhook", { url, allowed_updates: ["message", "callback_query", "my_chat_member"] }),
  };
}

export const ikbd = (rows) => ({ inline_keyboard: rows });
export const btn  = (text, cb)  => ({ text, callback_data: cb });
export const burl = (text, url) => ({ text, url });
