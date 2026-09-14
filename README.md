# Agente RAG de Atendimento — Perfumaria Essência (ELEVEN)

Status atual: **agente completo e em operação real via WhatsApp**, incluindo
atendimento automático (RAG), handoff para atendimento humano, e gestão de
processo em produção (auto-restart, avisos de desligamento).

Este documento descreve como o projeto está estruturado, como foi montado,
e como operar/testar o que já funciona.

---

## O que já está funcionando

- ✅ Canal WhatsApp real via Baileys (multi-dispositivo, sem custo por mensagem)
- ✅ Banco de dados com busca vetorial (Neon Postgres + pgvector)
- ✅ Geração de embeddings da base de conhecimento (Voyage AI)
- ✅ Geração de respostas em linguagem natural via **Groq** (`openai/gpt-oss-20b`),
  com suporte alternativo a Gemini/Anthropic
- ✅ Busca contextual (RAG): o agente só responde com base no que está
  cadastrado na base de conhecimento, sem inventar informação
- ✅ Memória de conversa por número de telefone (contexto entre mensagens)
- ✅ Resposta automática **no mesmo idioma** que o cliente escrever
  (português, inglês, francês, etc.)
- ✅ **Handoff completo para atendimento humano**: escalação, aviso ao
  cliente, notificação ao staff com histórico, resposta do staff por
  citação da notificação, reativação do bot via `/bot`, e cancelamento
  automático se o próprio cliente disser que não precisa mais
- ✅ Persistência do handoff no Postgres (sobrevive a reinícios do bot)
- ✅ Correção do bug de entrega silenciosa para contactos `@lid`
- ✅ Filtro de mensagens antigas (evita respostas "atrasadas" após reconexão)
- ✅ Gestão de processo em produção via **pm2**: auto-restart em caso de
  falha, aviso ao staff no desligamento controlado, aviso automático ao
  staff após reconexão de internet, scripts `.bat` para iniciar/parar sem
  usar terminal
- ✅ Tom de voz humanizado e ajustado para soar natural no WhatsApp
- ✅ Testado extensivamente em cenários reais (preço, promoção, escalação,
  cancelamento, mensagens em outros idiomas, quedas de conexão)

## O que ainda falta / limitações conhecidas

- 🔧 Detecção de intenção (escalação, negação, cancelamento) é baseada em
  palavras-chave — funciona bem nos casos testados, mas não generaliza
  para frases totalmente novas
- 🔧 Sem testes automatizados (toda validação até agora foi manual)
- 🔧 Número WhatsApp usado é uma conta pessoal via Baileys (não oficial) —
  ver seção "Riscos conhecidos" abaixo
- 🔧 Sem monitorização externa para detectar quedas de internet/PC *durante*
  a falha (só é possível avisar o staff *depois* de reconectar)

---

## Arquitetura

```
Cliente (WhatsApp)
     │  manda mensagem
     ▼
Bot (baileys-bot.js) — resolve @lid, filtra mensagens antigas
     │
     ▼
rag.js — verifica se a conversa esta pausada; se nao, busca contexto
     │  (embeddings/pgvector) e decide se precisa escalar
     ▼
   ┌─────────────┴─────────────┐
   │ Sem escalar               │ Escala
   ▼                           ▼
Groq gera resposta        Pausa a conversa (Postgres),
   │                       avisa o cliente, notifica o
   ▼                       staff (com historico)
Cliente recebe resposta         │
                                 ▼
                          Staff cita a notificacao e
                          responde (ou manda /bot pra
                          reativar o bot)
                                 │
                                 ▼
                          Bot repassa a resposta ao
                          cliente certo (via o ID da
                          notificacao citada)
```

## Estrutura do projeto

```
whatsapp-rag-agent/
├── src/
│   ├── db.js                → conexão com Postgres + criação das tabelas
│   ├── embeddings.js         → geração de embeddings via Voyage AI
│   ├── llm.js                → geração de respostas (Groq por padrão;
│   │                            Gemini e Anthropic disponíveis via
│   │                            LLM_PROVIDER no .env)
│   ├── rag.js                → núcleo do agente: busca + prompt + escalação
│   │                            + cancelamento pelo cliente
│   ├── baileys-bot.js        → ponte com o WhatsApp (Baileys): recebe/envia
│   │                            mensagens, handoff por citação, avisos de
│   │                            desligamento/reconexão
│   ├── seed.js                → popula a base de conhecimento (dados de exemplo)
│   ├── migrate.js             → cria as tabelas no banco (roda separado)
│   └── index.js                → servidor Express (não usado no fluxo
│                                  principal, que roda via baileys-bot.js)
├── create-staff-notifications.sql → cria a tabela staff_notifications
├── ecosystem.config.cjs      → configuração do pm2 (produção)
├── iniciar-bot.bat            → duplo clique pra ligar o bot (via pm2)
├── parar-bot.bat               → duplo clique pra desligar o bot
├── status-bot.bat              → duplo clique pra ver se está online
├── baileys-auth/               → sessão autenticada do WhatsApp (não commitar)
├── logs/                       → logs do pm2 (não commitar)
├── .env                        → chaves de API e configurações (não commitar)
├── .env.example                 → modelo do .env
└── package.json
```

## Banco de dados (tabelas)

- **`knowledge_chunks`** — a base de conhecimento em si. Cada linha é um
  "pedaço" de informação (produto, política, FAQ) com seu embedding
  (vetor) pra busca por similaridade.
- **`conversations`** — histórico de mensagens por número de telefone,
  usado como memória de curto prazo.
- **`conversation_state`** — se a conversa de um número está pausada
  (aguardando atendimento humano) e por quê.
- **`escalations`** — registro de quando e por que uma conversa foi
  escalada para atendimento humano.
- **`staff_notifications`** — relação entre cada notificação enviada ao
  staff e o cliente correspondente. É o que permite ao staff responder
  citando a notificação e o bot saber automaticamente pra quem repassar.
  Sobrevive a reinícios do bot (ao contrário de guardar isso só em memória).

## Como a base de conhecimento é alimentada

O arquivo `src/seed.js` contém os dados (produtos com preço, promoções,
política de troca, formas de pagamento, horário de funcionamento). Cada
item tem uma `category`, `title` e `content`. Ao rodar `npm run seed`,
cada item é convertido em embedding pela Voyage AI e salvo no banco.

**Para usar com dados reais**: edite o array `knowledgeBase` em
`src/seed.js` e rode `npm run seed` de novo.

## Geração de respostas (LLM)

Por padrão, o agente usa a **Groq** (`openai/gpt-oss-20b`), que é gratuita,
rápida, e com cota diária bem mais generosa que a alternativa testada
anteriormente. Controlado por `LLM_PROVIDER=groq` no `.env`.

Modelos alternativos na Groq (trocar via `GROQ_MODEL` no `.env`):
- `openai/gpt-oss-20b` (padrão — rápido, ótimo para respostas curtas)
- `openai/gpt-oss-120b` (mais forte, mais lento — para respostas mais elaboradas)

O `src/llm.js` também suporta `LLM_PROVIDER=gemini` ou `LLM_PROVIDER=anthropic`
como alternativas, caso necessário no futuro.

## Fluxo de atendimento humano (handoff)

Quando o agente detecta que precisa de um humano (pedido explícito,
frustração, ou falta de contexto na base de conhecimento):

1. A conversa do cliente é **pausada** — o bot para de responder
   automaticamente pra esse número.
2. O cliente recebe um aviso: *"Vou te conectar com um dos nossos
   atendentes. Só um momento!"*
3. O staff (número configurado em `STAFF_WHATSAPP_NUMBER`) recebe uma
   notificação com o histórico recente da conversa.
4. **O staff responde citando essa notificação** (segurar a mensagem →
   Responder no WhatsApp) — nunca soltando uma mensagem nova sem citar.
   O bot identifica automaticamente o cliente pelo ID da mensagem citada.
5. Pra devolver a conversa ao bot, o staff cita a **mesma notificação** de
   novo e escreve, numa mensagem separada, só `/bot`.
6. Se o cliente disser, enquanto espera, algo como *"não é necessário"* ou
   *"deixa pra lá"*, o bot detecta isso e retoma sozinho, sem esperar o
   staff — e avisa o staff que pode ignorar aquela notificação.

**Visibilidade para o staff**: por padrão, o staff só recebe mensagens
ligadas a uma escalação (não vê as conversas normais que o bot resolve
sozinho). Para o staff ver **todas** as trocas, mesmo sem escalar, define
`MIRROR_ALL_TO_STAFF=true` no `.env`.

## Tom de voz e regras do agente

O prompt do agente (`buildSystemPrompt()` em `src/rag.js`) foi ajustado para:

- Responder no **mesmo idioma** que o cliente usar
- Ser curto, caloroso e natural, como um funcionário de verdade da loja
- Usar negrito no formato do WhatsApp (`*texto*`, um asterisco)
- Nunca mencionar "sistema" ou "base de dados"
- Nunca inventar preços, políticas ou informações que não estejam na base
- Escalar quando: pedido explícito, frustração, ou contexto insuficiente
  — mas **não** escalar em saudações, agradecimentos, ou negações claras
  ("não quero atendente", "não é necessário", com ou sem acento)
- Ser honesto se perguntado diretamente se é um robô/IA

## Operação em produção (pm2)

O bot roda gerido pelo **pm2** (configurado em `ecosystem.config.cjs`),
que garante:
- Reinício automático se o processo cair (crash, erro não tratado)
- Aviso ao staff no desligamento controlado (`pm2 stop`) e após reconexão
  de internet (se ficou offline por mais de 1 minuto)
- Sobrevivência a reinícios do PC (via `pm2-startup install`, já configurado)

**Uso do dia a dia**, sem precisar de terminal:
- `iniciar-bot.bat` — duplo clique pra ligar
- `parar-bot.bat` — duplo clique pra desligar (avisa o staff)
- `status-bot.bat` — duplo clique pra ver se está online

**Quando usar `node src/baileys-bot.js` direto** (sem pm2): só durante
desenvolvimento/depuração ativa, nunca em produção, e nunca ao mesmo tempo
que o pm2 estiver a gerir o processo (os dois autenticados na mesma sessão
WhatsApp entram em conflito e podem colocar a conta em risco de restrição).

**Comandos manuais do pm2** (se precisar, fora dos `.bat`):
```powershell
pm2 status                    # ver se está a correr
pm2 logs whatsapp-bot         # ver logs ao vivo
pm2 restart whatsapp-bot      # reiniciar (depois de um patch)
pm2 start ecosystem.config.cjs  # ligar (primeira vez ou depois de pm2 delete)
```

## Como testar (sem WhatsApp, direto no terminal)

```powershell
node -e "import('./src/rag.js').then(m => m.handleIncomingMessage('teste-123', 'Qual o preco do Essencia Noir?').then(r => console.log(r.replyText)))"
```

### Cenários já testados e validados

| Cenário | Resultado |
|---|---|
| Pergunta de preço com promoção ativa | Respondeu certo e calculou o desconto |
| Política de troca | Respondeu completo, sem escalar à toa |
| Pergunta fora da base | Foi honesto, sem inventar, sugeriu alternativa |
| Pedido explícito de atendente humano | Escalou corretamente, staff notificado |
| Negação ("não quero atendente") | Não escalou, respondeu normalmente |
| Cancelamento durante espera | Bot retomou sozinho, staff avisado |
| Mensagem em inglês/francês | Respondeu no mesmo idioma |
| Resposta do staff via citação | Repassada corretamente ao cliente certo |
| Queda e reconexão de internet | Staff avisado automaticamente ao reconectar |
| `pm2 stop` (desligamento controlado) | Staff avisado antes do processo parar |

## Setup local (resumo)

1. `npm install`
2. Copiar `.env.example` para `.env` e preencher:
   - `DATABASE_URL` (Neon Postgres)
   - `VOYAGE_API_KEY` (Voyage AI, grátis)
   - `GROQ_API_KEY` (console.groq.com, grátis) + `LLM_PROVIDER=groq`
   - `STAFF_WHATSAPP_NUMBER` (número do staff, com código do país, sem `+`)
3. `npm run migrate` — cria as tabelas
4. Rodar o SQL de `create-staff-notifications.sql` no Postgres (uma vez)
5. `npm run seed` — popula a base de conhecimento
6. `node src/baileys-bot.js` — primeira conexão (escanear o QR code)
7. Depois de confirmar que funciona, mudar para produção via pm2:
   `pm2 start ecosystem.config.cjs && pm2 save && pm2-startup install`
   (ou simplesmente usar `iniciar-bot.bat` dali em diante)

### Problemas comuns

- **Erro de "password authentication failed"** → a `DATABASE_URL` está
  errada ou incompleta no `.env`.
- **Erro "Groq API falhou (404)"** → o nome do modelo em `GROQ_MODEL` pode
  ter mudado; rodar um script simples que consulta `GET
  https://api.groq.com/openai/v1/models` com a tua chave pra confirmar
  os nomes atuais disponíveis pra tua conta.
- **Mensagens não chegam ao cliente / "ack 463"** → confirmar que está a
  usar `@whiskeysockets/baileys@7.x` ou superior (necessário pro suporte
  a `@lid`), e que a resolução de `@lid` em `safeSendMessage` está intacta.
- **`cp` não reconhecido no terminal** → usar `Copy-Item .env.example .env`
  no PowerShell.
- **Dois processos a correr ao mesmo tempo** → nunca correr
  `node src/baileys-bot.js` manualmente enquanto o pm2 também gere o
  `whatsapp-bot`. Verificar com `Get-Process node` e `pm2 status`.

---

## Testes de segurança realizados

### Prompt injection e jailbreak
- Tentativa de "ignorar instruções anteriores": **bloqueado**
- Tentativa de se passar por desenvolvedor/admin: **bloqueado**
- Tentativa de forçar preço/desconto falso: **bloqueado**, sempre confirma
  com o preço real da base de conhecimento
- Tentativa de acessar conversas de outros clientes: **bloqueado**, cada
  conversa é isolada por número de telefone

### Validação de entrada
- Mensagens extremamente longas: limite de 1000 caracteres, recusa educada
- SQL Injection: bloqueado nativamente (queries parametrizadas, `$1`, `$2`, etc.)

### Correção crítica: modelo instável descoberto em produção
O `gemini-3.6-flash` (sugerido automaticamente numa correção anterior) se
mostrou instável, com cota gratuita muito restrita (20 req/dia), e em pelo
menos um caso vazou fragmentos do system prompt na resposta ao cliente —
um bug sério de segurança. Corrigido primeiro trocando para
`gemini-2.5-flash`, e posteriormente migrado de vez para a **Groq**, que
não tem esse histórico de instabilidade e oferece cota muito mais folgada.

### Bug de entrega silenciosa (`ack 463`)
Mensagens para contactos identificados como `@lid` (em vez do número de
telefone) eram "enviadas" sem erro nos logs, mas nunca chegavam ao
destinatário. Corrigido resolvendo o `@lid` para o JID real via
`sock.signalRepository.lidMapping` antes de cada envio.

### Risco de conflito de sessão (duas instâncias simultâneas)
Rodar `node src/baileys-bot.js` manualmente enquanto o pm2 também gere o
processo causa um loop de reconexões conflitantes entre as duas instâncias
(cada uma "rouba" a sessão da outra), o que pode ser interpretado pelo
WhatsApp como comportamento suspeito de automação. **Regra**: nunca correr
os dois ao mesmo tempo.

### Pendências conhecidas (não implementadas ainda)
- **Rate limiting por número de telefone**: sem limite de quantas mensagens
  um mesmo número pode mandar por minuto/hora.
- **Detecção de intenção por keyword**: escalação/negação/cancelamento
  usam listas de palavras-chave, não um classificador real — pode falhar
  em frases muito diferentes das testadas.
- **Monitorização externa de disponibilidade**: hoje só é possível avisar
  o staff de uma queda de internet/PC *depois* de reconectar, nunca
  *durante* a falha (limitação física: nada pode ser enviado sem conexão).
  Para cobrir isso, seria necessário um serviço externo (ex: Healthchecks.io)
  monitorando o bot de fora.

---

## Riscos conhecidos

- **Número WhatsApp não-oficial (via Baileys)**: sujeito a restrições ou
  banimento pelo WhatsApp se detectado como automação (já aconteceu uma
  vez durante os testes — restrição temporária seguida de remoção forçada
  do dispositivo). Para produção séria e de longo prazo, considerar migrar
  para a Meta WhatsApp Cloud API oficial.
- **Dependência de um PC pessoal sempre ligado**: o bot não roda num
  servidor na nuvem — se o PC ficar desligado ou sem internet, o
  atendimento para completamente até a conexão voltar. Para produção real,
  considerar hospedar num VPS (DigitalOcean, Hetzner, etc.), sempre online.

## Próximos passos

- Avaliar migração para a Meta WhatsApp Cloud API oficial (elimina o risco
  de restrição/banimento)
- Considerar hospedagem em servidor na nuvem (elimina a dependência do PC local)
- Trocar os dados de exemplo pelos dados reais do cliente-alvo
- Adicionar testes automatizados para os cenários já validados manualmente
- Avaliar monitorização externa (ex: Healthchecks.io) para detectar quedas
  de conectividade em tempo real
