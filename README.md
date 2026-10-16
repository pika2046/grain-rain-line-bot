# 穀雨 LINE AI 店員（艾琳）webhook

客人傳 LINE → 這支程式收訊息 → 丟給 LLM（艾琳店員人設＋店鋪知識庫）→ 用 LINE reply 即時回覆。
訂餐走「收集→摘要→客人回『確認』成立」流程，成立的訂單會印在 server log（Phase 2 再接老闆手機通知）。

## 本機試跑

```bash
cd webhook
cp .env.example .env   # 填入真實值
npm install
npm start              # http://localhost:3000/health 應回 ok
```

## 上線步驟（給老闆的待辦）

1. **LLM API key**：到 [Google AI Studio](https://aistudio.google.com/) 登入 Google 帳號 → Get API key → 建立一把，填入 `.env` 的 `LLM_API_KEY`（免費額度，不用綁卡）。
2. **部署**：推到 Zeabur／Render（免費方案），把 `.env` 的值設成環境變數，拿到公開 HTTPS 網址（例如 `https://xxx.zeabur.app`）。
3. **LINE Developers**：登入 → 建 Provider＋Messaging API Channel → 在 Messaging API 分頁：
   - 複製 Channel secret → `LINE_CHANNEL_SECRET`
   - 發行 Channel access token（長期）→ `LINE_CHANNEL_ACCESS_TOKEN`
   - Webhook URL 填 `https://你的網址/webhook` → 按 Verify → 把「Use webhook」打開
   - 把「Auto-reply messages」和「Greeting messages」關掉，避免跟 AI 搶話
4. 用 LINE 加官方帳號好友，傳訊息測試。

## 成本

- LINE reply 即時回覆：不計入每月訊息額度，免費。
- LLM：Gemini 免費額度內約為 0；付費約一則幾分錢台幣。

## 注意

- 會話記憶目前是記憶體版，server 重啟會遺失；正式長期跑建議換 Redis／資料庫。
- 艾琳人設與知識庫在 `lib/ailin.js`，改菜單、價格、營業時間直接改那檔。
