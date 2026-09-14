import dotenv from "dotenv";
dotenv.config();

const LLM_PROVIDER = process.env.LLM_PROVIDER || "groq";

export async function generateReply(systemPrompt, messages) {
  if (LLM_PROVIDER === "anthropic") {
    return generateWithAnthropic(systemPrompt, messages);
  }
  if (LLM_PROVIDER === "gemini") {
    return generateWithGemini(systemPrompt, messages);
  }
  return generateWithGroq(systemPrompt, messages);
}

async function generateWithGroq(systemPrompt, messages, retriesLeft = 2) {
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const url = "https://api.groq.com/openai/v1/chat/completions";

  // A API da Groq segue o mesmo formato da OpenAI: role "system"/"user"/"assistant".
  const chatMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: chatMessages,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const isRetryable = res.status === 503 || res.status === 429;
    if (isRetryable && retriesLeft > 0) {
      const waitMs = res.status === 429 ? 5000 : 1500;
      console.log(`[llm] Groq retornou ${res.status}, tentando novamente em ${waitMs}ms (${retriesLeft} tentativas restantes)`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return generateWithGroq(systemPrompt, messages, retriesLeft - 1);
    }
    throw new Error(`Groq API falhou (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function generateWithGemini(systemPrompt, messages, retriesLeft = 2) {
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 1024 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const isRetryable = res.status === 503 || res.status === 429;
    if (isRetryable && retriesLeft > 0) {
      const waitMs = res.status === 429 ? 5000 : 1500;
      console.log(`[llm] Gemini retornou ${res.status}, tentando novamente em ${waitMs}ms (${retriesLeft} tentativas restantes)`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return generateWithGemini(systemPrompt, messages, retriesLeft - 1);
    }
    throw new Error(`Gemini API falhou (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
  return text;
}

async function generateWithAnthropic(systemPrompt, messages) {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: systemPrompt,
    messages,
  });

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
