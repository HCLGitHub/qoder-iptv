// DIYP / 百川 EPG 接口适配：GET {base}?ch=<名称>&date=<YYYY-MM-DD>
// 返回 JSON：{ channel_name, date, epg_data:[{start:"HH:MM", end:"HH:MM", title, desc}] }
import { proxied } from './net.js';
import { t } from './i18n.js';

const DAY_MS = 24 * 3600 * 1000;

// 本地日期 -> 'YYYY-MM-DD'（dayOffset：0=今天，-1=昨天，+1=明天）
export function diypDateStr(dayOffset = 0) {
  const d = new Date(Date.now() + dayOffset * DAY_MS);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 'YYYY-MM-DD' + 'HH:MM' -> 本地时间戳（毫秒）
function toTs(dateStr, hhmm) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [H, Mi] = String(hhmm).split(':').map(Number);
  if (!y || isNaN(H)) return NaN;
  return new Date(y, (m || 1) - 1, d || 1, H || 0, Mi || 0, 0, 0).getTime();
}

// 拉取某频道某天的节目单，返回排序后的 [{ start, stop, title, desc }]
export async function fetchDiypDay(base, name, dateStr, timeoutMs = 15000) {
  if (!base || !name) return [];
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  const url = base + sep + 'ch=' + encodeURIComponent(name) + '&date=' + encodeURIComponent(dateStr);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(proxied(url), { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const day = json.date || dateStr;
    const rows = Array.isArray(json.epg_data) ? json.epg_data : [];
    const list = [];
    for (const p of rows) {
      const start = toTs(day, p.start);
      let stop = toTs(day, p.end);
      if (isNaN(start)) continue;
      // 跨零点：结束早于开始 -> 顺延到次日
      if (!isNaN(stop) && stop < start) stop += DAY_MS;
      list.push({
        start,
        stop: isNaN(stop) ? start + 3600000 : stop,
        title: (p.title || '').trim() || t('epg.unknownProgramme'),
        desc: (p.desc || '').trim()
      });
    }
    list.sort((a, b) => a.start - b.start);
    return list;
  } finally {
    clearTimeout(timer);
  }
}
