import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import Hls from 'hls.js';
import { Player } from '../src/player/Player.js';
import { NetSpeed } from '../src/ui/NetSpeed.js';
import { setLang } from '../src/core/i18n.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const ranges = (items) => ({ length: items.length, start: (i) => items[i][0], end: (i) => items[i][1] });

test('webOS graphics use supported FHD resolution independently of video decoding', async () => {
  const info = JSON.parse(await readFile(new URL('../appinfo.json', import.meta.url), 'utf8'));
  assert.equal(info.resolution, '1920x1080');
});

function fixture(t) {
  t.mock.method(console, 'log', () => {});
  const listeners = new Map();
  const video = {
    currentTime: 10,
    buffered: ranges([[10, 16]]),
    readyState: 2,
    paused: false,
    ended: false,
    seeking: false,
    playbackRate: 1,
    videoWidth: 0,
    error: null,
    muted: false,
    addEventListener(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit(event) { for (const fn of listeners.get(event) || []) fn(); },
    play() { return Promise.resolve(); },
    pause() { this.paused = true; },
    removeAttribute() {},
    load() {},
    canPlayType() { return ''; }
  };
  const player = new Player(video);
  player.current = { channel: { name: 'Test' }, url: 'https://example.test/live.m3u8' };
  player._activePath = 'hls';
  player._phase = { t0: Date.now() };
  player.hls = { config: { maxBufferLength: 30 }, destroy() {} };
  t.after(() => player.stop());
  return { player, video };
}

test('play() AbortError 不静音、不重试', async (t) => {
  const { player, video } = fixture(t);
  let calls = 0;
  video.play = () => { calls++; return Promise.reject(new DOMException('interrupted', 'AbortError')); };
  player._tryPlay();
  await flush();
  assert.equal(calls, 1);
  assert.equal(video.muted, false);
});

test('仅当前载入的自动播放权限拒绝才静音重试', async (t) => {
  const { player, video } = fixture(t);
  let calls = 0;
  video.play = () => ++calls === 1
    ? Promise.reject(new DOMException('blocked', 'NotAllowedError'))
    : Promise.resolve();
  player._tryPlay();
  await flush();
  assert.equal(calls, 2);
  assert.equal(video.muted, true);
});

test('换台、原生回退或停止后，旧 play Promise 不得重试', async (t) => {
  const { player, video } = fixture(t);
  for (const change of [
    () => { player._phase = { t0: Date.now() }; },
    () => { player._activePath = 'native'; },
    () => { player.stop(); }
  ]) {
    let reject;
    let calls = 0;
    player._activePath = 'hls';
    video.muted = false;
    video.play = () => { calls++; return new Promise((_, no) => { reject = no; }); };
    player._tryPlay();
    change();
    reject(new DOMException('late', 'NotAllowedError'));
    await flush();
    assert.equal(calls, 1);
    assert.equal(video.muted, false);
  }
});

function clock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100000 });
  return (ms) => t.mock.timers.tick(ms);
}

test('首帧停在连续缓冲首边界超过1秒，仅内移50ms一次', (t) => {
  const tick = clock(t);
  const { player, video } = fixture(t);
  player._watchStartup();
  tick(800);
  assert.equal(video.currentTime, 10);
  tick(200);
  assert.equal(video.currentTime, 10.05);
  assert.equal(player.startupStatus().nudged, true);
  assert.equal(player.startupStatus().motion, null);
  video.currentTime = 10;
  tick(2000);
  assert.equal(video.currentTime, 10, '不能反复seek');
});

test('正常起播时间推进立即结束观察，不延迟play也不校正', (t) => {
  const tick = clock(t);
  const { player, video } = fixture(t);
  let calls = 0;
  video.play = () => { calls++; return Promise.resolve(); };
  player._tryPlay();
  player._watchStartup();
  assert.equal(calls, 1);
  video.currentTime = 10.25;
  tick(200);
  assert.equal(player.startupStatus().reason, 'moving');
  assert.equal(player.startupStatus().nudged, false);
  assert.equal(player._startupTimer, null);
  tick(5000);
  assert.equal(video.currentTime, 10.25);
});

test('playing和首帧可用不冒充播放时间推进', (t) => {
  const tick = clock(t);
  const { player, video } = fixture(t);
  player._watchStartup();
  video.emit('loadeddata');
  video.emit('playing');
  tick(200);
  const status = player.startupStatus();
  assert.equal(status.data, 0);
  assert.equal(status.playing, 0);
  assert.equal(status.motion, null);
  assert.notEqual(status.reason, 'moving');
});

for (const [name, configure] of [
  ['缓冲不足', (p, v) => { v.buffered = ranges([[10, 10.4]]); }],
  ['音视频缓冲有空洞', (p, v) => { v.buffered = ranges([[9, 10.1], [10.3, 20]]); }],
  ['当前落在空洞内', (p, v) => { v.currentTime = 10.2; v.buffered = ranges([[9, 10.1], [10.3, 20]]); }],
  ['正在seeking', (p, v) => { v.seeking = true; }],
  ['尚无当前帧', (p, v) => { v.readyState = 1; }],
  ['已有后续帧交由HLS恢复', (p, v) => { v.readyState = 3; }],
  ['数据充足交由HLS恢复', (p, v) => { v.readyState = 4; }],
  ['暂停', (p, v) => { v.paused = true; }],
  ['片中间位置', (p, v) => { v.currentTime = 11; }],
  ['回看', (p) => { p.mode = 'catchup'; }],
  ['当前主片未完成', (p) => { p.hls.inFlightFragments = { main: { state: 'PARSING', frag: { start: 10 } } }; }],
  ['当前音轨未完成', (p) => { p.hls.inFlightFragments = { audio: { state: 'FRAG_LOADING', frag: { start: 9.8 } } }; }]
]) {
  test(name + '不能做首边界校正', (t) => {
    const tick = clock(t);
    const { player, video } = fixture(t);
    configure(player, video);
    const pos = video.currentTime;
    player._watchStartup();
    tick(1800);
    assert.equal(video.currentTime, pos);
    assert.equal(player.startupStatus().nudged, false);
  });
}

test('下一片的下载不阻止已有连续缓冲内的首边界校正', (t) => {
  const tick = clock(t);
  const { player, video } = fixture(t);
  player.hls.inFlightFragments = { main: { state: 'FRAG_LOADING', frag: { start: 16 } } };
  player._watchStartup();
  tick(1000);
  assert.equal(video.currentTime, 10.05);
});

test('seek跳时不当成播放，seek完成后重新计算停滞时间', (t) => {
  const tick = clock(t);
  const { player, video } = fixture(t);
  video.currentTime = 0;
  video.seeking = true;
  player._watchStartup();
  tick(2000);
  video.currentTime = 10;
  video.seeking = false;
  video.emit('seeked');
  assert.equal(player.startupStatus().motion, null);
  tick(800);
  assert.equal(video.currentTime, 10);
  tick(200);
  assert.equal(video.currentTime, 10.05);
});

test('超时观察不残留定时器，不绕过原有失败看门狗', (t) => {
  const tick = clock(t);
  const { player, video } = fixture(t);
  video.seeking = true;
  player._watchStartup();
  tick(10000);
  assert.equal(player.startupStatus().reason, 'timeout');
  assert.equal(player._startupTimer, null);
  assert.equal(video.currentTime, 10);
});

test('超过观察期限才收到首片不能启动永久空转的定时器', (t) => {
  const tick = clock(t);
  const { player } = fixture(t);
  tick(11000);
  player._watchStartup();
  assert.equal(player._startupTimer, null);
});

test('原生路径没有seekable时只能观察，不能照搬HLS边界校正', (t) => {
  const tick = clock(t);
  const { player, video } = fixture(t);
  player._activePath = 'native';
  player.hls = null;
  player._rawUrl = player.current.url;
  player._watchStartup();
  tick(2000);
  assert.equal(player.startupStatus().path, 'native');
  assert.equal(player.startupStatus().nudged, false);
  assert.equal(video.currentTime, 10);
});

test('停止或销毁后取消帧回调，迟到帧不污染新载入', (t) => {
  clock(t);
  const { player, video } = fixture(t);
  let frame;
  let cancelled;
  video.requestVideoFrameCallback = (fn) => { frame = fn; return 7; };
  video.cancelVideoFrameCallback = (id) => { cancelled = id; };
  player._watchStartup();
  player.stop();
  assert.equal(cancelled, 7);
  assert.equal(player._startupTimer, null);
  player._phase = { t0: Date.now() };
  frame();
  assert.equal(player._phase.frame, undefined);
});

test('实际帧回调与playing、播放推进分别记录', (t) => {
  const tick = clock(t);
  const { player, video } = fixture(t);
  let frame;
  video.requestVideoFrameCallback = (fn) => { frame = fn; return 7; };
  video.cancelVideoFrameCallback = () => {};
  player._watchStartup();
  tick(200);
  frame();
  assert.equal(player.startupStatus().frame, 200);
  assert.equal(player.startupStatus().playing, null);
  assert.equal(player.startupStatus().motion, null);
});

test('网速角标在尚未playing时显示起播诊断，支持中英文和清空', (t) => {
  clock(t);
  const { player } = fixture(t);
  player._watchStartup();
  const el = { innerHTML: '' };
  const badge = new NetSpeed(el, player);
  setLang('zh');
  t.after(() => setLang('zh'));
  badge._render();
  assert.match(el.innerHTML, /有帧0\.0s/);
  assert.match(el.innerHTML, /开播—/);
  assert.match(el.innerHTML, /推进—/);
  assert.match(el.innerHTML, /连续缓冲 6\.0s/);
  assert.doesNotMatch(el.innerHTML, /undefined|NaN|\{seconds\}/);
  setLang('en');
  badge._render();
  assert.match(el.innerHTML, /Data 0\.0s/);
  assert.match(el.innerHTML, /Buffered, not advancing/);
  player.stop();
  badge.reset();
  assert.doesNotMatch(el.innerHTML, /Buffered|Moving|Data/);
});

function nativeFixture(t) {
  const f = fixture(t);
  f.player.hls = null;
  f.player._activePath = 'native';
  f.player._rawUrl = f.player.current.url;
  f.video.seekable = ranges([[0, 30]]);
  return f;
}

for (const readyState of [2, 3, 4]) {
  test(`原生HLS readyState=${readyState} 有缓冲却静止也不得seek`, (t) => {
    const tick = clock(t);
    const { player, video } = nativeFixture(t);
    video.readyState = readyState;
    video.currentTime = 11;
    player._watchStartup();
    tick(5000);
    assert.equal(video.currentTime, 11);
    assert.equal(player.startupStatus().nudged, false);
    assert.equal(player.startupStatus().motion, null);
  });
}

for (const [name, configure] of [
  ['未报告buffered', (p, v) => { v.buffered = ranges([]); }],
  ['buffered查询失败', (p, v) => { Object.defineProperty(v, 'buffered', { get() { throw Error('unsupported'); } }); }],
  ['未报告seekable', (p, v) => { v.seekable = ranges([]); }],
  ['seekable查询失败', (p, v) => { Object.defineProperty(v, 'seekable', { get() { throw Error('unsupported'); } }); }],
  ['seekable不含当前位置', (p, v) => { v.seekable = ranges([[10.01, 30]]); }],
  ['定位区间有空洞', (p, v) => { v.seekable = ranges([[0, 10.02], [10.04, 30]]); }],
  ['目标后定位余量不足', (p, v) => { v.seekable = ranges([[0, 12.01]]); }],
  ['缓冲不足', (p, v) => { v.buffered = ranges([[10, 10.4]]); }],
  ['目标后缓冲余量不足', (p, v) => { v.buffered = ranges([[10, 12.01]]); }],
  ['播放头落在缓冲空洞', (p, v) => { v.buffered = ranges([[0, 9], [10.01, 30]]); }],
  ['尚无当前帧', (p, v) => { v.readyState = 1; }],
  ['暂停', (p, v) => { v.paused = true; }],
  ['正在定位', (p, v) => { v.seeking = true; }],
  ['已结束', (p, v) => { v.ended = true; }],
  ['已出错', (p, v) => { v.error = { code: 3 }; }],
  ['回看', (p) => { p.mode = 'catchup'; }],
  ['非HLS媒体', (p) => { p._rawUrl = 'https://example.test/video.mp4'; }]
]) {
  test(`原生${name}不得猜测定位`, (t) => {
    const tick = clock(t);
    const { player, video } = nativeFixture(t);
    configure(player, video);
    player._watchStartup();
    tick(2000);
    assert.equal(video.currentTime, 10);
    assert.equal(player.startupStatus().nudged, false);
  });
}

test('原生首帧晚到后仍只观察真实推进，不执行seek', (t) => {
  const tick = clock(t);
  const { player, video } = nativeFixture(t);
  video.readyState = 1;
  video.buffered = ranges([]);
  player._watchStartup();
  tick(3000);
  video.readyState = 2;
  video.buffered = ranges([[10, 16]]);
  video.emit('loadeddata');
  tick(2000);
  assert.equal(video.currentTime, 10);
  assert.equal(player.startupStatus().nudged, false);
  assert.equal(player.startupStatus().motion, null);
});

test('原生playing不冒充起播成功，时间真实推进才通知界面', (t) => {
  const tick = clock(t);
  const { player, video } = nativeFixture(t);
  const states = [];
  let plays = 0;
  player.onStateChange = state => states.push(state);
  video.play = () => { plays++; return Promise.resolve(); };
  player._watchStartup();
  player._tryPlay();
  assert.equal(plays, 1);
  video.emit('playing');
  assert.deepEqual(states, ['playing']);
  assert.equal(player.startupStatus().motion, null);
  video.currentTime = 10.2;
  tick(200);
  assert.deepEqual(states, ['playing', 'startupmoving']);
  assert.equal(player.startupStatus().reason, 'moving');
  assert.equal(player._startupTimer, null);
  tick(4000);
  assert.deepEqual(states, ['playing', 'startupmoving']);
  assert.equal(video.currentTime, 10.2);
  assert.equal(player.startupStatus().nudged, false);
});

test('原生静止时绝不写currentTime', (t) => {
  const tick = clock(t);
  const { player, video } = nativeFixture(t);
  let attempts = 0;
  Object.defineProperty(video, 'currentTime', { get: () => 10, set() { attempts++; throw Error('unsupported'); } });
  player._watchStartup();
  tick(5000);
  assert.equal(attempts, 0);
  assert.equal(player.startupStatus().nudged, false);
  assert.equal(player.startupStatus().motion, null);
});

test('原生seek跳时不算推进，完成后保持观察且不再微调', (t) => {
  const tick = clock(t);
  const { player, video } = nativeFixture(t);
  const states = [];
  player.onStateChange = state => states.push(state);
  player._watchStartup();
  tick(800);
  video.seeking = true;
  video.emit('seeking');
  video.currentTime = 12;
  tick(400);
  video.seeking = false;
  video.emit('seeked');
  tick(1000);
  assert.equal(video.currentTime, 12);
  assert.equal(player.startupStatus().motion, null);
  assert.deepEqual(states, []);
});

test('原生直接播放从load后开始观察；停止释放观察器', (t) => {
  clock(t);
  const { player, video } = fixture(t);
  const calls = [];
  player.hls.destroy = () => calls.push('destroy');
  video.removeAttribute = () => calls.push('remove');
  video.load = () => { calls.push('load'); video.currentTime = 0; video.readyState = 0; video.error = null; };
  video.play = () => { calls.push('play'); return Promise.resolve(); };
  player.playLive({ name: 'Native', url: 'https://example.test/live.m3u8' }, 'native');
  assert.deepEqual(calls, ['destroy', 'remove', 'load', 'play']);
  assert.equal(player.startupStatus().path, 'native');
  assert.equal(player.startupStatus().data, null);
  assert.equal(player.startupStatus().fallback, null);
  assert.notEqual(player._startupTimer, null);
  player.stop();
  assert.equal(player._startupTimer, null);
  assert.equal(player.startupStatus(), null);
});

test('HLS回退重置呈帧/playing/推进，取消旧帧回调并单独计算原生观察期限', (t) => {
  const tick = clock(t);
  const { player, video } = fixture(t);
  const frames = [];
  const cancelled = [];
  video.requestVideoFrameCallback = fn => { frames.push(fn); return frames.length; };
  video.cancelVideoFrameCallback = id => cancelled.push(id);
  player._watchStartup();
  video.emit('playing');
  player._phase.frame = Date.now();
  player._phase.motion = Date.now();
  tick(9000);
  player._proxiedUrl = player.current.url;
  player._rawUrl = player.current.url;
  video.load = () => { video.currentTime = 0; video.readyState = 0; video.error = null; };
  const states = [];
  player.onStateChange = state => states.push(state);
  assert.equal(player._fallbackToNative('audio'), true);
  assert.equal(player.hls, null);
  assert.ok(cancelled.includes(1));
  frames[0]();
  video.emit('playing');
  const status = player.startupStatus();
  assert.equal(status.native, 9000);
  assert.equal(status.fallback, 'audio');
  assert.equal(status.frame, null);
  assert.equal(status.playing, null);
  assert.equal(status.motion, null);
  assert.deepEqual(states, ['nativefallback']);
  tick(2000);
  assert.notEqual(player._startupTimer, null);
  tick(8000);
  assert.equal(player._startupTimer, null);
  assert.equal(player._fallbackToNative(), false);
});

test('HLS已playing后回退，原生首播前的真实错误仍报告；残余无错误事件不报', (t) => {
  clock(t);
  const { player, video } = fixture(t);
  video.emit('playing');
  player._proxiedUrl = player.current.url;
  player._rawUrl = player.current.url;
  video.load = () => { video.error = null; video.readyState = 0; };
  player._fallbackToNative('media');
  const errors = [];
  player.onError = message => errors.push(message);
  video.emit('error');
  assert.equal(errors.length, 0);
  video.error = { code: 3 };
  video.emit('error');
  assert.equal(errors.length, 1);
  assert.equal(player.startupStatus().reason, 'error');
  assert.equal(player._startupTimer, null);
});

test('原生错误与时间推进同一轮出现，不能将错误标为起播成功', (t) => {
  const tick = clock(t);
  const { player, video } = nativeFixture(t);
  player._watchStartup();
  video.currentTime = 10.2;
  video.error = { code: 3 };
  tick(200);
  assert.equal(player.startupStatus().reason, 'error');
  assert.equal(player.startupStatus().motion, null);
});

test('原生换台取消观察和帧回调，旧回调不得污染新频道', (t) => {
  clock(t);
  const { player, video } = nativeFixture(t);
  let frame;
  video.requestVideoFrameCallback = fn => { frame = fn; return 1; };
  video.cancelVideoFrameCallback = () => {};
  player._watchStartup();
  const oldFrame = frame;
  video.load = () => { video.readyState = 0; video.currentTime = 0; };
  player.playLive({ name: 'New', url: 'https://example.test/new.m3u8' }, 'native');
  oldFrame();
  assert.equal(player.startupStatus().frame, null);
  assert.equal(player.startupStatus().motion, null);
  assert.equal(player.current.channel.name, 'New');
});

test('原生诊断标明路径和回退原因，未报告缓冲不伪装成0秒', (t) => {
  clock(t);
  const { player, video } = nativeFixture(t);
  player._phase.native = Date.now();
  player._phase.fallback = 'codec';
  video.buffered = ranges([]);
  player._watchStartup();
  const el = { innerHTML: '' };
  const badge = new NetSpeed(el, player);
  setLang('zh');
  t.after(() => setLang('zh'));
  badge._render();
  assert.match(el.innerHTML, /原生 ← hls.js \(编码错误\)/);
  assert.match(el.innerHTML, /原生未报告缓冲/);
  assert.doesNotMatch(el.innerHTML, /连续缓冲 0|undefined|NaN/);
  setLang('en');
  badge._render();
  assert.match(el.innerHTML, /Native ← hls.js \(codec error\)/);
  assert.match(el.innerHTML, /Native buffer not reported/);
});

test('回退后迟到的HLS清单、档位和编码回调不得再启动或污染原生播放', (t) => {
  clock(t);
  const { player, video } = fixture(t);
  for (const name of ['self', 'window']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: globalThis });
    t.after(() => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]);
  }
  t.mock.method(Hls, 'isSupported', () => true);
  t.mock.method(Hls.prototype, 'attachMedia', () => {});
  t.mock.method(Hls.prototype, 'loadSource', () => {});
  const originalOn = Hls.prototype.on;
  const handlers = new Map();
  t.mock.method(Hls.prototype, 'on', function(event, callback, ...args) {
    handlers.set(event, callback);
    return originalOn.call(this, event, callback, ...args);
  });
  player._destroyHls();
  player.playLive({ name: 'HLS', url: 'https://example.test/live.m3u8' }, 'hls');
  const old = player.hls;
  player._fallbackToNative('media');
  let plays = 0;
  video.play = () => { plays++; return Promise.resolve(); };
  old.startLoad = () => assert.fail('已销毁的HLS不能加载');
  handlers.get(Hls.Events.MANIFEST_PARSED)();
  handlers.get(Hls.Events.LEVEL_LOADED)(null, { details: { live: true, fragments: [{}] } });
  handlers.get(Hls.Events.BUFFER_CODECS)(null, { video: { codec: 'stale' } });
  handlers.get(Hls.Events.LEVEL_SWITCHED)(null, { level: 0 });
  assert.equal(plays, 0);
  assert.equal(player._phase.manifest, undefined);
  assert.notEqual(player.mediaInfo.videoCodec, 'stale');
  assert.equal(player.activePath(), 'native');
});

test('原生回退重新启动失败看门狗，保留总耗时且清除旧waiting定时器', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const a = source.indexOf('function beginLoading(');
  const b = source.indexOf('function endLoading()', a);
  const c = source.indexOf('player.onStateChange =');
  const d = source.indexOf('\n};', c) + 3;
  const timers = new Map();
  const cleared = [];
  const shown = [];
  let id = 10;
  const context = vm.createContext({
    player: {}, zapStarting: false, zapStartAt: 1000, startWatchdog: null, stallTimer: 5,
    START_TIMEOUT_MS: 12000, onStartTimeout() {}, netSpeed: { reset() {} },
    loading: value => shown.push(value),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: timer => { cleared.push(timer); timers.delete(timer); }
  });
  vm.runInContext(source.slice(a, b) + '\n' + source.slice(c, d), context);
  context.player.onStateChange('nativefallback');
  assert.equal(context.zapStarting, true);
  assert.equal(context.zapStartAt, 1000);
  assert.ok(cleared.includes(5));
  assert.equal(timers.get(context.startWatchdog).ms, 12000);
  assert.deepEqual(shown, [true]);
});

test('原生首个playing保持起播遮罩，真实推进后才结束；HLS仍由playing结束', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const c = source.indexOf('player.onStateChange =');
  const d = source.indexOf('\n};', c) + 3;
  const shown = [];
  const startup = [];
  let path = 'native';
  const sandbox = {
    player: {
      activePath: () => path,
      warmStatus: () => ({ ok: true }),
      startupPhases: () => null
    },
    zapStarting: true,
    zapStartAt: 1000,
    stallTimer: null,
    netSpeed: { setStartupMs: (...args) => startup.push(args) },
    loading: value => shown.push(value),
    endLoading: () => { sandbox.zapStarting = false; shown.push(false); },
    setTimeout() { assert.fail('起播阶段不能启动播放中waiting防抖'); }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source.slice(c, d), context);

  context.player.onStateChange('playing');
  assert.equal(context.zapStarting, true);
  assert.deepEqual(shown, []);
  assert.equal(startup.length, 0);

  context.player.onStateChange('waiting');
  assert.deepEqual(shown, [true]);
  context.player.onStateChange('startupmoving');
  assert.equal(context.zapStarting, false);
  assert.deepEqual(shown, [true, false]);
  assert.equal(startup.length, 1);

  context.zapStarting = true;
  context.zapStartAt = 2000;
  path = 'hls';
  context.player.onStateChange('playing');
  assert.equal(context.zapStarting, false);
  assert.equal(startup.length, 2);
});
