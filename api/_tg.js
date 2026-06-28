export function tg(token) {
  const url = `https://api.telegram.org/bot${token}/`;
  return {
    async send(body) {
      return fetch(`${url}sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(r => r.json());
    },
    async edit(body) {
      return fetch(`${url}editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(r => r.json());
    },
    async answer(callbackQueryId, text = "", showAlert = false) {
      return fetch(`${url}answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert }),
      }).then(r => r.json());
    }
  };
}

export const ikbd = (inlineKeyboard) => ({ inline_keyboard: inlineKeyboard });
export const btn = (text, callbackData) => ({ text, callback_data: callbackData });
export const burl = (text, url) => ({ text, url });

export function cleanHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function tgRaw(token, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!data.ok) {
      console.error(`[TG API Error] ${method}: ${data.description} (${data.error_code})`);
    }
    return data;
  } catch (err) {
    console.error(`[TG Network Error] ${method}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
