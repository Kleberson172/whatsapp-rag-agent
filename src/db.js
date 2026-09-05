import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Cria as tabelas necessárias caso não existam.
 * Roda automaticamente no start (idempotente) e também via `npm run migrate`.
 */
export async function ensureSchema() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  // Base de conhecimento (produtos, políticas, FAQ, promoções...)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      category TEXT NOT NULL,          -- 'produto' | 'politica' | 'faq' | 'promocao'
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding vector(1024),          -- voyage-3 = 1024 dims
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
    ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
  `);

  // Histórico de conversas por número de telefone (memória de curto prazo)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      phone_number TEXT NOT NULL,
      role TEXT NOT NULL,              -- 'user' | 'assistant'
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS conversations_phone_idx
    ON conversations (tenant_id, phone_number, created_at);
  `);

  // Log de conversas escaladas para humano + métricas simples
  await pool.query(`
    CREATE TABLE IF NOT EXISTS escalations (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      phone_number TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  console.log("[db] schema verificado/criado com sucesso.");
}
