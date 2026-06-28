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

// Hardened Global Raw Request dengan Logging Protektif
export async function tgRaw(token, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const resData = await r.json();
    if (!resData.ok) {
      console.error(`[Telegram API Error] Method: ${method} | Code: ${resData.error_code} | Desc: ${resData.description}`);
    }
    return resData;
  } catch (err) {
    console.error(`[Telegram Network Transport Error] Method: ${method} | Msg: ${err.message}`);
    return { ok: false, description: err.message };
  }
}
