import express from "express";
import dotenv from "dotenv";
import { ensureSchema, pool } from "./db.js";
import { handleIncomingMessage } from "./rag.js";
import { sendWhatsAppMessage, parseIncomingMessage } from "./meta-whatsapp.js";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false })); // usado só se o webhook do Twilio estiver ativo
app.use(express.json()); // a Meta Cloud API manda JSON

const PORT = process.env.PORT || 3000;
const WHATSAPP_PROVIDER = process.env.WHATSAPP_PROVIDER || "meta"; // "meta" | "twilio"
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

// =========================================================================
// META WHATSAPP CLOUD API (recomendado — sem taxa extra de plataforma)
// =========================================================================

// A Meta exige esse passo de verificação UMA VEZ, ao configurar o webhook
// no painel do Meta for Developers. Ela manda um GET com um "challenge".
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("[webhook] verificação da Meta concluída com sucesso.");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recebe as mensagens reais dos clientes via Meta Cloud API
app.post("/webhook/whatsapp", async (req, res) => {
  // Responde 200 imediatamente — a Meta espera resposta rápida e reenvia
  // o webhook se demorar, o que pode gerar respostas duplicadas.
  res.sendStatus(200);

  if (WHATSAPP_PROVIDER !== "meta") return;

  try {
    const incoming = parseIncomingMessage(req.body);
    if (!incoming) return; // não é mensagem de texto (status de entrega, imagem, etc.)

    console.log(`[whatsapp] ${incoming.from}: ${incoming.text}`);

    const { replyText } = await handleIncomingMessage(incoming.from, incoming.text);

    await sendWhatsAppMessage(incoming.from, replyText);
  } catch (err) {
    console.error("[webhook] erro ao processar mensagem (Meta):", err);
  }
});

// --- Endpoint simples de métricas para o dashboard/demo ---
app.get("/metrics", async (req, res) => {
  try {
    const [{ rows: convRows }, { rows: escRows }, { rows: topicRows }] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT phone_number) AS total_conversas FROM conversations;`
      ),
      pool.query(`SELECT COUNT(*) AS total_escalacoes FROM escalations;`),
      pool.query(`
        SELECT category, COUNT(*) AS total
        FROM knowledge_chunks
        GROUP BY category
        ORDER BY total DESC;
      `),
    ]);

    res.json({
      total_conversas: Number(convRows[0].total_conversas),
      total_escalacoes: Number(escRows[0].total_escalacoes),
      base_conhecimento_por_categoria: topicRows,
    });
  } catch (err) {
    console.error("[metrics] erro:", err);
    res.status(500).json({ error: "falha ao buscar métricas" });
  }
});

// =========================================================================
// TWILIO (fallback opcional — útil pra testar no Sandbox antes da Meta
// aprovar seu número de produção). Ative com WHATSAPP_PROVIDER=twilio.
// =========================================================================
if (WHATSAPP_PROVIDER === "twilio") {
  const twilioModule = await import("twilio");
  const twilio = twilioModule.default;
  const { MessagingResponse } = twilio.twiml;

  app.post("/webhook/whatsapp-twilio", async (req, res) => {
    const twiml = new MessagingResponse();
    try {
      const from = req.body.From;
      const body = (req.body.Body || "").trim();
      if (!from || !body) {
        res.type("text/xml").send(twiml.toString());
        return;
      }
      console.log(`[whatsapp/twilio] ${from}: ${body}`);
      const { replyText } = await handleIncomingMessage(from, body);
      twiml.message(replyText);
      res.type("text/xml").send(twiml.toString());
    } catch (err) {
      console.error("[webhook/twilio] erro:", err);
      twiml.message("Desculpa, tive um problema técnico agora. Tenta de novo? 🙏");
      res.type("text/xml").send(twiml.toString());
    }
  });
  console.log("[server] rota Twilio ativa em /webhook/whatsapp-twilio");
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

async function start() {
  await ensureSchema();
  app.listen(PORT, () => {
    console.log(`[server] agente RAG rodando na porta ${PORT}`);
    console.log(`[server] webhook: POST http://localhost:${PORT}/webhook/whatsapp`);
  });
}

start().catch((err) => {
  console.error("[server] falha ao iniciar:", err);
  process.exit(1);
});
