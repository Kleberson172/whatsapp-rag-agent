# Agente RAG de Atendimento 24/7 via WhatsApp — MVP (ELEVEN)

MVP de agente de atendimento ao cliente com RAG (Retrieval-Augmented Generation),
integrado ao WhatsApp via Twilio, usando Claude para geração de respostas e
Postgres + pgvector como base de conhecimento pesquisável.

Exemplo de domínio: **loja de perfume**. Troque o conteúdo em `src/seed.js`
pelos dados reais do cliente antes da demo.

## Arquitetura

```
Cliente (WhatsApp)
      │
      ▼
Twilio (gateway WhatsApp)
      │  webhook POST
      ▼
Express (src/index.js)
      │
      ├─► Busca vetorial na base de conhecimento (pgvector)  [src/rag.js]
      ├─► Histórico recente da conversa (Postgres)
      └─► Claude (Anthropic API) gera a resposta
      │
      ▼
Resposta enviada de volta via Twilio → WhatsApp do cliente
```

## Pré-requisitos

1. **PostgreSQL** com a extensão `pgvector` disponível (local, Docker, ou um
   serviço gerenciado tipo Neon/Supabase — ambos já suportam pgvector).
2. Conta na **Anthropic** (chave de API) — https://console.anthropic.com
3. Conta na **Voyage AI** (embeddings, tem free tier) — https://www.voyageai.com
4. Conta de desenvolvedor na **Meta** (developers.facebook.com) com um app
   do tipo WhatsApp Business configurado — é grátis, mas exige verificação
   da empresa no Business Manager antes de sair do modo de teste.
   *(Alternativa mais rápida pra testar: Twilio WhatsApp Sandbox — grátis,
   mas cobra taxa por mensagem depois que for pra produção. Veja a seção
   "Usando Twilio em vez da Meta" mais abaixo.)*

## Por que Meta Cloud API em vez de Twilio?

O Twilio é um intermediário: ele repassa a tarifa da Meta e ainda cobra a
taxa dele por cima (a partir de $0,005 por mensagem). Indo direto pela Meta
Cloud API, você paga só o que a própria Meta cobra — e como o agente responde
de forma livre (não usa templates), essas são "conversas de serviço", que são
gratuitas. Ou seja: **WhatsApp Business API em si sai de graça** no seu caso
de uso; o único custo real recorrente vira o Claude API (uso da IA) + a
hospedagem do servidor.

## Configurando a Meta WhatsApp Cloud API

1. Vá em https://developers.facebook.com/apps e crie um novo app do tipo
   **"Business"**.
2. Adicione o produto **WhatsApp** ao app.
3. Na aba **API Setup**, você verá um número de teste temporário já pronto
   pra usar (grátis), um `Phone Number ID` e um `Temporary Access Token`.
   Copie os dois para `META_PHONE_NUMBER_ID` e `META_ACCESS_TOKEN` no `.env`.
   *(O token temporário expira em 24h — quando for pra produção de verdade,
   gere um token permanente vinculado a um System User, nas configurações
   do Business Manager.)*
4. Em `META_VERIFY_TOKEN`, invente uma senha qualquer (ex: `eleven-2026`) —
   é só um segredo que você define, usado no próximo passo.
5. Suba o servidor (`npm run dev`) e exponha-o publicamente com
   `npx localtunnel --port 3000` (ou ngrok).
6. De volta no painel da Meta, em **WhatsApp > Configuration > Webhook**,
   clique em "Edit", cole a URL pública + `/webhook/whatsapp`, e no campo
   "Verify token" cole a mesma senha que você colocou em `META_VERIFY_TOKEN`.
   Clique em "Verify and save" — se aparecer sucesso, o webhook está ativo.
7. Ainda na mesma tela, marque a inscrição no campo **"messages"** — é isso
   que garante que as mensagens dos clientes cheguem no seu webhook.
8. No painel de API Setup, adicione seu próprio número de WhatsApp como
   "destinatário de teste" (números de teste só podem falar com números
   pré-autorizados até você sair do modo de desenvolvimento).
9. Mande uma mensagem do seu WhatsApp pro número de teste da Meta. Pronto,
   já está conversando com o agente de verdade, sem gastar nada com Twilio.

## Setup

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# edite o .env com suas chaves reais

# 3. Criar as tabelas no banco
npm run migrate

# 4. Popular a base de conhecimento com os dados de exemplo (perfumaria)
npm run seed

# 5. Iniciar o servidor
npm run dev
```

O servidor sobe em `http://localhost:3000`. O endpoint do webhook é:
`POST http://localhost:3000/webhook/whatsapp`

## Usando Twilio em vez da Meta (opcional, mais rápido pra testar)

Se quiser testar em minutos sem passar pela verificação da Meta, ative o
Twilio Sandbox:

1. No `.env`, mude `WHATSAPP_PROVIDER=twilio` e preencha as chaves `TWILIO_*`.
2. Rode `npm run dev`.
3. Exponha o servidor: `npx localtunnel --port 3000` (ou ngrok).
4. No console do Twilio, em **WhatsApp Sandbox Settings → "When a message
   comes in"**, cole a URL pública + `/webhook/whatsapp-twilio`.
5. No WhatsApp do seu celular, mande a palavra de ativação do sandbox
   (tipo `join palavra-chave`) pro número do sandbox.

⚠️ Lembre-se: isso é só pra testes rápidos. Em produção, o Twilio cobra taxa
por mensagem em cima da tarifa da Meta — veja a seção acima sobre por que a
Meta Cloud API direta é a opção mais econômica pra rodar de verdade.

## Testando sem WhatsApp (mais rápido para depurar)

Você pode testar a lógica do RAG isolada, sem Twilio, chamando diretamente:

```js
import { handleIncomingMessage } from "./src/rag.js";
const { replyText } = await handleIncomingMessage("teste-123", "Qual o preço do Essência Noir?");
console.log(replyText);
```

## Endpoint de métricas (para a apresentação)

`GET /metrics` retorna:
```json
{
  "total_conversas": 12,
  "total_escalacoes": 2,
  "base_conhecimento_por_categoria": [
    { "category": "produto", "total": 2 },
    { "category": "faq", "total": 2 }
  ]
}
```
Dá pra plugar isso num dashboard simples ou até mostrar via `curl`/Postman
durante a apresentação — é um argumento forte de venda mostrar "quantas
conversas o agente já resolveu sozinho".

## Roadmap sugerido (pós-demo, para produção)

- [ ] Migrar de Twilio Sandbox → Meta WhatsApp Business Cloud API (produção)
- [ ] Multi-tenant real (reaproveitar o padrão `tenant_id` do RotaFlow) caso
      queira vender para várias lojas
- [ ] Painel web simples para o cliente final editar a base de conhecimento
      sem precisar mexer em código
- [ ] Fila (ex: BullMQ) se o volume de mensagens crescer
- [ ] Rate limiting e autenticação no `/metrics` antes de expor publicamente
- [ ] Envio de imagens de produtos (Twilio suporta mídia nas mensagens)
- [ ] Handoff real para atendente humano (ex: notificação no Slack/e-mail
      quando `escalated: true`)

## Segurança — antes de apresentar/produção

- Nunca commitar o `.env` (já está coberto por um `.gitignore` — confirme antes
  de subir pro GitHub)
- Validar assinatura das requisições do Twilio (`X-Twilio-Signature`) em produção
- Sanitizar entrada do usuário antes de logar (evitar vazar dados sensíveis)
