/**
 * Integración con Telegram Bot para alertas de ofertas,
 * pisos históricos de precios y variabilidad en supermercados.
 */

export async function sendTelegramNotification({ token, chatId, text, parseMode = "HTML" }) {
  if (!token || !chatId || !text) {
    return { ok: false, error: "Token o Chat ID no configurado." };
  }

  const cleanToken = token.trim();
  const cleanChatId = chatId.trim();
  const url = `https://api.telegram.org/bot${cleanToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cleanChatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: false,
      }),
      signal: AbortSignal.timeout(8000),
    });

    const json = await res.json();
    if (!res.ok || !json.ok) {
      return { ok: false, error: json.description || `HTTP ${res.status}` };
    }

    return { ok: true, result: json.result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function formatPriceAlertMessage({ item, storeName, oldPrice, newPrice, unitPrice, unit, savingsPct, productUrl }) {
  const isFloor = savingsPct >= 15;
  const emoji = isFloor ? "🟢🔥 ¡PISO HISTÓRICO DETECTADO!" : "🔔 ¡BAJÓ DE PRECIO!";

  return `
<b>${emoji}</b>

🛒 <b>Producto:</b> ${item.title}
🏪 <b>Supermercado:</b> ${storeName}
💰 <b>Nuevo Precio:</b> $${newPrice.toLocaleString("es-CL")} <i>(Antes: $${oldPrice.toLocaleString("es-CL")})</i>
📉 <b>Ahorro:</b> -${savingsPct}%
⚖️ <b>Precio por unidad:</b> $${unitPrice.toLocaleString("es-CL")} / ${unit === "lt" ? "L" : unit}

${productUrl ? `<a href="${productUrl}">👉 Ver producto en la tienda</a>` : ""}

<i>Monitoreado automáticamente por SuperPrecio CL</i>
  `.trim();
}
