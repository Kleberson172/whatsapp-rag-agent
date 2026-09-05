import { ensureSchema, pool } from "./db.js";
import { embed, toPgVector } from "./embeddings.js";

const TENANT_ID = "default";

// Troque este conteúdo pelos dados reais da empresa-alvo antes da demo.
// Cada item vira um "chunk" pesquisável pelo agente.
const knowledgeBase = [
  {
    category: "produto",
    title: "Perfume Essência Noir 100ml",
    content:
      "Perfume Essência Noir, 100ml, fragrância amadeirada/especiada. Preço: 45.000 Kz. Disponível nas versões masculina e unissex. Fixação alta, dura em média 8 horas na pele.",
  },
  {
    category: "produto",
    title: "Perfume Essência Fleur 50ml",
    content:
      "Perfume Essência Fleur, 50ml, fragrância floral/frutada, ideal para uso diário. Preço: 28.000 Kz. Fixação média, dura em média 5-6 horas na pele.",
  },
  {
    category: "promocao",
    title: "Promoção de aniversário da loja",
    content:
      "Durante o mês de aniversário da loja, todos os perfumes acima de 50ml têm 15% de desconto. Válido para compras na loja física e pelo WhatsApp. Não acumula com outras promoções.",
  },
  {
    category: "politica",
    title: "Política de troca e devolução",
    content:
      "Trocas podem ser feitas em até 7 dias após a compra, com o produto lacrado e nota fiscal. Não fazemos devolução de valor em dinheiro, apenas troca por outro produto de valor igual ou superior (com pagamento da diferença).",
  },
  {
    category: "politica",
    title: "Formas de pagamento e entrega",
    content:
      "Aceitamos pagamento via transferência bancária, Multicaixa Express e dinheiro na entrega (apenas em Luanda). Entregas em Luanda levam de 1 a 2 dias úteis. Para outras províncias, consulte prazo com um atendente.",
  },
  {
    category: "faq",
    title: "Horário de funcionamento",
    content:
      "A loja física funciona de segunda a sábado, das 9h às 18h. O atendimento por WhatsApp funciona 24 horas por dia — fora do horário comercial, pedidos são confirmados no próximo dia útil.",
  },
  {
    category: "faq",
    title: "Como saber qual perfume combina comigo",
    content:
      "Recomendamos perfumes amadeirados/especiados para quem gosta de fragrâncias mais intensas e marcantes, e florais/frutados para um aroma mais leve e do dia a dia. Também é possível pedir amostras (decants) de 5ml antes de comprar o frasco completo.",
  },
];

async function seed() {
  await ensureSchema();

  console.log(`Gerando embeddings para ${knowledgeBase.length} itens...`);
  const contents = knowledgeBase.map((item) => `${item.title}\n${item.content}`);
  const embeddings = await embed(contents, "document");

  for (let i = 0; i < knowledgeBase.length; i++) {
    const item = knowledgeBase[i];
    const vectorLiteral = toPgVector(embeddings[i]);
    await pool.query(
      `
      INSERT INTO knowledge_chunks (tenant_id, category, title, content, embedding)
      VALUES ($1, $2, $3, $4, $5::vector);
      `,
      [TENANT_ID, item.category, item.title, item.content, vectorLiteral]
    );
    console.log(`  ✓ ${item.title}`);
  }

  console.log("Seed concluído com sucesso.");
  await pool.end();
}

seed().catch((err) => {
  console.error("Erro no seed:", err);
  process.exit(1);
});
