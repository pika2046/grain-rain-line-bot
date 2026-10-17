// OpenAI 相容 API 的 chat completion 呼叫（含 JSON mode）
const { SYSTEM_PROMPT } = require('./ailin');

const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1/').replace(/\/$/, '');
const API_KEY = process.env.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

async function chat(history) {
  if (!API_KEY) throw new Error('LLM_API_KEY 未設定');
  // 每次呼叫都帶上今天日期（台灣時間），艾琳才知道「今天／明天」是哪一天、星期幾
  const today = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());
  const dateLine = `【今天是 ${today}（台灣時間）】回答「今天／明天／後天」或營業相關問題時，先用這個日期推算星期幾，再對照知識庫的營業時間回答。\n`;
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: dateLine + SYSTEM_PROMPT }, ...history],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 1000,
    }),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let text = data.choices?.[0]?.message?.content || '{}';
  // 強健解析：剝掉 ```json 圍欄與前後雜字，只取第一個 { 到最後一個 } 之間的 JSON
  text = text.replace(/^[\s\S]*?\{/, '{');
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace >= 0) text = text.slice(0, lastBrace + 1);
  try {
    return JSON.parse(text);
  } catch {
    console.error('[llm] JSON parse failed, raw:', String(data.choices?.[0]?.message?.content).slice(0, 300));
    return { reply: '不好意思，我剛剛沒聽清楚，可以再說一次嗎？', order: null };
  }
}

module.exports = { chat };
