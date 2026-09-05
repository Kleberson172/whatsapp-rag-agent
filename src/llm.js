import dotenv from "dotenv";
dotenv.config();

const LLM_PROVIDER = process.env.LLM_PROVIDER || "gemini";

export async function generateReply(systemPrompt, messages) {
  if (LLM_PROVIDER === "anthropic") {
    return generateWithAnthropic(systemPrompt, messages);
  }
  return generateWithGemini(systemPrompt, messages);
}

async function generateWithGemini(systemPrompt, messages) {
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


