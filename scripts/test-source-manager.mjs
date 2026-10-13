// Run: node --test scripts/test-source-manager.mjs
// VM-local fetch, storage, DOM and clocks: no user sources or network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setMaxListeners } from 'node:events';
import vm from 'node:vm';
import { parseM3U } from '../src/core/m3uParser.js';
import { resolveMediaUrl } from '../src/core/net.js';
import { KEY } from '../src/core/keys.js';
import { esc } from '../src/core/util.js';

const source = await readFile(new URL('../src/ui/SourceManager.js', import.meta.url), 'utf8');
const executable = source.replace(/^import .*;\r?$/gm, '').replace('export class SourceManager', 'class SourceManager');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const SOURCE = { id: 'source-a', name: 'A', m3uUrl: 'https://source.test/list.m3u', epgUrl: '' };
const channelUrl = (i) => `https://video.test/${i}.ts`;
const playlist = (urls) => '#EXTM3U\n' + urls.map((url, i) => `#EXTINF:-1 group-title="Group",Channel ${i}\n${url}`).join('\n');

function response(text = '', { status = 200, type = 'text/plain', url = '' } = {}) {
  const res = new Response(text, { status, headers: { 'Content-Type': type } });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

function openResponse({ text, type = 'video/mp2t', status = 200, fail = false, neverFinishCancel = false } = {}) {
  const state = { cancels: 0, pulls: 0 };
  const body = new ReadableStream({
    start(controller) {
      if (text !== undefined) controller.enqueue(new TextEncoder().encode(text));
      if (fail) controller.error(new Error('broken body'));
    },
    pull() { state.pulls++; },
    cancel() {
      state.cancels++;
      if (neverFinishCancel) return new Promise(() => {});
    }
  }, { highWaterMark: 0 });
  state.res = new Response(body, { status, headers: { 'Content-Type': type } });
  return state;
}

function pendingRequest(request, ignoreAbort = false) {
  const pending = deferred();
  if (!ignoreAbort) {
    if (request.signal.aborted) pending.reject(abortError());
    else request.signal.addEventListener('abort', () => pending.reject(abortError()), { once: true });
  }
  return { ...pending, signal: request.signal };
}

function clock() {
  let now = 0;
  let serial = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn, delay) {
      const id = ++serial;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = target;
      await flush();
    }
  };
}

function fixture(t, sources = [SOURCE], activeId = SOURCE.id) {
  let stored = copy(sources);
  const calls = [];
  const saves = [];
  const reloads = [];
  const progress = [];
  const renders = [];
  const time = clock();
  const classes = new Set(['hidden']);
  let fetchImpl = () => { throw new Error('Unexpected mock request; real network is forbidden'); };
  const el = {
    addEventListener() {},
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    set innerHTML(html) { renders.push(html); },
    querySelector(selector) {
      if (!selector.endsWith(' .value')) return null;
      return { set textContent(text) { progress.push({ selector, text }); } };
    }
  };
  class TestController extends AbortController {
    constructor() {
      super();
      // The production pool deliberately has up to 20 children on one run signal.
      setMaxListeners(0, this.signal);
    }
  }
  const api = vm.runInNewContext(executable + '\n;({ SourceManager, probeUrl });', {
    KEY, esc, parseM3U, URL, TextDecoder, AbortController: TestController,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    t: (key, params) => key + (params ? ' ' + JSON.stringify(params) : ''),
    getSources: () => copy(stored),
    saveSources: (list) => { stored = copy(list); saves.push(copy(list)); },
    getActiveSourceId: () => activeId,
    setActiveSourceId: (id) => { activeId = id; },
    proxied: (url) => url,
    resolveMediaUrl,
    fetch: (url, options = {}) => {
      const call = { url, ...options };
      calls.push(call);
      return fetchImpl(call);
    }
  }, { filename: 'SourceManager.js' });
  const manager = new api.SourceManager(el);
  manager.onUseSource = (src) => reloads.push(copy(src));
  manager.open();
  t.after(async () => {
    manager.close();
    await flush();
    assert.equal(time.timers.size, 0, 'all request timers must be released');
  });
  return {
    api, manager, calls, saves, reloads, progress, renders, time,
    fetch: (fn) => { fetchImpl = fn; },
    stored: () => copy(stored),
    replaceStored: (list) => { stored = copy(list); }
  };
}

function serveOne(f, video = () => response('', { type: 'video/mp2t' })) {
  f.fetch((request) => request.url === SOURCE.m3uUrl
    ? response(playlist([channelUrl(0)]))
    : video(request));
}

test('direct video and HTTP error bodies are canceled without reading or awaiting cancellation', async (t) => {
  const f = fixture(t);
  for (const status of [200, 404]) {
    const body = openResponse({ status, neverFinishCancel: true });
    f.fetch(() => body.res);
    assert.equal(await f.api.probeUrl(channelUrl(0)), status === 200);
    assert.equal(body.cancels, 1);
    assert.equal(body.pulls, 0);
    assert.equal(body.res.body.locked, false);
    assert.equal(f.calls.at(-1).signal.aborted, true);
    assert.equal(f.time.timers.size, 0);
  }
});

test('HLS master, variant and ranged segment all release their responses', async (t) => {
  const f = fixture(t);
  const segment = openResponse();
  const master = response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8', {
    url: 'https://cdn.test/live/master.m3u8'
  });
  const child = response('#EXTM3U\n#EXTINF:5,\nseg.ts', { url: 'https://cdn.test/redirected/child.m3u8' });
  f.fetch(({ url }) => {
    if (url === 'https://video.test/master.m3u8') return master;
    if (url === 'https://cdn.test/live/child.m3u8') return child;
    assert.equal(url, 'https://cdn.test/redirected/seg.ts');
    return segment.res;
  });
  assert.equal(await f.api.probeUrl('https://video.test/master.m3u8'), true);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].headers.Range, 'bytes=0-1');
  assert.equal(segment.cancels, 1);
  assert.equal(segment.pulls, 0);
  for (const res of [master, child, segment.res]) assert.equal(res.body.locked, false);
  assert.ok(f.calls.every((call) => call.signal.aborted));
});

test('playlist size cap cancels and unlocks the reader before requesting a segment', async (t) => {
  const f = fixture(t);
  const body = openResponse({ text: '#EXTM3U\n#EXTINF:5,\nseg.ts\n#' + 'x'.repeat(512000), type: 'text/plain', neverFinishCancel: true });
  const segment = openResponse();
  f.fetch(({ url }) => {
    if (url.endsWith('live.m3u8')) return body.res;
    assert.equal(body.cancels, 1);
    assert.equal(body.res.body.locked, false);
    assert.equal(url, 'https://video.test/seg.ts');
    return segment.res;
  });
  assert.equal(await f.api.probeUrl('https://video.test/live.m3u8'), true);
  assert.equal(body.cancels, 1);
  assert.equal(segment.cancels, 1);
});

test('malformed playlists, empty variants and HTTP failures stop and release each chain', async (t) => {
  const f = fixture(t);
  const cases = [
    [response('not a playlist')],
    [response('#EXTM3U')],
    [response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1')],
    [response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8'), response('not a playlist')],
    [response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8'), openResponse({ status: 503 }).res],
    [response('#EXTM3U\n#EXTINF:5,\nseg.ts'), openResponse({ status: 404 }).res],
    [openResponse({ type: 'text/plain', fail: true }).res]
  ];
  for (const responses of cases) {
    let index = 0;
    f.fetch(() => {
      assert.ok(index < responses.length, 'no unexpected child request');
      return responses[index++];
    });
    assert.equal(await f.api.probeUrl('https://video.test/live.m3u8'), false);
    assert.equal(index, responses.length);
    assert.ok(responses.every((res) => !res.body.locked));
    assert.ok(f.calls.every((call) => call.signal.aborted));
  }
});

test('probe request timeout includes headers and body; intentional abort is not a dead URL', async (t) => {
  const f = fixture(t);
  for (const stage of ['headers', 'body']) {
    const body = openResponse({ type: 'text/plain', text: '#EXTM3U\n' });
    f.fetch((request) => stage === 'headers' ? pendingRequest(request).promise : body.res);
    const task = f.api.probeUrl('https://video.test/live.m3u8');
    await flush();
    await f.time.advance(1199);
    assert.equal(f.calls.at(-1).signal.aborted, false);
    await f.time.advance(1);
    assert.equal(await task, false);
    assert.equal(f.calls.at(-1).signal.aborted, true);
    if (stage === 'body') {
      assert.equal(body.cancels, 1);
      assert.equal(body.res.body.locked, false);
    }
  }
  const controller = new AbortController();
  f.fetch((request) => pendingRequest(request).promise);
  const canceled = f.api.probeUrl(channelUrl(0), 1200, 2500, controller.signal);
  controller.abort();
  assert.equal(await canceled, null);
  const before = f.calls.length;
  assert.equal(await f.api.probeUrl(channelUrl(1), 1200, 2500, controller.signal), null);
  assert.equal(f.calls.length, before, 'already canceled runs must not fetch');
});

test('total probe budget caps a chain even when each request is under its own timeout', async (t) => {
  const f = fixture(t);
  const pending = [];
  f.fetch((request) => {
    const item = pendingRequest(request);
    pending.push(item);
    return item.promise;
  });
  const task = f.api.probeUrl('https://video.test/master.m3u8');
  await f.time.advance(1000);
  pending[0].resolve(response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8'));
  await flush();
  await f.time.advance(1000);
  pending[1].resolve(response('#EXTM3U\n#EXTINF:5,\nseg.ts'));
  await flush();
  assert.equal(pending.length, 3);
  await f.time.advance(499);
  assert.equal(pending[2].signal.aborted, false);
  await f.time.advance(1);
  assert.equal(await task, false);
  assert.equal(pending[2].signal.aborted, true);
});

test('closing cancels initial fetch or body, leaves deadUrls intact, and permits a new test', async (t) => {
  for (const stage of ['headers', 'body']) {
    await t.test(stage, async (t) => {
      const f = fixture(t, [{ ...SOURCE, deadUrls: ['previous'] }]);
      const body = openResponse({ text: '#EXTM3U\n', type: 'text/plain' });
      f.fetch((request) => stage === 'headers' ? pendingRequest(request).promise : body.res);
      const task = f.manager._testSource(0);
      await flush();
      await f.manager._testSource(0);
      assert.equal(f.calls.length, 1, 'busy click must not start another run');
      f.manager.close();
      const renderCount = f.renders.length;
      assert.equal(f.manager.testing, false);
      assert.equal(f.calls[0].signal.aborted, true);
      await task;
      assert.equal(f.renders.length, renderCount);
      assert.equal(f.manager.testMsg, '');
      assert.equal(f.saves.length, 0);
      assert.equal(f.reloads.length, 0);
      assert.deepEqual(f.stored()[0].deadUrls, ['previous']);
      if (stage === 'body') {
        assert.equal(body.cancels, 1);
        assert.equal(body.res.body.locked, false);
      }
      f.manager.open();
      serveOne(f);
      await f.manager._testSource(0);
      assert.equal(f.manager.testing, false);
      assert.equal(f.saves.length, 1);
      assert.equal(f.reloads.length, 1);
    });
  }
});

test('initial fetch and body have a 45s timeout and recover without saving failures', async (t) => {
  for (const stage of ['headers', 'body']) {
    await t.test(stage, async (t) => {
      const f = fixture(t);
      const body = openResponse({ text: '#EXTM3U\n', type: 'text/plain' });
      f.fetch((request) => stage === 'headers' ? pendingRequest(request).promise : body.res);
      const task = f.manager._testSource(0);
      await flush();
      await f.time.advance(44999);
      assert.equal(f.manager.testing, true);
      await f.time.advance(1);
      await task;
      assert.equal(f.manager.testing, false);
      assert.equal(f.manager._testRun, null);
      assert.match(f.manager.testMsg, /^sm.testFailed/);
      assert.equal(f.saves.length, 0);
      assert.equal(f.reloads.length, 0);
      assert.equal(f.calls[0].signal.aborted, true);
      serveOne(f);
      await f.manager._testSource(0);
      assert.equal(f.saves.length, 1);
    });
  }
});

test('pool stays bounded at 20 and close aborts every worker without dequeuing the remainder', async (t) => {
  const f = fixture(t, [{ ...SOURCE, deadUrls: ['previous'] }]);
  const pending = [];
  f.fetch((request) => {
    if (request.url === SOURCE.m3uUrl) return response(playlist(Array.from({ length: 47 }, (_, i) => channelUrl(i))));
    const item = pendingRequest(request);
    pending.push(item);
    return item.promise;
  });
  const task = f.manager._testSource(0);
  await flush();
  assert.equal(pending.length, 20);
  f.manager.close();
  assert.ok(pending.every((item) => item.signal.aborted));
  await task;
  assert.equal(pending.length, 20);
  assert.equal(f.progress.length, 0);
  assert.equal(f.saves.length, 0);
  assert.equal(f.reloads.length, 0);
  assert.deepEqual(f.stored()[0].deadUrls, ['previous']);
});

test('repeated open/close cancels pending probe readers without retaining busy state', async (t) => {
  const f = fixture(t, [{ ...SOURCE, deadUrls: ['previous'] }]);
  for (let cycle = 0; cycle < 4; cycle++) {
    f.manager.open();
    const body = openResponse({ text: '#EXTM3U\n', type: 'text/plain', neverFinishCancel: true });
    f.fetch(({ url }) => url === SOURCE.m3uUrl
      ? response(playlist(['https://video.test/live.m3u8']))
      : body.res);
    const task = f.manager._testSource(0);
    await flush();
    assert.equal(body.res.body.locked, true);
    f.manager.close();
    const renders = f.renders.length;
    await task;
    assert.equal(body.cancels, 1);
    assert.equal(body.res.body.locked, false);
    assert.equal(f.manager.testing, false);
    assert.equal(f.manager._testRun, null);
    assert.equal(f.renders.length, renders);
    assert.equal(f.time.timers.size, 0);
  }
  assert.equal(f.saves.length, 0);
  assert.equal(f.reloads.length, 0);
  assert.deepEqual(f.stored()[0].deadUrls, ['previous']);
});

test('pool eventually tests every distinct URL without exceeding 20 simultaneous requests', async (t) => {
  const f = fixture(t);
  const pending = [];
  let active = 0;
  let maximum = 0;
  f.fetch((request) => {
    if (request.url === SOURCE.m3uUrl) return response(playlist(Array.from({ length: 47 }, (_, i) => channelUrl(i))));
    active++;
    maximum = Math.max(maximum, active);
    request.signal.addEventListener('abort', () => active--, { once: true });
    const item = pendingRequest(request);
    pending.push(item);
    return item.promise;
  });
  const task = f.manager._testSource(0);
  await flush();
  for (let i = 0; i < 47; i++) {
    assert.ok(pending[i]);
    pending[i].resolve(response('', { type: 'video/mp2t' }));
    await flush();
  }
  await task;
  assert.equal(maximum, 20);
  assert.equal(active, 0);
  assert.equal(pending.length, 47);
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.stored()[0].deadUrls, []);
  assert.match(f.manager.testMsg, /"kept":47,"dead":0/);
});

test('late initial success or rejection cannot touch a reopened run, even with the same source id and URL', async (t) => {
  for (const outcome of ['resolve', 'reject']) {
    await t.test(outcome, async (t) => {
      const f = fixture(t);
      const pending = [];
      f.fetch((request) => {
        if (request.url !== SOURCE.m3uUrl) return response('', { type: 'video/mp2t' });
        const item = pendingRequest(request, true);
        pending.push(item);
        return item.promise;
      });
      const old = f.manager._testSource(0);
      f.manager.close();
      f.manager.open();
      const next = f.manager._testSource(0);
      const run = f.manager._testRun;
      const renderCount = f.renders.length;
      const oldBody = openResponse({ text: playlist([channelUrl(9)]), type: 'text/plain' });
      if (outcome === 'resolve') pending[0].resolve(oldBody.res);
      else pending[0].reject(new Error('late failure'));
      await old;
      assert.equal(f.manager._testRun, run);
      assert.equal(f.manager.testing, true);
      assert.equal(f.manager.testMsg, 'sm.pulling');
      assert.equal(f.renders.length, renderCount);
      assert.equal(f.progress.length, 0);
      assert.equal(f.saves.length, 0);
      assert.equal(f.reloads.length, 0);
      assert.equal(f.calls.length, 2);
      if (outcome === 'resolve') assert.equal(oldBody.cancels, 1);
      pending[1].resolve(response(playlist([channelUrl(0)])));
      await next;
      assert.equal(f.saves.length, 1);
      assert.equal(f.reloads.length, 1);
      assert.equal(f.manager.testing, false);
    });
  }
});

test('open without close also cancels the previous run', async (t) => {
  const f = fixture(t);
  f.fetch((request) => pendingRequest(request).promise);
  const old = f.manager._testSource(0);
  f.manager.open();
  assert.equal(f.calls[0].signal.aborted, true);
  serveOne(f);
  const next = f.manager._testSource(0);
  await Promise.all([old, next]);
  assert.equal(f.saves.length, 1);
  assert.equal(f.reloads.length, 1);
  assert.equal(f.manager.testing, false);
});

test('late worker results cannot save, reload, render, clear a new busy state, or dequeue old URLs', async (t) => {
  const f = fixture(t);
  const oldWorkers = [];
  let manifestCount = 0;
  let nextManifest;
  f.fetch((request) => {
    if (request.url === SOURCE.m3uUrl) {
      if (manifestCount++ === 0) return response(playlist(Array.from({ length: 30 }, (_, i) => channelUrl(i))));
      nextManifest = pendingRequest(request);
      return nextManifest.promise;
    }
    const item = pendingRequest(request, true);
    oldWorkers.push(item);
    return item.promise;
  });
  const old = f.manager._testSource(0);
  await flush();
  assert.equal(oldWorkers.length, 20);
  f.manager.close();
  f.manager.open();
  const next = f.manager._testSource(0);
  const run = f.manager._testRun;
  const renderCount = f.renders.length;
  for (const item of oldWorkers) item.resolve(openResponse({ status: 404 }).res);
  await old;
  assert.equal(oldWorkers.length, 20);
  assert.equal(f.manager._testRun, run);
  assert.equal(f.manager.testing, true);
  assert.equal(f.renders.length, renderCount);
  assert.equal(f.progress.length, 0);
  assert.equal(f.saves.length, 0);
  assert.equal(f.reloads.length, 0);
  f.manager.close();
  await next;
  assert.equal(nextManifest.signal.aborted, true);
});

test('editing, saving an already-open edit, and removing the tested source invalidate pending results', async (t) => {
  for (const action of ['edit', 'save', 'remove']) {
    await t.test(action, async (t) => {
      const f = fixture(t);
      let pending;
      if (action === 'save') f.manager._editSource(0);
      serveOne(f, (request) => {
        pending = pendingRequest(request, true);
        return pending.promise;
      });
      const old = f.manager._testSource(0);
      await flush();
      if (action === 'remove') {
        f.manager.focusIdx = 4;
        f.manager._deleteFocused();
      } else {
        if (action === 'edit') f.manager._editSource(0);
        f.manager.form.m3uUrl = 'https://edited.test/new.m3u';
        f.manager._save();
        // Even an A -> B -> A edit must not revive the old A test.
        f.manager._editSource(0);
        f.manager.form.m3uUrl = SOURCE.m3uUrl;
        f.manager._save();
      }
      assert.equal(pending.signal.aborted, true);
      assert.equal(f.manager.testing, false);
      const saved = f.stored();
      const saves = f.saves.length;
      const reloads = f.reloads.length;
      const renders = f.renders.length;
      pending.resolve(openResponse({ status: 404 }).res);
      await old;
      assert.deepEqual(f.stored(), saved);
      assert.equal(f.saves.length, saves);
      assert.equal(f.reloads.length, reloads);
      assert.equal(f.renders.length, renders);
      assert.equal(f.progress.length, 0);
    });
  }
});

test('source address changes, replacement objects and removal are detected even without UI handlers', async (t) => {
  for (const action of ['address', 'replace', 'remove']) {
    await t.test(action, async (t) => {
      const f = fixture(t);
      let pending;
      serveOne(f, (request) => {
        pending = pendingRequest(request, true);
        return pending.promise;
      });
      const old = f.manager._testSource(0);
      await flush();
      if (action === 'address') f.manager.sources[0].m3uUrl = 'https://edited.test/list.m3u';
      if (action === 'replace') f.manager.sources[0] = { ...f.manager.sources[0] };
      if (action === 'remove') f.manager.sources = [];
      const renders = f.renders.length;
      pending.resolve(response('', { status: 404 }));
      await old;
      assert.equal(f.saves.length, 0);
      assert.equal(f.reloads.length, 0);
      assert.equal(f.progress.length, 0);
      assert.equal(f.renders.length, renders);
      assert.equal(f.manager.testing, false);
      assert.equal(f.manager._testRun, null);
    });
  }
});

test('removing a preceding row does not redirect progress or writeback to the wrong source', async (t) => {
  const other = { ...SOURCE, id: 'other', name: 'Other', m3uUrl: 'https://other.test/list.m3u' };
  const f = fixture(t, [other, SOURCE]);
  let pending;
  serveOne(f, (request) => {
    pending = pendingRequest(request);
    return pending.promise;
  });
  const task = f.manager._testSource(1);
  await flush();
  f.manager.focusIdx = 4;
  f.manager._deleteFocused();
  assert.equal(f.manager.testingIdx, 0);
  assert.equal(pending.signal.aborted, false);
  pending.resolve(response('', { status: 404 }));
  await task;
  assert.equal(f.progress[0].selector, '[data-idx="4"] .value');
  assert.equal(f.stored().length, 1);
  assert.equal(f.stored()[0].id, SOURCE.id);
  assert.deepEqual(f.stored()[0].deadUrls, [channelUrl(0)]);
  assert.equal(f.reloads[0].id, SOURCE.id);
});

test('persisted removal or address edit blocks final writeback and reload', async (t) => {
  for (const edited of [[], [{ ...SOURCE, m3uUrl: 'https://edited.test/list.m3u' }]]) {
    await t.test(edited.length ? 'edited' : 'removed', async (t) => {
      const f = fixture(t);
      let pending;
      serveOne(f, (request) => {
        pending = pendingRequest(request);
        return pending.promise;
      });
      const task = f.manager._testSource(0);
      await flush();
      f.replaceStored(edited);
      pending.resolve(response('', { status: 404 }));
      await task;
      assert.deepEqual(f.stored(), edited);
      assert.equal(f.saves.length, 0);
      assert.equal(f.reloads.length, 0);
      assert.equal(f.manager.testing, false);
      assert.equal(f.manager.sources[0].deadUrls, undefined);
    });
  }
});

test('successful writeback merges only deadUrls into the latest persisted list', async (t) => {
  const other = { ...SOURCE, id: 'other' };
  const f = fixture(t, [SOURCE, other]);
  let pending;
  serveOne(f, (request) => {
    pending = pendingRequest(request);
    return pending.promise;
  });
  const task = f.manager._testSource(0);
  await flush();
  const edited = { ...SOURCE, name: 'Renamed elsewhere', epgUrl: 'https://epg.test/new.xml' };
  const added = { ...SOURCE, id: 'added' };
  f.replaceStored([edited, added]);
  pending.resolve(response('', { status: 404 }));
  await task;
  assert.deepEqual(f.stored(), [{ ...edited, deadUrls: [channelUrl(0)] }, added]);
  assert.equal(f.reloads[0].name, edited.name);
  assert.equal(f.reloads[0].epgUrl, edited.epgUrl);
});

test('success deduplicates probes and reports channel/group survival, reloading only the active source', async (t) => {
  for (const activeId of [SOURCE.id, 'other']) {
    await t.test(activeId, async (t) => {
      const f = fixture(t, [SOURCE], activeId);
      const text = '#EXTM3U\n' + [
        '#EXTINF:-1 group-title="Kept",Alternatives\n' + channelUrl(0),
        '#EXTINF:-1 group-title="Kept",Alternatives\n' + channelUrl(1),
        '#EXTINF:-1 group-title="Kept",Also uses good\n' + channelUrl(0),
        '#EXTINF:-1 group-title="Dead",Only dead\n' + channelUrl(2)
      ].join('\n');
      f.fetch(({ url }) => url === SOURCE.m3uUrl ? response(text)
        : response('', { status: url === channelUrl(0) ? 200 : 404, type: 'video/mp2t' }));
      await f.manager._testSource(0);
      assert.equal(f.calls.length, 4);
      assert.deepEqual(f.stored()[0].deadUrls.sort(), [channelUrl(1), channelUrl(2)]);
      assert.match(f.manager.testMsg, /"kept":2,"dead":1/);
      assert.match(f.manager.testMsg, /sm.testDoneGroups.*"n":1/);
      assert.equal(f.reloads.length, activeId === SOURCE.id ? 1 : 0);
      assert.equal(f.manager.testing, false);
      assert.equal(f.manager.testingIdx, -1);
    });
  }
});

test('reload callback can close, reopen and start another test without old finally clearing it', async (t) => {
  const f = fixture(t);
  serveOne(f);
  let next;
  let run;
  f.manager.onUseSource = (src) => {
    f.reloads.push(copy(src));
    f.manager.close();
    f.manager.open();
    f.fetch((request) => pendingRequest(request).promise);
    next = f.manager._testSource(0);
    run = f.manager._testRun;
  };
  await f.manager._testSource(0);
  assert.equal(f.manager._testRun, run);
  assert.equal(f.manager.testing, true);
  assert.equal(f.manager.testMsg, 'sm.pulling');
  assert.equal(f.saves.length, 1);
  assert.equal(f.reloads.length, 1);
  assert.equal(f.renders.length, 4, 'initial open, first test, reopen, second test only');
  f.manager.close();
  await next;
});

test('relative channel URLs use final M3U URL, unwrap only dev proxy u, and fall back to requested URL', async (t) => {
  const cases = [
    ['https://redirect.test/nested/list.m3u', 'https://redirect.test/video.ts'],
    ['http://localhost:5173/__proxy__?u=' + encodeURIComponent('https://remote.test/nested/list.m3u'), 'https://remote.test/video.ts'],
    ['https://redirect.test/nested/list.m3u?u=' + encodeURIComponent('https://wrong.test/list.m3u'), 'https://redirect.test/video.ts'],
    ['', 'https://source.test/video.ts']
  ];
  for (const [finalUrl, expected] of cases) {
    await t.test(finalUrl || 'missing response URL', async (t) => {
      const f = fixture(t);
      f.fetch(({ url }) => url === SOURCE.m3uUrl
        ? response(playlist(['../video.ts']), { url: finalUrl })
        : response('', { status: 404 }));
      await f.manager._testSource(0);
      assert.equal(f.calls[1].url, expected);
      assert.deepEqual(f.stored()[0].deadUrls, [expected]);
      assert.equal(f.calls.length, 2);
    });
  }
});

test('probe timeout records a dead URL, unlike intentional task cancellation', async (t) => {
  const f = fixture(t);
  serveOne(f, (request) => pendingRequest(request).promise);
  const task = f.manager._testSource(0);
  await flush();
  await f.time.advance(1200);
  await task;
  assert.deepEqual(f.stored()[0].deadUrls, [channelUrl(0)]);
  assert.equal(f.saves.length, 1);
  assert.equal(f.reloads.length, 1);
  assert.match(f.manager.testMsg, /^sm.testDone/);
});

test('HTTP and empty initial playlists fail cleanly; local and closed sources never fetch', async (t) => {
  const f = fixture(t);
  const errorBody = openResponse({ status: 503 });
  for (const res of [errorBody.res, response('#EXTM3U')]) {
    f.fetch(() => res);
    await f.manager._testSource(0);
    assert.equal(f.manager.testing, false);
    assert.equal(f.manager._testRun, null);
    assert.match(f.manager.testMsg, /^sm.testFailed/);
    assert.equal(f.saves.length, 0);
    assert.equal(f.reloads.length, 0);
    assert.equal(res.body.locked, false);
  }
  assert.equal(errorBody.cancels, 1);
  f.manager.sources[0].m3uUrl = '/local.m3u';
  await f.manager._testSource(0);
  f.manager.close();
  f.manager.sources[0].m3uUrl = SOURCE.m3uUrl;
  await f.manager._testSource(0);
  assert.equal(f.calls.length, 2);
});
