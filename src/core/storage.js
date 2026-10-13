// localStorage 持久化封装：源列表、收藏、设置、上次频道、EPG 缓存
const NS = 'iptv:';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

// 清理 EPG 缓存项（expiredOnly=true 只清过期的），返回清除条数。
// DIYP 模式下每「频道×日期」一个 key，长期累积容易顶满配额，靠这里腾空间。
function pruneEpgCache(expiredOnly = true) {
  let n = 0;
  try {
    const now = Date.now();
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(NS + 'epg:')) continue;
      if (expiredOnly) {
        let keep = false;
        try {
          const v = JSON.parse(localStorage.getItem(k));
          keep = !!(v && v.expire > now);
        } catch (e) {}
        if (keep) continue;
      }
      localStorage.removeItem(k);
      n++;
    }
  } catch (e) {}
  return n;
}

function write(key, value) {
  const raw = JSON.stringify(value);
  try {
    localStorage.setItem(NS + key, raw);
    return true;
  } catch (e) {
    // 写满了：先清过期 EPG 缓存，不够再清全部 EPG 缓存（可重拉），
    // 保住源列表/收藏/隐藏分组等用户数据能写进去，不再静默丢弃。
    for (const expiredOnly of [true, false]) {
      if (!pruneEpgCache(expiredOnly)) continue;
      try {
        localStorage.setItem(NS + key, raw);
        return true;
      } catch (e2) {}
    }
    if (!key.startsWith('epg:')) console.warn('[storage] 写入失败（存储已满）:', key);
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(NS + key);
  } catch (e) {}
}

// ---- 直播源（M3U）列表 ----
// source: { id, name, m3uUrl, epgUrl }
export function getSources() {
  return read('sources', []);
}
export function saveSources(list) {
  write('sources', list);
}
export function getActiveSourceId() {
  return read('activeSource', null);
}
export function setActiveSourceId(id) {
  write('activeSource', id);
}

// ---- 设置 ----
const DEFAULT_SETTINGS = {
  aspect: '16:9', // 16:9 | 4:3 | fill
  // 默认自动：普通频道用 hls.js（真机实测比电视原生 HLS 管线更流畅），
  // 4K/HEVC 频道自动改用原生硬件解码（MSE 不支持 HEVC）
  decoder: 'auto', // auto | native | hls
  autoPlayLast: true,
  showNetSpeed: false, // 右下角显示当前频道的加载网速
  fontScale: 1,
  language: 'auto', // auto | zh | en
  languageVersion: 2
};
export function getSettings() {
  const raw = read('settings', {});
  const s = { ...DEFAULT_SETTINGS, ...raw };
  // 旧版每次保存设置都会连同默认值 language:'zh' 一起写入，无法区分是否手动选择；
  // 迁移一次为跟随系统，之后保存会带上新版本号，用户再手动选中文也不会被改回。
  if (raw.languageVersion !== DEFAULT_SETTINGS.languageVersion) {
    if (s.language === 'zh') s.language = 'auto';
    s.languageVersion = DEFAULT_SETTINGS.languageVersion;
  }
  return s;
}
export function saveSettings(s) {
  write('settings', { ...getSettings(), ...s });
}

// ---- 收藏（按频道唯一键） ----
//
// 带内存缓存，而且是必须的：isFavorite() 在频道菜单里是**逐频道**调用的
// （_buildGroups 过滤一遍、每次 render 的签名再过一遍、建条目时又一遍）。
// 原来每调一次就是一次 localStorage.getItem + JSON.parse + 数组 includes，
// 几千个台的源上，按一下方向键就是几千次同步读盘加解析——电视的弱 CPU 上
// 这是开菜单和导航卡顿的头号来源。查询改走 Set，写入时整体失效。
let favArr = null; // 缓存的收藏数组（与持久化内容一致）
let favSet = null; // 同一份数据的查询索引
let favVer = 0; // 数据版本，供上层判断「收藏变了没」而不必逐项比对

export function getFavorites() {
  if (!favArr) favArr = read('favorites', []);
  return favArr;
}
// 收藏表的版本号。只在真正写入时递增，上层拿它做 O(1) 的变更判定。
export function favVersion() {
  return favVer;
}
export function saveFavorites(list) {
  favArr = list;
  favSet = null;
  favVer++;
  write('favorites', list);
}
export function isFavorite(key) {
  if (!favSet) favSet = new Set(getFavorites());
  return favSet.has(key);
}
export function toggleFavorite(key) {
  const list = getFavorites();
  const idx = list.indexOf(key);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(key);
  saveFavorites(list);
  return idx < 0; // true=已收藏
}

// ---- 上次观看频道 ----
export function getLastChannelKey() {
  return read('lastChannel', null);
}
export function setLastChannelKey(key) {
  write('lastChannel', key);
}

// ---- EPG 缓存 ----
export function getEpgCache(url) {
  return read('epg:' + url, null);
}
export function setEpgCache(url, data, ttlMs) {
  write('epg:' + url, { data, expire: Date.now() + ttlMs });
}
export function clearEpgCache() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(NS + 'epg:'))
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) {}
}

// ---- 回看能力探测结果缓存 ----
// 时移能力是「网关级」的：同一个网关下的频道要么都能回看，要么都不能，
// 所以 key 用「源id::网关host」而不是频道，一次探测全源受益。
// 成功缓存久一点，失败短一点（换套餐/服务端恢复都有机会重新探到）。
export const CATCHUP_TTL_OK = 7 * 24 * 3600 * 1000;
export const CATCHUP_TTL_FAIL = 6 * 3600 * 1000;

export function getCatchupProbe(key) {
  const v = read('cp:' + key, null);
  if (!v || !v.expire || v.expire < Date.now()) return null;
  return v; // { result: {catchup,catchupSource}|null, expire }
}
export function setCatchupProbe(key, result) {
  write('cp:' + key, {
    result: result || null,
    expire: Date.now() + (result ? CATCHUP_TTL_OK : CATCHUP_TTL_FAIL)
  });
}
export function clearCatchupProbe() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(NS + 'cp:'))
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) {}
}

export { read, write, remove };
