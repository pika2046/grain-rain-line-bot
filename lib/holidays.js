// 國定假日公休表（2026-10-26 老闆指示：台灣國定假日＋補假一律公休）
// 來源：行政院人事行政總處 115年（2026）、116年（2027）政府行政機關辦公日曆表
// 注意：每年新行事曆公布後要補上新年度的日期。
// 春節那週（2027 為 2/4–2/10）整週列為公休；其他連假只列假日本身＋補假，
// 連假裡的一般週六仍照週六規則（只開早上），週日原本就公休。
// key: 'YYYY-MM-DD'，value: 假日名稱
const HOLIDAYS = {
  // 2026 下半年
  '2026-10-25': '台灣光復暨金門古寧頭大捷紀念日',
  '2026-10-26': '光復節補假',
  '2026-12-25': '行憲紀念日',
  // 2027
  '2027-01-01': '元旦',
  '2027-02-04': '春節連假',
  '2027-02-05': '除夕',
  '2027-02-06': '農曆初一',
  '2027-02-07': '農曆初二',
  '2027-02-08': '農曆初三',
  '2027-02-09': '春節補假',
  '2027-02-10': '春節補假',
  '2027-02-28': '和平紀念日',
  '2027-03-01': '和平紀念日補假',
  '2027-04-04': '兒童節',
  '2027-04-05': '清明節',
  '2027-04-06': '兒童節補假',
  '2027-04-30': '勞動節補假',
  '2027-05-01': '勞動節',
  '2027-06-09': '端午節',
  '2027-09-15': '中秋節',
  '2027-09-28': '教師節',
  '2027-10-10': '國慶日',
  '2027-10-11': '國慶日補假',
  '2027-10-25': '台灣光復暨金門古寧頭大捷紀念日',
  '2027-12-24': '行憲紀念日補假',
  '2027-12-25': '行憲紀念日',
  '2027-12-31': '2028 元旦補假',
};

// 台灣今天（YYYY-MM-DD）：Render 伺服器時區不是台灣，一定要用 Asia/Taipei 算
function taiwanToday() {
  const parts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function holidayName(dateStr) {
  return HOLIDAYS[dateStr] || null;
}

// 把取餐時間字串換算成台灣日期 YYYY-MM-DD；只有時間、沒日期時視為今天
function parsePickupDate(pickupTime) {
  const todayStr = taiwanToday();
  const [y, m, d] = todayStr.split('-').map(Number);
  const base = new Date(y, m - 1, d); // 用本地日期組裝，避免時區位移
  const fmt = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const add = (n) => {
    const t = new Date(base);
    t.setDate(t.getDate() + n);
    return fmt(t);
  };
  if (!pickupTime) return todayStr;
  if (/大後天/.test(pickupTime)) return add(3);
  if (/後天/.test(pickupTime)) return add(2);
  if (/明天/.test(pickupTime)) return add(1);
  if (/今天|今日/.test(pickupTime)) return todayStr;
  const weekM = pickupTime.match(/週([一二三四五六日天])/);
  if (weekM) {
    const target = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[weekM[1]];
    const diff = (target - base.getDay() + 7) % 7;
    return add(diff);
  }
  const mdM = pickupTime.match(/(\d{1,2})\/(\d{1,2})/) || pickupTime.match(/(\d{1,2})月(\d{1,2})[日號]/);
  if (mdM) {
    const mm = parseInt(mdM[1], 10), dd = parseInt(mdM[2], 10);
    let t = new Date(y, mm - 1, dd);
    if (t < base) t = new Date(y + 1, mm - 1, dd); // 已過的日期視為明年
    return fmt(t);
  }
  return todayStr; // 只有時間（如中午 12 點）：視為今天
}

module.exports = { HOLIDAYS, taiwanToday, holidayName, parsePickupDate };
