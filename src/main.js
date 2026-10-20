// 应用入口：初始化各模块、加载源、全局遥控分发
import { KEY, digitOf } from './core/keys.js';
import { fetchM3U, applyActiveSource, renumberChannels, groupChannels } from './core/m3uParser.js';
import { epgStore } from './core/epgStore.js';
import { buildCatchupUrl, probeCatchup } from './core/catchup.js';
import {
  getSources,
  saveSources,
  getActiveSourceId,
  setActiveSourceId,
  getSettings,
  saveSettings,
  toggleFavorite,
  getLastChannelKey,
  setLastChannelKey,
  getCatchupProbe,
  setCatchupProbe
} from './core/storage.js';
import { esc } from './core/util.js';
import { t, setLang, getLang, groupLabel } from './core/i18n.js';
import { Player } from './player/Player.js';
import { Osd } from './player/osd.js';
import { StatusBar } from './ui/StatusBar.js';
import { ChannelMenu } from './ui/ChannelMenu.js';
import { EpgGuide } from './ui/EpgGuide.js';
import { Settings } from './ui/Settings.js';
import { SourceManager } from './ui/SourceManager.js';
import { GroupManager } from './ui/GroupManager.js';
import { PlayerTuning } from './ui/PlayerTuning.js';
import { DeviceInfo } from './ui/DeviceInfo.js';
import { CatchupBar } from './ui/CatchupBar.js';
import { NetSpeed } from './ui/NetSpeed.js';

const $ = (id) => document.getElementById(id);

const app = {
  channels: [], // 扁平频道列表（按 index 排序，已应用分组隐藏过滤）
  allChannels: [], // 隐藏过滤前的全量频道，改分组可见性时即时重新过滤，无需重拉源
  allGroups: [], // [{ name, count }] 隐藏前的全部分组，供分组管理面板列出
  current: null, // 当前频道
  source: null, // 当前源
  settings: getSettings(),
  numBuffer: '',
  numTimer: null
};

// 源切换可能并发：慢请求晚到时不得覆盖用户后来选择的源。
let sourceLoadId = 0;

// ---- 组件实例 ----
const player = new Player($('video'));
const osd = new Osd($('osd'));
const statusBar = new StatusBar($('status-bar'));
const channelMenu = new ChannelMenu($('channel-menu'));
const epgGuide = new EpgGuide($('epg-guide'));
const settings = new Settings($('settings'));
const sourceManager = new SourceManager($('source-manager'));
const groupManager = new GroupManager($('group-manager'));
const playerTuning = new PlayerTuning($('player-tuning'));
const deviceInfo = new DeviceInfo($('device-info'));
const catchupBar = new CatchupBar($('catchup-bar'), player);
const netSpeed = new NetSpeed($('net-speed'), player);

// ---- 通用 UI ----
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}
function loading(show) {
  $('loading').classList.toggle('hidden', !show);
}

// ---- 退出确认对话框 ----
// 直播界面按返回键弹出，确认后退出到电视主界面（默认焦点在“取消”，避免误退）。
let exitDialogOpen = false;
let exitFocus = 0; // 0=取消 1=退出

function renderExitDialog() {
  $('exit-dialog').innerHTML = `
    <div class="exit-box">
      <div class="exit-title">${t('exit.title')}</div>
      <div class="exit-sub">${t('exit.sub')}</div>
      <div class="exit-btns">
        <div class="exit-btn${exitFocus === 0 ? ' focused' : ''}" data-action="cancel">${t('exit.cancel')}</div>
        <div class="exit-btn danger${exitFocus === 1 ? ' focused' : ''}" data-action="exit">${t('exit.exit')}</div>
      </div>
    </div>`;
}

function openExitDialog() {
  exitDialogOpen = true;
  exitFocus = 1;
  renderExitDialog();
  $('exit-dialog').classList.remove('hidden');
}

function closeExitDialog() {
  exitDialogOpen = false;
  $('exit-dialog').classList.add('hidden');
}

// 退出到电视主界面：优先走 webOS 系统接口，不行再退回 window.close()
function exitApp() {
  closeExitDialog();
  try {
    if (window.webOSSystem && typeof window.webOSSystem.close === 'function') {
      window.webOSSystem.close();
      return;
    }
    if (window.PalmSystem && typeof window.PalmSystem.deactivate === 'function') {
      window.PalmSystem.deactivate();
      return;
    }
  } catch (e) {}
  try { window.close(); } catch (e) {}
}

function handleExitKey(code) {
  switch (code) {
    case KEY.LEFT:
    case KEY.RIGHT:
      exitFocus = exitFocus === 0 ? 1 : 0;
      renderExitDialog();
      break;
    case KEY.OK:
      if (exitFocus === 1) exitApp();
      else closeExitDialog();
      break;
    case KEY.BACK:
      closeExitDialog();
      break;
    default:
      break;
  }
  return true; // 对话框打开时吞掉其余按键
}

// ---- 加载指示的状态机 ----
// 只在"换台起播"阶段立刻转圈；画面出来之后，播放途中的短暂缓冲抖动（waiting）
// 不再重新弹出转圈，只有持续卡顿超过 1.5 秒才显示，避免看起来"又转了一次"。
let zapStarting = false;
let zapStartAt = 0; // 本次换台的起播计时起点，出画面时算出耗时给网速角标显示
let stallTimer = null;
let startWatchdog = null; // 起播看门狗：超时仍未出画面则判定失败（hls.js 卡在 manifest 时不一定报 fatal，需应用层兼底）
let failoverCount = 0; // 本次换台已自动尝试的备用源次数
const START_TIMEOUT_MS = 12000; // 起播超时（含 hls.js 内部重试余量）

function beginLoading(preserveStart = false) {
  zapStarting = true;
  if (!preserveStart || !zapStartAt) zapStartAt = Date.now();
  clearTimeout(stallTimer);
  stallTimer = null;
  clearTimeout(startWatchdog);
  startWatchdog = setTimeout(onStartTimeout, START_TIMEOUT_MS);
  loading(true);
  netSpeed.reset(); // 换台：下载字节计数归零，网速基准同步重置
}

function endLoading() {
  zapStarting = false;
  clearTimeout(stallTimer);
  stallTimer = null;
  clearTimeout(startWatchdog);
  startWatchdog = null;
  loading(false);
}

// 起播看门狗触发：到点仍未出画面 → 先自动切备用源，源试完再报错停转圈
function onStartTimeout() {
  startWatchdog = null;
  if (tryFailover()) return;
  zapStarting = false;
  clearTimeout(stallTimer);
  stallTimer = null;
  loading(false);
  toast(t('toast.channelUnavailable'), 4000);
}

// 尝试切到同频道的下一个备用源并重试（仅直播态；全部试完返回 false）
function tryFailover() {
  const ch = app.current;
  if (player.isCatchup() || !ch || !ch.sources || ch.sources.length < 2) return false;
  if (failoverCount >= ch.sources.length - 1) return false;
  failoverCount++;
  ch.sourceIdx = (ch.sourceIdx + 1) % ch.sources.length;
  applyActiveSource(ch);
  liveStartAt = Date.now();
  beginLoading();
  player.playLive(ch, app.settings.decoder);
  schedulePrefetch();
  toast(t('toast.tryingBackup', { n: ch.sourceIdx + 1, total: ch.sources.length }), 2500);
  return true;
}

// 是否有任意浮层打开
function anyOverlayOpen() {
  return (
    channelMenu.isOpen() ||
    epgGuide.isOpen() ||
    settings.isOpen() ||
    sourceManager.isOpen() ||
    groupManager.isOpen() ||
    playerTuning.isOpen() ||
    deviceInfo.isOpen()
  );
}

// ---- 播放 ----
let liveStartAt = 0; // 本次直播起流的时刻，用于判断是否卡死需要重试

// 目标频道是否就是"当前已在加载/播放中的那一路直播流"。
// 以播放地址为准而不是频道 key：key 含分组名（如 ch:央视|CCTV10高清），
// 同一个台在不同分组下 key 并不相同，只要地址一致就是同一路流，无需重新加载。
// 也不要用 readyState/paused 判断：正在缓冲、或因自动播放策略被静音暂停时它们会失真。
function isPlayingLive(ch) {
  if (!ch || !ch.url) return false;
  if (player.isCatchup()) return false; // 回看态选同一台，应当切回直播
  const cur = player.current;
  if (!cur || cur.url !== ch.url) return false; // 尚未起流，或地址已变（换源/切备用源）
  const v = player.video;
  if (!v || v.error) return false; // 播放出错时允许重选以重试
  // 起流已超过 8 秒却仍拿不到任何数据，视为卡死，允许重选以重试
  if (v.readyState === 0 && Date.now() - liveStartAt > 8000) return false;
  return true;
}

// playLive(ch, delay)：delay>0 时先只更新 OSD/状态，延迟后才真正起流。
// 用于连按上下键快速翻台——中间台不会各自发起一次加载，只加载最终停留的那个台。
function playLive(ch, delay = 0) {
  if (!ch) return;
  clearTimeout(playLive._t);

  // 选中的就是当前正在正常播放的频道：不重新起流，只刷新 OSD，
  // 避免在频道栏点当前台造成一次无谓的重新缓冲。
  if (isPlayingLive(ch)) {
    app.current = ch;
    osd.show(ch);
    return;
  }

  app.current = ch;
  setLastChannelKey(ch.key);
  catchupBar.hide();
  osd.show(ch);

  const start = () => {
    playLive._t = null;
    failoverCount = 0; // 用户主动换台：重置备用源自动切换计数
    liveStartAt = Date.now();
    beginLoading();
    player.playLive(ch, app.settings.decoder);
    schedulePrefetch();
  };
  if (delay > 0) playLive._t = setTimeout(start, delay);
  else start();
}

function playCatchup(ch, programme) {
  const url = buildCatchupUrl(ch, programme);
  if (!url) {
    toast(t('toast.noCatchup'));
    return;
  }
  app.current = ch;
  player.playCatchup(ch, programme, url, app.settings.decoder);
  beginLoading();
  catchupBar.show(programme);
  toast(t('toast.catchup', { title: programme.title }), 3000);
}

function returnToLive() {
  if (player.isCatchup() && app.current) {
    playLive(app.current);
    toast(t('toast.backToLive'));
  }
}

// 换台只登记邻台，最新清单和分片均由连续可播余量放行。

function schedulePrefetch() {
  player.holdWarm();
  prefetchNeighbors();
}

function prefetchNeighbors() {
  const list = zapOrder();
  if (!list.length || !app.current) return;
  const idx = list.findIndex((c) => c.key === app.current.key);
  if (idx < 0) return;
  const next = list[(idx + 1) % list.length];
  const prev = list[(idx - 1 + list.length) % list.length];
  try {
    console.log('[warm] neighbours of ' + app.current.name + ': ' + next.name + ' / ' + prev.name);
  } catch (e) {}
  // Player 按登记顺序串行取最新清单，先照顾上次翻台的方向。
  const forward = lastZapDir >= 0;
  player.prefetch(forward ? next.url : prev.url);
  player.prefetch(forward ? prev.url : next.url);
}

// 上一次翻台的方向（+1 = CH+/下一个，-1 = CH-/上一个），供预热排序用
let lastZapDir = 1;

// 换台序列：按分组聚合展开，与频道菜单分组栏顺序一致
// 这样上下键会在组内依次走，走到本组最后一个再按下就进入下一组的第一个台。
// 收藏组不参与（它只是引用，避免同一个台被遍历两次）。结果按 app.channels 引用缓存。
function zapOrder() {
  if (zapOrder._src === app.channels && zapOrder._list) return zapOrder._list;
  const map = new Map();
  for (const ch of app.channels) {
    if (!map.has(ch.group)) map.set(ch.group, []);
    map.get(ch.group).push(ch);
  }
  const list = [];
  for (const arr of map.values()) list.push(...arr);
  zapOrder._src = app.channels;
  zapOrder._list = list;
  return list;
}

// 跨分组换台时短暂提示新分组名
function showGroupHint(name) {
  if (!name) return;
  const el = $('group-hint');
  el.innerHTML = `<span class="gh-label">${t('hint.group')}</span><span>${esc(groupLabel(name))}</span>`;
  el.classList.remove('hidden');
  clearTimeout(showGroupHint._t);
  showGroupHint._t = setTimeout(() => el.classList.add('hidden'), 2000);
}

// 按分组顺序换台（相对偏移）
// 连按时用 350ms 防抖：翻过的中间台不起流，只加载最终停留的频道
function switchByOffset(delta) {
  const list = zapOrder();
  if (!list.length) return;
  lastZapDir = delta >= 0 ? 1 : -1; // 记下方向，预热优先热这一侧（见 prefetchNeighbors）
  let idx = list.findIndex((c) => c.key === (app.current && app.current.key));
  if (idx < 0) idx = 0;
  idx = (idx + delta + list.length) % list.length;
  const next = list[idx];
  // 进入新分组时提示分组名
  if (!app.current || app.current.group !== next.group) showGroupHint(next.group);
  // 单次换台立即起流（零额外延迟）；仅当连按（距上次换台 <500ms）时才延迟合并，
  // 避免快速翻台时每个中间台都发起一次加载。
  const now = Date.now();
  const rapid = now - (switchByOffset._last || 0) < 500;
  switchByOffset._last = now;
  playLive(next, rapid ? 300 : 0);
}

// 切换当前频道的源（同 tvg-id 的不同源），delta=+1/-1
function switchSource(delta) {
  const ch = app.current;
  if (!ch || !ch.sources || ch.sources.length < 2) return false;
  failoverCount = 0; // 用户手动换源：重置自动切换计数
  ch.sourceIdx = (ch.sourceIdx + delta + ch.sources.length) % ch.sources.length;
  applyActiveSource(ch);
  setLastChannelKey(ch.key);
  liveStartAt = Date.now();
  beginLoading();
  player.playLive(ch, app.settings.decoder);
  osd.show(ch);
  toast(t('toast.sourceSwitch', { n: ch.sourceIdx + 1, total: ch.sources.length, label: ch.sources[ch.sourceIdx].label }));
  return true;
}

// 数字换台
function pushDigit(d) {
  app.numBuffer += String(d);
  const el = $('channel-input');
  el.textContent = app.numBuffer;
  el.classList.remove('hidden');
  clearTimeout(app.numTimer);
  app.numTimer = setTimeout(() => commitNumber(), 2000);
}
function commitNumber() {
  clearTimeout(app.numTimer);
  const n = parseInt(app.numBuffer, 10);
  app.numBuffer = '';
  $('channel-input').classList.add('hidden');
  if (!n) return;
  // 频道序号已统一从 1 连编（chno），index 与其相同，作兼容回退
  const ch =
    app.channels.find((c) => String(c.chno) === String(n)) ||
    app.channels.find((c) => c.index === n);
  if (ch) playLive(ch);
  else toast(t('toast.channelNotFound', { num: n }));
}

// ---- 加载源 ----

// 按 hiddenGroups 过滤出可见频道并重新连号（从 1 起）。
// 全隐藏会导致列表空掉，此时忽略设置以防白屏。返回的数组始终已重新编号。
function filterVisibleGroups(channels, hiddenGroups) {
  const hidden = new Set(hiddenGroups || []);
  const visible = hidden.size ? channels.filter((ch) => !hidden.has(ch.group)) : channels;
  if (hidden.size && !visible.length) {
    renumberChannels(channels);
    return channels;
  }
  renumberChannels(visible);
  return visible;
}

// 分组管理面板关闭时回调：写回并持久化 hiddenGroups，用全量即时重新过滤，免重拉源。
function applyGroupVisibility(hiddenArr) {
  const src = app.source;
  if (!src) return;
  src.hiddenGroups = hiddenArr;
  // 持久化到 sources 列表里同 id 的项（与 deadUrls 同一套路径）
  const list = getSources();
  const item = list.find((s) => s.id === src.id);
  if (item) {
    item.hiddenGroups = hiddenArr;
    saveSources(list);
  }
  const visible = filterVisibleGroups(app.allChannels, hiddenArr);
  app.channels = visible;
  statusBar.setSource(src.name, visible.length);
  statusBar.show(5000);
  // 当前台仍在可见列表里就不打断播放；被隐藏了才切到第一个可见台
  if (app.current && !visible.some((c) => c.key === app.current.key)) {
    if (visible.length) playLive(visible[0]);
  }
  toast(t('toast.groupsApplied', { n: visible.length }));
}

async function loadSource(src) {
  if (!src) return;
  const loadId = ++sourceLoadId;
  app.source = src;
  // 立即使上一个源尚未完成的 XMLTV/DIYP 请求失效，不能让旧节目单写回新源。
  epgStore.clear();
  loading(true);
  try {
    const { epgUrl, channels: parsed } = await fetchM3U(src.m3uUrl);
    if (loadId !== sourceLoadId) return;
    let channels = parsed;
    // 应用「测试」得到的失效地址过滤：去掉不可播的源，源全没了就删频道（空组自然不显示）
    if (src.deadUrls && src.deadUrls.length) {
      const dead = new Set(src.deadUrls);
      channels = channels.filter((ch) => {
        ch.sources = ch.sources.filter((s) => !dead.has(s.url));
        if (!ch.sources.length) return false;
        ch.sourceIdx = 0;
        applyActiveSource(ch);
        return true;
      });
      // 删掉频道后会缺号，重新连编
      renumberChannels(channels);
    }
    if (!channels.length) {
      toast(t('toast.noChannels'));
      loading(false);
      return;
    }
    applySourceCatchup(src, channels);
    // 记录隐藏过滤前的全量：供分组管理面板列出，也用于改可见性时即时重过滤（免重拉源）
    app.allChannels = channels;
    app.allGroups = groupChannels(channels).map((g) => ({ name: g.name, count: g.channels.length }));
    // 按源保存的隐藏分组设置，过滤出可见频道
    const visible = filterVisibleGroups(channels, src.hiddenGroups);
    app.channels = visible;
    statusBar.setSource(src.name, visible.length);

    // 加载 EPG：只使用用户手填地址或 M3U 内的 url-tvg，不自动请求第三方节目数据。
    const finalEpg = src.epgUrl || epgUrl;
    const finalEpgType = src.epgType;
    if (finalEpg) {
      epgStore.load(finalEpg, finalEpgType).then((ok) => {
        if (loadId !== sourceLoadId || ok == null) return;
        if (ok) refreshVisible();
        else toast(t('toast.epgLoadFailed'));
      });
    }

    // 自动播放上次频道或第一个
    let target = null;
    if (app.settings.autoPlayLast) {
      const lastKey = getLastChannelKey();
      target = channels.find((c) => c.key === lastKey);
    }
    target = target || channels[0];
    loading(false);
    playLive(target);
    statusBar.show(5000);
  } catch (e) {
    if (loadId !== sourceLoadId) return;
    loading(false);
    const msg = (e && e.message) || '';
    toast(t('toast.loadFailed', { msg: describeFetchError(msg, src.m3uUrl) }), 8000);
    // 拉不到频道就什么也做不了，直接把源管理器弹出来，让用户能当场改地址
    //（LG Magic Remote 没有彩色键，按不了蓝键手动打开）
    sourceManager.open();
  }
}

// 把底层的 fetch 报错翻译成能指导操作的说明。
// 网页层的 fetch 拿不到失败细节：域名不存在、证书不被信任、CORS 被拦、网络不通，
// 统统只给一句 Failed to fetch，无法区分，所以把常见原因按可能性列出来。
function describeFetchError(msg, url) {
  if (/abort/i.test(msg)) return t('err.timeout');
  if (/HTTP\s*\d/i.test(msg)) return t('err.httpRejected', { msg });
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
    const base = t('err.connBase');
    return /^https:/i.test(url || '')
      ? base + t('err.connHttps')
      : base + t('err.connOther');
  }
  return msg || t('sm.netError');
}

// 刷新当前可见组件（EPG 到达后）
function refreshVisible() {
  if (channelMenu.isOpen()) channelMenu.refreshEpg();
  if (epgGuide.isOpen()) epgGuide.refreshEpg();
  // OSD 正显示时补上刚到达的节目信息
  if (osd.isVisible() && app.current) {
    osd.show(app.current, {
      catchup: player.isCatchup(),
      programme: player.current && player.current.programme
    });
  }
}

// EPG 懒加载（DIYP 按需拉取）新数据到达时刷新界面
epgStore.onUpdate = refreshVisible;

// ---- 应用设置 ----
function applySettings(s) {
  app.settings = s;
  player.setAspect(s.aspect);
  netSpeed.setEnabled(!!s.showNetSpeed);
  document.documentElement.style.setProperty('--ui-zoom', s.fontScale || 1);
  applyLanguage();
}

// 语言变了：切换词库并重渲染当前可见的浮层/状态栏，无需重启应用
function applyLanguage() {
  const changed = setLang(app.settings.language);
  document.documentElement.lang = getLang() === 'en' ? 'en' : 'zh-CN';
  if (changed) relocalize();
}

// 语言切换后重新渲染已打开的界面（只重画可见的，其他下次打开自然是新语言）
function relocalize() {
  if (channelMenu.isOpen()) channelMenu.render();
  if (epgGuide.isOpen()) epgGuide.render();
  if (settings.isOpen()) settings.render();
  if (sourceManager.isOpen()) sourceManager.render();
  if (groupManager.isOpen()) groupManager.render();
  if (playerTuning.isOpen()) playerTuning.render();
  if (deviceInfo.isOpen()) deviceInfo.render();
  if (exitDialogOpen) renderExitDialog();
  if (statusBar.isVisible()) statusBar.show(5000);
  if (osd.isVisible() && app.current) {
    osd.show(app.current, {
      catchup: player.isCatchup(),
      programme: player.current && player.current.programme
    });
  }
}

// webOS 图形画布使用 FHD；视频解码分辨率独立于 UI 画布。
function fitScreen() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const s = Math.min(w / 1920, h / 1080) || 1;
  const x = Math.round((w - 1920 * s) / 2);
  const y = Math.round((h - 1080 * s) / 2);
  const appEl = document.getElementById('app');
  if (appEl) appEl.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
}
window.addEventListener('resize', fitScreen);
window.addEventListener('orientationchange', fitScreen);

// ---- 组件回调 ----
channelMenu.onPlayLive = playLive;
channelMenu.onPlayCatchup = playCatchup;
channelMenu.onOpenSettings = () => settings.open();
channelMenu.onProbeCatchup = probeChannelCatchup;

epgGuide.onPlayLive = playLive;
epgGuide.onPlayCatchup = playCatchup;
epgGuide.onProbeCatchup = probeChannelCatchup;

settings.onChange = (s) => applySettings(s);
settings.onRefreshEpg = () => {
  const url = (app.source && app.source.epgUrl) || epgStore.url;
  if (!url) { toast(t('toast.noEpgUrl')); return; }
  const type = (app.source && app.source.epgType) || epgStore.mode;
  toast(t('toast.refreshingEpg'));
  epgStore.load(url, type, { force: true }).then((ok) => {
    if (ok == null) return; // 已被更新的加载接管，不显示旧请求的失败提示
    toast(ok ? t('toast.epgUpdated') : t('toast.epgFailed'));
    refreshVisible();
  });
};
settings.onOpenSources = () => sourceManager.open();
settings.onOpenGroups = () => {
  if (!app.allGroups.length) {
    toast(t('toast.noGroups'));
    return;
  }
  groupManager.open(
    app.allGroups,
    (app.source && app.source.hiddenGroups) || [],
    app.source && app.source.name
  );
};

sourceManager.onUseSource = (src) => loadSource(src);

groupManager.onApply = applyGroupVisibility;

settings.onOpenTuning = () => playerTuning.open(player.activePath());
playerTuning.onWarmChange = (tuning) => player.applyWarmTuning(tuning);
playerTuning.getWarmStatus = () => player.getWarmBufferStatus();

settings.onOpenDevice = () => deviceInfo.open();

// 关闭调参面板且改过参数：hls.js 的配置只在 new Hls() 时读一次，所以必须重新起播才生效。
// 回看态不去打断（重起会丢掉当前进度），标记留着，下次起播自然会应用。
playerTuning.onApply = () => {
  player.markTuningDirty();
  if (!app.current || player.isCatchup()) return;
  toast(t('toast.tuningApplied'));
  player.stop(); // 清掉 player.current，否则 playLive 会认为「已在播这个台」而短路
  playLive(app.current);
};

player.onError = (msg) => {
  // 先尝试备用源（多源频道），源都试完再报错
  if (tryFailover()) return;
  endLoading();
  toast(msg, 4000);
};

// 分辨率/音频编码到位后补上 OSD 的画质标签
player.onMediaInfo = (info) => osd.setMediaInfo(info);
// OSD 上的「距直播延迟」标签取值（只在直播模式有值）
osd.getLatency = () => player.getLiveLatency();

// hls.js 的 playing 可以结束起播；webOS 原生 HLS 的 playing 可能只有一张静止首帧，
// 必须等媒体时间真实推进。播放途中的 waiting 仍延迟 1.5 秒显示，避免短抖动打扰。
player.onStateChange = (ev) => {
  if (ev === 'nativefallback') {
    beginLoading(true);
  } else if (ev === 'startupmoving' ||
      (ev === 'playing' && (player.activePath() !== 'native' || !zapStarting))) {
    if (zapStarting && zapStartAt) {
      const warm = player.warmStatus();
      netSpeed.setStartupMs(Date.now() - zapStartAt, warm, player.startupPhases());
    }
    endLoading();
  } else if (ev === 'waiting') {
    if (zapStarting) {
      loading(true);
    } else if (!stallTimer) {
      stallTimer = setTimeout(() => {
        stallTimer = null;
        loading(true);
      }, 1500);
    }
  }
};

$('catchup-bar').addEventListener('click', (e) => catchupBar.onClick(e));

// ---- 全局遥控分发 ----
function onKey(code, event) {
  // 退出确认对话框优先（最高）
  if (exitDialogOpen) return handleExitKey(code);

  // 浮层优先
  if (groupManager.isOpen()) return groupManager.handleKey(code);
  if (playerTuning.isOpen()) return playerTuning.handleKey(code);
  if (deviceInfo.isOpen()) return deviceInfo.handleKey(code);
  if (sourceManager.isOpen()) return sourceManager.handleKey(code, event);
  if (settings.isOpen()) return settings.handleKey(code);
  if (epgGuide.isOpen()) return epgGuide.handleKey(code);
  if (channelMenu.isOpen()) return channelMenu.handleKey(code);

  // 回看控制条：方向键调进度（其余键交回下方常规处理）
  if (player.isCatchup() && catchupBar.handleKey(code)) return true;

  // 数字键
  const d = digitOf(code);
  if (d !== null) {
    pushDigit(d);
    return true;
  }

  // 播放态按键
  switch (code) {
    case KEY.OK:
      openChannelMenu();
      break;
    case KEY.LEFT:
      // 直播态：切源，单源回退打开频道菜单（回看态左右键已由回看控制条处理）
      if (!switchSource(-1)) openChannelMenu();
      break;
    case KEY.RIGHT:
      if (!switchSource(1)) openChannelMenu();
      break;
    case KEY.UP:
    case KEY.CH_UP:
      switchByOffset(-1);
      break;
    case KEY.DOWN:
    case KEY.CH_DOWN:
      switchByOffset(1);
      break;
    case KEY.RED:
      openEpgGuide();
      break;
    case KEY.GREEN:
      settings.open();
      break;
    case KEY.YELLOW:
      toggleFav();
      break;
    case KEY.BLUE:
      sourceManager.open();
      break;
    case KEY.INFO:
      if (app.current) osd.show(app.current, { catchup: player.isCatchup(), programme: player.current && player.current.programme });
      statusBar.show(5000);
      break;
    case KEY.FF:
      if (player.isCatchup()) player.seek(30);
      break;
    case KEY.RW:
      if (player.isCatchup()) player.seek(-30);
      break;
    case KEY.STOP:
      returnToLive();
      break;
    case KEY.BACK:
      if (player.isCatchup()) returnToLive();
      else openExitDialog();
      break;
    default:
      return false;
  }
  return true;
}

function openChannelMenu() {
  if (!app.channels.length) {
    sourceManager.open();
    return;
  }
  channelMenu.open(app.channels, app.current && app.current.key);
}

function openEpgGuide() {
  if (!app.channels.length) return;
  if (!epgStore.loaded) toast(t('toast.noEpgData'));
  epgGuide.open(app.channels, app.current && app.current.key);
}

function toggleFav() {
  if (!app.current) return;
  const added = toggleFavorite(app.current.key);
  toast(added ? t('toast.faved', { name: app.current.name }) : t('toast.unfaved'));
}

// 退出对话框：鼠标点击支持（Magic Remote 指针）
$('exit-dialog').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'exit') exitApp();
  else closeExitDialog();
});

// ---- 键盘监听 ----
document.addEventListener('keydown', (e) => {
  player.userUnmute(); // 首次交互后恢复声音（浏览器自动播放策略下曾被静音）
  const handled = onKey(e.keyCode, e);
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
});
// 鼠标点击也算交互（本地浏览器预览时恢复声音）
document.addEventListener('click', () => player.userUnmute());

// ---- 鼠标基本操作 ----
const playerLayer = $('player-layer');
if (playerLayer) {
  // 单击画面：无浮层时呼出频道菜单
  playerLayer.addEventListener('click', () => {
    if (!anyOverlayOpen()) openChannelMenu();
  });
  // 双击画面：切换全屏
  playerLayer.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen && document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
  });
  // 滚轮：无浮层时上下换台
  playerLayer.addEventListener('wheel', (e) => {
    if (anyOverlayOpen()) return;
    e.preventDefault();
    switchByOffset(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  // 右键：回到直播（回看态）
  playerLayer.addEventListener('contextmenu', (e) => {
    if (player.isCatchup()) { e.preventDefault(); returnToLive(); }
  });
}

// 内置默认源：已全部取消。
//
// 原先内置的「广东联通」源指向随包打进去的 public/default.m3u，那是一条私人
// IPTV 网关地址（还带账号 token），不该随包分发；这类网关地址失效也快，内置
// 反而制造「开箱就播不了」的第一印象。现在首次启动直接弹源管理器让用户自己填。
//
// 数组留着不删：以后若要再内置源，下面 boot() 里那套「缺失就补、第一项为主源」
// 的迁移逻辑不用重写，往这里加一项就行。
const DEFAULT_SOURCES = [];

// 把源级 catchup 配置下发给未声明 catchup 的频道及其各源
function applySourceCatchup(src, channels) {
  if (!src || !src.catchup) return;
  for (const ch of channels) {
    for (const s of ch.sources || []) {
      if (!s.catchup) {
        s.catchup = src.catchup;
        s.catchupSource = src.catchupSource || '';
        s.catchupDays = src.catchupDays || 7;
      }
    }
    if (!ch.catchup) {
      ch.catchup = src.catchup;
      ch.catchupSource = src.catchupSource || '';
      ch.catchupDays = src.catchupDays || 7;
    }
  }
}

// ---- 在线源回看能力自动探测 ----
// 在线源（用户自己填的 m3u）几乎都不写 catchup 属性，源管理里也没这个字段，
// 于是 isCatchupAvailable() 第一道就把回看按钮全挡掉了，只有内置源能回看。
// 这里的做法：用户展开节目单时静默试一次时移地址，真取到历史分片才认。
// 时移能力是网关级的（同网关下频道要么都行要么都不行），所以按「源id::host」
// 缓存并整批套用到该网关的所有频道，一次探测全源受益，不必每个台都探。
const probingCatchup = new Set();
// 同一个源里不同频道可能落在不同网关节点上，每个节点都要各探一次；
// 提示只在该源第一次探到时弹，免得换几个台就弹一遍
const catchupNotified = new Set();

function hostOf(url) {
  try {
    return new URL(url, location.href).host;
  } catch (e) {
    return '';
  }
}

// 把探测到的模板补进同网关的频道及其备用源，返回新打上标记的频道数
function applyProbedCatchup(host, preset) {
  const days = preset.catchupDays || 7;
  let n = 0;
  for (const ch of app.allChannels || []) {
    let hit = false;
    for (const s of ch.sources || []) {
      if (hostOf(s.url) !== host) continue;
      hit = true;
      if (s.catchup) continue;
      s.catchup = preset.catchup;
      s.catchupSource = preset.catchupSource;
      s.catchupDays = days;
    }
    if (!ch.catchup && (hit || hostOf(ch.url) === host)) {
      ch.catchup = preset.catchup;
      ch.catchupSource = preset.catchupSource;
      ch.catchupDays = days;
      n++;
    }
  }
  return n;
}

async function probeChannelCatchup(ch) {
  const url = ch && ch.url;
  const host = hostOf(url);
  if (!host) return;
  const srcId = (app.source && app.source.id) || '?';
  const key = srcId + '::' + host;
  if (probingCatchup.has(key)) return;

  // 已探过：直接套缓存结果。只有真改了东西才刷新，否则 refreshEpg -> render ->
  // 又回调到这里，会绕成死循环。
  const cached = getCatchupProbe(key);
  if (cached) {
    if (cached.result && applyProbedCatchup(host, cached.result)) channelMenu.refreshEpg();
    return;
  }

  probingCatchup.add(key);
  try {
    const found = await probeCatchup(url);
    setCatchupProbe(key, found);
    if (found && applyProbedCatchup(host, found)) {
      if (!catchupNotified.has(srcId)) {
        catchupNotified.add(srcId);
        const days = found.catchupDays || 7;
        const span =
          days >= 1
            ? t('unit.days', { n: Math.round(days) })
            : t('unit.hours', { n: Math.max(1, Math.round(days * 24)) });
        toast(t('toast.catchupDetected', { span }), 3000);
      }
      channelMenu.refreshEpg();
      if (epgGuide.isOpen()) epgGuide.render();
    }
  } catch (e) {
    // 探测纯属加分项，失败就当不支持，绝不影响正常看直播
  } finally {
    probingCatchup.delete(key);
  }
}

// ---- 启动 ----
function boot() {
  fitScreen();
  applySettings(app.settings);
  let sources = getSources();
  let changed = false;

  // 迁移：移除历史内置源（旧版「联通 IPTV」远程源、「央视/卫视自动更新」、已下线的央视/卫视三组，
  // 以及两代广东电信直连源——网关地址失效快，不再内置）。
  // default-gd（广东联通）也在其中：它指向 ./default.m3u，而这个文件已不再随包
  // 分发，留在列表里只会在启动时 404，还不如干脆清掉让用户重新填源。
  const REMOVED_IDS = [
    'default-liantong',
    'cctv-auto',
    'cctv-public',
    'cctv-online',
    'cctv-fmm-ipv6',
    'gd-dx-hls',
    'gd-dx-local',
    'default-gd'
  ];
  const kept = sources.filter((s) => !REMOVED_IDS.includes(s.id));
  if (kept.length !== sources.length) {
    sources = kept;
    changed = true;
  }

  // 迁移：内置源改名后，同步已保存的旧名称（用户自己改过名的不动——这里只对内置 id 生效）
  for (const b of DEFAULT_SOURCES) {
    const s = sources.find((x) => x.id === b.id);
    if (s && s.name !== b.name) {
      s.name = b.name;
      changed = true;
    }
  }

  // 内置源缺失（首次安装或旧版升级）：补进来。第一项算主源，置顶并设为当前源；
  // 其余追加到末尾，不动当前活跃源。DEFAULT_SOURCES 现在是空的，这段不会执行。
  DEFAULT_SOURCES.forEach((b, i) => {
    if (sources.some((s) => s.id === b.id)) return;
    if (i === 0) {
      sources.unshift({ ...b });
      setActiveSourceId(b.id);
    } else {
      sources.push({ ...b });
    }
    changed = true;
  });
  if (changed) saveSources(sources);

  const activeId = getActiveSourceId();
  const src = sources.find((s) => s.id === activeId) || sources[0];
  // 活跃源被清理掉了：把落点回写，避免源管理里「使用中」标记错位
  if (src && src.id !== activeId) setActiveSourceId(src.id);
  const tip = $('empty-tip');
  if (tip) tip.remove();

  // 一个源都没有（首次安装，或旧内置源刚被迁移清掉）：直接把源管理器弹出来。
  // 不这么做的话用户面对的是纯黑屏，连个能按的东西都没有。
  if (!src) {
    sourceManager.open();
    toast(t('toast.addSourceFirst'), 5000);
    return;
  }
  loadSource(src);
}

// 源添加成功后移除欢迎提示
const origUse = sourceManager.onUseSource;
sourceManager.onUseSource = (src) => {
  const tip = $('empty-tip');
  if (tip) tip.remove();
  origUse(src);
};

// 应用运行中改了电视系统语言：选择「跟随系统」时即时切换
document.addEventListener('webOSLocaleChange', applyLanguage);
window.addEventListener('languagechange', applyLanguage);

// 网络状态变化：断网给提示；恢复后自动重连当前频道（挖后台、路由重启等导致的断流常见）
let wasOffline = false;
window.addEventListener('offline', () => {
  wasOffline = true;
  toast(t('toast.offline'), 3000);
  if (statusBar.isVisible()) statusBar.show(3000);
});
window.addEventListener('online', () => {
  if (statusBar.isVisible()) statusBar.show(3000);
  if (!wasOffline) return;
  wasOffline = false;
  toast(t('toast.online'), 2000);
  // 有频道就强制重连当前台（绕开 isPlayingLive 去重，确保重新起流）；
  // 一个都没有（源当初就没拉到）则整源重载。
  if (app.channels.length && app.current) {
    liveStartAt = Date.now();
    beginLoading();
    player.playLive(app.current, app.settings.decoder);
    schedulePrefetch();
  } else if (app.source) {
    loadSource(app.source);
  }
});
boot();
if (window.__bootDone) window.__bootDone();
