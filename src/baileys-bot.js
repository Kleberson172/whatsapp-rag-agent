import { createRequire } from "module";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import { handleIncomingMessage } from "./rag.js";

const require = createRequire(import.meta.url);
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./baileys-auth");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n[baileys] Escaneie este QR code com o WhatsApp do celular:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("[baileys] conexao fechada, reconectando:", shouldReconnect);
      if (shouldReconnect) {
        startBot();
      } else {
        console.log("[baileys] sessao encerrada (logout). Apague a pasta baileys-auth e rode de novo pra reconectar.");
      }
    } else if (connection === "open") {
      console.log("[baileys] Conectado ao WhatsApp com sucesso! Pode mandar mensagens agora.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      const isGroup = from?.endsWith("@g.us");
      if (isGroup) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!text.trim()) continue;

      console.log(`[baileys] mensagem de ${from}: ${text}`);

      try {
        const { replyText } = await handleIncomingMessage(from, text);
        await sock.sendMessage(from, { text: replyText });
        console.log(`[baileys] respondido para ${from}`);
      } catch (err) {
        console.error("[baileys] erro ao processar mensagem:", err);
        await sock.sendMessage(from, {
          text: "Desculpa, tive um problema tecnico agora. Pode tentar de novo?",
        });
      }
    }
  });
}

startBot().catch((err) => {
  console.error("[baileys] falha ao iniciar:", err);
  process.exit(1);
});


