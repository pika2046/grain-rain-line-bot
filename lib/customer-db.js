// 客人檔案：Google 試算表當顧客資料庫（客人檔案＋訂購記錄）
// 沒設 GOOGLE_SHEETS_KEY / SHEET_ID 時所有函式都是安全的 no-op，不影響回覆流程。
const SHEET_ID = process.env.SHEET_ID;
const KEY_JSON = process.env.GOOGLE_SHEETS_KEY;

let sheets = null; // lazy init
async function client() {
  if (sheets) return sheets;
  if (!SHEET_ID || !KEY_JSON) return null;
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(KEY_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

// 客人檔案欄位：A=userId B=姓名 C=電話 D=喜好/忌口 E=首次來店日 F=訂購次數 G=上次訂購 H=備註
const PROFILE_RANGE = '客人檔案!A2:H';
const ORDER_RANGE = '訂購記錄!A2:G';
// 會話分頁欄位：A=userId B=historyJson C=orderJson D=updatedAt
const SESSION_RANGE = '會話!A2:D';
let sessionTabReady = false;

async function ensureSessionTab(s) {
  if (sessionTabReady) return;
  try {
    // 試讀一次，tab 不存在會報錯
    await s.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: '會話!A1:D1' });
    sessionTabReady = true;
  } catch (e) {
    // 建立「會話」分頁
    console.log('[customer-db] creating 會話 sheet tab');
    await s.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: '會話' } } }] },
    });
    await s.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: '會話!A1:D1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['userId', 'historyJson', 'orderJson', 'updatedAt']] },
    });
    sessionTabReady = true;
  }
}

// 記憶體快取，避免每則訊息都打 API
const cache = new Map();

async function getProfile(userId) {
  if (cache.has(userId)) return cache.get(userId);
  try {
    const s = await client();
    if (!s) return null;
    const res = await s.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: PROFILE_RANGE });
    const rows = res.data.values || [];
    const row = rows.find((r) => r[0] === userId);
    const profile = row
      ? { userId: row[0], name: row[1] || '', phone: row[2] || '', note: row[3] || '', firstDate: row[4] || '', orderCount: row[5] || '0', lastOrder: row[6] || '' }
      : null;
    cache.set(userId, profile);
    return profile;
  } catch (e) {
    console.error('[customer-db] getProfile:', e.message);
    return null;
  }
}

function todayStr() {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// 訂單成立時：寫入「訂購記錄」＋更新「客人檔案」
async function saveOrder({ userId, name, phone, items, pickup_time }) {
  try {
    const s = await client();
    if (!s) return;
    const itemStr = (items || []).map((i) => `${i.name}x${i.qty}`).join('、');
    const now = todayStr();
    // 1. 訂購記錄 append
    await s.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: '訂購記錄!A:G',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[now, userId, name || '', itemStr, pickup_time || '', phone || '', '']] },
    });
    // 2. 客人檔案 upsert
    const res = await s.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: PROFILE_RANGE });
    const rows = res.data.values || [];
    const idx = rows.findIndex((r) => r[0] === userId);
    if (idx >= 0) {
      const row = rows[idx];
      const count = (parseInt(row[5], 10) || 0) + 1;
      await s.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `客人檔案!B${idx + 2}:G${idx + 2}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[name || row[1] || '', phone || row[2] || '', row[3] || '', row[4] || now, String(count), itemStr]] },
      });
    } else {
      await s.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: '客人檔案!A:H',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[userId, name || '', phone || '', '', now, '1', itemStr, '']] },
      });
    }
    cache.delete(userId); // 清快取，下次重抓
  } catch (e) {
    console.error('[customer-db] saveOrder:', e.message);
  }
}

// LLM 順手記下的偏好：併入「喜好/忌口」
async function updateNote(userId, note) {
  if (!note) return;
  try {
    const s = await client();
    if (!s) return;
    const res = await s.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: PROFILE_RANGE });
    const rows = res.data.values || [];
    const idx = rows.findIndex((r) => r[0] === userId);
    if (idx >= 0) {
      const old = rows[idx][3] || '';
      const merged = old.includes(note) ? old : (old ? old + '；' + note : note);
      await s.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `客人檔案!D${idx + 2}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[merged]] },
      });
    } else {
      await s.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: '客人檔案!A:H',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[userId, '', '', note, todayStr(), '0', '', '']] },
      });
    }
    cache.delete(userId);
  } catch (e) {
    console.error('[customer-db] updateNote:', e.message);
  }
}

// 會話持久化：讀取（記憶體快取 → 試算表）
const sessionCache = new Map();
async function getSession(userId) {
  if (sessionCache.has(userId)) return sessionCache.get(userId);
  let session = { history: [], order: null };
  try {
    const s = await client();
    if (s) {
      await ensureSessionTab(s);
      const res = await s.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SESSION_RANGE });
      const rows = res.data.values || [];
      const row = rows.find((r) => r[0] === userId);
      if (row) {
        try {
          session.history = JSON.parse(row[1] || '[]');
          session.order = JSON.parse(row[2] || 'null');
        } catch (e) { console.error('[customer-db] session parse:', e.message); }
      } else {
        console.log('[new user]', userId);
      }
    }
  } catch (e) {
    console.error('[customer-db] getSession:', e.message);
  }
  sessionCache.set(userId, session);
  return session;
}

// 會話持久化：寫回（write-through）
async function saveSession(userId) {
  const session = sessionCache.get(userId);
  if (!session) return;
  try {
    const s = await client();
    if (!s) return;
    await ensureSessionTab(s);
    const now = new Date().toISOString();
    const historyJson = JSON.stringify((session.history || []).slice(-20));
    const orderJson = JSON.stringify(session.order || null);
    const res = await s.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SESSION_RANGE });
    const rows = res.data.values || [];
    const idx = rows.findIndex((r) => r[0] === userId);
    if (idx >= 0) {
      await s.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `會話!B${idx + 2}:D${idx + 2}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[historyJson, orderJson, now]] },
      });
    } else {
      await s.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: '會話!A:D',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[userId, historyJson, orderJson, now]] },
      });
    }
  } catch (e) {
    console.error('[customer-db] saveSession:', e.message);
  }
}

module.exports = { getProfile, saveOrder, updateNote, getSession, saveSession };
