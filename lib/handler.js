// 訊息處理：會話狀態＋訂單狀態機＋LINE reply
const { chat } = require('./llm');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// 會話記憶（每位用戶：對話歷史＋訂單狀態）
// 注意：正式上線建議改用 Redis／資料庫，記憶體版重啟會遺失。
const sessions = new Map();
const MAX_HISTORY = 20; // 只保留最近 20 則，避免 token 爆掉

function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { history: [], order: null });
  return sessions.get(userId);
}

async function lineReply(replyToken, texts) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: texts.slice(0, 5).map((t) => ({ type: 'text', text: t })),
    }),
  });
  if (!res.ok) throw new Error(`LINE reply ${res.status}: ${await res.text()}`);
}

function orderSummary(order) {
  const lines = (order.items || []).map((i) => `・${i.name} x${i.qty}`);
  return [
    '跟你確認一下訂單：',
    ...lines,
    `取餐時間：${order.pickup_time || '未填'}`,
    `姓名：${order.name || '未填'}　電話：${order.phone || '未填'}`,
    '沒問題請回「確認」，要改直接跟我說！',
  ].join('\n');
}

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();
  if (!text) return;

  const session = getSession(userId);
  session.history.push({ role: 'user', content: text });
  session.history = session.history.slice(-MAX_HISTORY);

  let result;
  try {
    result = await chat(session.history);
  } catch (e) {
    console.error('[llm]', e.message);
    await lineReply(event.replyToken, ['不好意思，系統剛剛恍神了一下，可以再說一次嗎？']);
    session.history.pop();
    return;
  }

  const replyText = result.reply || '收到！';
  session.history.push({ role: 'assistant', content: replyText });

  const order = result.order;
  session.order = order && order.status !== 'none' ? order : null;

  // 訂單剛被確認：通知老闆（先印 log；Phase 2 接 push 通知）
  if (order && order.status === 'confirmed') {
    console.log('[ORDER CONFIRMED]', JSON.stringify({ userId, ...order }));
    session.order = null; // 結單後重置，下一筆重新開始
  }

  await lineReply(event.replyToken, [replyText]);
}

module.exports = { handleMessage, orderSummary };
