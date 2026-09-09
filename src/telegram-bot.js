import { createRequire } from "module";
import dotenv from "dotenv";
import { handleIncomingMessage } from "./rag.js";

dotenv.config();

const require = createRequire(import.meta.url);
const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("[telegram] ERRO: defina TELEGRAM_BOT_TOKEN no .env antes de rodar.");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

console.log("[telegram] Bot iniciado, aguardando mensagens...");

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  console.log(`[telegram] mensagem de ${chatId}: ${text}`);

  try {
    const { replyText } = await handleIncomingMessage(`telegram-${chatId}`, text);
    await bot.sendMessage(chatId, replyText);
    console.log(`[telegram] respondido para ${chatId}`);
  } catch (err) {
    console.error("[telegram] erro ao processar mensagem:", err);
    await bot.sendMessage(chatId, "Desculpa, tive um problema tecnico agora. Pode tentar de novo?");
  }
});

bot.on("polling_error", (err) => {
  console.error("[telegram] erro de polling:", err.message);
});
