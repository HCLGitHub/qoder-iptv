// Run: node --test scripts/test-range-load.mjs
// Isolated fetch/readers/clock: no network, Player, browser or configuration changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import Hls from 'hls.js';
import { rangeLoad, setRangeLanes } from '../src/player/rangeLoad.js';
import { makeCachedFragLoader, setSegBudget, putSeg, setPending, resetSegHits } from '../src/player/fragCache.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const hash = (buf) => createHash('sha256').update(new Uint8Array(buf)).digest('hex');
const TOTAL = 1024 * 1024 + 37;
let serial = 0;

function fixture(t) {
  let now = 100;
  let timerId = 0;
  const timers = new Map();
  const calls = [];
  const url = `https://range-${++serial}.test/segment.ts`;
  const oldSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: { performance: { now: () => now }, location: { href: url } }
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    const id = ++timerId;
    timers.set(id, { fn, at: now + ms });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => timers.delete(id));
  const f = {
    url, calls, timers,
    fetch() { throw new Error('Unexpected mock request; real network is forbidden'); },
    elapse(ms) { now += ms; },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = until;
    }
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return f.fetch(url, options, calls.length - 1);
  });
  setRangeLanes(4);
  resetSegHits();
  setSegBudget(0);
  t.after(() => {
    setRangeLanes(0);
    setSegBudget(0);
    if (oldSelf) Object.defineProperty(globalThis, 'self', oldSelf);
    else delete globalThis.self;
  });
  return f;
}

// Deliberately does not honor fetch's signal: production must cancel readers and
// discard late responses itself, rather than relying only on cooperative mocks.
function response(status, headers = {}, chunks = []) {
  const seen = { reads: 0, bodyCancels: 0, readerCancels: 0, releases: 0, arrays: 0 };
  let index = 0;
  const reader = {
    async read() {
      seen.reads++;
      if (index >= chunks.length) return { done: true };
      const chunk = chunks[index++];
      if (chunk instanceof Error) throw chunk;
      if (typeof chunk === 'function') return chunk();
      return { done: false, value: chunk };
    },
    cancel() { seen.readerCancels++; return Promise.resolve(); },
    releaseLock() { seen.releases++; }
  };
  return {
    status, headers: new Headers(headers), seen,
    body: {
      getReader: () => reader,
      cancel() { seen.bodyCancels++; return Promise.resolve(); }
    },
    arrayBuffer() { seen.arrays++; throw new Error('Unbounded arrayBuffer must not be used'); }
  };
}

function probe(total = TOTAL, chunks = [new Uint8Array(1)], headers = {}) {
  return response(206, { 'Content-Range': `bytes 0-0/${total}`, ...headers }, chunks);
}

function requested(options) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
  assert.ok(match);
  return match.slice(1).map(Number);
}

class BaseLoader {
  constructor() {
    this.stats = {
      aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 }
    };
    this.loads = [];
  }
  load(context, config, callbacks) {
    // Real Hls loaders reject a second load (including prefilled loading.start).
    assert.equal(this.stats.loading.start, 0);
    this.loads.push({ context, config, callbacks, timeout: config.timeout });
    this.stats.loading.start = self.performance.now();
    this.callbacks = callbacks;
    this.context = context;
    // Hls mutates the passed configuration when arming/rearming its timer.
    config.timeout = config.loadPolicy?.maxTimeToFirstByteMs ?? config.timeout;
  }
  abort() { this.callbacks?.onAbort?.(this.stats, this.context, null); }
  destroy() { this.abort(); this.stats = null; }
}
const CachedLoader = makeCachedFragLoader(BaseLoader);
const RealCachedLoader = makeCachedFragLoader(Hls.DefaultConfig.loader);

function mockXhr() {
  const requests = [];
  self.setTimeout = globalThis.setTimeout;
  self.clearTimeout = globalThis.clearTimeout;
  self.XMLHttpRequest = class {
    constructor() { requests.push(this); this.readyState = 0; this.aborted = false; }
    open() { this.readyState = 1; }
    setRequestHeader() {}
    send() {}
    abort() { this.aborted = true; }
  };
  return requests;
}

function assertCancellation(c, action, stats, networkDetails = null) {
  assert.deepEqual(c.events, action === 'abort'
    ? [{ name: 'onAbort', args: [stats, c.context, networkDetails] }] : []);
  if (action === 'abort') assert.equal(stats.aborted, true);
}

function loaderCase(f, config = {
  timeout: 1000,
  loadPolicy: { maxLoadTimeMs: 1000, maxTimeToFirstByteMs: 800, timeoutRetry: null, errorRetry: null }
}, Loader = CachedLoader) {
  const loader = new Loader({});
  const context = { url: f.url, responseType: 'arraybuffer' };
  const events = [];
  const callbacks = Object.fromEntries(['onSuccess', 'onError', 'onTimeout', 'onAbort', 'onProgress']
    .map((name) => [name, (...args) => events.push({ name, args })]));
  return { loader, context, config, events, callbacks, load: () => loader.load(context, config, callbacks) };
}

test('200 probe is reused as a complete one-lane result; noRange caches its origin', async (t) => {
  const f = fixture(t);
  const outer = new AbortController();
  const bytes = Uint8Array.from([5, 4, 3, 2, 1]);
  const r = response(200, { 'Content-Length': '5' }, [bytes.subarray(0, 2), bytes.subarray(2)]);
  f.fetch = () => { f.elapse(20); return r; };
  const job = rangeLoad(f.url, 1000, { maxBytes: 5, signal: outer.signal });
  assert.equal(getEventListeners(outer.signal, 'abort').length, 1);
  const result = await job.promise;
  assert.deepEqual(Object.keys(result).sort(), ['buf', 'lanes', 'ms', 'ttfb']);
  assert.deepEqual(new Uint8Array(result.buf), bytes);
  assert.equal(result.lanes, 1);
  assert.equal(result.ttfb, 20);
  assert.ok(result.ms >= result.ttfb);
  assert.equal(f.calls.length, 1);
  assert.equal(r.seen.arrays, 0);
  assert.equal(r.seen.releases, 1);
  assert.equal(f.calls[0].options.signal.aborted, false);
  assert.equal(outer.signal.aborted, false);
  assert.equal(getEventListeners(outer.signal, 'abort').length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(rangeLoad(new URL('/another.ts', f.url).href, 1000), null);
  job.abort(); // Completed success cannot be replaced by cancellation.
  assert.equal(await job.promise, result);
});

test('foreground 200 succeeds once without calling the whole-segment loader', async (t) => {
  const f = fixture(t);
  f.fetch = () => response(200, {}, [new Uint8Array([7, 8, 9])]);
  const c = loaderCase(f);
  const stats = c.loader.stats;
  c.load();
  assert.equal(c.events.length, 0);
  await flush();
  assert.equal(c.loader.loads.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].name, 'onSuccess');
  assert.equal(c.events[0].args[1], stats);
  assert.equal(c.events[0].args[2], c.context);
  assert.deepEqual(new Uint8Array(c.events[0].args[0].data), new Uint8Array([7, 8, 9]));
  assert.equal(stats.loaded, 3);
  assert.equal(stats.total, 3);
  c.loader.abort();
  c.loader.abort();
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].name, 'onSuccess');
});

test('known oversized 200 cancels without reading and preserves overCap and noRange', async (t) => {
  const f = fixture(t);
  const outer = new AbortController();
  const r = response(200, { 'Content-Length': '9000' }, [new Uint8Array(9000)]);
  f.fetch = () => r;
  assert.deepEqual(await rangeLoad(f.url, 1000, { maxBytes: 8, signal: outer.signal }).promise,
    { overCap: true, total: 9000 });
  assert.equal(r.seen.reads, 0);
  assert.equal(r.seen.bodyCancels, 1);
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(outer.signal.aborted, false);
  assert.equal(getEventListeners(outer.signal, 'abort').length, 0);
  assert.equal(rangeLoad(f.url, 1000), null);
});

for (const length of [null, '2', 'invalid']) {
  test(`200 stream cap applies with missing/lying Content-Length (${length})`, async (t) => {
    const f = fixture(t);
    const r = response(200, length === null ? {} : { 'Content-Length': length },
      [new Uint8Array(4), new Uint8Array(4), new Uint8Array(1000)]);
    f.fetch = () => r;
    assert.deepEqual(await rangeLoad(f.url, 1000, { maxBytes: 6 }).promise,
      { overCap: true, total: 8 });
    assert.equal(r.seen.reads, 2);
    assert.ok(r.seen.readerCancels > 0);
    assert.equal(r.seen.arrays, 0);
    assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(f.timers.size, 0);
  });
}

test('unknown length exactly at cap succeeds, including real ReadableStream chunks', async (t) => {
  const f = fixture(t);
  f.fetch = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
      controller.close();
    }
  }));
  const result = await rangeLoad(f.url, 1000, { maxBytes: 4 }).promise;
  assert.deepEqual(new Uint8Array(result.buf), new Uint8Array([1, 2, 3, 4]));
});

for (const total of [TOTAL, 100]) {
  test(`206 total over cap cancels before body, including small segments (${total})`, async (t) => {
    const f = fixture(t);
    const r = probe(total);
    f.fetch = () => r;
    assert.deepEqual(await rangeLoad(f.url, 1000, { maxBytes: 50 }).promise,
      { overCap: true, total });
    assert.equal(f.calls.length, 1);
    assert.equal(r.seen.reads, 0);
    assert.equal(r.seen.bodyCancels, 1);
    assert.equal(f.calls[0].options.signal.aborted, true);
  });
}

test('normal 206 assembles uneven out-of-order lanes with identical size and SHA-256', async (t) => {
  const f = fixture(t);
  const bytes = Uint8Array.from({ length: TOTAL }, (_, i) => (i * 31 + (i >>> 10)) % 251);
  const responses = [];
  const parts = [];
  const outer = new AbortController();
  f.fetch = (url, options, i) => {
    const [start, end] = requested(options);
    assert.equal(options.cache, 'no-store');
    const mid = start + Math.floor((end - start + 1) / 2);
    const r = response(206, {
      'Content-Range': `bytes ${start}-${end}/${TOTAL}`,
      'Content-Length': String(end - start + 1)
    }, [bytes.subarray(start, mid), bytes.subarray(mid, end + 1)]);
    responses.push(r);
    if (!i) return r;
    const d = deferred();
    parts.push({ d, r });
    return d.promise;
  };
  const job = rangeLoad(f.url, 1000, { maxBytes: TOTAL, signal: outer.signal });
  await flush();
  assert.equal(parts.length, 4);
  for (const p of [...parts].reverse()) { p.d.resolve(p.r); await flush(); }
  const result = await job.promise;
  assert.equal(result.buf.byteLength, TOTAL);
  assert.equal(hash(result.buf), hash(bytes));
  assert.equal(result.lanes, 4);
  assert.equal(f.calls.length, 5);
  assert.ok(responses.every((r) => r.seen.arrays === 0 && r.seen.releases === 1));
  assert.equal(getEventListeners(outer.signal, 'abort').length, 0);
  assert.equal(getEventListeners(f.calls[0].options.signal, 'abort').length, 0);
  assert.equal(f.timers.size, 0);
});

for (const cr of [null, 'garbage/1048576', 'bytes 1-1/1048576', 'bytes 0-10/1048576',
  'bytes 0-0/*', 'bytes 0-0/0', 'bytes 0-0/9007199254740993', 'bytes -1-0/1048576']) {
  test(`malformed probe Content-Range is rejected before reading (${cr})`, async (t) => {
    const f = fixture(t);
    const outer = new AbortController();
    const r = response(206, cr === null ? {} : { 'Content-Range': cr }, [new Uint8Array(4000)]);
    f.fetch = () => r;
    assert.equal(await rangeLoad(f.url, 1000, { signal: outer.signal }).promise, null);
    assert.equal(r.seen.reads, 0);
    assert.equal(r.seen.bodyCancels, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(getEventListeners(outer.signal, 'abort').length, 0);
  });
}

for (const kind of ['huge header', 'huge stream', 'empty stream']) {
  test(`206 one-byte probe is strictly bounded (${kind})`, async (t) => {
    const f = fixture(t);
    const r = probe(TOTAL, kind === 'empty stream' ? [] : [new Uint8Array(1), new Uint8Array(2000), new Uint8Array(2000)],
      kind === 'huge header' ? { 'Content-Length': '9999999999' } : {});
    f.fetch = () => r;
    assert.equal(await rangeLoad(f.url, 1000).promise, null);
    assert.equal(f.calls.length, 1);
    assert.ok(r.seen.reads <= 2);
    if (kind === 'huge header') assert.equal(r.seen.reads, 0);
    else assert.ok(r.seen.readerCancels > 0);
    assert.equal(f.calls[0].options.signal.aborted, true);
  });
}

for (const kind of ['offset', 'total', 'missing header', '200', 'short', 'long', 'length header', 'read error']) {
  test(`invalid parallel lane fails closed and cancels siblings (${kind})`, async (t) => {
    const f = fixture(t);
    const siblings = [];
    let bad;
    f.fetch = (url, options, i) => {
      if (!i) return probe();
      const [start, end] = requested(options);
      const size = end - start + 1;
      if (i === 1) {
        const headers = { 'Content-Range': `bytes ${start}-${end}/${TOTAL}` };
        if (kind === 'offset') headers['Content-Range'] = `bytes ${start + 1}-${end + 1}/${TOTAL}`;
        if (kind === 'total') headers['Content-Range'] = `bytes ${start}-${end}/${TOTAL + 1}`;
        if (kind === 'missing header') delete headers['Content-Range'];
        if (kind === 'length header') headers['Content-Length'] = String(size + 1);
        const chunks = kind === 'read error' ? [new Error('broken body')]
          : [new Uint8Array(kind === 'short' ? size - 1 : kind === 'long' ? size + 1 : size)];
        bad = response(kind === '200' ? 200 : 206, headers, chunks);
        return bad;
      }
      const r = response(206, { 'Content-Range': `bytes ${start}-${end}/${TOTAL}` },
        [() => new Promise(() => {})]);
      siblings.push(r);
      return r;
    };
    assert.equal(await rangeLoad(f.url, 1000).promise, null);
    assert.equal(f.calls.length, 5);
    assert.ok(f.calls.every((c) => c.options.signal.aborted));
    assert.ok(bad.seen.readerCancels + bad.seen.bodyCancels > 0);
    assert.ok(siblings.every((r) => r.seen.readerCancels + r.seen.bodyCancels > 0));
    if (['offset', 'total', 'missing header', '200', 'length header'].includes(kind)) assert.equal(bad.seen.reads, 0);
    assert.equal(f.timers.size, 0);
  });
}

test('network error cancels late sibling responses without consuming their bodies', async (t) => {
  const f = fixture(t);
  const late = deferred();
  f.fetch = (url, options, i) => {
    if (!i) return probe();
    if (i === 1) throw new Error('connection lost');
    return late.promise;
  };
  assert.equal(await rangeLoad(f.url, 1000).promise, null);
  const r = response(206, {}, [new Uint8Array(1000)]);
  late.resolve(r);
  await flush();
  assert.equal(r.seen.reads, 0);
  assert.equal(r.seen.bodyCancels, 3);
});

test('bounded responses without a streaming reader never use arrayBuffer', async (t) => {
  const f = fixture(t);
  const r = response(200, { 'Content-Length': '4' });
  delete r.body.getReader;
  f.fetch = () => r;
  assert.equal(await rangeLoad(f.url, 1000, { maxBytes: 4 }).promise, null);
  assert.equal(r.seen.arrays, 0);
  assert.equal(r.seen.bodyCancels, 1);
});

for (const action of ['abort', 'external abort', 'timeout']) {
  test(`${action} settles despite stalled fetch and removes external listener`, async (t) => {
    const f = fixture(t);
    const outer = new AbortController();
    const late = deferred();
    f.fetch = () => late.promise;
    const job = rangeLoad(f.url, 1000, { signal: outer.signal });
    if (action === 'abort') job.abort();
    else if (action === 'external abort') outer.abort();
    else f.advance(1000);
    assert.equal(await job.promise, null);
    assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(getEventListeners(outer.signal, 'abort').length, 0);
    assert.equal(f.timers.size, 0);
    const r = probe();
    late.resolve(r);
    await flush();
    assert.equal(r.seen.reads, 0);
    assert.equal(r.seen.bodyCancels, 1);
    assert.equal(f.calls.length, 1);
  });
}

test('abort cancels an active reader and ignores its late data', async (t) => {
  const f = fixture(t);
  const next = deferred();
  const r = response(200, {}, [() => next.promise]);
  f.fetch = () => r;
  const job = rangeLoad(f.url, 1000, { maxBytes: 20 });
  await flush();
  job.abort();
  assert.equal(await job.promise, null);
  assert.ok(r.seen.readerCancels > 0);
  next.resolve({ done: false, value: new Uint8Array(4) });
  await flush();
  assert.equal(r.seen.reads, 1);
  assert.equal(r.seen.releases, 1);
});

test('parallel failure passes only remaining budget in cloned config and loadPolicy', async (t) => {
  const f = fixture(t);
  const retry = Object.freeze({ maxNumRetry: 0, retryDelayMs: 0, maxRetryDelayMs: 0 });
  const config = Object.freeze({ timeout: 1000, maxRetry: 0, loadPolicy: Object.freeze({
    maxLoadTimeMs: 1000, maxTimeToFirstByteMs: 800, timeoutRetry: retry, errorRetry: retry
  }) });
  f.fetch = (url, options, i) => {
    if (!i) return probe();
    if (i === 1) { f.elapse(375); throw new Error('lane failed'); }
    return response(500);
  };
  const c = loaderCase(f, config);
  c.load();
  await flush();
  assert.equal(c.loader.loads.length, 1);
  assert.equal(f.calls.length, 5);
  const fallback = c.loader.loads[0];
  assert.notEqual(fallback.config, config);
  assert.notEqual(fallback.config.loadPolicy, config.loadPolicy);
  assert.equal(fallback.timeout, 625);
  assert.equal(fallback.config.loadPolicy.maxLoadTimeMs, 625);
  assert.equal(fallback.config.loadPolicy.maxTimeToFirstByteMs, 625);
  assert.equal(fallback.config.loadPolicy.errorRetry, retry);
  assert.equal(config.timeout, 1000);
  assert.equal(config.loadPolicy.maxLoadTimeMs, 1000);
  assert.equal(c.events.length, 0);
  fallback.callbacks.onSuccess({ data: new ArrayBuffer(4) }, c.loader.stats, c.context, null);
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].name, 'onSuccess');
});

for (const first of [100, 0, Infinity]) {
  test(`fallback first-byte deadline is bounded by remaining total (${first})`, async (t) => {
    const f = fixture(t);
    f.fetch = () => { f.elapse(400); return response(503); };
    const c = loaderCase(f, { timeout: 1000, loadPolicy: { maxLoadTimeMs: 1000, maxTimeToFirstByteMs: first } });
    c.load();
    await flush();
    assert.equal(c.loader.loads[0].config.loadPolicy.maxLoadTimeMs, 600);
    assert.equal(c.loader.loads[0].config.loadPolicy.maxTimeToFirstByteMs, first === 100 ? 100 : 600);
  });
}

test('legacy timeout-only config receives remaining time without modifying the original', async (t) => {
  const f = fixture(t);
  f.fetch = () => { f.elapse(250); return response(404); };
  const config = Object.freeze({ timeout: 1000, maxRetry: 0 });
  const c = loaderCase(f, config);
  c.load();
  await flush();
  assert.equal(c.loader.loads[0].config.timeout, 750);
  assert.equal(config.timeout, 1000);
});

test('real Hls XHR fallback times out at the original deadline after receiving headers', async (t) => {
  const f = fixture(t);
  let xhr;
  self.setTimeout = globalThis.setTimeout;
  self.clearTimeout = globalThis.clearTimeout;
  self.XMLHttpRequest = class {
    constructor() { xhr = this; this.readyState = 0; this.aborted = false; }
    open() { this.readyState = 1; }
    setRequestHeader() {}
    send() {}
    abort() { this.aborted = true; }
  };
  f.fetch = () => { f.elapse(375); return response(503); };
  const config = Object.freeze({ timeout: 1000, maxRetry: 0, loadPolicy: Object.freeze({
    maxLoadTimeMs: 1000, maxTimeToFirstByteMs: 100, timeoutRetry: null, errorRetry: null
  }) });
  const c = loaderCase(f, config);
  const RealCachedLoader = makeCachedFragLoader(Hls.DefaultConfig.loader);
  const loader = new RealCachedLoader({});
  const stats = loader.stats;
  loader.load(c.context, config, c.callbacks);
  await flush();
  assert.ok(xhr);
  assert.equal(stats.loading.start, 475);
  f.advance(50);
  xhr.readyState = 2;
  xhr.onreadystatechange();
  f.advance(574);
  assert.equal(c.events.length, 0);
  f.advance(1); // 375 parallel + 50 to headers + 575 body = original 1000 ms.
  assert.deepEqual(c.events, [{ name: 'onTimeout', args: [stats, c.context, xhr] }]);
  assert.equal(xhr.aborted, true);
  assert.equal(config.timeout, 1000);
  assert.equal(config.loadPolicy.maxLoadTimeMs, 1000);
  loader.abort();
  loader.destroy();
  assert.deepEqual(c.events, [{ name: 'onTimeout', args: [stats, c.context, xhr] }]);
});

for (const trigger of ['range timeout', 'late failure']) {
  test(`exhausted budget reports one correctly shaped Hls timeout, no whole request (${trigger})`, async (t) => {
    const f = fixture(t);
    const late = deferred();
    f.fetch = () => late.promise;
    const outerStats = [];
    const c = loaderCase(f);
    outerStats.push(c.loader.stats);
    c.load();
    if (trigger === 'range timeout') f.advance(1000);
    else { f.elapse(1100); late.reject(new Error('late failure')); }
    await flush();
    assert.equal(c.loader.loads.length, 0);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(c.events, [{ name: 'onTimeout', args: [outerStats[0], c.context, null] }]);
    assert.equal(outerStats[0].loading.start, 100);
    assert.equal(outerStats[0].aborted, true);
    assert.equal(f.calls[0].options.signal.aborted, true);
    c.loader.abort();
    c.loader.abort();
    late.resolve(response(200));
    f.advance(2000);
    await flush();
    assert.equal(c.events.length, 1);
    assert.equal(c.loader.loads.length, 0);
  });
}

for (const action of ['abort', 'destroy']) {
  test(`${action} prevents pending range callbacks, timeout and stale fallback`, async (t) => {
    const f = fixture(t);
    const late = deferred();
    f.fetch = () => late.promise;
    const c = loaderCase(f);
    const stats = c.loader.stats;
    c.load();
    c.loader[action]();
    assertCancellation(c, action, stats);
    c.loader.abort(); // Repeated abort, including after silent destroy.
    await flush();
    const r = probe();
    late.resolve(r);
    f.advance(2000);
    await flush();
    assertCancellation(c, action, stats);
    assert.equal(c.loader.loads.length, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(r.seen.reads, 0);
    assert.equal(r.seen.bodyCancels, 1);
    assert.equal(f.timers.size, 0);
  });

  test(`${action} suppresses even late base-loader callbacks after fallback`, async (t) => {
    const f = fixture(t);
    f.fetch = () => response(500);
    const c = loaderCase(f);
    c.load();
    await flush();
    const callbacks = c.loader.loads[0].callbacks;
    const stats = c.loader.stats;
    c.loader[action]();
    assertCancellation(c, action, stats);
    c.loader.abort();
    for (const callback of Object.values(callbacks)) callback({}, {}, c.context, null);
    c.load(); // Destroyed/aborted instance cannot be restarted by stale work.
    f.advance(2000);
    assertCancellation(c, action, stats);
    assert.equal(c.loader.loads.length, 1);
    assert.equal(f.calls.length, 1);
  });

  test(`${action} cancels queued cache hits and in-flight warm resumes`, async (t) => {
    const f = fixture(t);
    setSegBudget(100);
    putSeg(f.url, new ArrayBuffer(4), 10);
    const c = loaderCase(f);
    const stats = c.loader.stats;
    c.load();
    c.loader[action]();
    assertCancellation(c, action, stats);
    c.loader.abort();
    f.advance(0);
    assertCancellation(c, action, stats);
    const d = deferred();
    setPending(f.url, d.promise, { startedAt: Date.now() - 3000 });
    const waiting = loaderCase(f);
    const waitingStats = waiting.loader.stats;
    waiting.load();
    waiting.loader[action]();
    assertCancellation(waiting, action, waitingStats);
    waiting.loader.abort();
    d.resolve();
    await flush();
    f.advance(2000);
    assertCancellation(waiting, action, waitingStats);
    assert.equal(waiting.loader.loads.length, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.timers.size, 0);
  });
}

for (const [name, Base] of [['mock', BaseLoader], ['real Hls XHR', Hls.DefaultConfig.loader]]) {
  const Loader = makeCachedFragLoader(Base);

  for (const path of ['direct', 'fallback']) {
    test(`${name} ${path} abort notifies once after cleanup despite synchronous destroy/reentry`, async (t) => {
      const f = fixture(t);
      const requests = mockXhr();
      if (path === 'direct') setRangeLanes(0);
      else f.fetch = () => response(503);
      let baseCleanups = 0;
      const baseAbort = Base.prototype.abort;
      t.mock.method(Base.prototype, 'abort', function () {
        baseAbort.call(this);
        baseCleanups++;
      });
      const c = loaderCase(f, undefined, Loader);
      const stats = c.loader.stats;
      const onAbort = c.callbacks.onAbort;
      c.callbacks.onAbort = (...args) => {
        assert.equal(baseCleanups, 1); // Not inside super.abort's callback.
        assert.equal(stats.aborted, true);
        assert.equal(f.timers.size, 0);
        if (requests.length) assert.equal(requests[0].aborted, true);
        onAbort(...args);
        c.loader.abort();
        c.loader.destroy(); // FragmentLoader.resetLoader does this synchronously.
        c.load();
      };
      c.load();
      await flush();
      const lateCallbacks = c.loader.callbacks;
      assert.equal(c.loader.context, c.context);
      c.loader.abort();
      c.loader.abort();
      for (const callback of Object.values(lateCallbacks)) callback({}, {}, c.context, null);
      f.advance(2000);
      assertCancellation(c, 'abort', stats, requests[0] || null);
      assert.equal(f.calls.length, path === 'direct' ? 0 : 1);
      assert.equal(requests.length, Base === BaseLoader ? 0 : 1);
      if (Base === BaseLoader) assert.equal(c.loader.loads.length, 1);
    });
  }

  test(`${name} destroy is silent even when followed by abort and late callbacks`, (t) => {
    const f = fixture(t);
    const requests = mockXhr();
    setRangeLanes(0);
    const c = loaderCase(f, undefined, Loader);
    c.load();
    const lateCallbacks = c.loader.callbacks;
    c.loader.destroy();
    c.loader.abort();
    c.load();
    for (const callback of Object.values(lateCallbacks)) callback({}, {}, c.context, null);
    f.advance(2000);
    assert.deepEqual(c.events, []);
    assert.equal(f.timers.size, 0);
    assert.equal(f.calls.length, 0);
    if (requests.length) assert.equal(requests[0].aborted, true);
  });

  for (const terminal of ['onSuccess', 'onError', 'onTimeout', 'onAbort']) {
    test(`${name} ${terminal} is terminal before callback abort/destroy/reentry`, (t) => {
      const f = fixture(t);
      const requests = mockXhr();
      setRangeLanes(0);
      const c = loaderCase(f, undefined, Loader);
      const stats = c.loader.stats;
      const original = c.callbacks[terminal];
      c.callbacks[terminal] = (...args) => {
        original(...args);
        c.load(); // Must not reset terminal state or call the one-shot base again.
        c.loader.abort();
        c.loader.destroy();
      };
      c.load();
      const lateCallbacks = c.loader.callbacks;
      const xhr = requests[0];
      const data = new ArrayBuffer(4);
      lateCallbacks.onProgress(stats, c.context, data, xhr || null);
      assert.equal(c.events.length, 1); // Progress itself is not terminal.
      let args;
      if (terminal === 'onSuccess') {
        args = [{ url: f.url, data, code: 200 }, stats, c.context, xhr || null];
      } else if (terminal === 'onError') {
        args = [{ code: 404, text: 'Not Found' }, c.context, xhr || null, stats];
      } else {
        args = [stats, c.context, xhr || null];
      }
      if (!xhr) lateCallbacks[terminal](...args);
      else if (terminal === 'onTimeout') f.advance(800);
      else if (terminal === 'onAbort') Base.prototype.abort.call(c.loader);
      else {
        xhr.status = terminal === 'onSuccess' ? 200 : 404;
        xhr.statusText = 'Not Found';
        xhr.responseURL = f.url;
        xhr.response = data;
        xhr.readyState = 4;
        xhr.onreadystatechange();
      }
      const progressCount = xhr && terminal === 'onSuccess' ? 2 : 1;
      assert.deepEqual(c.events.slice(0, progressCount).map((e) => e.name),
        Array(progressCount).fill('onProgress'));
      assert.deepEqual(c.events.slice(progressCount), [{ name: terminal, args }]);
      c.loader.abort();
      for (const callback of Object.values(lateCallbacks)) callback({}, {}, c.context, null);
      f.advance(2000);
      assert.equal(c.events.length, progressCount + 1);
      assert.equal(f.timers.size, 0);
      assert.equal(f.calls.length, 0);
    });
  }

  for (const path of ['cache', 'range']) {
    test(`${name} ${path} success cannot emit abort during synchronous callback cleanup`, async (t) => {
      const f = fixture(t);
      const requests = mockXhr();
      const data = new Uint8Array([3, 1, 4]);
      if (path === 'cache') { setSegBudget(100); putSeg(f.url, data.buffer, 10); }
      else f.fetch = () => response(200, {}, [data]);
      const c = loaderCase(f, undefined, Loader);
      const stats = c.loader.stats;
      const success = c.callbacks.onSuccess;
      c.callbacks.onSuccess = (...args) => {
        success(...args);
        c.load();
        c.loader.abort();
        c.loader.destroy();
      };
      c.load();
      f.advance(0);
      await flush();
      c.loader.abort();
      assert.deepEqual(c.events, [{ name: 'onSuccess', args: [
        { url: f.url, data: data.buffer }, stats, c.context, null
      ] }]);
      assert.equal(requests.length, 0);
      assert.equal(f.calls.length, path === 'cache' ? 0 : 1);
      assert.equal(f.timers.size, 0);
    });
  }

  for (const resume of ['cache', 'base', 'range']) {
    test(`${name} pending resume to ${resume} keeps the original abort context and callbacks`, async (t) => {
      const f = fixture(t);
      const requests = mockXhr();
      const warm = deferred();
      setPending(f.url, warm.promise, { startedAt: Date.now() - 3000 });
      if (resume === 'base') setRangeLanes(0);
      if (resume === 'range') f.fetch = () => new Promise(() => {});
      const c = loaderCase(f, undefined, Loader);
      const stats = c.loader.stats;
      c.load();
      assert.equal(c.loader.context, c.context);
      assert.equal(c.events.length, 0);
      assert.equal(f.timers.size, 1);
      if (resume === 'cache') { setSegBudget(100); putSeg(f.url, new ArrayBuffer(4), 10); }
      warm.resolve();
      await flush(); // Internal this.load has resumed, but cache success is still queued.
      c.loader.abort();
      c.loader.abort();
      c.loader.destroy();
      c.load();
      f.advance(2000);
      await flush();
      assertCancellation(c, 'abort', stats, requests[0] || null);
      assert.equal(f.calls.length, resume === 'range' ? 1 : 0);
      if (resume === 'range') assert.equal(f.calls[0].options.signal.aborted, true);
      assert.equal(requests.length, resume === 'base' && Base !== BaseLoader ? 1 : 0);
      if (Base === BaseLoader) assert.equal(c.loader.loads.length, resume === 'base' ? 1 : 0);
      assert.equal(f.timers.size, 0);
    });
  }
}

for (const path of ['cache', 'range', 'pending']) {
  test(`real Hls XHR ${path} abort notifies once and destroy stays silent without a base request`, async (t) => {
    const f = fixture(t);
    const requests = mockXhr();
    for (const action of ['abort', 'destroy']) {
      const warm = deferred();
      if (path === 'cache') { setSegBudget(100); putSeg(f.url, new ArrayBuffer(4), 10); }
      if (path === 'range') f.fetch = () => new Promise(() => {});
      if (path === 'pending') setPending(f.url, warm.promise, { startedAt: Date.now() - 3000 });
      const c = loaderCase(f, undefined, RealCachedLoader);
      const stats = c.loader.stats;
      const onAbort = c.callbacks.onAbort;
      c.callbacks.onAbort = (...args) => {
        assert.equal(f.timers.size, 0);
        if (path === 'range') assert.ok(f.calls.every((call) => call.options.signal.aborted));
        onAbort(...args);
        c.loader.destroy();
        c.loader.abort();
        c.load();
      };
      c.load();
      c.loader[action]();
      c.loader.abort();
      warm.resolve();
      await flush();
      f.advance(2000);
      assertCancellation(c, action, stats);
      assert.equal(requests.length, 0);
      assert.equal(f.timers.size, 0);
    }
    assert.equal(f.calls.length, path === 'range' ? 2 : 0);
  });
}

for (const path of ['base', 'range', 'cache', 'pending']) {
  test(`real Hls FragmentLoader rejects the old ${path} promise when loading a new fragment`, async (t) => {
    const f = fixture(t);
    const requests = mockXhr();
    const warm = deferred();
    setSegBudget(100);
    if (path === 'base') setRangeLanes(0);
    if (path === 'range') f.fetch = () => new Promise(() => {});
    if (path === 'cache') putSeg(f.url, new ArrayBuffer(4), 10);
    if (path === 'pending') setPending(f.url, warm.promise, { startedAt: Date.now() - 3000 });
    const hls = new Hls({ fLoader: RealCachedLoader, autoStartLoad: false, enableWorker: false });
    t.after(() => hls.destroy());
    const fragmentLoader = hls.streamController.fragmentLoader;
    const frag = { url: f.url, sn: 1 };
    let outcome;
    const oldPromise = fragmentLoader.load(frag).then(
      (value) => { outcome = { value }; },
      (error) => { outcome = { error }; }
    );
    const stats = frag.stats;
    const oldLoader = frag.loader;
    const next = { url: new URL('/next.ts', f.url).href, sn: 2 };
    const data = new ArrayBuffer(3);
    putSeg(next.url, data, 10);
    const nextPromise = fragmentLoader.load(next);
    await flush();
    assert.ok(outcome?.error, 'the old promise must reject, not remain pending');
    await oldPromise;
    assert.equal(outcome.error.data.details, Hls.ErrorDetails.INTERNAL_ABORTED);
    assert.equal(outcome.error.data.frag, frag);
    assert.equal(outcome.error.data.stats, stats);
    assert.equal(outcome.error.data.networkDetails, requests[0] || null);
    assert.equal(stats.aborted, true);
    assert.equal(frag.loader, null);
    oldLoader.abort();
    warm.resolve();
    f.advance(0);
    const result = await nextPromise;
    assert.equal(result.payload, data);
    assert.equal(next.loader, null);
    f.advance(2000);
    await flush();
    assert.equal(requests.length, path === 'base' ? 1 : 0);
    if (requests.length) assert.equal(requests[0].aborted, true);
    assert.equal(f.calls.length, path === 'range' ? 1 : 0);
    if (f.calls.length) assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(f.timers.size, 0);
  });
}
