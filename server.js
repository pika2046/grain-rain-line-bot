// 穀雨 LINE AI 店員 webhook 主程式
const express = require('express');
const crypto = require('crypto');
const { handleMessage } = require('./lib/handler');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const PORT = process.env.PORT || 3000;

const app = express();
app.get('/health', (req, res) => res.send('ok'));

function verifySignature(rawBody, signature) {
  if (!CHANNEL_SECRET || !signature) return false;
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(hash);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// LINE 要求 raw body 驗簽，所以這裡用 express.raw
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const rawBody = req.body.toString('utf8');

  if (!verifySignature(rawBody, signature)) {
    return res.status(401).send('bad signature');
  }

  let events = [];
  try {
    events = JSON.parse(rawBody).events || [];
  } catch {
    return res.status(400).send('bad json');
  }

  res.status(200).send('OK'); // 先回 200，再慢慢處理

  for (const ev of events) {
    if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
      try {
        await handleMessage(ev);
      } catch (e) {
        console.error('[event]', e.message);
      }
    }
    // 非文字訊息（貼圖、圖片等）第一版先忽略
  }
});

app.listen(PORT, () => console.log(`grain-rain-line-bot listening on ${PORT}`));
