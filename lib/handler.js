// 訊息處理：會話狀態＋訂單狀態機＋LINE reply＋客人檔案
const { chat } = require('./llm');
const db = require('./customer-db');
const { holidayName, parsePickupDate } = require('./holidays');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const BOSS_USER_ID = process.env.BOSS_USER_ID; // 老闆私人 LINE 的 userId（U 開頭），有設才推播

// 自取分流（2026-11-03 老闆指示）：LINE 只接外送預訂，自取一律導向線上點餐系統
// 背景：唐小姐 2026-11-03 晚餐時段用 LINE 點自取單、艾琳確認成立，但老闆忙著出餐沒看到，
// 客人到店無餐可取、憤而離去並封鎖。自取單走線上系統直接進店裡系統，不再經 LINE 接單。
const PICKUP_ORDER_URL = 'line://app/1607331440-2dNpzWeB?type=order&id=d3f611418e5e4edb8eeb0bb754af3317';
const PICKUP_RE = /自取|自己拿|現場取|過去拿|來拿|到店取|外帶|自己來拿|我去拿|親取/;
const PICKUP_REDIRECT = `先跟您說明一下，我是穀雨的 AI 輔助點餐小幫手艾琳 😊 LINE 這邊是接外送預訂的；如果是要自取，麻煩用我們的線上點餐自取系統下單，單會直接進店裡系統喔：${PICKUP_ORDER_URL}`;

// 會話記憶：改由試算表持久化（lib/customer-db.js），重啟/部署不再遺失
const MAX_HISTORY = 20; // 只保留最近 20 則，避免 token 爆掉

// 老闆手動接管：暫停自動回覆（重啟後預設恢復，避免忘記開回來）
let manualPaused = false; // 全部暫停
let pauseUntil = 0;
const pausedUsers = new Map(); // 單一客人暫停：userId → 到期時間戳
let lastCustomer = null; // 最近一位客人的 userId（不含老闆本人）

// 確認 pattern：短訊息以確認詞開頭、且不含否定詞，才算成立
function isConfirmText(text) {
  const t = text.trim();
  if (t.length > 12) return false;
  return /^(確認|好|好的|可以|沒問題|OK|ok|對|確定|就這樣)/.test(t) && !/(不要|不行|取消|改|等一下)/.test(t);
}

// 解析取餐時間是星期幾（0=週日..6=週六），無法判斷回 null
function parseDayOfWeek(pickupTime) {
  if (!pickupTime) return null;
  const now = new Date();
  if (/大後天/.test(pickupTime)) { const d = new Date(now); d.setDate(d.getDate() + 3); return d.getDay(); }
  if (/後天/.test(pickupTime)) { const d = new Date(now); d.setDate(d.getDate() + 2); return d.getDay(); }
  if (/明天/.test(pickupTime)) { const d = new Date(now); d.setDate(d.getDate() + 1); return d.getDay(); }
  const weekM = pickupTime.match(/週([一二三四五六日天])/);
  if (weekM) return { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[weekM[1]];
  const mdM = pickupTime.match(/(\d{1,2})\/(\d{1,2})/) || pickupTime.match(/(\d{1,2})月(\d{1,2})[日號]/);
  if (mdM) {
    const d = new Date(now.getFullYear(), parseInt(mdM[1], 10) - 1, parseInt(mdM[2], 10));
    if (d.getTime() < now.getTime() - 86400000 * 30) d.setFullYear(d.getFullYear() + 1);
    return d.getDay();
  }
  return null;
}

// 判斷取餐時間是否為「今天」（當日外送攔截用）
function isTodayPickup(pickupTime) {
  if (!pickupTime) return true; // 沒給日期：視為當日
  if (/大後天|後天|明天/.test(pickupTime)) return false;
  if (/今天|今日/.test(pickupTime)) return true;
  const mdM = pickupTime.match(/(\d{1,2})\/(\d{1,2})/) || pickupTime.match(/(\d{1,2})月(\d{1,2})[日號]/);
  if (mdM) {
    const now = new Date();
    return parseInt(mdM[1], 10) === now.getMonth() + 1 && parseInt(mdM[2], 10) === now.getDate();
  }
  const weekM = pickupTime.match(/週([一二三四五六日天])/);
  if (weekM) {
    const d = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[weekM[1]];
    return d === new Date().getDay();
  }
  return true; // 只有時間（如「中午12點」）：視為今天
}

// 作弊日營業日檢查（程式碼擋下，不靠 prompt）
function checkCheatDay(items, pickupTime) {
  const hasCheat = (items || []).some((i) => (i.name || '').includes('作弊日'));
  if (!hasCheat) return null;
  const day = parseDayOfWeek(pickupTime);
  if (day !== null && day !== 5 && day !== 6) {
    return '不好意思，作弊日餐點只有週五、週六才有供應喔！您選的時間沒有，要不要改成其他餐點，或改週五／六取餐呢？';
  }
  return null;
}

// 國定假日公休檢查（2026-10-26 老闆指示，程式碼擋下，不靠 prompt）：
// 取餐日是國定假日或補假 → 店休，不接當天的單
function checkHoliday(pickupTime) {
  const dateStr = parsePickupDate(pickupTime);
  const name = holidayName(dateStr);
  if (!name) return null;
  const [, m, d] = dateStr.split('-');
  return `不好意思，${parseInt(m, 10)}月${parseInt(d, 10)}日是${name}，店裡公休一天喔！要不要改成其他天取餐呢？`;
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
  const lines = (order.items || []).map((i) => `・${i.name} x${i.qty}${i.note ? `（${i.note}）` : ''}`);
  return [
    '跟你確認一下訂單：',
    ...lines,
    `取餐時間：${order.pickup_time || '未填'}`,
    `姓名：${order.name || '未填'}　電話：${order.phone || '未填'}`,
    ...(order.address ? [`外送地址：${order.address}`] : []),
    ...(order.generalNote ? [`備註：${order.generalNote}`] : []),
    '沒問題請回「確認」，要改直接跟我說！',
  ].join('\n');
}

// 簡稱→正式品項（跟知識庫的簡稱對照表同步）
const ALIAS = {
  '雞胸': '厚切舒肥嫩雞胸', '舒肥雞': '厚切舒肥嫩雞胸',
  '梅花豬': '韓式醬烤梅花豬', '韓式烤梅花': '韓式醬烤梅花豬',
  '打拋豬': '泰式打拋豬', '泰式打拋豬': '泰式打拋豬', '泰式打拋': '泰式打拋豬', '打拋': '泰式打拋豬',
  '虱目魚': '嫩煎台南虱目魚柳', '魚柳': '嫩煎台南虱目魚柳', '魚': '嫩煎台南虱目魚柳',
  '壽喜牛': '和風壽喜牛丼', '牛肉丼': '和風壽喜牛丼', '牛丼': '和風壽喜牛丼',
  '雙拼': '120%元氣雙拼', '雙拼餐盒': '120%元氣雙拼',
  '綠野鮮蔬盒': '綠野鮮蔬盒', '鮮蔬盒': '綠野鮮蔬盒',
  '爌肉': '作弊日一號 阿嬤爌肉＋滷雞腿', '滷雞腿': '作弊日一號 阿嬤爌肉＋滷雞腿', '控肉': '作弊日一號 阿嬤爌肉＋滷雞腿', '控肉飯': '作弊日一號 阿嬤爌肉＋滷雞腿', '爌肉飯': '作弊日一號 阿嬤爌肉＋滷雞腿',
  '作弊日一號': '作弊日一號 阿嬤爌肉＋滷雞腿', '一號': '作弊日一號 阿嬤爌肉＋滷雞腿',
  '三倍牛': '作弊日二號 三倍壽喜牛丼', '作弊日二號': '作弊日二號 三倍壽喜牛丼', '二號': '作弊日二號 三倍壽喜牛丼',
  '海南雞腿排': '海南雞腿排', '海南雞': '海南雞腿排',
  '胡麻豆腐': '日式胡麻冷豆腐', '豆腐': '日式胡麻冷豆腐',
  '哈佛蔬菜湯': '哈佛蔬菜湯', '蔬菜湯': '哈佛蔬菜湯',
};
const SURNAMES = '王李張劉陳楊黃趙吳周徐孫馬朱胡郭何羅梁鄭謝宋唐鄧韓馮董蕭程曹袁許傅沈曾彭呂蘇盧蔣蔡賈丁魏薛葉閻余潘杜戴夏鍾汪田任姜范方石姚譚廖鄒熊金陸郝孔白崔康毛邱秦江史顧侯邵孟龍萬段雷錢湯尹黎易常武喬賀賴龔文林莊柯顏翁尤詹藍連';
const CN_NUM = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function toQty(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (CN_NUM[s] !== undefined) return CN_NUM[s];
  return 0;
}

// LLM 格式跑掉時的最後救援：用正規表示式從訊息抓姓名、電話、外送地址、品項
// 電話正規（2026-10-30 修：舊版不認帶分隔符的手機，客人寫 0937-930160、0937-930-160
// 都抓不到，艾琳就會一直重問電話）：手機 09 開頭 10 碼，- 或空白可出現在數字間；
// 市話 0X 開頭，可帶分機 #121；2026-11-12 補：無區碼的 7 碼市話＋分機（例：2160121#2232，
// 客人寫「聯絡人電話：2160121#2232」時舊版因無 0 開頭而抓不到，艾琳重問電話）
const PHONE_RE = /09\d{2}[- ]?\d{3}[- ]?\d{3}|0\d[- ]?\d{3,4}[- ]?\d{4}(?:#\d+)?|\d{7}#\d+/;
// 抓到的電話去分隔符存成純數字（分機保留），方便比對與顯示
function normalizePhone(raw) {
  const extM = raw.match(/#\d+$/);
  const ext = extM ? extM[0] : '';
  const base = ext ? raw.slice(0, -ext.length) : raw;
  return base.replace(/\D/g, '') + ext;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 正式品項 → 可在訊息中辨認它的字串（正式名、簡稱、開頭詞）
function itemMatchStrings(formalName) {
  const strs = [formalName];
  for (const [alias, formal] of Object.entries(ALIAS)) {
    if (formal === formalName && !strs.includes(alias)) strs.push(alias);
  }
  const firstToken = formalName.split(' ')[0];
  if (firstToken && firstToken !== formalName && !strs.includes(firstToken)) strs.push(firstToken);
  return strs;
}
// 本次訊息裡有沒有提到這個品項（簡稱也算；單字簡稱不做子字串比對，避免誤判）
function itemMentionedInText(formalName, text) {
  return itemMatchStrings(formalName).some((s) => (s.length >= 2 ? text.includes(s) : text.trim() === s));
}

function salvage(text) {
  const out = { name: null, phone: null, address: null, items: [] };
  const phoneM = text.match(PHONE_RE);
  if (phoneM) out.phone = normalizePhone(phoneM[0]);
  else {
    // 標籤式電話（例：「聯絡人電話：2160121」）：無區碼、無分機的市話也認，
    // 但只認「電話／手機」標籤後面的數字，避免把統編等數字誤認成電話
    const labelM = text.match(/(?:電話|手機)[：:\s]*([0-9][0-9\- ]{5,}(?:#\d+)?)/);
    if (labelM) out.phone = normalizePhone(labelM[1].trim());
  }
  const nameM = text.match(/(?:訂購人|聯絡人|聯絡者|姓名|稱呼)[：:\s]*([^\s，,。；;]+)/)
    || text.match(new RegExp(`([${SURNAMES}][^\\s，,。；;]{0,3})(先生|小姐|太太|老闆)`));
  if (nameM) out.name = nameM[1] + (nameM[2] || '');
  const addrM = text.match(/(?:外送到|送到|地址[：:\s]*)([^\n，。；;]+)/);
  if (addrM) {
    out.address = addrM[1].trim();
  } else {
    // 沒有關鍵字時：如果某一行像地址（有路/街/號/中心/大樓等）就當地址
    const lines = text.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t && !PHONE_RE.test(t) && !new RegExp(`^[${SURNAMES}]`).test(t) &&
          /(路|街|號|中心|大樓|廣場|園區|醫院|學校|公司)/.test(t)) {
        out.address = t;
        break;
      }
    }
  }
  // 日期（11/16、11月16日）：即使訊息裡還有品項也要抓，更新取餐時間
  const dateM = text.match(/(\d{1,2})\/(\d{1,2})|(\d{1,2})月(\d{1,2})[日號]/);
  if (dateM) out.dateStr = dateM[0];
  // 時刻（11:50）：日期後面若有寫時間也一起抓，摘要才不會只剩日期
  const timeM = text.match(/(\d{1,2})[：:](\d{2})/);
  if (timeM) out.timeStr = timeM[0];
  const aliases = Object.keys(ALIAS).sort((a, b) => b.length - a.length);
  // 第一輪：數量在前、品名在後（例：「2個雞胸」）。2026-11-12 修：數量與品名限同一行，
  // 舊版 \s* 會跨行，把上一行的數量配到下一行品名（例：「*1\n嫩煎虱目魚柳$135*2」誤抓魚柳 x1）
  const itemRe = /([0-9一二兩三四五六七八九十]+)[ \t]*個?[ \t]*([^\d\s，,。；;]+)/g;
  let m;
  while ((m = itemRe.exec(text)) !== null) {
    const qty = toQty(m[1]);
    if (!(qty > 0 && qty < 1000)) continue;
    const raw = m[2];
    // 單字簡稱（如「魚」）只接受完全相符，避免誤判
    const hit = aliases.find((a) => (a.length >= 2 && raw.includes(a)) || (a.length === 1 && raw === a));
    if (hit) out.items.push({ name: ALIAS[hit], qty });
  }
  // 第二輪：品項在前、數量在後（例：「海南雞腿排6盒」「虱目魚柳 x1」「作弊日一號 x4」），第一輪抓不到這種寫法。
  // 2026-11-12 補：品名後可能接殘字（柳／肉）、價格（$150 或 135）、再接 *數量（例：「海南雞腿排$150*2」
  // 「泰式低脂打拋豬肉135*1」），舊版只認品名後直接接數量，會抓不到
  const foundNames = new Set(out.items.map((i) => i.name));
  for (const a of aliases) {
    if (a.length < 2) continue;
    const re2 = new RegExp(`${escapeRegExp(a)}(?:柳|肉)?(?:\\$?\\d+\\s*[xX×\\*]\\s*)?\\s*[xX×\\*個]?\\s*([0-9一二兩三四五六七八九十]+)\\s*[盒個份]?`, 'g');
    let m2;
    while ((m2 = re2.exec(text)) !== null) {
      const qty = toQty(m2[1]);
      const formal = ALIAS[a];
      if (qty > 0 && qty < 1000 && !foundNames.has(formal)) {
        out.items.push({ name: formal, qty });
        foundNames.add(formal);
      }
    }
  }
  // 整筆備註（半飯、少飯、加飯、換地瓜、換菜等）：先抓關鍵字，細節交給 LLM 或老闆確認
  const noteM = text.match(/(半飯換菜|不飯換菜|換菜|半飯|少飯|加飯|多飯|白飯換地瓜|換地瓜|不要飯|去飯|醬多|醬少|少醬)/);
  if (noteM) out.generalNote = noteM[0];
  return out;
}

// LLM 格式跑掉時的救援：把抓到的資訊併入訂單，盡量完成流程
function salvageResult(text, order) {
  const s = salvage(text);
  // 純時間／日期回答（例：「10/20中午11點」「明天下午2點」）：當作取餐時間
  const isTimeOnly = !s.name && !s.phone && !s.address && !s.items.length &&
    /(\d\s*[點:：]|\/|明天|後天|大後天|週[一二三四五六日天])/.test(text);

  // 還沒有進行中的訂單也照樣救援（2026-10-22 修：舊版在這裡直接放棄，
  // 客人第一則訊息格式複雜時就會一路「沒聽清楚」到底）
  if (!order) order = { items: [], status: 'collecting' };

  let updated = false;
  if (s.items.length) { order.items = s.items; updated = true; }
  if (s.name) { order.name = s.name; updated = true; }
  if (s.phone) { order.phone = s.phone; updated = true; }
  if (s.address) { order.address = s.address; updated = true; }
  if (s.generalNote) { order.generalNote = s.generalNote; updated = true; }
  if (isTimeOnly && !order.pickup_time) { order.pickup_time = text.trim(); updated = true; }
  // 抓到日期（如 11/16）：併入取餐時間
  if (s.dateStr) {
    const timePart = order.pickup_time && !/\d+\/\d+/.test(order.pickup_time) ? ` ${order.pickup_time}` : '';
    const clockPart = s.timeStr && !`${s.dateStr}${timePart}`.includes(s.timeStr) ? ` ${s.timeStr}` : '';
    const newPickup = `${s.dateStr}${timePart}${clockPart}`.trim();
    if (order.pickup_time !== newPickup) { order.pickup_time = newPickup; updated = true; }
  }

  if (!updated) {
    // 救援也抓不到任何東西：不要再回「沒聽清楚」，交給 handler 轉交老闆接手
    return { escalate: true };
  }

  // 品項＋姓名＋電話＋外送地址都有了 → 給訂單摘要請客人確認
  // 沒有外送地址時不進 confirming（LINE 只接外送預訂），改問缺的資料
  if (order.name && order.phone && order.items && order.items.length && order.address) {
    return { reply: orderSummary(order), order: { ...order, status: 'confirming' }, customer_note: null };
  }
  // 還缺資料 → 問缺的
  const missing = [];
  if (!order.items || !order.items.length) missing.push('餐點品項');
  if (!order.pickup_time) missing.push('取餐時間');
  if (!order.name) missing.push('稱呼');
  if (!order.phone) missing.push('電話');
  if (!order.address) missing.push('外送地址');
  return {
    reply: `好的，記下了。再麻煩提供${missing.join('、')}，我們好為您完成預訂，謝謝！`,
    order: { ...order, status: 'collecting' },
    customer_note: null,
  };
}

// 艾琳處理不了時轉交老闆（2026-10-22 老闆指示）：停止回覆該客人（噤聲 1 小時，同手動接管），
// 並把客人訊息推播到老闆私人 LINE，由老闆親自接手
async function escalateToBoss(userId, text, reason) {
  pausedUsers.set(userId, Date.now() + 60 * 60 * 1000);
  if (!BOSS_USER_ID) return;
  let who = '客人';
  try {
    const p = await db.getProfile(userId);
    if (p && (p.name || p.phone)) who = `${p.name || '未留名'}${p.phone ? ' ' + p.phone : ''}`;
  } catch (e) {}
  const msg = ['【艾琳需要你接手】', `客人：${who}`, `原因：${reason}`, `客人訊息：${text}`].join('\n');
  try {
    await linePush(BOSS_USER_ID, [msg]);
  } catch (e) {
    console.error('[escalate push]', e.message);
  }
}

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();
  if (!text) return;

  // 老闆指令（只認 BOSS_USER_ID）
  if (BOSS_USER_ID && userId === BOSS_USER_ID) {
    if (/^(暫停全部|全部暫停)$/.test(text)) {
      manualPaused = true;
      pauseUntil = Date.now() + 60 * 60 * 1000;
      await lineReply(event.replyToken, ['收到，這 1 小時我不會回任何客人。輸入「恢復」可提早回來。']);
      return;
    }
    if (/^(暫停|接管|手動)$/.test(text)) {
      // 只對最近一位客人噤聲
      if (lastCustomer) {
        pausedUsers.set(lastCustomer, Date.now() + 60 * 60 * 1000);
        let who = '最近一位客人';
        try {
          const p = await db.getProfile(lastCustomer);
          if (p && (p.name || p.phone)) who = `${p.name || '未留名'}${p.phone ? ' ' + p.phone : ''}`;
        } catch (e) {}
        await lineReply(event.replyToken, [`已對「${who}」噤聲 1 小時，其他客人我照常回。輸入「恢復」可提早回來。`]);
      } else {
        await lineReply(event.replyToken, ['目前沒有客人在聊天，不用暫停。']);
      }
      return;
    }
    if (/^(恢復|繼續|自動)$/.test(text)) {
      manualPaused = false;
      pausedUsers.clear();
      await lineReply(event.replyToken, ['我回來了，自動回覆已全部恢復。']);
      return;
    }
    // 老闆的其他訊息照常當測試處理
  }

  // 記錄最近一位客人（老闆本人不算）
  if (!BOSS_USER_ID || userId !== BOSS_USER_ID) {
    lastCustomer = userId;
  }

  // 檢查是否被噤聲（單一或全部）
  const now = Date.now();
  const singleExpiry = pausedUsers.get(userId) || 0;
  if (singleExpiry && now > singleExpiry) pausedUsers.delete(userId); // 逾時清除
  const isSinglePaused = pausedUsers.has(userId);
  if (manualPaused && now > pauseUntil) manualPaused = false; // 全部暫停逾時自動恢復

  if (manualPaused || isSinglePaused) {
    // 靜默：訊息照樣存檔（老闆可在試算表看到），不回覆
    const session = await db.getSession(userId);
    session.history.push({ role: 'user', content: text });
    session.history = session.history.slice(-MAX_HISTORY);
    await db.saveSession(userId);
    return;
  }

  const session = await db.getSession(userId);
  session.history.push({ role: 'user', content: text });
  session.history = session.history.slice(-MAX_HISTORY);

  // 自取分流攔截（程式碼擋下，不靠 prompt）：進行中的訂單或本則訊息已有品項，
  // 且客人說要自取、又沒有外送地址 → 不接單、不產生摘要，直接導向線上點餐自取系統。
  // 有外送地址時不攔（那是外送單）；沒品項的純提問交給 LLM 回答。
  if (!BOSS_USER_ID || userId !== BOSS_USER_ID) {
    const salv = salvage(text);
    const hasOrderIntent = (session.order && session.order.items && session.order.items.length) || salv.items.length;
    const hasAddress = (session.order && session.order.address) || salv.address;
    if (hasOrderIntent && !hasAddress && PICKUP_RE.test(text)) {
      session.order = null;
      session.history.push({ role: 'assistant', content: PICKUP_REDIRECT });
      await db.saveSession(userId);
      await lineReply(event.replyToken, [PICKUP_REDIRECT]);
      return;
    }
  }

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
    await db.saveSession(userId);
    return;
  }

  // LLM 兩次格式都跑掉：用正規表示式救援，盡量把訂單完成，不跟客人說沒聽清楚
  if (result.parseFailed) {
    console.error('[salvage] regex rescue for:', text.slice(0, 60));
    result = salvageResult(text, session.order);
    // 救援只看當則訊息：若仍缺姓名／電話／地址，從對話歷史往回找補上
    // （客人前面留過、現在只說「電話已有提供」時，不再重問）
    const ord = result.order || session.order;
    if (ord && (!ord.phone || !ord.name || !ord.address)) {
      const hist = session.history.slice(0, -1).filter((h) => h.role === 'user').map((h) => h.content).reverse();
      for (const old of hist) {
        const s = salvage(old);
        if (!ord.phone && s.phone) ord.phone = s.phone;
        if (!ord.name && s.name) ord.name = s.name;
        if (!ord.address && s.address) ord.address = s.address;
        if (ord.phone && ord.name && ord.address) break;
      }
      // 補齊後重新結算一次（原本的回覆可能是補齊前的缺件提問）
      if (ord.items && ord.items.length && ord.name && ord.phone && ord.address) {
        result = { reply: orderSummary(ord), order: { ...ord, status: 'confirming' }, customer_note: null };
      } else if (ord.items?.length || ord.name || ord.phone || ord.address || ord.pickup_time) {
        const missing = [];
        if (!ord.items || !ord.items.length) missing.push('餐點品項');
        if (!ord.pickup_time) missing.push('取餐時間');
        if (!ord.name) missing.push('稱呼');
        if (!ord.phone) missing.push('電話');
        if (!ord.address) missing.push('外送地址');
        result = { reply: `好的，記下了。再麻煩提供${missing.join('、')}，我們好為您完成預訂，謝謝！`, order: { ...ord, status: 'collecting' }, customer_note: null };
      }
    }
    if (result.escalate) {
      // 救援也抓不到東西：停止回覆，轉交老闆接手
      await escalateToBoss(userId, text, '艾琳聽不懂這則訊息（解析失敗、救援也抓不到資料），已停止回覆');
      session.history.push({ role: 'assistant', content: '（系統註記：此對話已轉交老闆親自接手，艾琳暫停回覆 1 小時）' });
      await db.saveSession(userId);
      return;
    }
  }

  // LLM 自評無法回答（問題不在知識庫、無法確定答案）：停止回覆，轉交老闆
  if (result.need_human) {
    await escalateToBoss(userId, text, '客人問的問題艾琳無法回答，已停止回覆');
    session.history.push({ role: 'assistant', content: '（系統註記：此對話已轉交老闆親自接手，艾琳暫停回覆 1 小時）' });
    await db.saveSession(userId);
    return;
  }

  // === 訂單狀態機（程式碼主導，不再信任 LLM 的 status）===
  // LLM 只負責：reply 口氣 ＋ 抽取欄位（品項/時間/姓名/電話/地址）
  const fields = result.order || {};

  // === 新訂單防呆（2026-11-08 修：鈞鋒公司 11/10 新單誤觸作弊日攔截）===
  // 事故：客人 10/28 的舊單（作弊日一號 x4，未確認）殘留在 session.order，
  // 11/08 新下 11/10 海南雞腿排 x6，LLM 把歷史舊品項帶進新單（或沒抽到品項），
  // 作弊日檢查誤用舊品項擋單，艾琳回了錯誤的作弊日訊息。
  // 三道防線：(1) 剔除 LLM 抄來的歷史舊品項；(2) LLM 沒抽到品項時用正規救援補；
  // (3) 新日期＋完整新單時，清掉殘留舊單。
  const salvNow = salvage(text);
  // (1) 本次訊息有明確品項、且客人沒說「跟上次一樣」時，LLM 抽出的某品項若在本次訊息
  // 完全沒提到、卻在上次未完成的訂單裡 → 視為抄歷史，剔除；不在上次訂單裡的品項一律
  // 保留（避免 LLM 品名簡寫、如紅茶→復刻紅茶，被誤殺）。全被剔除時改用正規救援的品項。
  const SAME_AS_LAST_RE = /跟上次一樣|和上次一樣|跟上次的|照上次|老樣子|一樣就好|跟之前一樣/;
  if (!SAME_AS_LAST_RE.test(text) && salvNow.items.length && fields.items && fields.items.length) {
    const prevNames = new Set(((session.order && session.order.items) || []).map((i) => i.name));
    const kept = fields.items.filter((i) => itemMentionedInText(i.name, text) || !prevNames.has(i.name));
    fields.items = kept.length ? kept : salvNow.items;
  }
  // (2) LLM 沒抽到品項、但訊息裡明明有品項時，用正規救援補上，避免整筆訂單憑空消失
  if ((!fields.items || !fields.items.length) && salvNow.items.length) {
    fields.items = salvNow.items;
    if (!fields.pickup_time && salvNow.dateStr) fields.pickup_time = salvNow.dateStr + (salvNow.timeStr ? ` ${salvNow.timeStr}` : '');
    if (!fields.name && salvNow.name) fields.name = salvNow.name;
    if (!fields.phone && salvNow.phone) fields.phone = salvNow.phone;
    if (!fields.address && salvNow.address) fields.address = salvNow.address;
    if (!fields.generalNote && salvNow.generalNote) fields.generalNote = salvNow.generalNote;
  }
  // (3) 新訂單偵測：本次訊息的取餐日期與進行中訂單不同、且內容像一筆完整新單
  // （有品項，或姓名＋電話＋地址齊全）→ 先清掉殘留舊單，後面的檢查才不會拿舊品項擋新單。
  // 單純改日期（「改到 11/10」）不算新單，舊單保留、多輪訂餐的作弊日檢查照常運作。
  const msgDate = parsePickupDate(fields.pickup_time || text);
  const oldDate = session.order && session.order.pickup_time ? parsePickupDate(session.order.pickup_time) : null;
  const looksLikeFreshOrder = (fields.items && fields.items.length) ||
    (fields.name && fields.phone && fields.address);
  if (oldDate && msgDate !== oldDate && looksLikeFreshOrder) {
    console.log('[new-order] reset stale session order:', JSON.stringify(session.order));
    session.order = null;
  }

  // 作弊日營業日檢查（程式碼擋下，不靠 prompt）
  const cheatErr = checkCheatDay(fields.items || (session.order && session.order.items), fields.pickup_time || (session.order && session.order.pickup_time));
  if (cheatErr) {
    session.history.push({ role: 'assistant', content: cheatErr });
    await db.saveSession(userId);
    await lineReply(event.replyToken, [cheatErr]);
    return;
  }

  // 國定假日公休檢查：取餐日是假日就擋下（只在有訂單意圖時檢查，純問問題交給 LLM 回答）
  const holidayPickup = fields.pickup_time || (session.order && session.order.pickup_time);
  const hasOrderIntent = (fields.items && fields.items.length) || session.order;
  if (hasOrderIntent) {
    const holidayErr = checkHoliday(holidayPickup);
    if (holidayErr) {
      session.history.push({ role: 'assistant', content: holidayErr });
      await db.saveSession(userId);
      await lineReply(event.replyToken, [holidayErr]);
      return;
    }
  }

  // 當日外送攔截（2026-10-21 老闆指示）：當天要外送 → 表明 AI 身分，請客人打電話由專人服務，LINE 不登記
  const deliveryAddress = fields.address || (session.order && session.order.address);
  const deliveryTime = fields.pickup_time || (session.order && session.order.pickup_time);
  const deliveryItems = (fields.items && fields.items.length) || (session.order && session.order.items && session.order.items.length);
  if (deliveryAddress && deliveryItems && isTodayPickup(deliveryTime)) {
    const msg = '先跟您說明一下，我是穀雨的 AI 輔助點餐小幫手艾琳 😊 當日外送需要專人幫您確認安排，再麻煩您直接撥打 06-2650156，會有專人為您服務喔！如果是明天之後的外送預訂，我可以先幫您登記。';
    session.history.push({ role: 'assistant', content: msg });
    await db.saveSession(userId);
    await lineReply(event.replyToken, [msg]);
    return;
  }

  // 合併欄位到進行中的訂單
  let order = session.order;
  if (!order && fields.items && fields.items.length) {
    order = { items: fields.items, status: 'collecting' };
  }
  if (order) {
    if (fields.items && fields.items.length) order.items = fields.items;
    if (fields.pickup_time) order.pickup_time = fields.pickup_time;
    if (fields.name) order.name = fields.name;
    if (fields.phone) order.phone = normalizePhone(fields.phone);
    if (fields.address) order.address = fields.address;
    if (fields.generalNote) order.generalNote = fields.generalNote;
  }

  let replyText = result.reply || '收到！';

  // collecting → confirming：品項＋姓名＋電話＋外送地址齊了，程式產生摘要
  // 沒有外送地址（還沒確認是外送）時不產生摘要，改問外送地址並附自取連結，訂單維持 collecting
  if (order && order.status === 'collecting' && order.items && order.items.length && order.name && order.phone) {
    if (!order.address) {
      replyText = `請問這筆是要外送嗎？再麻煩提供外送地址，我幫您登記外送預訂喔！如果是自取，請直接用我們的線上點餐自取系統下單：${PICKUP_ORDER_URL}`;
    } else {
      order.status = 'confirming';
      replyText = orderSummary(order);
    }
  }
  // confirming → confirmed：只有明確說「確認」才算成立
  // 防線：沒有外送地址的訂單絕對不能在 LINE 成立，改回收集並導向自取連結
  else if (order && order.status === 'confirming' && isConfirmText(text)) {
    if (!order.address) {
      order.status = 'collecting';
      replyText = PICKUP_REDIRECT;
    } else {
      order.status = 'confirmed';
      replyText = `好的，${order.name}！訂單成立，我們會妥善安排，謝謝您的訂購！`;
    }
  }
  // confirming 但說了別的 → 回到 collecting，用 LLM 的回覆處理修改
  else if (order && order.status === 'confirming') {
    order.status = 'collecting';
  }

  session.history.push({ role: 'assistant', content: replyText });
  session.order = order && order.status !== 'none' ? order : null;

  // 訂單剛被確認：寫入客人檔案＋推播通知老闆（每單扣 1 則額度）
  if (order && order.status === 'confirmed') {
    console.log('[ORDER CONFIRMED]', JSON.stringify({ userId, ...order }));
    await db.saveOrder({ userId, name: order.name, phone: order.phone, items: order.items, pickup_time: order.pickup_time });
    if (BOSS_USER_ID) {
      const lines = (order.items || []).map((i) => `・${i.name} x${i.qty}${i.note ? `（${i.note}）` : ''}`).join('\n');
      const msg = [
        '【新訂單】',
        lines,
        `取餐時間：${order.pickup_time || '未填'}`,
        `姓名：${order.name || '未填'}　電話：${order.phone || '未填'}`,
        ...(order.address ? [`外送地址：${order.address}`] : []),
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

  await db.saveSession(userId); // 每次處理完寫回試算表，部署重啟不遺失
  await lineReply(event.replyToken, [replyText]);
}

module.exports = { handleMessage, orderSummary, salvage, salvageResult };
