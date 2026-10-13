// EPG 索引存储：支持两种数据源
//  - xmltv：一次性加载整份 XMLTV，按 channel id 组织
//  - diyp ：DIYP/百川接口，按「频道名 + 日期」懒加载，适合电视端小流量
import { fetchXMLTV } from './xmltvParser.js';
import { fetchDiypDay, diypDateStr } from './diyp.js';
import { getEpgCache, setEpgCache } from './storage.js';

const DAY_MS = 24 * 3600 * 1000;
const CACHE_TTL = 6 * 3600 * 1000; // 6 小时
const RETRY_DELAY = 60 * 1000; // 失败后最多冷却一分钟，由下一次查询触发重试

// 探测 EPG 类型：显式 type 优先，其次按 URL 特征
// 猜错的代价不对称：DIYP 接口的地址常常只是「主机:端口/」，看不出任何特征，
// 会落到 xmltv 分支上白拉一场。所以 _refreshXmltv 里还有一道「拉到了但一个节目
// 都没有 → 改按 diyp 再试」的兜底，别只靠这里的正则。
function detectMode(url, type) {
  if (type) return type;
  if (/(?:\?|&)ch=/.test(url)) return 'diyp';
  return 'xmltv';
}

class EpgStore {
  constructor() {
    this.mode = '';
    this.url = '';
    this.channels = new Map();
    this.programmes = new Map(); // key -> sorted [{start,stop,title,desc}]
    this.loaded = false;
    // 节目数据的版本号：每次内容真正变动就递增。
    // 给 UI 做「节目单变了没」的 O(1) 判定——否则只能逐频道取一遍 getNowNext()
    // 去比，那是 O(频道数 × 节目数)，几千个台的源上每按一下方向键都要跑一次。
    this.version = 0;
    // 每次 clear/load 都推进。异步请求完成时必须核对，旧源结果不得写回新源状态。
    this._loadId = 0;

    // diyp 懒加载状态：成功有效期与失败重试时间分开，不能把失败当作已加载。
    this.loadedDays = new Map(); // 'name|YYYY-MM-DD' -> expire
    this.retryAfter = new Map(); // 'name|YYYY-MM-DD' -> 下一次允许重试的时间
    this.pending = new Map(); // 'name|date' -> Promise（去重）
    this._forceRefresh = false;
    this.onUpdate = null; // 新数据到达回调（由上层挂 refreshVisible）
    this._updTimer = null;
  }

  clear() {
    this._loadId++;
    this.url = '';
    this.mode = '';
    this._forceRefresh = false;
    this.channels.clear();
    this.programmes.clear();
    this.loadedDays.clear();
    this.retryAfter.clear();
    this.pending.clear();
    this.loaded = false;
    this.version++;
    // 换源时把待触发的刷新一并取消，避免残留定时器对着新数据空刷一次
    if (this._updTimer) {
      clearTimeout(this._updTimer);
      this._updTimer = null;
    }
  }

  // 加载/配置 EPG 源。手动刷新用 force 跳过持久缓存，普通换源仍复用新鲜缓存。
  async load(url, type, { force = false } = {}) {
    this.clear();
    this.url = url || '';
    if (!url) return false;
    const loadId = this._loadId;
    this._forceRefresh = force;
    this.mode = detectMode(url, type);
    if (this.mode === 'diyp') {
      // 无需预载，按需拉取；标记就绪以便打开指南
      this.loaded = true;
      return true;
    }
    return this._loadXmltv(url, loadId);
  }

  // ---------- XMLTV 全量 ----------
  async _loadXmltv(url, loadId) {
    const cached = this._forceRefresh ? null : getEpgCache(url);
    if (cached && cached.expire > Date.now() && cached.data) {
      if (loadId !== this._loadId) return null;
      this._ingestRaw(cached.data);
      this._refreshXmltv(url, loadId); // 后台静默刷新
      return true;
    }
    return this._refreshXmltv(url, loadId);
  }

  async _refreshXmltv(url, loadId) {
    try {
      const { channels, programmes } = await fetchXMLTV(url);
      if (loadId !== this._loadId) return null;
      // 拿到了内容却解析不出任何节目 —— 这地址不是 XMLTV。最常见的就是 DIYP/百川
      // 接口（形如 http://host:5678/）被 detectMode 猜成了 XMLTV：M3U 头里写了
      // x-tvg-url、或用户在源里手填了接口地址，都会走到这。改按 diyp 懒加载再试，
      // 比让整个节目单空着强。
      if (!programmes.size) {
        console.warn('[EPG] 按 XMLTV 解析不出节目，改按 DIYP 接口使用:', url);
        this.mode = 'diyp';
        this.loaded = true;
        this._scheduleUpdate();
        return true;
      }
      this.channels = channels;
      this.programmes = programmes;
      this.loaded = true;
      this.version++;
      const raw = {
        channels: Array.from(channels.values()),
        programmes: Array.from(programmes.entries())
      };
      setEpgCache(url, raw, CACHE_TTL);
      this._scheduleUpdate();
      return true;
    } catch (e) {
      if (loadId !== this._loadId) return null;
      console.warn('[EPG] XMLTV 加载失败:', e && e.message);
      return this.loaded;
    }
  }

  _ingestRaw(raw) {
    const channels = new Map();
    (raw.channels || []).forEach((c) => channels.set(c.id, c));
    const programmes = new Map();
    (raw.programmes || []).forEach(([id, list]) => programmes.set(id, list));
    this.channels = channels;
    this.programmes = programmes;
    this.loaded = true;
    this.version++;
  }

  // ---------- 键解析 ----------
  _diypName(channel) {
    if (!channel) return '';
    return (channel.epgName || channel.name || '').trim();
  }

  _key(channel) {
    if (!channel) return '';
    if (this.mode === 'diyp') return this._diypName(channel);
    // xmltv：优先 tvg-id，其次频道名
    const id = channel.tvgId;
    if (id && this.programmes.has(id)) return id;
    const nm = this._diypName(channel);
    if (nm && this.programmes.has(nm)) return nm;
    return id || nm;
  }

  // ---------- diyp 懒加载 ----------
  ensure(channel, dayOffset = 0) {
    if (!this.loaded || !this.url || this.mode !== 'diyp') return;
    const name = this._diypName(channel);
    if (!name) return;
    const ds = diypDateStr(dayOffset);
    const loadKey = name + '|' + ds;
    const now = Date.now();
    if (this.pending.has(loadKey) || this.loadedDays.get(loadKey) > now || this.retryAfter.get(loadKey) > now) return;
    this.loadedDays.delete(loadKey);
    this.retryAfter.delete(loadKey);

    const loadId = this._loadId;
    const sourceUrl = this.url;
    const cacheKey = 'diyp:' + sourceUrl + ':' + loadKey;
    const cached = this._forceRefresh ? null : getEpgCache(cacheKey);
    if (cached && cached.expire > now && cached.data) {
      this._mergeDay(name, ds, cached.data);
      this.loadedDays.set(loadKey, cached.expire);
      return;
    }

    const p = fetchDiypDay(sourceUrl, name, ds)
      .then((list) => {
        if (loadId !== this._loadId || this.pending.get(loadKey) !== p) return;
        this._mergeDay(name, ds, list);
        this.loadedDays.set(loadKey, Date.now() + CACHE_TTL);
        this.retryAfter.delete(loadKey);
        setEpgCache(cacheKey, list, CACHE_TTL);
        this.pending.delete(loadKey);
        this._scheduleUpdate();
      })
      .catch(() => {
        if (loadId !== this._loadId || this.pending.get(loadKey) !== p) return;
        this.pending.delete(loadKey);
        this.retryAfter.set(loadKey, Date.now() + RETRY_DELAY);
      });
    this.pending.set(loadKey, p);
  }

  _mergeDay(name, ds, list) {
    const [y, m, d] = ds.split('-').map(Number);
    const dayStart = new Date(y, m - 1, d).getTime();
    const dayEnd = new Date(y, m - 1, d + 1).getTime();
    const cur = this.programmes.get(name) || [];
    // 整天替换（包含删除、改标题和改结束时间），保留其它天及前一天跨零点的节目。
    const byStart = new Map();
    for (const p of cur) {
      if (p.start < dayStart || p.start >= dayEnd) byStart.set(p.start, p);
    }
    for (const p of list || []) byStart.set(p.start, p);
    const next = Array.from(byStart.values()).sort((a, b) => a.start - b.start);
    if (this.programmes.has(name) && cur.length === next.length && cur.every((p, i) => {
      const n = next[i];
      return p.start === n.start && Object.is(p.stop, n.stop) && p.title === n.title && p.desc === n.desc;
    })) return; // 内容没变，不动版本号
    this.programmes.set(name, next);
    this.version++;
  }

  _scheduleUpdate() {
    if (this._updTimer) return;
    this._updTimer = setTimeout(() => {
      this._updTimer = null;
      if (this.onUpdate) this.onUpdate();
    }, 200);
  }

  // ---------- 查询 ----------
  getList(channel) {
    const key = this._key(channel);
    if (!key) return [];
    return this.programmes.get(key) || [];
  }

  // 当前/下一个节目（会触发当天懒加载）
  getNowNext(channel, at = Date.now()) {
    this.ensure(channel, 0);
    const list = this.getList(channel);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const stop = isNaN(p.stop) ? p.start + 3600000 : p.stop;
      if (at >= p.start && at < stop) {
        return { now: p, next: list[i + 1] || null };
      }
      if (at < p.start) {
        return { now: null, next: p };
      }
    }
    return { now: null, next: null };
  }

  // 某一天（dayOffset：0=今天，-1=昨天，+1=明天）的节目（会触发该天懒加载）
  getDayProgrammes(channel, dayOffset = 0) {
    this.ensure(channel, dayOffset);
    const list = this.getList(channel);
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const dayStart = base.getTime() + dayOffset * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    return list.filter((p) => p.start < dayEnd && (isNaN(p.stop) ? p.start : p.stop) > dayStart);
  }
}

export const epgStore = new EpgStore();
export { DAY_MS };
