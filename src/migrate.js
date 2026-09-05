import { ensureSchema, pool } from "./db.js";

ensureSchema()
  .then(() => {
    console.log("Migração concluída.");
    return pool.end();
  })
  .catch((err) => {
    console.error("Erro na migração:", err);
    process.exit(1);
  });
