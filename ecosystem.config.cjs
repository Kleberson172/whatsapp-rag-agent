module.exports = {
  apps: [
    {
      name: "whatsapp-bot",
      script: "src/baileys-bot.js",

      // Reinicia sozinho se o processo cair (crash, erro nao tratado, etc.)
      autorestart: true,

      // Evita loop infinito de restart se o bot estiver quebrado de verdade.
      max_restarts: 20,
      min_uptime: "10s",
      restart_delay: 3000,

      // Nao reinicia so porque um ficheiro mudou.
      watch: false,

      // No Windows, sinais como SIGINT/SIGTERM nem sempre chegam de forma
      // confiavel ao processo via "pm2 stop". Esta opcao faz o pm2 mandar
      // uma mensagem IPC ("shutdown") em vez de depender so do sinal do
      // sistema operativo - e o proprio codigo do bot que escuta essa
      // mensagem (process.on("message", ...)) pra mandar o aviso ao staff.
      shutdown_with_message: true,

      // Da tempo ao processo de mandar o aviso de desligamento ao staff
      // antes do pm2 forcar o encerramento com SIGKILL.
      kill_timeout: 8000,

      out_file: "./logs/bot-out.log",
      error_file: "./logs/bot-error.log",
      time: true,
    },
  ],
};
