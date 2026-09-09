import dotenv from "dotenv";
import { pool } from "./db.js";
import { embed, toPgVector } from "./embeddings.js";
import { generateReply } from "./llm.js";

dotenv.config();

const BUSINESS_NAME = process.env.BUSINESS_NAME || "a empresa";
const TENANT_ID = "default";

const MAX_HISTORY_MESSAGES = 8;
const TOP_K = 5;

async function retrieveContext(query) {
  const queryEmbedding = await embed(query, "query");
  const vectorLiteral = toPgVector(queryEmbedding);

  const { rows } = await pool.query(
    `
    SELECT title, content, category, 1 - (embedding <=> $1::vector) AS similarity
    FROM knowledge_chunks
    WHERE tenant_id = $2
    ORDER BY embedding <=> $1::vector
    LIMIT $3;
    `,
    [vectorLiteral, TENANT_ID, TOP_K]
  );

  return rows;
}

async function getRecentHistory(phoneNumber) {
  const { rows } = await pool.query(
    `
    SELECT role, content
    FROM conversations
    WHERE tenant_id = $1 AND phone_number = $2
    ORDER BY created_at DESC
    LIMIT $3;
    `,
    [TENANT_ID, phoneNumber, MAX_HISTORY_MESSAGES]
  );
  return rows.reverse();
}

async function saveMessage(phoneNumber, role, content) {
  await pool.query(
    `INSERT INTO conversations (tenant_id, phone_number, role, content) VALUES ($1, $2, $3, $4);`,
    [TENANT_ID, phoneNumber, role, content]
  );
}

async function logEscalation(phoneNumber, reason) {
  await pool.query(
    `INSERT INTO escalations (tenant_id, phone_number, reason) VALUES ($1, $2, $3);`,
    [TENANT_ID, phoneNumber, reason]
  );
}

function buildSystemPrompt(contextChunks) {
  const contextText = contextChunks.length
    ? contextChunks
        .map((c, i) => `[${i + 1}] (${c.category}) ${c.title}\n${c.content}`)
        .join("\n\n")
    : "Nenhuma informacao relevante encontrada na base de conhecimento.";

  return `Voce e o assistente virtual de atendimento ao cliente da ${BUSINESS_NAME}, uma perfumaria, falando via WhatsApp.

REGRAS IMPORTANTES:
- Responda SOMENTE com base nas informacoes fornecidas abaixo (contexto recuperado). Nunca invente precos, prazos, disponibilidade de produtos ou politicas.
- Se a informacao nao estiver no contexto, diga honestamente que nao tem certeza e ofereca transferir para um atendente humano.
- Fale como uma pessoa de verdade conversando no WhatsApp: frases curtas, tom leve e caloroso, do jeito que uma vendedora simpatica da loja falaria. Evite linguagem formal e evite repetir sempre a mesma estrutura de frase.
- Varie a forma de comecar as respostas, nem toda mensagem precisa comecar com "Ola!".
- Se o cliente so mandar uma saudacao (oi, boa noite, etc.) sem pergunta nenhuma, responda de forma simples e acolhedora, perguntando como pode ajudar - nao empurre produtos nem mencione atendente humano nessa primeira troca.
- Para negrito, use APENAS um asterisco de cada lado (ex: *Essencia Noir*), nunca dois asteriscos, e o padrao do WhatsApp.
- Use no maximo 2-3 frases curtas por resposta. Emojis com moderacao, so quando soar natural.
- Se o cliente demonstrar frustracao, insistir em falar com humano, ou pedir algo fora do escopo (reclamacao grave, troca/devolucao complexa, problema de pagamento), sinalize claramente que vai escalar para atendimento humano.
- Mantenha um tom pessoal e caloroso, mas se o cliente perguntar diretamente se esta falando com um robo, IA ou assistente virtual, responda com honestidade e naturalidade, sem soar como aviso legal.
- Nunca mencione "sistema", "base de dados", "nao tenho essa informacao no sistema" ou frases parecidas - isso soa robotico. Se o cliente perguntar algo fora do que a loja vende ou oferece, responda direto e natural, tipo "aqui a gente trabalha so com perfumes mesmo" ou "isso a gente nao tem, infelizmente" - como um funcionario de verdade responderia, sem parecer que esta consultando algo.

CONTEXTO RECUPERADO DA BASE DE CONHECIMENTO:
${contextText}`;
}

function shouldEscalate(userMessage, contextChunks) {
  const frustrationSignals = [
    "atendente", "humano", "pessoa real", "reclamacao", "reclamar",
    "processo", "advogado", "cancelar pedido", "estorno", "nao funciona",
  ];
  const greetingPatterns = [
    "oi", "ola", "boa noite", "bom dia", "boa tarde", "tudo bem",
    "ei", "e ai", "salve", "hey", "start",
  ];
  const lower = userMessage.toLowerCase().trim();
  const isGreeting =
    lower.length <= 25 && greetingPatterns.some((g) => lower.includes(g));

  const mentionsFrustration = frustrationSignals.some((s) => lower.includes(s));
  const noContext =
    !isGreeting &&
    (contextChunks.length === 0 || contextChunks.every((c) => c.similarity < 0.3));
  return { escalate: mentionsFrustration || noContext, mentionsFrustration, noContext };
}

const MAX_MESSAGE_LENGTH = 1000;

export async function handleIncomingMessage(phoneNumber, userMessage) {
  if (userMessage.length > MAX_MESSAGE_LENGTH) {
    return {
      replyText: "Opa, essa mensagem ficou grande demais pra mim! Pode resumir em algumas frases o que voce precisa?",
      escalated: false,
    };
  }
  const [contextChunks, history] = await Promise.all([
    retrieveContext(userMessage),
    getRecentHistory(phoneNumber),
  ]);

  const { escalate, mentionsFrustration, noContext } = shouldEscalate(userMessage, contextChunks);

  const systemPrompt = buildSystemPrompt(contextChunks);

  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  let replyText = await generateReply(systemPrompt, messages);

  if (escalate) {
    replyText += `\n\nVou te conectar com um dos nossos atendentes para continuar por aqui, ok?`;
    await logEscalation(phoneNumber, mentionsFrustration ? "frustracao/palavra-chave" : "sem contexto suficiente");
  }

  await saveMessage(phoneNumber, "user", userMessage);
  await saveMessage(phoneNumber, "assistant", replyText);

  return { replyText, escalated: escalate };
}

