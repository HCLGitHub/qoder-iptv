// Run: node --test scripts/test-epg-store.mjs
// Isolated storage, fetch, clock and DOM fixtures; no real EPG/network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { epgStore as store } from '../src/core/epgStore.js';
import { diypDateStr } from '../src/core/diyp.js';
import { EpgGuide } from '../src/ui/EpgGuide.js';

const TTL = 6 * 3600 * 1000;
const RETRY = 60 * 1000;
const START = new Date(2026, 8, 10, 8).getTime();
const SOURCE = 'https://epg.example.test/a';
const OTHER = 'https://epg.example.test/b';
const CHANNEL = { key: 'tv', name: 'TV', epgName: 'TV', tvgId: 'tv', index: 1 };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const row = (start = '08:00', end = '09:00', title = 'Programme', desc = '') => ({ start, end, title, desc });
const loadKey = (off = 0) => 'TV|' + diypDateStr(off);
const cacheKey = (url = SOURCE, off = 0) => 'diyp:' + url + ':' + loadKey(off);
const programme = (hour, title, off = 0, stopHour = hour + 1, desc = '') => {
  const date = new Date(Date.now());
  date.setDate(date.getDate() + off);
  date.setHours(hour, 0, 0, 0);
  return { start: date.getTime(), stop: date.getTime() + (stopHour - hour) * 3600000, title, desc };
};

function replaceGlobal(t, name, value) {
  const old = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, name, old);
    else delete globalThis[name];
  });
}

// Only emulate the DOMParser boundary; XMLTV parser itself still builds the maps.
class FixtureDOMParser {
  parseFromString(text) {
    const data = JSON.parse(text);
    const node = (attrs, texts = {}) => ({
      getAttribute: (key) => attrs[key] || '',
      getElementsByTagName: (key) => key in texts ? [{ textContent: texts[key] }] : []
    });
    return {
      getElementsByTagName: (tag) => tag === 'channel'
        ? [{ ...node({ id: 'tv' }, { 'display-name': 'TV' }) }]
        : tag === 'programme' ? data.map((p) => node(
          { channel: 'tv', start: '20260910080000 +0000', stop: '20260910090000 +0000' },
          { title: p, desc: '' }
        )) : []
    };
  }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: START });
  const storage = Object.create(null);
  Object.defineProperties(storage, {
    getItem: { value(key) { return this[key] ?? null; } },
    setItem: { value(key, value) { this[key] = String(value); } },
    removeItem: { value(key) { delete this[key]; } }
  });
  replaceGlobal(t, 'localStorage', storage);
  replaceGlobal(t, 'DOMParser', FixtureDOMParser);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'setInterval', () => { throw new Error('EPG must not schedule repeating timers'); });
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url, options = {}) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const request = {
      url: new URL(url), options,
      json: (rows = [], date) => resolve({ ok: true, json: async () => ({ epg_data: rows, date }) }),
      xml: (titles = ['XML programme']) => resolve({ ok: true, text: async () => JSON.stringify(titles) }),
      fail: () => reject(new Error('Offline'))
    };
    options.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    requests.push(request);
    return promise;
  });
  store.clear();
  store.onUpdate = null;
  t.after(() => { store.onUpdate = null; store.clear(); });
  return {
    requests,
    tick: (ms) => t.mock.timers.tick(ms),
    seed: (key, data, expire = Date.now() + TTL) => storage.setItem('iptv:epg:' + key, JSON.stringify({ data, expire })),
    cached: (key) => JSON.parse(storage.getItem('iptv:epg:' + key)),
    storage
  };
}

function guideFixture(t) {
  const classes = new Set(['hidden']);
  const nodes = Object.fromEntries(['#eg-day-list', '#eg-chan-col', '#eg-prog-col'].map((id) => [id, { innerHTML: '', children: [] }]));
  const el = {
    innerHTML: '', addEventListener() {}, querySelector: (selector) => nodes[selector] || null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) }
  };
  const guide = new EpgGuide(el);
  t.mock.method(guide, 'render');
  return { guide, nodes };
}

test('unconfigured, unloaded and XMLTV queries never start DIYP requests', async (t) => {
  const f = fixture(t);
  assert.equal(store.url, '');
  assert.equal(store.mode, '');
  store.ensure(CHANNEL);
  store.getNowNext(CHANNEL);
  assert.deepEqual(store.getDayProgrammes(CHANNEL), []);
  assert.equal(await store.load('', 'diyp'), false);
  assert.equal(store.mode, '');
  await store.load(SOURCE, 'diyp');
  store.loaded = false;
  store.ensure(CHANNEL);
  store.loaded = true;
  store.url = '';
  store.ensure(CHANNEL);
  store.url = SOURCE;
  store.mode = 'xmltv';
  store.ensure(CHANNEL);
  store.mode = 'diyp';
  store.ensure(null);
  store.ensure({ name: '  ' });
  assert.equal(f.requests.length, 0);
});

test('clear fully unconfigures, cancels updates and cannot revive a source without EPG', async (t) => {
  const f = fixture(t);
  await store.load(SOURCE, 'diyp', { force: true });
  store.ensure(CHANNEL);
  f.requests[0].json([row()]);
  await flush();
  store.ensure({ name: 'Fail' });
  f.requests[1].fail();
  await flush();
  store.ensure({ name: 'Pending' });
  let updates = 0;
  store.onUpdate = () => updates++;
  const generation = store._loadId;
  const version = store.version;
  store.clear(); // main calls this even when the next M3U has no EPG URL.
  assert.equal(store._loadId, generation + 1);
  assert.equal(store.version, version + 1);
  assert.equal(store.url, '');
  assert.equal(store.mode, '');
  assert.equal(store.loaded, false);
  assert.equal(store._forceRefresh, false);
  for (const map of [store.channels, store.programmes, store.loadedDays, store.retryAfter, store.pending]) assert.equal(map.size, 0);
  assert.equal(store._updTimer, null);
  store.getNowNext(CHANNEL);
  store.getDayProgrammes(CHANNEL, -1);
  f.requests[2].json([row()]);
  await flush();
  f.tick(200);
  assert.equal(updates, 0);
  assert.equal(store.programmes.size, 0);
  assert.equal(f.requests.length, 3);
  assert.equal(f.cached('diyp:' + SOURCE + ':Pending|' + diypDateStr()), null);
});

for (const outcome of ['success', 'failure']) {
  test(`late DIYP ${outcome} cannot overwrite a newer generation or delete its pending request`, async (t) => {
    const f = fixture(t);
    await store.load(SOURCE, 'diyp');
    store.ensure(CHANNEL);
    const old = store.pending.get(loadKey());
    await store.load(OTHER, 'diyp');
    await store.load(SOURCE, 'diyp'); // Same URL/name/day again: generation must still distinguish them.
    store.ensure(CHANNEL);
    const current = store.pending.get(loadKey());
    const version = store.version;
    if (outcome === 'success') f.requests[0].json([row('08:00', '09:00', 'Old')]);
    else f.requests[0].fail();
    await old;
    assert.equal(store.pending.get(loadKey()), current);
    assert.equal(store.version, version);
    assert.equal(store.loadedDays.size, 0);
    assert.equal(store.retryAfter.size, 0);
    assert.equal(f.cached(cacheKey()), null);
    assert.equal(store._updTimer, null);
    f.requests[1].json([row('08:00', '09:00', 'New')]);
    await current;
    assert.equal(store.getList(CHANNEL)[0].title, 'New');
    assert.equal(f.cached(cacheKey()).data[0].title, 'New');
  });

  test(`pending identity rejects a replaced request's late ${outcome} within a generation`, async (t) => {
    const f = fixture(t);
    await store.load(SOURCE, 'diyp');
    store.ensure(CHANNEL);
    const old = store.pending.get(loadKey());
    store.pending.delete(loadKey());
    store.ensure(CHANNEL);
    const replacement = store.pending.get(loadKey());
    if (outcome === 'success') f.requests[0].json([row()]);
    else f.requests[0].fail();
    await old;
    assert.equal(store.pending.get(loadKey()), replacement);
    assert.equal(store.programmes.size, 0);
    assert.equal(store.retryAfter.size, 0);
    assert.equal(f.cached(cacheKey()), null);
    f.requests[1].json([]);
    await replacement;
  });
}

test('DIYP source caches stay isolated and in-flight queries are deduplicated by channel/day', async (t) => {
  const f = fixture(t);
  f.seed(cacheKey(SOURCE), [programme(8, 'Source A')]);
  await store.load(OTHER, 'diyp');
  for (let n = 0; n < 20; n++) { store.getNowNext(CHANNEL); store.getDayProgrammes(CHANNEL); }
  store.ensure(CHANNEL, -1);
  store.ensure({ name: 'Other TV' });
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[0].url.origin + f.requests[0].url.pathname, OTHER);
  assert.equal(f.requests[0].url.searchParams.get('ch'), 'TV');
  assert.equal(f.requests[1].url.searchParams.get('date'), diypDateStr(-1));
  for (const request of f.requests) request.json([]);
  await flush();
  await store.load(SOURCE, 'diyp');
  assert.equal(store.getNowNext(CHANNEL).now.title, 'Source A');
  assert.equal(f.requests.length, 3);
});

test('fresh DIYP cache keeps its original deadline, then queries refresh it exactly at expiry', async (t) => {
  const f = fixture(t);
  const expiry = Date.now() + 1000;
  f.seed(cacheKey(), [programme(8, 'Cached')], expiry);
  await store.load(SOURCE, 'diyp');
  assert.equal(store.getNowNext(CHANNEL).now.title, 'Cached');
  assert.equal(store.loadedDays.get(loadKey()), expiry);
  f.tick(999);
  store.getDayProgrammes(CHANNEL);
  assert.equal(f.requests.length, 0);
  f.tick(1);
  assert.equal(f.requests.length, 0); // No autonomous expiry timer.
  assert.equal(store.getNowNext(CHANNEL).now.title, 'Cached'); // Stale data remains while revalidating.
  store.getDayProgrammes(CHANNEL);
  assert.equal(f.requests.length, 1);
  f.requests[0].json([row('08:00', '10:00', 'Updated')]);
  await flush();
  assert.equal(store.getNowNext(CHANNEL).now.title, 'Updated');
  assert.equal(store.loadedDays.get(loadKey()), Date.now() + TTL);
});

test('successful network data expires in memory; identical refresh does not bump the version', async (t) => {
  const f = fixture(t);
  await store.load(SOURCE, 'diyp');
  store.ensure(CHANNEL);
  f.tick(2000);
  f.requests[0].json([row()]);
  await flush();
  const expiry = Date.now() + TTL;
  assert.equal(store.loadedDays.get(loadKey()), expiry);
  assert.equal(f.cached(cacheKey()).expire, expiry);
  const version = store.version;
  f.tick(TTL - 1);
  store.getNowNext(CHANNEL);
  assert.equal(f.requests.length, 1);
  f.tick(1);
  assert.equal(f.requests.length, 1);
  store.getDayProgrammes(CHANNEL);
  assert.equal(f.requests.length, 2);
  f.requests[1].json([row()]);
  await flush();
  assert.equal(store.version, version);
});

test('failures use a bounded query-driven cooldown, then recover without reload', async (t) => {
  const f = fixture(t);
  await store.load(SOURCE, 'diyp');
  let updates = 0;
  store.onUpdate = () => updates++;
  for (let attempt = 0; attempt < 3; attempt++) {
    store.getDayProgrammes(CHANNEL);
    assert.equal(f.requests.length, attempt + 1);
    f.requests[attempt].fail();
    await flush();
    assert.equal(store.loadedDays.has(loadKey()), false);
    assert.equal(store.retryAfter.get(loadKey()), Date.now() + RETRY);
    assert.equal(store.pending.size, 0);
    assert.equal(store._updTimer, null);
    for (let n = 0; n < 20; n++) store.getNowNext(CHANNEL);
    f.tick(RETRY - 1);
    store.getDayProgrammes(CHANNEL);
    assert.equal(f.requests.length, attempt + 1);
    f.tick(1);
    assert.equal(f.requests.length, attempt + 1);
  }
  store.getNowNext(CHANNEL);
  f.requests[3].json([row()]);
  await flush();
  assert.equal(store.retryAfter.size, 0);
  assert.equal(store.loadedDays.has(loadKey()), true);
  assert.equal(store.getNowNext(CHANNEL).now.title, 'Programme');
  f.tick(200);
  assert.equal(updates, 1);
});

test('failed revalidation retains stale programmes without marking them fresh', async (t) => {
  const f = fixture(t);
  f.seed(cacheKey(), [programme(8, 'Keep me')], Date.now() + 1);
  await store.load(SOURCE, 'diyp');
  store.ensure(CHANNEL);
  const version = store.version;
  f.tick(1);
  store.ensure(CHANNEL);
  f.requests[0].fail();
  await flush();
  assert.equal(store.getList(CHANNEL)[0].title, 'Keep me');
  assert.equal(store.version, version);
  assert.equal(store.loadedDays.has(loadKey()), false);
  f.tick(RETRY);
  store.getDayProgrammes(CHANNEL);
  assert.equal(f.requests.length, 2);
  f.requests[1].json([row('08:00', '09:00', 'Recovered')]);
  await flush();
  assert.equal(store.getList(CHANNEL)[0].title, 'Recovered');
});

test('day refresh replaces changed/removed programmes, deduplicates starts and preserves other days', async (t) => {
  const f = fixture(t);
  f.seed(cacheKey(SOURCE, -1), [programme(23, 'Overnight', -1, 25)]);
  f.seed(cacheKey(SOURCE, 1), [programme(0, 'Tomorrow', 1)]);
  f.seed(cacheKey(), [programme(8, 'Old title'), programme(10, 'Removed')], Date.now() + 1);
  await store.load(SOURCE, 'diyp');
  for (const off of [-1, 0, 1]) store.ensure(CHANNEL, off);
  const snapshot = store.getDayProgrammes(CHANNEL);
  const version = store.version;
  f.tick(1);
  store.getDayProgrammes(CHANNEL);
  f.requests[0].json([
    row('09:00', '10:00', 'Inserted'), row('08:00', '08:30', 'Duplicate'),
    row('08:00', '09:30', 'New title', 'New description')
  ]);
  await flush();
  const list = store.getList(CHANNEL);
  assert.deepEqual(list.map((p) => p.title), ['Overnight', 'New title', 'Inserted', 'Tomorrow']);
  assert.equal(list[1].desc, 'New description');
  assert.equal(list[1].stop - list[1].start, 90 * 60000);
  assert.equal(store.version, version + 1);
  assert.deepEqual(snapshot.map((p) => p.title), ['Overnight', 'Old title', 'Removed']);
  assert.equal(store.getDayProgrammes(CHANNEL)[0].title, 'Overnight');

  f.tick(TTL);
  store.getDayProgrammes(CHANNEL);
  f.requests[1].json([]); // Empty successful response really removes today's old entries.
  await flush();
  assert.deepEqual(store.getList(CHANNEL).map((p) => p.title), ['Overnight', 'Tomorrow']);
  assert.deepEqual(store.getDayProgrammes(CHANNEL).map((p) => p.title), ['Overnight']);
  assert.equal(store.loadedDays.get(loadKey()), Date.now() + TTL);
  store.getDayProgrammes(CHANNEL);
  assert.equal(f.requests.length, 2);
});

test('a successful empty day has a TTL, not an endless loaded marker or a failure loop', async (t) => {
  const f = fixture(t);
  await store.load(SOURCE, 'diyp');
  store.getDayProgrammes(CHANNEL);
  f.requests[0].json([]);
  await flush();
  assert.equal(store.retryAfter.size, 0);
  const version = store.version;
  for (let i = 0; i < 10; i++) store.getDayProgrammes(CHANNEL);
  assert.equal(f.requests.length, 1);
  f.tick(TTL);
  store.getDayProgrammes(CHANNEL);
  f.requests[1].json([]);
  await flush();
  assert.equal(store.version, version);
});

test('normal reload reuses fresh cache; explicit manual force skips it and resets failure cooldown', async (t) => {
  const f = fixture(t);
  f.seed(cacheKey(), [programme(8, 'Cached')]);
  await store.load(SOURCE, 'diyp');
  store.getDayProgrammes(CHANNEL);
  await store.load(SOURCE, 'diyp');
  store.getDayProgrammes(CHANNEL);
  assert.equal(f.requests.length, 0);
  await store.load(SOURCE, 'diyp', { force: true });
  assert.equal(f.requests.length, 0); // DIYP remains lazy even for manual refresh.
  store.getNowNext(CHANNEL);
  assert.equal(f.requests.length, 1);
  f.requests[0].fail();
  await flush();
  store.getNowNext(CHANNEL);
  assert.equal(f.requests.length, 1);
  await store.load(SOURCE, 'diyp', { force: true });
  store.getNowNext(CHANNEL);
  assert.equal(f.requests.length, 2);
  f.requests[1].json([row('08:00', '09:00', 'Fresh')]);
  await flush();
  for (let n = 0; n < 5; n++) store.getNowNext(CHANNEL);
  assert.equal(f.requests.length, 2);
  await store.load(SOURCE, 'diyp');
  assert.equal(store.getNowNext(CHANNEL).now.title, 'Fresh');
  assert.equal(f.requests.length, 2);
});

for (const outcome of ['success', 'empty', 'failure']) {
  test(`old XMLTV ${outcome} cannot alter a newer DIYP source`, async (t) => {
    const f = fixture(t);
    const oldLoad = store.load(SOURCE, 'xmltv');
    await store.load(OTHER, 'diyp');
    store.ensure(CHANNEL);
    const current = store.pending.get(loadKey());
    const version = store.version;
    if (outcome === 'failure') f.requests[0].fail();
    else f.requests[0].xml(outcome === 'empty' ? [] : ['Old XML']);
    assert.equal(await oldLoad, null);
    assert.equal(store.mode, 'diyp');
    assert.equal(store.url, OTHER);
    assert.equal(store.version, version);
    assert.equal(store.pending.get(loadKey()), current);
    assert.equal(f.cached(SOURCE), null);
    assert.equal(store._updTimer, null);
    f.requests[1].json([row()]);
    await current;
  });
}

test('XMLTV fresh-cache background refresh and explicit force keep distinct semantics', async (t) => {
  const f = fixture(t);
  f.seed(SOURCE, { channels: [{ id: 'tv', name: 'TV' }], programmes: [['tv', [programme(8, 'Cached XML')]]] });
  assert.equal(await store.load(SOURCE, 'xmltv'), true);
  assert.equal(store.getList(CHANNEL)[0].title, 'Cached XML');
  assert.equal(f.requests.length, 1);
  f.requests[0].xml(['Refreshed XML']);
  await flush();
  assert.equal(store.getList(CHANNEL)[0].title, 'Refreshed XML');
  assert.equal(f.cached(SOURCE).data.programmes[0][1][0].title, 'Refreshed XML');
  const forced = store.load(SOURCE, 'xmltv', { force: true });
  assert.equal(store.loaded, false);
  assert.deepEqual(store.getList(CHANNEL), []);
  f.requests[1].xml(['Forced XML']);
  assert.equal(await forced, true);
  assert.equal(store.getList(CHANNEL)[0].title, 'Forced XML');
});

test('XMLTV auto-detection still falls back to DIYP, but clear blocks its late result', async (t) => {
  const f = fixture(t);
  const loading = store.load(SOURCE);
  f.requests[0].xml([]);
  assert.equal(await loading, true);
  assert.equal(store.mode, 'diyp');
  store.getNowNext(CHANNEL);
  const pending = store.pending.get(loadKey());
  store.clear();
  f.requests[1].json([row()]);
  await pending;
  assert.equal(store.loaded, false);
  assert.equal(store.mode, '');
  assert.equal(store.programmes.size, 0);
  store.getDayProgrammes(CHANNEL);
  assert.equal(f.requests.length, 2);
});

test('a stale XMLTV background refresh cannot reconfigure a source without EPG', async (t) => {
  const f = fixture(t);
  f.seed(SOURCE, { channels: [], programmes: [['tv', [programme(8, 'Cached XML')]]] });
  await store.load(SOURCE, 'xmltv');
  store.clear();
  f.requests[0].xml([]);
  await flush();
  assert.equal(store.loaded, false);
  assert.equal(store.mode, '');
  assert.equal(store.url, '');
  assert.equal(store.programmes.size, 0);
  assert.equal(store._updTimer, null);
});

test('guide async refresh populates an initially empty snapshot and preserves focus by start', async (t) => {
  const f = fixture(t);
  const { guide, nodes } = guideFixture(t);
  await store.load(SOURCE, 'diyp');
  store.onUpdate = () => guide.refreshEpg(); // main owns wiring refreshVisible to this entry point.
  guide.open([CHANNEL], CHANNEL.key);
  guide.zone = 2;
  assert.deepEqual(guide.progList, []);
  f.requests[0].json([row('08:00', '09:00', 'First'), row('09:00', '10:00', 'Focused')]);
  await flush();
  assert.deepEqual(guide.progList, []);
  f.tick(200);
  assert.equal(guide.progList.length, 2);
  guide.progIdx = 1;
  const focusedStart = guide.progList[1].start;
  f.tick(TTL);
  guide.refreshEpg();
  f.requests[1].json([
    row('07:00', '08:00', 'Inserted'), row('08:00', '09:00', 'First'),
    row('09:00', '11:00', 'Renamed', 'Updated details')
  ]);
  await flush();
  f.tick(200);
  assert.equal(guide.progIdx, 2);
  assert.equal(guide.progList[2].start, focusedStart);
  assert.equal(guide.progList[2].title, 'Renamed');
  assert.equal(guide.zone, 2);
  assert.equal(guide.chanIdx, 0);
  assert.equal(guide.dayPos, 7);
  assert.match(nodes['#eg-prog-col'].innerHTML, /class="eg-prog focused" data-role="prog" data-idx="2"/);
  assert.match(nodes['#eg-prog-col'].innerHTML, /Renamed/);
  assert.doesNotMatch(nodes['#eg-prog-col'].innerHTML, />Focused</);
  assert.equal(f.requests.length, 2);
});

test('guide refresh uses current channel/date, clamps missing focus, clears empty focus and keeps every zone', (t) => {
  fixture(t);
  const { guide, nodes } = guideFixture(t);
  let list = [programme(7, 'A'), programme(8, 'B'), programme(9, 'C')];
  const query = t.mock.method(store, 'getDayProgrammes', () => list);
  const other = { ...CHANNEL, key: 'other', name: 'Other', catchup: 'append' };
  guide.open([CHANNEL, other], CHANNEL.key);
  guide.chanIdx = 1;
  guide.dayPos = 6;
  guide.progIdx = 2;
  list = [programme(7, 'A'), programme(8, 'Replacement')];
  for (const zone of [0, 1, 2]) {
    guide.zone = zone;
    guide.refreshEpg();
    assert.equal(guide.zone, zone);
    assert.equal(guide.progIdx, 1);
    assert.equal(guide.chanIdx, 1);
    assert.equal(guide.dayPos, 6);
    assert.deepEqual(query.mock.calls.at(-1).arguments, [other, -1]);
  }
  let selected;
  guide.onPlayLive = () => { selected = guide.progList[guide.progIdx]; };
  guide._confirm();
  assert.equal(selected, list[1]);
  guide.el.classList.remove('hidden');
  list = [];
  guide.refreshEpg();
  assert.equal(guide.progIdx, -1);
  assert.equal(guide.zone, 2);
  assert.doesNotMatch(nodes['#eg-prog-col'].innerHTML, /focused/);
  list = [programme(8, 'Back')];
  guide.refreshEpg();
  assert.equal(guide.progIdx, 0);
  for (const invalid of [-5, 999, NaN, undefined]) {
    guide.progIdx = invalid;
    guide.refreshEpg();
    assert.equal(guide.progIdx, 0);
  }
  guide.channels = [];
  guide.refreshEpg();
  assert.equal(guide.progIdx, -1);
  assert.deepEqual(guide.progList, []);
  guide.close();
  const calls = query.mock.callCount();
  const renders = guide.render.mock.callCount();
  guide.refreshEpg();
  assert.equal(query.mock.callCount(), calls);
  assert.equal(guide.render.mock.callCount(), renders);
});
