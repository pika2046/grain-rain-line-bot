// OpenAI 相容 API 的 chat completion 呼叫（含 JSON mode）
const { SYSTEM_PROMPT } = require('./ailin');

const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1/').replace(/\/$/, '');
const API_KEY = process.env.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

async function chat(history) {
  if (!API_KEY) throw new Error('LLM_API_KEY 未設定');
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 600,
    }),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { reply: '不好意思，我剛剛沒聽清楚，可以再說一次嗎？', order: null };
  }
}

module.exports = { chat };
