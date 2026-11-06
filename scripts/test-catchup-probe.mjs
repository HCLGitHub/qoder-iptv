// Run: node --test scripts/test-catchup-probe.mjs
// 回看探测的过程记录（trace）和缓存时长：电视上没日志，没回看的原因全靠它们说清
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeCatchup } from '../src/core/catchup.js';
import {
  setCatchupProbe,
  getCatchupProbe,
  CATCHUP_TTL_OK,
  CATCHUP_TTL_FAIL,
  CATCHUP_TTL_RETRY
} from '../src/core/storage.js';

const LIVE = 'http://gw.test/live.m3u8';
const liveList = '#EXTM3U\n#EXTINF:2,\nlive1.ts\n#EXTINF:2,\nlive2.ts\n';
const histList = '#EXTM3U\n' + [1, 2, 3, 4, 5].map((i) => `#EXTINF:2,\nh${i}.ts\n`).join('') + '#EXT-X-ENDLIST\n';

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function fakeFetch(t, handler) {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: handler });
  t.after(() => Object.defineProperty(globalThis, 'fetch', old));
}

function fakeStorage(t) {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
      removeItem: (key) => data.delete(key)
    }
  });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, 'localStorage', old);
    else delete globalThis.localStorage;
  });
}

test('gateway with playseek archive: first preset and 7-day window recorded as ok', async (t) => {
  fakeFetch(t, async (url) => {
    const u = new URL(url);
    if (u.pathname !== '/live.m3u8') return res(404, '');
    return res(200, u.searchParams.has('playseek') ? histList : liveList);
  });
  const trace = {};
  const r = await probeCatchup(LIVE, { trace });
  assert.equal(r.catchupDays, 7);
  assert.deepEqual(trace.steps, ['0:ok', '7d:ok']);
  assert.equal(trace.transient, undefined);
  assert.equal(typeof trace.tz, 'number');
});

test('live playlist that never answers is a transient live-timeout failure', async (t) => {
  fakeFetch(t, (url, opts) =>
    new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })
  );
  const trace = {};
  const r = await probeCatchup(LIVE, { trace, timeout: 30 });
  assert.equal(r, null);
  assert.equal(trace.reason, 'live');
  assert.equal(trace.live, 'timeout');
  assert.equal(trace.transient, true);
});

test('gateway that ignores timeshift params ends as a definitive nomatch', async (t) => {
  fakeFetch(t, async (url) => (new URL(url).pathname === '/live.m3u8' ? res(200, liveList) : res(404, '')));
  const trace = {};
  const r = await probeCatchup(LIVE, { trace });
  assert.equal(r, null);
  assert.equal(trace.reason, 'nomatch');
  assert.deepEqual(trace.steps, ['0:live', '1:live', '2:live', '3:live', '4:live', '5:http 404']);
  assert.equal(trace.transient, undefined);
});

test('window probing that hits a short archive records the too-few-segments signal', async (t) => {
  const short = '#EXTM3U\n#EXTINF:2,\nold.ts\n';
  fakeFetch(t, async (url) => {
    const u = new URL(url);
    const ps = u.searchParams.get('playseek');
    if (!ps) return res(200, liveList);
    const start = ps.split('-')[0];
    const y = +start.slice(0, 4), mo = +start.slice(4, 6) - 1, d = +start.slice(6, 8);
    const h = +start.slice(8, 10), mi = +start.slice(10, 12);
    const ageH = (Date.now() - new Date(y, mo, d, h, mi).getTime()) / 3600e3;
    return res(200, ageH < 3 ? histList : short);
  });
  const trace = {};
  const r = await probeCatchup(LIVE, { trace });
  assert.equal(r.catchupDays, 2 / 24);
  assert.deepEqual(trace.steps, ['0:ok', '7d:n1', '3d:n1', '1d:n1', '6h:n1', '2h:ok']);
});

test('probe cache: transient results expire in minutes, clean ones keep their long TTL', (t) => {
  fakeStorage(t);
  assert.equal(CATCHUP_TTL_OK, 3 * 24 * 3600 * 1000, '成功的结论只留 3 天');
  const now = Date.now();
  const preset = { catchup: 'append', catchupSource: '?x', catchupDays: 7 };
  setCatchupProbe('a', null, { reason: 'live', live: 'timeout', transient: true });
  setCatchupProbe('b', null, { reason: 'nomatch' });
  setCatchupProbe('c', preset, { steps: ['0:ok', '7d:ok'] });
  setCatchupProbe('d', preset, { steps: ['0:ok', '7d:timeout'], transient: true });
  const near = (key, ttl) => assert.ok(Math.abs(getCatchupProbe(key).expire - now - ttl) < 1000, key);
  near('a', CATCHUP_TTL_RETRY);
  near('b', CATCHUP_TTL_FAIL);
  near('c', CATCHUP_TTL_OK);
  near('d', CATCHUP_TTL_RETRY);
  assert.equal(getCatchupProbe('a').diag.live, 'timeout');
});

test('dev-proxy rewritten playlists are compared by original segment paths', async (t) => {
  const wrap = (list) =>
    list.replace(/^(\w+\.ts)$/gm, (m) => '/__proxy__?u=' + encodeURIComponent('http://gw.test/' + m));
  fakeFetch(t, async (url) => {
    const u = new URL(url);
    if (u.pathname !== '/live.m3u8') return res(404, '');
    return res(200, wrap(u.searchParams.has('playseek') ? histList : liveList));
  });
  const trace = {};
  const r = await probeCatchup(LIVE, { trace });
  assert.equal(r.catchupDays, 7);
  assert.deepEqual(trace.steps, ['0:ok', '7d:ok']);
});

test('5xx from the live playlist is retried soon, 4xx is not', async (t) => {
  let status = 502;
  fakeFetch(t, async () => res(status, ''));
  const a = {};
  await probeCatchup(LIVE, { trace: a });
  assert.equal(a.live, 'http 502');
  assert.equal(a.transient, true);
  status = 403;
  const b = {};
  await probeCatchup(LIVE, { trace: b });
  assert.equal(b.live, 'http 403');
  assert.equal(b.transient, false);
});

test('udpxy multicast relays are not fetched at all', async (t) => {
  let calls = 0;
  fakeFetch(t, async () => { calls++; return res(200, ''); });
  const trace = {};
  assert.equal(await probeCatchup('http://relay.test:4022/rtp/239.1.1.1:5000', { trace }), null);
  assert.equal(trace.reason, 'mcast');
  assert.equal(calls, 0);
});

test('a raw video stream answer is rejected from headers without reading the body', async (t) => {
  let read = false;
  fakeFetch(t, async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'video/mp2t' },
    text: async () => { read = true; return ''; }
  }));
  const trace = {};
  assert.equal(await probeCatchup(LIVE, { trace }), null);
  assert.equal(trace.live, 'm3u');
  assert.equal(trace.transient, false);
  assert.equal(read, false);
});
