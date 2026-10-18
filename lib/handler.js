// 訊息處理：會話狀態＋訂單狀態機＋LINE reply＋客人檔案
const { chat } = require('./llm');
const db = require('./customer-db');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BOSS_USER_ID = process.env.BOSS_USER_ID; // 老闆私人 LINE 的 userId（U 開頭），有設才推播

// 會話記憶（每位用戶：對話歷史＋訂單狀態）
// 注意：正式上線建議改用 Redis／資料庫，記憶體版重啟會遺失。
const sessions = new Map();
const MAX_HISTORY = 20; // 只保留最近 20 則，避免 token 爆掉

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { history: [], order: null });
    console.log('[new user]', userId); // 抓 userId 用（老闆 BOSS_USER_ID 設定）
  }
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

async function linePush(to, texts) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: texts.slice(0, 5).map((t) => ({ type: 'text', text: t })),
    }),
  });
  if (!res.ok) throw new Error(`LINE push ${res.status}: ${await res.text()}`);
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

  // 老客人：把檔案摘要塞給 LLM，讓艾琳認得人
  let profileLine = '';
  try {
    const p = await db.getProfile(userId);
    if (p && (p.name || p.orderCount !== '0')) {
      profileLine = `【老客人檔案】${p.name ? p.name : '（未留名）'}，來過 ${p.orderCount} 次${p.lastOrder ? `，上次點了：${p.lastOrder}` : ''}${p.note ? `，喜好/忌口：${p.note}` : ''}。自然地認出他（例：「還是跟上次一樣嗎？」），不要生硬背誦。`;
    }
  } catch (e) {
    console.error('[profile]', e.message);
  }

  let result;
  try {
    result = await chat(session.history, profileLine);
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

  // 訂單剛被確認：寫入客人檔案＋推播通知老闆（每單扣 1 則額度）
  if (order && order.status === 'confirmed') {
    console.log('[ORDER CONFIRMED]', JSON.stringify({ userId, ...order }));
    await db.saveOrder({ userId, name: order.name, phone: order.phone, items: order.items, pickup_time: order.pickup_time });
    if (BOSS_USER_ID) {
      const lines = (order.items || []).map((i) => `・${i.name} x${i.qty}`).join('\n');
      const msg = [
        '【新訂單】',
        lines,
        `取餐時間：${order.pickup_time || '未填'}`,
        `姓名：${order.name || '未填'}　電話：${order.phone || '未填'}`,
      ].join('\n');
      try {
        await linePush(BOSS_USER_ID, [msg]);
      } catch (e) {
        console.error('[push boss]', e.message);
      }
    }
    session.order = null; // 結單後重置，下一筆重新開始
  }

  // LLM 順手記下的客人偏好 → 寫入檔案
  if (result.customer_note) {
    await db.updateNote(userId, result.customer_note);
  }

  await lineReply(event.replyToken, [replyText]);
}

module.exports = { handleMessage, orderSummary };
