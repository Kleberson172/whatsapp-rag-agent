import dotenv from "dotenv";
dotenv.config();

const GRAPH_VERSION = "v21.0";
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

/**
 * Envia uma mensagem de texto livre via Meta WhatsApp Cloud API.
 * Só funciona dentro da janela de 24h de uma "conversa de serviço"
 * (ou seja: depois que o cliente mandou mensagem primeiro).
 */
export async function sendWhatsAppMessage(toPhoneNumber, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhoneNumber, // formato: número com código do país, sem "+", ex: "244923000000"
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Meta Cloud API falhou (${res.status}): ${errBody}`);
  }

  return res.json();
}

/**
 * Extrai a mensagem de texto e o número do remetente de um payload
 * recebido pelo webhook da Meta. Retorna null se não for uma mensagem
 * de texto de usuário (pode ser status de entrega, imagem, etc).
 */
export function parseIncomingMessage(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== "text") {
      return null;
    }

    return {
      from: message.from, // número do cliente, ex: "244923000000"
      text: message.text.body,
      profileName: value.contacts?.[0]?.profile?.name || null,
    };
  } catch {
    return null;
  }
}
