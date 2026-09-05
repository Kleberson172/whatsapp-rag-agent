import dotenv from "dotenv";
dotenv.config();

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

/**
 * Gera embeddings usando a Voyage AI (recomendada pela Anthropic para RAG).
 * Aceita uma string ou array de strings.
 * inputType: "document" ao indexar a base, "query" ao buscar (melhora a precisão).
 */
export async function embed(texts, inputType = "document") {
  const input = Array.isArray(texts) ? texts : [texts];

  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input,
      model: "voyage-3",
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Voyage embeddings falhou (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const vectors = data.data.map((d) => d.embedding);
  return Array.isArray(texts) ? vectors : vectors[0];
}

/** Formata um array JS de floats para o formato literal do pgvector: '[0.1,0.2,...]' */
export function toPgVector(embedding) {
  return `[${embedding.join(",")}]`;
}
