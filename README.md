# 穀雨 LINE AI 店員（艾琳）webhook

客人傳 LINE → 這支程式收訊息 → 丟給 LLM（艾琳店員人設＋店鋪知識庫）→ 用 LINE reply 即時回覆。
訂餐走「收集→摘要→客人回『確認』成立」流程，成立的訂單會用 LINE Push 推播通知老闆（需設 BOSS_USER_ID）。

## 本機試跑

```bash
cd webhook
cp .env.example .env   # 填入真實值
npm install
npm start              # http://localhost:3000/health 應回 ok
```

## 上線步驟（給老闆的待辦）

1. **LLM API key**：到 [Google AI Studio](https://aistudio.google.com/) 登入 Google 帳號 → Get API key → 建立一把，填入 `.env` 的 `LLM_API_KEY`。再到左側 USAGE & BILLING 設定帳單、購買預付點數（免費層額度太低不夠店用，約 NT$150 起）。
2. **部署**：推到 Zeabur／Render（免費方案），把 `.env` 的值設成環境變數，拿到公開 HTTPS 網址（例如 `https://xxx.zeabur.app`）。
3. **LINE Developers**：登入 → 建 Provider＋Messaging API Channel → 在 Messaging API 分頁：
   - 複製 Channel secret → `LINE_CHANNEL_SECRET`
   - 發行 Channel access token（長期）→ `LINE_CHANNEL_ACCESS_TOKEN`
   - Webhook URL 填 `https://你的網址/webhook` → 按 Verify → 把「Use webhook」打開
   - 把「Auto-reply messages」和「Greeting messages」關掉，避免跟 AI 搶話
4. 用 LINE 加官方帳號好友，傳訊息測試。

## 成本

- LINE reply 即時回覆：不計入每月訊息額度，免費。
- 訂單推播給老闆：走 Push API，每單扣 1 則額度（免費 200 則/月）。
- LLM：Gemini API 付費預付點數制，店裡的量一個月約幾塊美金。

## 注意

- 會話記憶目前是記憶體版，server 重啟會遺失；正式長期跑建議換 Redis／資料庫。
- 艾琳人設與知識庫在 `lib/ailin.js`，改菜單、價格、營業時間直接改那檔。
