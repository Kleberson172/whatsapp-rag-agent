# Agente RAG de Atendimento — Perfumaria Essência (ELEVEN)

Status atual: **núcleo do agente 100% funcional e testado**. A integração
com o canal WhatsApp está em andamento (ver seção "Próximos passos").

Este documento descreve como o projeto está estruturado até agora, como
foi montado, e como testar o que já funciona.

---

## O que já está funcionando

- ✅ Banco de dados com busca vetorial (Neon Postgres + pgvector)
- ✅ Geração de embeddings da base de conhecimento (Voyage AI)
- ✅ Geração de respostas em linguagem natural (Google Gemini)
- ✅ Busca contextual (RAG): o agente só responde com base no que está
  cadastrado na base de conhecimento, sem inventar informação
- ✅ Memória de conversa por número de telefone (contexto entre mensagens)
- ✅ Lógica de escalação para atendente humano (por palavra-chave ou baixa
  confiança na resposta)
- ✅ Tom de voz humanizado e ajustado para soar natural no WhatsApp
- ✅ Testado via terminal com múltiplos cenários (preço, promoção, política
  de troca, pergunta fora do escopo, pedido de atendente humano)

## O que ainda falta

- 🔧 Conectar o agente a um canal real de WhatsApp (em andamento)

---

## Arquitetura

```
Pergunta do cliente (texto)
        │
        ▼
Busca vetorial na base de conhecimento (Neon + pgvector)
        │  encontra os trechos mais relevantes (produtos, políticas, FAQ...)
        ▼
Monta o prompt: instruções + contexto encontrado + histórico da conversa
        │
        ▼
Google Gemini gera a resposta em linguagem natural
        │
        ▼
Regras de negócio verificam se precisa escalar para humano
        │
        ▼
Resposta final + registro da conversa no banco
```

## Estrutura do projeto

```
whatsapp-rag-agent/
├── src/
│   ├── db.js            → conexão com Postgres + criação das tabelas
│   ├── embeddings.js     → geração de embeddings via Voyage AI
│   ├── llm.js            → geração de respostas (Gemini por padrão)
│   ├── rag.js            → núcleo do agente: busca + prompt + escalação
│   ├── seed.js           → popula a base de conhecimento (dados de exemplo)
│   ├── migrate.js        → cria as tabelas no banco (roda separado)
│   └── index.js          → servidor Express (usado na integração WhatsApp)
├── .env                  → chaves de API e configurações (não commitar)
├── .env.example          → modelo do .env
└── package.json
```

## Banco de dados (tabelas)

- **`knowledge_chunks`** — a base de conhecimento em si. Cada linha é um
  "pedaço" de informação (um produto, uma política, uma pergunta de FAQ)
  com seu respectivo embedding (vetor) pra busca por similaridade.
- **`conversations`** — histórico de mensagens por número de telefone,
  usado como memória de curto prazo (últimas 8 mensagens).
- **`escalations`** — registro de quando e por que uma conversa foi
  escalada para atendimento humano.

## Como a base de conhecimento é alimentada

Hoje, o arquivo `src/seed.js` contém os dados de exemplo (fictícios) de
uma perfumaria: produtos com preço, uma promoção, política de troca,
formas de pagamento, horário de funcionamento e dicas de recomendação.

Cada item tem uma `category` (`produto`, `politica`, `faq`, `promocao`),
um `title` e um `content`. Ao rodar `npm run seed`, cada item é convertido
em um embedding (vetor numérico) pela Voyage AI e salvo no banco.

**Para usar com dados reais de um cliente**: basta editar o array
`knowledgeBase` dentro de `src/seed.js` com as informações reais (produtos,
preços, políticas da empresa) e rodar `npm run seed` de novo. Não precisa
mexer em nenhum outro arquivo do projeto.

## Geração de respostas (LLM)

Por padrão, o agente usa o **Google Gemini** (`gemini-3.6-flash`), que é
gratuito e não pede cartão de crédito. Isso é controlado pela variável
`LLM_PROVIDER=gemini` no `.env`.

O arquivo `src/llm.js` também tem suporte pronto para usar o **Claude
(Anthropic)** no lugar do Gemini, caso no futuro haja créditos disponíveis
(ex: programa de estudante) — basta mudar `LLM_PROVIDER=anthropic` no `.env`.

## Tom de voz e regras do agente

O prompt do agente (dentro de `buildSystemPrompt()` em `src/rag.js`) foi
ajustado, depois de vários testes, para:

- Responder de forma curta, calorosa e natural, como um funcionário de
  verdade da loja falaria no WhatsApp — não como um script robótico
- Usar negrito no formato do WhatsApp (`*texto*`, um asterisco), não
  Markdown tradicional (`**texto**`)
- Nunca mencionar "sistema" ou "base de dados" ao responder — se não sabe
  algo, responde direto e natural ("aqui a gente só trabalha com X")
- Nunca inventar preços, políticas ou informações que não estejam na base
- Escalar para atendente humano quando: o cliente pede explicitamente, usa
  palavras de frustração, ou quando a base de conhecimento não tem
  informação suficiente (confiança da busca abaixo de um limite)
- Ser honesto (sem soar como aviso legal) se o cliente perguntar
  diretamente se está falando com um robô ou assistente virtual

## Como testar (sem WhatsApp, direto no terminal)

Com o `.env` configurado e a base de conhecimento populada (`npm run seed`),
dá pra testar o agente diretamente, simulando uma conversa:

```powershell
node -e "import('./src/rag.js').then(m => m.handleIncomingMessage('teste-123', 'Qual o preço do Essência Noir?').then(r => console.log(r.replyText)))"
```

Trocando o texto da pergunta e mantendo o mesmo identificador (`teste-123`)
entre chamadas, dá pra testar também a memória de conversa (perguntas de
seguimento tipo "e esse tem desconto?").

### Cenários já testados e validados

| Cenário | Resultado |
|---|---|
| Pergunta de preço com promoção ativa | Respondeu certo e calculou o desconto |
| Política de troca | Respondeu completo, sem escalar à toa |
| Pergunta fora da base (ex: produto que não vendem) | Foi honesto, sem inventar, sugeriu alternativa |
| Pedido explícito de atendente humano | Escalou corretamente |

## Setup local (resumo)

1. `npm install`
2. Copiar `.env.example` para `.env` e preencher:
   - `DATABASE_URL` (Neon Postgres)
   - `VOYAGE_API_KEY` (Voyage AI, grátis)
   - `GEMINI_API_KEY` (Google AI Studio, grátis)
3. `npm run migrate` — cria as tabelas
4. `npm run seed` — popula a base de conhecimento
5. Testar via terminal (comando acima) ou seguir para a integração com
   WhatsApp (próxima etapa, ainda em configuração)

---

## Rodando pela primeira vez em outro computador

Guia completo para quem nunca configurou o projeto antes (ex: um colega
recebendo a pasta do projeto pela primeira vez).

### 1. Instalar os programas necessários

Antes de tocar no projeto, instale nessa ordem:

- **Node.js** (versão 20 ou superior) — baixe em [nodejs.org](https://nodejs.org)
  e instale normalmente (Next, Next, Finish). Isso já inclui o `npm`.
  Para confirmar que instalou certo, abra o terminal e rode:
  ```powershell
  node -v
  npm -v
  ```
  Deve mostrar um número de versão em cada um, sem erro.

- **Visual Studio Code** (editor de código) — baixe em
  [code.visualstudio.com](https://code.visualstudio.com). Não é
  obrigatório, mas facilita muito editar arquivos e usar o terminal
  integrado.

- **Git** (opcional, só se for clonar de um repositório em vez de copiar
  a pasta) — baixe em [git-scm.com](https://git-scm.com).

### 2. Copiar o projeto

Se o projeto foi enviado como uma pasta ou arquivo `.zip`, extraia essa
pasta em qualquer lugar do computador (ex: `Área de Trabalho` ou
`Documentos`). Se for por Git, clone o repositório normalmente.

Abra essa pasta no VS Code (`File > Open Folder...`), e abra o terminal
integrado (`Terminal > New Terminal`, ou o atalho **Ctrl + \``**).

### 3. Instalar as dependências do projeto

Dentro do terminal, na pasta do projeto, rode:
```powershell
npm install
```
Isso baixa todas as bibliotecas que o projeto usa (pode demorar um pouco
na primeira vez).

### 4. Criar o arquivo de configuração (.env)

Rode:
```powershell
cp .env.example .env
```

Abra o arquivo `.env` que acabou de ser criado (aparece na barra lateral
do VS Code) e preencha cada chave. **Cada uma precisa ser criada na conta
de quem for rodar o projeto** (são gratuitas, mas pessoais):

| Variável | Onde conseguir | Custo |
|---|---|---|
| `DATABASE_URL` | Criar um banco em [neon.tech](https://neon.tech) (conta grátis) e copiar a "Connection String" | Grátis |
| `VOYAGE_API_KEY` | Criar conta em [voyageai.com](https://www.voyageai.com), gerar uma API Key | Grátis |
| `GEMINI_API_KEY` | Criar em [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Grátis |

Não precisa mexer nas outras variáveis do `.env` por enquanto (Twilio,
Meta, etc) — essas fazem parte da integração com WhatsApp, que ainda está
em andamento.

### 5. Criar as tabelas do banco de dados

```powershell
npm run migrate
```
Deve aparecer `[db] schema verificado/criado com sucesso.` e `Migração
concluída.` sem nenhum erro.

### 6. Popular a base de conhecimento

```powershell
npm run seed
```
Isso cadastra os dados de exemplo da perfumaria (ou os dados reais, se
já tiverem sido editados em `src/seed.js`).

### 7. Testar se está tudo funcionando

```powershell
node -e "import('./src/rag.js').then(m => m.handleIncomingMessage('teste-999', 'Qual o preço do Essência Noir?').then(r => console.log(r.replyText)))"
```

Se aparecer uma resposta com o preço do perfume, está tudo funcionando
corretamente. Se der erro, confira se todas as chaves no `.env` foram
preenchidas corretamente (sem espaços extras, sem aspas ao redor do
valor).

### Problemas comuns

- **Erro de "password authentication failed"** → a `DATABASE_URL` está
  errada ou incompleta no `.env`.
- **Erro "Gemini API falhou (404)"** → o nome do modelo em `GEMINI_MODEL`
  pode estar desatualizado; confira o valor atual em
  [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models).
- **Caracteres estranhos tipo `Ã§Ã£`** → problema de codificação ao
  editar o `.env` ou os arquivos `.js`. Edite pelo VS Code diretamente
  (não copie/cole por comandos de terminal que reescrevem o arquivo).
- **`cp` não reconhecido no terminal** → normal em alguns terminais do
  Windows; use `Copy-Item .env.example .env` no PowerShell como
  alternativa.

---

## Próximos passos

- Finalizar a conexão com um canal de WhatsApp (avaliando as opções
  disponíveis)
- Trocar os dados de exemplo pelos dados reais do cliente-alvo
- Preparar a demonstração comercial
