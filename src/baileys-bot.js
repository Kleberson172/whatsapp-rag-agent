/**
 * baileys-bot.js
 * ============================================================================
 * Ponte entre o WhatsApp (via Baileys) e o motor de atendimento (rag.js).
 *
 * Fluxo resumido:
 *   1. Cliente manda mensagem -> handleIncomingMessage() decide responder
 *      sozinho (Gemini + RAG) ou escalar para um humano.
 *   2. Se escalar: a conversa fica pausada no Postgres, o cliente recebe um
 *      aviso, e o staff recebe uma notificacao no WhatsApp dele.
 *   3. O staff responde CITANDO essa notificacao (segurar -> Responder no
 *      WhatsApp). O bot le o ID da mensagem citada, descobre pra qual
 *      cliente repassar, e faz a ponte. Citando a mesma notificacao com o
 *      texto exato "/bot", o staff devolve a conversa pro bot.
 *
 * A associacao "notificacao -> cliente" fica gravada na tabela Postgres
 * staff_notifications (nao em memoria), para sobreviver a reinicios do bot.
 * ============================================================================
 */

import { createRequire } from "module";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import dotenv from "dotenv";
import { handleIncomingMessage, resumeConversation, getRecentHistory } from "./rag.js";
import { pool } from "./db.js";

dotenv.config();

// Baileys e um pacote CommonJS; import dinamico via createRequire pra usar
// import/export normal (ESM) no resto do projeto.
const require = createRequire(import.meta.url);
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");

const STAFF_NUMBER = process.env.STAFF_WHATSAPP_NUMBER;

// Ignora mensagens mais velhas que isso quando chegam em lote na reconexao
// (ver funcao isStaleMessage abaixo).
const STALE_MESSAGE_THRESHOLD_SECONDS = 120;

// Guarda uma referencia ao sock e staffJid "atuais", atualizada sempre que
// a conexao (re)abre. Usado so pelo handler de encerramento abaixo, pra
// mandar um ultimo aviso ao staff quando o processo for parado de forma
// "educada" (Ctrl+C, pm2 stop, desligar o PC normalmente).
const botState = { sock: null, staffJid: null };

async function notifyStaffOfShutdown() {
  if (!botState.sock || !botState.staffJid) return;
  try {
    await safeSendMessage(botState.sock, botState.staffJid, {
      text: "AVISO: o bot foi desligado agora (PC/processo parado). Por favor, assuma o atendimento manualmente ate ele voltar.",
    });
    console.log("[baileys] aviso de desligamento enviado ao staff");
  } catch (err) {
    console.error("[baileys] falha ao avisar staff do desligamento:", err.message);
  }
}

// So cobre encerramentos "com aviso previo" (Ctrl+C, pm2 stop, shutdown
// normal do Windows que da tempo ao processo). Uma queda de energia ou
// crash abrupto NAO passa por aqui - nesses casos nada pode ser enviado,
// porque o processo simplesmente para de existir sem chance de reagir.
process.on("SIGINT", async () => {
  await notifyStaffOfShutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await notifyStaffOfShutdown();
  process.exit(0);
});

// No Windows, o pm2 nem sempre consegue entregar SIGINT/SIGTERM de forma
// confiavel ao processo. Em vez disso, ele manda uma mensagem IPC quando
// configurado com shutdown_with_message: true no ecosystem.config.cjs.
// Isto cobre o "pm2 stop"/"pm2 restart"/"pm2 delete" no Windows.
if (process.send) {
  process.on("message", async (msg) => {
    if (msg === "shutdown") {
      await notifyStaffOfShutdown();
      process.exit(0);
    }
  });
}

// ============================================================================
// Persistencia das notificacoes de handoff (Postgres)
// ----------------------------------------------------------------------------
// Cada vez que o bot notifica o staff sobre um cliente, guardamos aqui a
// relacao "ID da mensagem de notificacao -> JID do cliente". Isso e o que
// permite ao staff responder por CITACAO: ele cita a notificacao, o bot
// olha o stanzaId da citacao, consulta esta tabela, e sabe pra quem repassar.
//
// Fica no Postgres (nao num Map() em memoria) porque o bot reinicia com
// alguma frequencia (deploys, crashes, updates) e um Map() em memoria
// perderia todas as conversas em atendimento a cada restart.
// ============================================================================

async function saveNotification(notificationId, customerJid) {
  await pool.query(
    `INSERT INTO staff_notifications (notification_id, customer_jid) VALUES ($1, $2)
     ON CONFLICT (notification_id) DO NOTHING;`,
    [notificationId, customerJid]
  );
}

// Retorna o JID do cliente associado a uma notificacao, ou null se a
// notificacao nao existir ou ja tiver sido resolvida (staff ja respondeu
// ou ja reativou o bot pra aquele cliente usando essa notificacao).
async function getCustomerByNotification(notificationId) {
  const { rows } = await pool.query(
    `SELECT customer_jid FROM staff_notifications
     WHERE notification_id = $1 AND resolved_at IS NULL;`,
    [notificationId]
  );
  return rows.length > 0 ? rows[0].customer_jid : null;
}

async function resolveNotification(notificationId) {
  await pool.query(
    `UPDATE staff_notifications SET resolved_at = now() WHERE notification_id = $1;`,
    [notificationId]
  );
}

// Resolve TODAS as notificacoes pendentes de um cliente de uma vez -
// usado quando o proprio cliente cancela o pedido de atendimento antes
// do staff responder, pra nao deixar notificacoes "orfas" no ar.
async function resolveAllNotificationsForCustomer(customerJid) {
  await pool.query(
    `UPDATE staff_notifications SET resolved_at = now() WHERE customer_jid = $1 AND resolved_at IS NULL;`,
    [customerJid]
  );
}

// ============================================================================
// Resolucao de JIDs (@lid) e envio seguro de mensagens
// ----------------------------------------------------------------------------
// O WhatsApp por vezes identifica um contacto por um "LID" (linked ID,
// formato xxxxx@lid) em vez do numero de telefone real (xxxxx@s.whatsapp.net).
// Enviar mensagens direto pra um JID @lid causava entregas que pareciam
// funcionar nos logs ("respondido para...") mas nunca chegavam de fato ao
// destinatario (erro "ack 463" do WhatsApp, falha silenciosa).
//
// A correcao: antes de qualquer envio, resolvemos o @lid pro JID real via
// sock.signalRepository.lidMapping, disponivel a partir do Baileys 7.x.
// Por isso TODO envio de mensagem no ficheiro passa por safeSendMessage()
// em vez de chamar sock.sendMessage() direto.
// ============================================================================

async function resolveSendJid(sock, jid) {
  if (!jid || !jid.endsWith("@lid")) return jid;

  try {
    const phoneNumberJid = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
    if (phoneNumberJid) {
      console.log(`[baileys] @lid resolvido: ${jid} -> ${phoneNumberJid}`);
      return phoneNumberJid;
    }
  } catch (err) {
    console.error("[baileys] erro ao resolver @lid via signalRepository:", err.message);
  }

  console.warn(`[baileys] AVISO: nao foi possivel resolver ${jid} para um JID real. Envio pode falhar (ack 463).`);
  return jid;
}

async function safeSendMessage(sock, jid, content) {
  const sendJid = await resolveSendJid(sock, jid);
  return sock.sendMessage(sendJid, content);
}

// Resolve o numero de telefone do staff (do .env) para o JID de WhatsApp
// correspondente, usado para mandar as notificacoes de escalacao.
async function resolveStaffJid(sock, phoneNumber) {
  try {
    const results = await sock.onWhatsApp(phoneNumber);
    if (results && results[0]?.exists) {
      return results[0].jid;
    }
  } catch (err) {
    console.error("[baileys] erro ao resolver JID do staff:", err.message);
  }
  return null;
}

// ============================================================================
// Filtro de mensagens antigas (offline backlog)
// ----------------------------------------------------------------------------
// O WhatsApp guarda mensagens enviadas enquanto o bot esta desligado e
// entrega tudo de uma vez quando ele reconecta. Sem este filtro, o bot
// processa e responde a mensagens de horas atras, misturando contexto
// antigo com a conversa atual (respostas "fora de sincronia").
// ============================================================================

function isStaleMessage(msg) {
  if (msg.key.fromMe) return false; // nunca filtra mensagens do proprio staff/bot
  const messageTimestamp = Number(msg.messageTimestamp) || 0;
  if (messageTimestamp === 0) return false;
  const ageSeconds = Math.floor(Date.now() / 1000) - messageTimestamp;
  return ageSeconds > STALE_MESSAGE_THRESHOLD_SECONDS;
}

// ============================================================================
// Handler: mensagens enviadas pelo staff (fromMe = true)
// ----------------------------------------------------------------------------
// Duas formas de reativar/responder:
//   A) Citando uma notificacao valida (fluxo principal, recomendado).
//   B) "/bot" solto, sem citar nada, direto numa conversa de cliente
//      (fluxo antigo de compatibilidade, usado so em testes/emergencia).
// ============================================================================

async function handleStaffMessage(sock, msg, from, text, staffJid) {
  const stanzaId = msg.message.extendedTextMessage?.contextInfo?.stanzaId;

  if (stanzaId) {
    const quotedCustomerJid = await getCustomerByNotification(stanzaId);

    if (quotedCustomerJid) {
      if (text.trim().toLowerCase() === "/bot") {
        // Staff citou a notificacao e mandou /bot -> devolve a conversa ao bot.
        await resumeConversation(quotedCustomerJid);
        await resolveNotification(stanzaId);
        console.log(`[baileys] bot retomado (via citacao) para ${quotedCustomerJid}`);
        await safeSendMessage(sock, from, { text: `Bot reativado para ${quotedCustomerJid}.` });
      } else {
        // Staff citou a notificacao e escreveu uma resposta -> repassa ao cliente.
        await safeSendMessage(sock, quotedCustomerJid, { text });
        console.log(`[baileys] mensagem do staff repassada (via citacao) para ${quotedCustomerJid}`);
      }
    } else {
      // Citou algo, mas essa notificacao ja foi resolvida antes ou nao existe.
      // Importante: NAO cai no fluxo de compatibilidade aqui - isso poderia
      // reativar a conversa errada em silencio. Melhor avisar o staff.
      console.log(`[baileys] citacao nao corresponde a notificacao pendente (stanzaId=${stanzaId})`);
      await safeSendMessage(sock, from, {
        text: "Essa notificacao ja foi respondida ou expirou. Peca pro cliente mandar outra mensagem, ou cite a notificacao mais recente dele.",
      });
    }
    return;
  }

  // Sem citacao nenhuma.
  if (text.trim().toLowerCase() === "/bot") {
    // Compara os JIDs depois de resolver @lid e remover o sufixo de
    // dispositivo (":0", ":7", etc). O mesmo numero do staff pode chegar
    // como @lid, @s.whatsapp.net, com ou sem sufixo de dispositivo,
    // dependendo do evento - uma comparacao direta de string falha nesses casos.
    const stripDevice = (jid) => (jid ? jid.replace(/:\d+(?=@)/, "") : jid);
    const resolvedFrom = stripDevice(await resolveSendJid(sock, from));
    const resolvedStaffJid = staffJid ? stripDevice(await resolveSendJid(sock, staffJid)) : null;

    if (resolvedStaffJid && resolvedFrom === resolvedStaffJid) {
      // Staff mandou "/bot" solto na propria conversa com o bot, sem citar
      // nada. Isso nao tem cliente associado - avisamos em vez de nao fazer
      // nada (silenciosamente inutil).
      console.log('[baileys] "/bot" sem citacao recebido do staff - avisando');
      await safeSendMessage(sock, from, {
        text: "Pra reativar o bot de um cliente, responda (cite) a notificacao dele e so entao mande /bot.",
      });
    } else {
      // Compatibilidade com o fluxo antigo: "/bot" direto na conversa do
      // cliente (ex: staff com acesso direto ao WhatsApp do bot). Reativa
      // em silencio, sem confirmacao, porque essa conversa e vista pelo
      // proprio cliente.
      await resumeConversation(from);
      console.log(`[baileys] bot retomado manualmente (silencioso) para ${from}`);
    }
  }
}

// ============================================================================
// Handler: mensagens recebidas de clientes
// ----------------------------------------------------------------------------
// Chama o motor de atendimento (rag.js). Se ele devolver replyText, o bot
// responde diretamente. Se devolver null, a conversa foi pausada (ou ja
// estava pausada) e o cliente/staff precisam ser avisados.
// ============================================================================

async function notifyStaffOfEscalation(sock, staffJid, from, text, justEscalated) {
  if (!staffJid) return;

  let notifText;

  if (justEscalated) {
    // Primeira escalacao desta conversa: manda o historico recente junto,
    // pro staff nao comecar o atendimento sem contexto nenhum.
    const recentHistory = await getRecentHistory(from, 4);
    const historyText = recentHistory.length
      ? recentHistory.map((h) => `${h.role === "user" ? "Cliente" : "Bot"}: ${h.content}`).join("\n")
      : "Sem historico anterior.";
    notifText = `Cliente ${from} precisa de atendimento.\n\nHistorico recente:\n${historyText}\n\nUltima mensagem: ${text}`;
  } else {
    // Cliente ja estava pausado e mandou mais uma mensagem: aviso mais
    // simples, so com o texto novo, pro staff nao perder o fio da conversa.
    notifText = `Cliente ${from} (ja em atendimento) mandou mais uma mensagem:\n${text}`;
  }

  const notification = await safeSendMessage(sock, staffJid, { text: notifText });
  const notificationId = notification?.key?.id;
  if (notificationId) {
    await saveNotification(notificationId, from);
    console.log(`[baileys] notificacao registada: ${notificationId} -> ${from}`);
  }
}

async function handleCustomerMessage(sock, from, text, staffJid) {
  console.log(`[baileys] mensagem de ${from}: ${text}`);

  try {
    const { replyText, justEscalated, escalationCancelled } = await handleIncomingMessage(from, text);

    if (replyText === null) {
      console.log(`[baileys] conversa pausada para ${from}, aguardando atendente`);

      // So na primeira escalacao avisamos o cliente - evita repetir
      // "vou te conectar..." a cada mensagem enquanto ele espera.
      if (justEscalated) {
        await safeSendMessage(sock, from, {
          text: "Vou te conectar com um dos nossos atendentes. So um momento!",
        });
      }

      await notifyStaffOfEscalation(sock, staffJid, from, text, justEscalated);
      return;
    }

    await safeSendMessage(sock, from, { text: replyText });
    console.log(`[baileys] respondido para ${from}`);

    if (escalationCancelled) {
      // O cliente cancelou o pedido de atendimento enquanto esperava
      // (ex: disse "nao e necessario"). Resolve as notificacoes pendentes
      // e avisa o staff que nao precisa agir.
      await resolveAllNotificationsForCustomer(from);
      console.log(`[baileys] cliente cancelou o proprio pedido de atendimento: ${from}`);
      if (staffJid) {
        await safeSendMessage(sock, staffJid, {
          text: `Cliente ${from} cancelou o pedido de atendimento (disse: "${text}") e ja voltou a ser atendido pelo bot automaticamente. Nao precisa responder.`,
        });
      }
    } else {
      // Espelha a troca (pergunta do cliente + resposta do bot) no WhatsApp
      // do staff, para acompanhamento - mesmo quando o bot respondeu
      // sozinho, sem precisar de escalar. Controlavel via
      // MIRROR_ALL_TO_STAFF no .env (default: ligado; "false" desativa).
      // Por padrao, o staff so recebe mensagens ligadas a uma escalacao
      // (pedido de atendimento, mensagens durante a pausa, cancelamento).
      // Para voltar a espelhar TODAS as trocas normais (mesmo sem escalar),
      // define MIRROR_ALL_TO_STAFF=true no .env.
      const mirrorEnabled = process.env.MIRROR_ALL_TO_STAFF === "true";
      if (mirrorEnabled && staffJid) {
        await safeSendMessage(sock, staffJid, {
          text: `Cliente ${from}:\n${text}\n\nBot respondeu:\n${replyText}`,
        });
      }
    }
  } catch (err) {
    console.error("[baileys] erro ao processar mensagem:", err);
    // Protege contra uma segunda falha aqui (ex: conexao instavel) derrubar
    // o processo inteiro - isso anularia toda a resiliencia do pm2, porque
    // um erro nao tratado aqui sobe e mata o Node.js de vez.
    try {
      await safeSendMessage(sock, from, {
        text: "Desculpa, tive um problema tecnico agora. Pode tentar de novo?",
      });
    } catch (sendErr) {
      console.error("[baileys] falha tambem ao enviar mensagem de erro:", sendErr.message);
    }
  }
}

// ============================================================================
// Bootstrap da conexao com o WhatsApp
// ============================================================================

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./baileys-auth");
  let staffJid = null;

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    // Sem isto, algumas versoes 7.x do Baileys desativam TODA a
    // sincronizacao quando syncFullHistory e false - o que quebra o
    // preenchimento do mapeamento LID (usado em resolveSendJid acima).
    shouldSyncHistoryMessage: (msg) => {
      return (
        msg.syncType === 0 /* INITIAL_BOOTSTRAP */ ||
        msg.syncType === 2 /* RECENT */
      );
    },
  });

  botState.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
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
      return;
    }

    if (connection === "open") {
      console.log("[baileys] Conectado ao WhatsApp com sucesso! Pode mandar mensagens agora.");

      if (!STAFF_NUMBER) {
        console.log("[baileys] AVISO: STAFF_WHATSAPP_NUMBER nao configurado no .env - avisos de escalacao nao serao enviados.");
        return;
      }

      const jid = await resolveStaffJid(sock, STAFF_NUMBER);
      if (jid) {
        staffJid = jid;
        botState.staffJid = jid;
        console.log(`[baileys] numero de staff resolvido: ${jid}`);
      } else {
        console.log(`[baileys] AVISO: nao foi possivel encontrar ${STAFF_NUMBER} no WhatsApp. Confira se o numero esta correto (com codigo do pais, sem +).`);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const from = msg.key.remoteJid;
      if (from?.endsWith("@g.us")) continue; // ignora mensagens de grupo

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      if (!text.trim()) continue;

      if (isStaleMessage(msg)) {
        const ageSeconds = Math.floor(Date.now() / 1000) - Number(msg.messageTimestamp);
        console.log(`[baileys] mensagem antiga ignorada de ${from} (idade: ${ageSeconds}s): ${text}`);
        continue;
      }

      if (msg.key.fromMe) {
        await handleStaffMessage(sock, msg, from, text, staffJid);
        continue;
      }

      await handleCustomerMessage(sock, from, text, staffJid);
    }
  });
}

startBot().catch((err) => {
  console.error("[baileys] falha ao iniciar:", err);
  process.exit(1);
});
