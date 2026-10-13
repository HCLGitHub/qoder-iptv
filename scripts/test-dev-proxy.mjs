// Run: node --test scripts/test-dev-proxy.mjs
// All traffic stays on ephemeral loopback servers; no existing dev server is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createServer, loadConfigFromFile } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const configFile = fileURLToPath(new URL('../vite.config.js', import.meta.url));
const proxyPath = (url) => '/__proxy__?u=' + encodeURIComponent(url);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};

function get(url, { headers = {}, onData } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers, agent: false }, (response) => {
      const chunks = [];
      const result = () => ({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      response.on('data', (chunk) => {
        chunks.push(chunk);
        onData?.(request, response);
      });
      response.once('end', () => resolve(result()));
      response.once('error', (error) => {
        error.response = result();
        reject(error);
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('local request timed out')));
    request.once('error', reject);
  });
}

test('devProxy against local mock upstream', { timeout: 30000 }, async (t) => {
  const routes = new Map();
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (handler) handler(req, res);
    else { res.statusCode = 404; res.end('unknown mock route'); }
  });
  let vite;
  t.after(async () => {
    // Close only the servers created by this test, including unfinished test streams.
    upstream.closeAllConnections();
    const closed = new Promise((resolve) => upstream.close(resolve));
    if (vite) {
      vite.httpServer?.closeAllConnections();
      await vite.close();
    }
    await closed;
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

  // Observe real HTTP objects to verify destruction and listener cleanup, not fake I/O.
  const outgoing = [];
  const originalRequest = http.request;
  t.mock.method(http, 'request', function (url, ...args) {
    assert.equal(url.origin, upstreamOrigin, 'proxy must only contact the local mock');
    const request = originalRequest.call(this, url, ...args);
    const record = { request, closed: deferred(), ready: deferred() };
    outgoing.push(record);
    request.once('close', record.closed.resolve);
    request.once('response', (response) => {
      record.response = response;
      record.responseClosed = deferred();
      response.once('close', record.responseClosed.resolve);
      record.ready.resolve(response);
    });
    return request;
  });

  const downstream = [];
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, configFile, root);
  const proxy = loaded.config.plugins.find((plugin) => plugin.name === 'dev-proxy');
  assert.ok(proxy);
  vite = await createServer({
    ...loaded.config,
    configFile: false,
    root,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null },
    // Exclude the asset-copy closeBundle hook so test teardown never touches dist.
    plugins: [{
      name: 'observe-test-clients',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          downstream.push({ req, res });
          next();
        });
      }
    }, proxy]
  });
  // Vite 5's vite.listen() treats port 0 as the default port. Its HTTP server's
  // listen wrapper still initializes Vite, but honors the OS-assigned port.
  await new Promise((resolve, reject) => {
    vite.httpServer.once('error', reject);
    vite.httpServer.listen(0, '127.0.0.1', () => {
      vite.httpServer.removeListener('error', reject);
      resolve();
    });
  });
  const viteOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const target = (path) => new URL(path, upstreamOrigin).href;
  const proxied = (path) => viteOrigin + proxyPath(target(path));
  const getProxy = (path, options) => get(proxied(path), options);

  await t.test('rewritten master and segment URLs remain usable by source probing', async () => {
    routes.set('/probe/master.m3u8', (_req, res) => {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8?version=1');
    });
    routes.set('/probe/child.m3u8', (_req, res) => {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXTINF:6,\nsegment.ts?version=1');
    });
    routes.set('/probe/segment.ts', (_req, res) => {
      res.setHeader('Content-Type', 'video/mp2t');
      res.end('local segment');
    });
    const net = await vite.ssrLoadModule('/src/core/net.js');
    const source = await readFile(new URL('../src/ui/SourceManager.js', import.meta.url), 'utf8');
    const executable = source.replace(/^import .*;\r?$/gm, '').replace('export class SourceManager', 'class SourceManager');
    const { probeUrl } = vm.runInNewContext(executable + '\n({ probeUrl });', {
      ...net, URL, AbortController, TextDecoder, setTimeout, clearTimeout,
      fetch: (url, options) => fetch(new URL(url, viteOrigin), options)
    });
    const begin = received.length;
    assert.equal(await probeUrl(target('/probe/master.m3u8')), true);
    assert.deepEqual(received.slice(begin).map((r) => r.url), [
      '/probe/master.m3u8', '/probe/child.m3u8?version=1', '/probe/segment.ts?version=1'
    ]);
    assert.equal(received.at(-1).headers.range, 'bytes=0-1');
    assert.equal(net.resolveMediaUrl(proxyPath(target('/probe/child.m3u8?version=1')), target('/probe/master.m3u8')),
      target('/probe/child.m3u8?version=1'));
    assert.equal(net.resolveMediaUrl('../segment.ts', target('/probe/child.m3u8')), target('/segment.ts'));
  });

  function stream(path, { type = 'video/mp2t', chunk = 'first chunk', headers = {}, sendHeaders = true } = {}) {
    const started = deferred();
    const closed = deferred();
    routes.set(path, (_req, res) => {
      res.once('close', () => closed.resolve(res));
      if (sendHeaders) {
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': '65536', ...headers });
        res.flushHeaders();
        if (chunk !== null) res.write(chunk);
      }
      started.resolve(res);
    });
    return { started: started.promise, closed: closed.promise };
  }

  routes.set('/media.ts', (req, res) => {
    const body = '0123456789';
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === '"mock-etag"')) {
      if (req.headers.range !== 'bytes=2-5') {
        res.writeHead(416, { 'Content-Range': 'bytes */10', 'Content-Length': '0' });
        res.end();
      } else {
        res.writeHead(206, { 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4' });
        res.end(body.slice(2, 6));
      }
    } else {
      res.setHeader('Content-Length', String(body.length));
      res.end(body);
    }
  });

  await t.test('forwards Range/If-Range and relays 206 metadata verbatim', async () => {
    const result = await getProxy('/media.ts', { headers: { Range: 'bytes=2-5', 'If-Range': '"mock-etag"' } });
    assert.equal(received.at(-1).headers.range, 'bytes=2-5');
    assert.equal(received.at(-1).headers['if-range'], '"mock-etag"');
    assert.equal(result.status, 206);
    assert.equal(result.body, '2345');
    assert.equal(result.headers['content-range'], 'bytes 2-5/10');
    assert.equal(result.headers['accept-ranges'], 'bytes');
    assert.equal(result.headers['content-length'], '4');
    assert.equal(result.headers['access-control-allow-origin'], '*');
    assert.match(result.headers['access-control-expose-headers'], /Content-Range/);
  });

  await t.test('preserves no-range 200 and upstream ignoring Range for stale If-Range', async () => {
    for (const headers of [{}, { Range: 'bytes=2-5', 'If-Range': 'Wed, 01 Jan 2020 00:00:00 GMT' }]) {
      const result = await getProxy('/media.ts', { headers });
      assert.equal(result.status, 200);
      assert.equal(result.body, '0123456789');
      assert.equal(result.headers['content-length'], '10');
      assert.equal(result.headers['accept-ranges'], 'bytes');
      assert.equal(result.headers['content-range'], undefined);
      assert.equal(received.at(-1).headers.range, headers.Range);
      assert.equal(received.at(-1).headers['if-range'], headers['If-Range']);
    }
  });

  await t.test('preserves range errors', async () => {
    const result = await getProxy('/media.ts', { headers: { Range: 'bytes=99-' } });
    assert.equal(result.status, 416);
    assert.equal(result.headers['content-range'], 'bytes */10');
    assert.equal(result.headers['content-length'], '0');
    assert.equal(result.body, '');
  });

  const playlist = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"',
    '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000',
    'child/index.m3u8',
    '#EXTINF:6,',
    '../media.ts',
    target('/absolute.ts'),
    ''
  ].join('\r\n');
  for (const path of ['/live/main.m3u8', '/live/manifest']) {
    routes.set(path, (_req, res) => {
      res.writeHead(200, {
        'Content-Type': path.endsWith('.m3u8') ? 'text/plain' : 'application/x-mpegurl',
        'Content-Length': String(Buffer.byteLength(playlist)),
        'Accept-Ranges': 'bytes'
      });
      res.end(playlist);
    });
  }

  await t.test('rewrites complete M3U8 by extension or MIME type without stale length/ranges', async () => {
    const expected = [
      '#EXTM3U',
      `#EXT-X-KEY:METHOD=AES-128,URI="${proxyPath(target('/key.bin'))}"`,
      `#EXT-X-MEDIA:TYPE=AUDIO,URI="${proxyPath(target('/live/audio.m3u8'))}"`,
      `#EXT-X-MAP:URI="${proxyPath(target('/live/init.mp4'))}"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=1000',
      proxyPath(target('/live/child/index.m3u8')),
      '#EXTINF:6,',
      proxyPath(target('/media.ts')),
      proxyPath(target('/absolute.ts')),
      ''
    ].join('\n');
    for (const path of ['/live/main.m3u8?token=local', '/live/manifest']) {
      const result = await getProxy(path);
      assert.equal(result.status, 200);
      assert.equal(result.body, expected);
      assert.equal(result.headers['content-type'], 'application/vnd.apple.mpegurl');
      assert.equal(result.headers['accept-ranges'], undefined);
      assert.equal(result.headers['content-range'], undefined);
      if (result.headers['content-length'] !== undefined) {
        assert.equal(Number(result.headers['content-length']), Buffer.byteLength(expected));
      }
      assert.notEqual(result.headers['content-length'], String(Buffer.byteLength(playlist)));
    }
  });

  await t.test('does not rewrite partial playlists or promote playlist 404 to 200', async () => {
    for (const [path, status, type, body] of [
      ['/partial.m3u8', 206, 'application/vnd.apple.mpegurl', 'part.ts'],
      ['/missing.m3u8', 404, 'text/plain', 'playlist not found'],
      ['/missing.m3u', 404, 'application/x-mpegurl', 'M3U not found'],
      ['/missing.ts', 404, 'text/plain', 'segment not found']
    ]) {
      routes.set(path, (_req, res) => {
        res.writeHead(status, {
          'Content-Type': type,
          'Content-Length': String(Buffer.byteLength(body)),
          ...(status === 206 ? { 'Content-Range': 'bytes 8-14/100', 'Accept-Ranges': 'bytes' } : {})
        });
        res.end(body);
      });
      const result = await getProxy(path, status === 206 ? { headers: { Range: 'bytes=8-14' } } : {});
      assert.equal(result.status, status);
      assert.equal(result.body, body);
      assert.equal(result.headers['content-type'], type);
      assert.equal(Number(result.headers['content-length']), Buffer.byteLength(body));
      if (status === 206) {
        assert.equal(result.headers['content-range'], 'bytes 8-14/100');
        assert.equal(result.headers['accept-ranges'], 'bytes');
      }
    }
  });

  await t.test('preserves no-body playlist statuses', async () => {
    for (const status of [204, 304]) {
      const path = `/empty-${status}.m3u8`;
      routes.set(path, (_req, res) => { res.writeHead(status); res.end(); });
      const result = await getProxy(path);
      assert.equal(result.status, status);
      assert.equal(result.body, '');
    }
  });

  await t.test('preserves redirect codes and resolves relative and absolute targets through proxy', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const path = `/redirect/${status}`;
      const destination = status === 302 ? '/live/main.m3u8?redirect=1' : '/media.ts';
      routes.set(path, (_req, res) => {
        res.writeHead(status, { Location: status === 308 ? target(destination) : '..' + destination });
        res.end('discarded redirect body');
      });
      const result = await getProxy(path);
      assert.equal(result.status, status);
      assert.equal(result.headers.location, proxyPath(target(destination)));
      assert.equal(result.body, '');
      const followed = await get(viteOrigin + result.headers.location, { headers: { Range: 'bytes=2-5' } });
      assert.equal(followed.status, status === 302 ? 200 : 206);
      if (status === 302) assert.match(followed.body, /\/__proxy__\?u=/);
      else assert.equal(followed.body, '2345');
    }
  });

  await t.test('rejects missing, malformed and non-HTTP(S) initial URLs without upstream I/O', async () => {
    const before = outgoing.length;
    assert.equal((await get(viteOrigin + '/__proxy__')).status, 400);
    for (const url of ['not a URL', 'file:///local/mock', 'ftp://127.0.0.1/mock', 'data:text/plain,mock', 'ws://127.0.0.1/mock']) {
      assert.equal((await get(viteOrigin + proxyPath(url))).status, 400);
    }
    assert.equal(outgoing.length, before);
  });

  await t.test('handles invalid redirect locations as one 502 response', async () => {
    routes.set('/bad-redirect', (_req, res) => { res.writeHead(302, { Location: 'http://[invalid' }); res.end(); });
    const result = await getProxy('/bad-redirect');
    assert.equal(result.status, 502);
    assert.equal(result.headers.location, undefined);
    assert.equal(result.body, 'bad redirect');
  });

  await t.test('client cancellation closes streamed upstream request and response', async () => {
    const source = stream('/cancel.ts');
    await assert.rejects(getProxy('/cancel.ts', { onData: (request) => request.destroy() }), /aborted/);
    const response = await source.closed;
    assert.equal(response.writableFinished, false);
    assert.equal(outgoing.at(-1).request.destroyed, true);
    assert.equal(outgoing.at(-1).response.destroyed, true);
  });

  await t.test('client cancellation also stops pending headers and buffered playlists', async () => {
    for (const [path, sendHeaders] of [['/pending.ts', false], ['/cancel.m3u8', true]]) {
      const source = stream(path, { sendHeaders, type: 'application/vnd.apple.mpegurl', chunk: '#EXTM3U\n' });
      const client = http.get(proxied(path), { agent: false });
      client.on('error', () => {}); // Intentional client cancellation.
      t.after(() => client.destroy());
      await source.started;
      const record = outgoing.at(-1);
      if (sendHeaders) await record.ready.promise;
      client.destroy();
      assert.equal((await source.closed).writableFinished, false);
      assert.equal(record.request.destroyed, true);
      if (sendHeaders) assert.equal(record.response.destroyed, true);
    }
  });

  await t.test('upstream disconnect before headers or during playlist buffering yields 502', async () => {
    for (const [path, sendHeaders] of [['/reset.ts', false], ['/broken.m3u8', true]]) {
      const source = stream(path, { sendHeaders, type: 'application/vnd.apple.mpegurl', chunk: '#EXTM3U\n' });
      const pending = getProxy(path);
      const response = await source.started;
      if (sendHeaders) await outgoing.at(-1).ready.promise;
      response.destroy();
      const result = await pending;
      assert.equal(result.status, 502);
      assert.match(result.body, /^(proxy|upstream) error$/);
      assert.match(result.headers['content-type'], /^text\/plain/);
      assert.notEqual(result.headers['content-length'], '65536');
    }
  });

  await t.test('upstream abort before body clears unsent length/range headers for 502', async () => {
    const source = stream('/empty-broken.ts', { chunk: null, headers: { 'Content-Range': 'bytes 0-65535/99999', 'Accept-Ranges': 'bytes' } });
    const pending = getProxy('/empty-broken.ts');
    const response = await source.started;
    await outgoing.at(-1).ready.promise;
    response.destroy();
    const result = await pending;
    assert.equal(result.status, 502);
    assert.equal(result.body, 'upstream error');
    assert.equal(result.headers['content-range'], undefined);
    assert.equal(result.headers['accept-ranges'], undefined);
    assert.notEqual(result.headers['content-length'], '65536');
    if (result.headers['content-length'] !== undefined) {
      assert.equal(Number(result.headers['content-length']), Buffer.byteLength(result.body));
    }
  });

  await t.test('upstream abort after body begins terminates stream without second headers/body', async () => {
    const source = stream('/broken.ts');
    const pending = getProxy('/broken.ts', { onData: async () => (await source.started).destroy() });
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'ECONNRESET');
      assert.equal(error.response.status, 200);
      assert.equal(error.response.body, 'first chunk');
      return true;
    });
    await source.closed;
    assert.equal((await getProxy('/media.ts')).status, 200, 'proxy remains usable after errors');
  });

  await t.test('finish/cancel/error paths remove proxy-owned listeners', async () => {
    await Promise.all(outgoing.flatMap((record) => [record.closed.promise, record.responseClosed?.promise]));
    await new Promise(setImmediate);
    const owns = (fn) => ['onClientDone', 'onRequestError', 'onResponseError', 'onTimeout', 'onPlaylistData', 'onPlaylistEnd'].includes(fn.name);
    for (const { req, res } of downstream) {
      assert.equal(req.listeners('aborted').some(owns), false);
      for (const event of ['finish', 'close', 'error']) assert.equal(res.listeners(event).some(owns), false);
    }
    for (const { request, response } of outgoing) {
      for (const event of ['error', 'timeout']) assert.equal(request.listeners(event).some(owns), false);
      if (response) {
        for (const event of ['error', 'aborted', 'data', 'end']) assert.equal(response.listeners(event).some(owns), false);
      }
    }
  });
});
