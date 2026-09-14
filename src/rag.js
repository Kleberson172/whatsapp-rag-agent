/**
 * rag.js
 * ============================================================================
 * Motor de atendimento: decide como responder a cada mensagem do cliente.
 *
 * Para cada mensagem recebida, handleIncomingMessage() faz o seguinte:
 *   1. Se a conversa ja estiver pausada (aguardando staff), so grava a
 *      mensagem e devolve replyText: null - nao gasta chamada ao Gemini.
 *   2. Busca contexto relevante na base de conhecimento (embeddings/pgvector).
 *   3. Decide se precisa escalar para um humano (shouldEscalate).
 *   4. Se escalar: pausa a conversa no Postgres e devolve replyText: null
 *      (quem avisa o cliente e notifica o staff e o baileys-bot.js).
 *   5. Se nao escalar: gera a resposta com o Gemini (RAG) e devolve o texto.
 *
 * Todo o estado (historico, pausa, escalacoes) fica no Postgres (Neon),
 * nao em memoria - assim sobrevive a reinicios do bot.
 * ============================================================================
 */

import dotenv from "dotenv";
import { pool } from "./db.js";
import { embed, toPgVector } from "./embeddings.js";
import { generateReply } from "./llm.js";

dotenv.config();

// ============================================================================
// Configuracao
// ============================================================================

const BUSINESS_NAME = process.env.BUSINESS_NAME || "a empresa";
const TENANT_ID = "default"; // preparado para multi-tenant, so 1 loja por agora

const MAX_HISTORY_MESSAGES = 8; // quantas mensagens de historico entram no prompt do Gemini
const MAX_MESSAGE_LENGTH = 1000; // limite de tamanho da mensagem do cliente
const TOP_K = 5; // quantos trechos da base de conhecimento buscar por mensagem

// ============================================================================
// Base de conhecimento (RAG) e historico de conversa
// ============================================================================

// Busca os trechos mais relevantes da base de conhecimento para a mensagem
// do cliente, usando similaridade de embeddings (pgvector).
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

// Historico recente da conversa com um cliente. O parametro `limit` permite
// pedir menos mensagens do que o padrao - usado pelo baileys-bot.js para
// incluir um resumo curto na notificacao ao staff.
export async function getRecentHistory(phoneNumber, limit = MAX_HISTORY_MESSAGES) {
  const { rows } = await pool.query(
    `
    SELECT role, content
    FROM conversations
    WHERE tenant_id = $1 AND phone_number = $2
    ORDER BY created_at DESC
    LIMIT $3;
    `,
    [TENANT_ID, phoneNumber, limit]
  );
  return rows.reverse(); // volta em ordem cronologica (mais antiga primeiro)
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

// ============================================================================
// Prompt do sistema (personalidade e regras do assistente)
// ============================================================================

function buildSystemPrompt(contextChunks) {
  const contextText = contextChunks.length
    ? contextChunks
        .map((c, i) => `[${i + 1}] (${c.category}) ${c.title}\n${c.content}`)
        .join("\n\n")
    : "Nenhuma informacao relevante encontrada na base de conhecimento.";

  return `Voce e o assistente virtual de atendimento ao cliente da ${BUSINESS_NAME}, uma perfumaria, falando via WhatsApp.

REGRAS IMPORTANTES:
- Responda SEMPRE no mesmo idioma que o cliente usar na mensagem mais recente dele. Se ele escrever em ingles, responda em ingles; em frances, em frances; em portugues, em portugues. Nao misture idiomas numa mesma resposta, e mantenha esse idioma de forma consistente enquanto o cliente continuar a escrever nele.
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

// ============================================================================
// Decisao de escalacao para atendimento humano
// ----------------------------------------------------------------------------
// Regras, por ordem de prioridade:
//   1. Saudacao simples ("oi", "boa noite") ou agradecimento/despedida
//      ("obrigado", "tchau") -> nunca escala.
//   2. Negacao explicita ("nao quero atendente", "deixa pra la") -> nunca
//      escala, mesmo se a frase contiver uma palavra-gatilho como
//      "atendente" (ex: "nao quero falar com atendente" NAO deve escalar).
//   3. Palavra-gatilho de frustracao (atendente, humano, reclamacao, etc.)
//      -> escala.
//   4. Nenhum trecho relevante encontrado na base de conhecimento -> escala
//      (o bot nao tem como responder com confianca).
// ============================================================================

function shouldEscalate(userMessage, contextChunks) {
  const frustrationSignals = [
    "atendente", "humano", "pessoa real", "reclamacao", "reclamar",
    "processo", "advogado", "cancelar pedido", "estorno", "nao funciona",
  ];
  const negationPrefixes = [
    "nao quero", "nao preciso", "nao precisa", "nao e preciso",
    "sem ser", "nao e necessario", "nao precisava", "ta bem assim",
    "esta bem assim", "deixa pra la", "deixa para la", "pode deixar",
  ];
  const greetingPatterns = [
    "oi", "ola", "boa noite", "bom dia", "boa tarde", "tudo bem",
    "ei", "e ai", "salve", "hey", "start",
    "obrigado", "obrigada", "obg", "vlw", "valeu", "tchau", "ate mais", "flw",
  ];

  // Remove acentos antes de comparar - sem isso, "nao quero" (sem acento,
  // como escrevemos nas listas acima) nunca bate com "não quero" (como o
  // cliente realmente digita), fazendo negacoes/saudacoes passarem batido.
  const lower = userMessage
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  const isGreeting =
    lower.length <= 25 && greetingPatterns.some((g) => lower.includes(g));

  // Nega explicitamente o pedido (ex: "nao quero um atendente") - nao conta
  // como sinal de frustracao nem de falta de contexto, mesmo contendo uma
  // palavra-gatilho.
  const isNegatedRequest = negationPrefixes.some((n) => lower.includes(n));

  const mentionsFrustration =
    !isNegatedRequest && frustrationSignals.some((s) => lower.includes(s));

  const noContext =
    !isGreeting &&
    !isNegatedRequest &&
    (contextChunks.length === 0 || contextChunks.every((c) => c.similarity < 0.3));

  return {
    escalate: mentionsFrustration || noContext,
    mentionsFrustration,
    noContext,
  };
}

// ============================================================================
// Estado da conversa (pausada / ativa)
// ----------------------------------------------------------------------------
// Guardado na tabela conversation_state do Postgres - nao em memoria - para
// sobreviver a reinicios do bot. is_paused = true significa "aguardando
// resposta do staff"; enquanto isso, handleIncomingMessage nao chama o
// Gemini para esse numero.
// ============================================================================

export async function isConversationPaused(phoneNumber) {
  const { rows } = await pool.query(
    `SELECT is_paused FROM conversation_state WHERE tenant_id = $1 AND phone_number = $2;`,
    [TENANT_ID, phoneNumber]
  );
  return rows.length > 0 && rows[0].is_paused === true;
}

export async function pauseConversation(phoneNumber, reason) {
  await pool.query(
    `
    INSERT INTO conversation_state (tenant_id, phone_number, is_paused, paused_reason, updated_at)
    VALUES ($1, $2, true, $3, now())
    ON CONFLICT (phone_number)
    DO UPDATE SET is_paused = true, paused_reason = $3, updated_at = now();
    `,
    [TENANT_ID, phoneNumber, reason]
  );
}

export async function resumeConversation(phoneNumber) {
  await pool.query(
    `
    INSERT INTO conversation_state (tenant_id, phone_number, is_paused, paused_reason, updated_at)
    VALUES ($1, $2, false, NULL, now())
    ON CONFLICT (phone_number)
    DO UPDATE SET is_paused = false, paused_reason = NULL, updated_at = now();
    `,
    [TENANT_ID, phoneNumber]
  );
}

// ============================================================================
// Ponto de entrada: processa uma mensagem recebida do cliente
// ============================================================================

// Mensagens que, enquanto a conversa esta pausada (aguardando staff),
// indicam que o cliente desistiu do atendimento humano - o bot pode
// retomar sozinho, sem esperar o staff responder.
const CANCEL_PATTERNS = [
  "nao precisa", "nao e necessario", "nao quero mais", "deixa pra la",
  "deixa para la", "pode deixar", "esquece", "cancela", "ja resolvi",
  "consegui sozinho", "nao precisava", "ta bem assim", "esta bem assim",
];

function isCancelRequest(userMessage) {
  const lower = userMessage
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  return CANCEL_PATTERNS.some((p) => lower.includes(p));
}

export async function handleIncomingMessage(phoneNumber, userMessage) {
  // 1. Conversa ja pausada?
  //    - Se o cliente disser que nao precisa mais de atendimento humano
  //      (ex: "nao e necessario", "deixa pra la"), o bot retoma sozinho.
  //    - Caso contrario, so grava e devolve null - nao gasta chamada ao
  //      Gemini enquanto o cliente espera o staff.
  const paused = await isConversationPaused(phoneNumber);
  let escalationCancelled = false;

  if (paused) {
    if (isCancelRequest(userMessage)) {
      await resumeConversation(phoneNumber);
      escalationCancelled = true;
      // nao retorna aqui - segue o fluxo normal abaixo, como se a
      // conversa ja nao estivesse mais pausada.
    } else {
      await saveMessage(phoneNumber, "user", userMessage);
      return { replyText: null, escalated: true, justEscalated: false, paused: true };
    }
  }

  // 2. Mensagem absurdamente longa - responde sem gastar chamada ao Gemini.
  if (userMessage.length > MAX_MESSAGE_LENGTH) {
    return {
      replyText: "Opa, essa mensagem ficou grande demais pra mim! Pode resumir em algumas frases o que voce precisa?",
      escalated: false,
    };
  }

  // 3. Busca contexto (RAG) e historico em paralelo.
  const [contextChunks, history] = await Promise.all([
    retrieveContext(userMessage),
    getRecentHistory(phoneNumber),
  ]);

  const { escalate, mentionsFrustration } = shouldEscalate(userMessage, contextChunks);

  let justEscalated = false;
  let replyText;

  if (escalate) {
    // 4a. Precisa de humano: pausa a conversa e devolve null. NAO chama o
    //     Gemini - o baileys-bot.js e quem avisa o cliente e notifica o staff.
    const reason = mentionsFrustration ? "frustracao/palavra-chave" : "sem contexto suficiente";
    await logEscalation(phoneNumber, reason);
    await pauseConversation(phoneNumber, reason);
    justEscalated = true;
    replyText = null;
  } else {
    // 4b. Bot responde sozinho, usando o contexto da base de conhecimento
    //     e o historico recente da conversa.
    const systemPrompt = buildSystemPrompt(contextChunks);
    const messages = [
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userMessage },
    ];
    replyText = await generateReply(systemPrompt, messages);
  }

  await saveMessage(phoneNumber, "user", userMessage);
  if (replyText !== null) {
    await saveMessage(phoneNumber, "assistant", replyText);
  }

  return { replyText, escalated: escalate, justEscalated, escalationCancelled };
}
