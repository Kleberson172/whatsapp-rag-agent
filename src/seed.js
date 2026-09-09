import { ensureSchema, pool } from "./db.js";
import { embed, toPgVector } from "./embeddings.js";

const TENANT_ID = "default";

const knowledgeBase = [
  {
    category: "produto",
    title: "Perfume Essencia Noir 100ml",
    content:
      "Perfume Essencia Noir, 100ml, fragrancia amadeirada/especiada. Preco: 45.000 Kz. Disponivel nas versoes masculina e unissex. Fixacao alta, dura em media 8 horas na pele.",
  },
  {
    category: "produto",
    title: "Perfume Essencia Fleur 50ml",
    content:
      "Perfume Essencia Fleur, 50ml, fragrancia floral/frutada, ideal para uso diario. Preco: 28.000 Kz. Fixacao media, dura em media 5-6 horas na pele.",
  },
  {
    category: "promocao",
    title: "Promocao de aniversario da loja",
    content:
      "Durante o mes de aniversario da loja, todos os perfumes acima de 50ml tem 15% de desconto. Valido para compras na loja fisica e pelo WhatsApp. Nao acumula com outras promocoes.",
  },
  {
    category: "politica",
    title: "Politica de troca e devolucao",
    content:
      "Trocas podem ser feitas em ate 7 dias apos a compra, com o produto lacrado e nota fiscal. Nao fazemos devolucao de valor em dinheiro, apenas troca por outro produto de valor igual ou superior (com pagamento da diferenca).",
  },
  {
    category: "politica",
    title: "Formas de pagamento e entrega",
    content:
      "Aceitamos pagamento via transferencia bancaria, Multicaixa Express e dinheiro na entrega (apenas em Luanda). Entregas em Luanda levam de 1 a 2 dias uteis. Para outras provincias, consulte prazo com um atendente.",
  },
  {
    category: "faq",
    title: "Horario de funcionamento",
    content:
      "A loja fisica funciona de segunda a sabado, das 9h as 18h. O atendimento por WhatsApp funciona 24 horas por dia - fora do horario comercial, pedidos sao confirmados no proximo dia util.",
  },
  {
    category: "faq",
    title: "Como saber qual perfume combina comigo",
    content:
      "Recomendamos perfumes amadeirados/especiados para quem gosta de fragrancias mais intensas e marcantes, e florais/frutados para um aroma mais leve e do dia a dia. Tambem e possivel pedir amostras (decants) de 5ml antes de comprar o frasco completo.",
  },
  {
    category: "faq",
    title: "Endereco da loja fisica",
    content:
      "A Perfumaria Essencia fica na Rua Comandante Valodia, numero 45, bairro Maianga, Luanda, proximo ao Kero Maianga. Temos estacionamento proprio na frente da loja.",
  },
  {
    category: "faq",
    title: "Contato e redes sociais",
    content:
      "Alem do WhatsApp, a Perfumaria Essencia esta no Instagram como @perfumaria.essencia.ao, onde postamos novidades e promocoes. Tambem atendemos por telefone fixo: (222) 123-456.",
  },
  {
    category: "faq",
    title: "Entrega para outras provincias alem de Luanda",
    content:
      "Fazemos entrega para outras provincias via transportadora parceira, com prazo de 3 a 7 dias uteis dependendo da localidade. O custo do frete e calculado no momento do pedido e informado antes da confirmacao da compra.",
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
    console.log(`  ok: ${item.title}`);
  }

  console.log("Seed concluido com sucesso.");
  await pool.end();
}

seed().catch((err) => {
  console.error("Erro no seed:", err);
  process.exit(1);
});
