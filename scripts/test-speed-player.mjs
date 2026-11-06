// Player 回看倍速的状态机：防抖重载、续播位置、引擎失败回退、拒绝原因。
// hls.js 的挂载/加载全部打桩；引擎在假 media 原型上照常装属性垫片。
import test from 'node:test';
import assert from 'node:assert/strict';
import Hls from 'hls.js';
import { Player } from '../src/player/Player.js';
import { detectSpeed } from '../src/player/speed/engine.js';

const NONE = { length: 0, start() { return 0; }, end() { return 0; } };

class FakeMedia {
  constructor() {
    this._t = 0;
    this._d = NaN;
    this._rate = 1;
    this._drate = 1;
    this._ls = new Map();
    this.readyState = 4;
    this.paused = false;
    this.ended = false;
    this.seeking = false;
    this.error = null;
    this.muted = false;
    this.videoWidth = 0;
    this.videoHeight = 0;
  }
  addEventListener(ev, fn) {
    if (!this._ls.has(ev)) this._ls.set(ev, []);
    this._ls.get(ev).push(fn);
  }
  removeEventListener(ev, fn) {
    const a = this._ls.get(ev) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  emit(ev) {
    for (const fn of (this._ls.get(ev) || []).slice()) fn();
  }
  play() { return Promise.resolve(); }
  pause() {}
  removeAttribute() {}
  load() {}
  canPlayType() { return ''; }
}
const def = (k, get, set) => Object.defineProperty(FakeMedia.prototype, k, { configurable: true, get, set });
def('currentTime', function () { return this._t; }, function (v) { this._t = v; });
def('duration', function () { return this._d; });
def('buffered', () => NONE);
def('seekable', () => NONE);
def('playbackRate', function () { return this._rate; }, function (v) { this._rate = v; });
def('defaultPlaybackRate', function () { return this._drate; }, function (v) { this._drate = v; });

const CH = { name: 'Test', url: 'https://example.test/live.m3u8' };
const PROG = { title: 'P', start: 0, stop: 3600 * 1000 };
const CU = 'https://example.test/catchup.m3u8';

function globals(t) {
  for (const name of ['self', 'window']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: globalThis });
    t.after(() => (old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]));
  }
  for (const [name, val] of [['MediaSource', class FakeMS {}], ['HTMLMediaElement', FakeMedia]]) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: val });
    t.after(() => (old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]));
  }
}

async function setup(t) {
  t.mock.method(console, 'log', () => {});
  globals(t);
  const calls = { attachMS: [], start: [], recover: 0 };
  t.mock.method(Hls, 'isSupported', () => true);
  t.mock.method(Hls.prototype, 'attachMedia', function () { calls.attachMS.push(globalThis.MediaSource); });
  t.mock.method(Hls.prototype, 'loadSource', function () {});
  t.mock.method(Hls.prototype, 'startLoad', function (p) { calls.start.push(p); });
  t.mock.method(Hls.prototype, 'recoverMediaError', function () { calls.recover++; });
  const on = Hls.prototype.on;
  // hls.js 内部控制器注册时都带 context，Player 的不带：只记 Player 的
  t.mock.method(Hls.prototype, 'on', function (ev, fn, ctx) {
    if (ctx === undefined) {
      if (!this.__h) this.__h = new Map();
      if (!this.__h.has(ev)) this.__h.set(ev, []);
      this.__h.get(ev).push(fn);
    }
    return on.call(this, ev, fn, ctx);
  });
  const video = new FakeMedia();
  const player = new Player(video);
  await detectSpeed(); // 构造里那次探测先落地，再覆盖成「本机能用」
  player._speedCap = { ok: true, path: 'webcodecs' };
  const fails = [];
  player.onRateFail = (r) => fails.push(r);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => player.stop());
  return { player, video, calls, fails };
}

function fire(hls, ev, data) {
  for (const fn of (hls.__h && hls.__h.get(ev)) || []) fn(ev, data);
}

// 换到某档并等防抖走完；模拟新 MediaSource 起步时真实时间归零
function toRate(t, player, video, r) {
  player.setRate(r);
  t.mock.timers.tick(600);
  video._t = 0;
}

test('回看换档：停手 600ms 才按新倍率重建一次，续播位置交给 startLoad', async (t) => {
  const { player, video, calls } = await setup(t);
  player.playCatchup(CH, PROG, CU);
  const h1 = player.hls;
  assert.ok(h1);
  assert.equal(player.engine, null);
  fire(h1, Hls.Events.MANIFEST_PARSED);
  assert.deepEqual(calls.start, [-1]);

  video._t = 120;
  assert.equal(player.setRate(1.25), 1.25);
  assert.equal(player.setRate(1.5), 1.5);
  assert.equal(player.rateSettling(), true);
  t.mock.timers.tick(599);
  assert.equal(player.hls, h1, '防抖期内不重载');
  t.mock.timers.tick(1);
  const h2 = player.hls;
  assert.notEqual(h2, h1);
  assert.equal(player.engine.S, 1.5);
  assert.equal(calls.attachMS.at(-1), player.engine.MediaSourceClass, 'attachMedia 那一下用倍速 MediaSource');
  assert.notEqual(globalThis.MediaSource, player.engine.MediaSourceClass, '挂完立刻换回原生类');

  video._t = 0; // 新 MediaSource 还没 seek 到续播点
  assert.equal(player.position(), 120, '起播前用待续位置，不读 currentTime');
  fire(h2, Hls.Events.MANIFEST_PARSED);
  assert.equal(calls.start.at(-1), 120);
  assert.equal(h1.config.startOnSegmentBoundary, true);
  assert.equal(h2.config.startOnSegmentBoundary, false, '续播点不能被退回片头');
  assert.equal(player.rateSettling(), true);
  video.emit('playing');
  assert.equal(player.rateSettling(), false);
  video._t = 100;
  assert.equal(video.currentTime, 150, '垫片后 currentTime 是内容时间');
  assert.equal(player.position(), 150);
});

test('回到 1× 同样重建实例，引擎拆掉后 video 露出原生属性', async (t) => {
  const { player, video } = await setup(t);
  player.playCatchup(CH, PROG, CU);
  toRate(t, player, video, 2);
  assert.ok(player.engine);
  assert.ok(Object.prototype.hasOwnProperty.call(video, 'currentTime'));
  video.emit('playing');
  video._t = 30;
  toRate(t, player, video, 1);
  assert.equal(player.engine, null);
  assert.equal(Object.prototype.hasOwnProperty.call(video, 'currentTime'), false);
  assert.equal(player.position(), 60, '按 2× 时的内容位置续播');
  assert.equal(player.rateSettling(), true);
  const h = player.hls;
  fire(h, Hls.Events.MANIFEST_PARSED);
  player.playLive(CH);
  assert.notEqual(player.hls, h, '续播实例改过起播配置，回直播必须重建');
  assert.equal(player.hls.config.startOnSegmentBoundary, true);
});

test('引擎失败：回 1×、报原因、从原内容位置重播，本节目不再尝试；换节目恢复', async (t) => {
  const { player, video, fails } = await setup(t);
  player.playCatchup(CH, PROG, CU);
  toRate(t, player, video, 1.5);
  video.emit('playing');
  video._t = 40;
  const eng = player.engine;
  eng.fail('audio-codec');
  assert.equal(player.engine, eng, '失败回调异步，不在 hls.js 调用栈里销毁');
  t.mock.timers.tick(0);
  assert.deepEqual(fails, ['audio-codec']);
  assert.equal(player.rate, 1);
  assert.equal(player.engine, null);
  assert.equal(player.position(), 60);
  assert.equal(player.speedBlocked(), 'audio-codec');
  assert.equal(player.setRate(2), 1);
  assert.deepEqual(fails, ['audio-codec', 'audio-codec']);
  t.mock.timers.tick(600);
  assert.equal(player.engine, null, '被拒的换档不能排重载');

  player.playCatchup(CH, { ...PROG, title: 'Q' }, CU);
  assert.equal(player.speedBlocked(), '');
  assert.equal(player.setRate(2), 2);
});

test('倍速时的解码错误、直播清单、无视频轨都交给引擎回退，不走恢复/原生回退', async (t) => {
  const { player, video, calls, fails } = await setup(t);
  const fresh = () => {
    player.playCatchup(CH, PROG, CU);
    toRate(t, player, video, 1.5);
    return player.engine;
  };

  let eng = fresh();
  fire(player.hls, Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR, details: 'bufferStalledError' });
  assert.equal(eng.failed, 'media');
  assert.equal(calls.recover, 0);
  t.mock.timers.tick(0);

  eng = fresh();
  video.error = { code: 3 };
  video.emit('error');
  video.error = null;
  assert.equal(eng.failed, 'media');
  assert.equal(player.activePath(), 'hls', '没有改走原生');
  t.mock.timers.tick(0);

  eng = fresh();
  fire(player.hls, Hls.Events.LEVEL_LOADED, { details: { live: true, fragments: [] } });
  assert.equal(eng.failed, 'live');
  t.mock.timers.tick(0);

  eng = fresh();
  fire(player.hls, Hls.Events.BUFFER_CREATED, { tracks: { audio: {} } });
  assert.equal(eng.failed, 'no-video');
  t.mock.timers.tick(0);

  assert.deepEqual(fails, ['media', 'media', 'live', 'no-video']);
});

test('不能倍速的场合直接拒绝并给原因；1× 永远放行', async (t) => {
  const { player, fails } = await setup(t);
  player.playLive(CH);
  assert.equal(player.setRate(2), 1);
  assert.equal(player.speedBlocked(), 'live');

  player.playCatchup(CH, PROG, CU);
  player._activePath = 'native';
  assert.equal(player.setRate(2), 1);
  player._activePath = 'hls';
  player._speedCap = { ok: false, reason: 'no-webaudio' };
  assert.equal(player.setRate(2), 1);
  player._speedCap = null;
  assert.equal(player.setRate(2), 1);
  assert.deepEqual(fails, ['native', 'no-webaudio', 'detect']);
  assert.equal(player.setRate(1), 1);
  assert.equal(fails.length, 3);
});

test('倍速中回退原生：拆引擎并回 1×；停止时取消待执行的换档', async (t) => {
  const { player, video, fails } = await setup(t);
  player.playCatchup(CH, PROG, CU);
  toRate(t, player, video, 1.5);
  assert.ok(player.engine);
  player._fallbackToNative('hevc');
  assert.equal(player.engine, null);
  assert.equal(player.rate, 1);
  assert.deepEqual(fails, ['native']);
  assert.equal(Object.prototype.hasOwnProperty.call(video, 'currentTime'), false);

  player.playCatchup(CH, PROG, CU);
  player.setRate(2);
  player.stop();
  t.mock.timers.tick(600);
  assert.equal(player.hls, null);
  assert.equal(player.rate, 1);
});

test('直播换台不受影响：同实例复用，不建引擎', async (t) => {
  const { player } = await setup(t);
  player.playLive(CH);
  const h = player.hls;
  player.playLive({ name: 'B', url: 'https://example.test/b.m3u8' });
  assert.equal(player.hls, h);
  assert.equal(player.engine, null);
});
