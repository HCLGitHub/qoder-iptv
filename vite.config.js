import { defineConfig } from 'vite';
import { copyFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import http from 'http';
import https from 'https';

// 应用版本号注入到前端（设备信息面板要显示）。
// 从 package.json 取，跟着升版自动同步，不另外硬编一份避免忘改。
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

// 把 webOS 打包所需文件（appinfo.json、图标）复制到 dist。
// THIRD-PARTY-NOTICES.txt 也必须进包：hls.js 是 Apache-2.0，分发时要随附许可全文，
// 只放在仓库里不算——买家手上的 ipk 才是「分发物」。
function webosAssets() {
  const files = ['appinfo.json', 'icon.png', 'largeIcon.png', 'THIRD-PARTY-NOTICES.txt'];
  return {
    name: 'webos-assets',
    closeBundle() {
      for (const f of files) {
        const src = resolve(__dirname, f);
        if (existsSync(src)) {
          copyFileSync(src, resolve(__dirname, 'dist', f));
        }
      }
    }
  };
}

// file:// 下用普通脚本避开 CORS，并在诊断脚本之后执行以捕获加载失败。
function classicScript() {
  return {
    name: 'classic-script',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      let src = '';
      html = html.replace(/\s*<script type="module"[^>]*\ssrc="([^"]+)"[^>]*><\/script>/, (m, s) => {
        src = s;
        return '';
      });
      if (!src) throw new Error('classic-script: module entry script not found');
      html = html.replace(/(<link\b[^>]*?)\s+crossorigin(?:="[^"]*")?/g, '$1');
      return html.replace('</body>', `  <script src="${src}"></script>\n  </body>`);
    }
  };
}

// 开发代理：转发外部 M3U/EPG/流，忽略自签证书、补 CORS 头；
// 对 m3u8 播放列表重写内部切片/子列表地址，使其也走代理（解决 hls.js 跨域）。
function devProxy() {
  const UA =
    'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79 Safari/537.36';

  function proxyUrl(abs) {
    return '/__proxy__?u=' + encodeURIComponent(abs);
  }

  function rewriteM3u8(text, baseUrl) {
    return text
      .split(/\r?\n/)
      .map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          // 重写 KEY / MEDIA / MAP 等标签里的 URI="..."
          if (/URI="[^"]+"/i.test(t)) {
            return t.replace(/URI="([^"]+)"/i, (m, uri) => {
              try {
                return 'URI="' + proxyUrl(new URL(uri, baseUrl).href) + '"';
              } catch (e) {
                return m;
              }
            });
          }
          return line;
        }
        // 非注释行 = 切片或子播放列表地址
        try {
          return proxyUrl(new URL(t, baseUrl).href);
        } catch (e) {
          return line;
        }
      })
      .join('\n');
  }

  return {
    name: 'dev-proxy',
    configureServer(server) {
      server.middlewares.use('/__proxy__', (req, res) => {
        const q = new URL(req.url, 'http://localhost');
        const target = q.searchParams.get('u');
        if (!target) {
          res.statusCode = 400;
          res.end('missing u');
          return;
        }
        let targetUrl;
        try {
          targetUrl = new URL(target);
          if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error('bad protocol');
        } catch (e) {
          res.statusCode = 400;
          res.end('bad url');
          return;
        }
        const mod = targetUrl.protocol === 'https:' ? https : http;
        const options = {
          method: 'GET',
          rejectUnauthorized: false,
          headers: {
            'User-Agent': UA,
            Accept: '*/*',
            Referer: targetUrl.origin + '/'
          }
        };
        for (const header of ['range', 'if-range']) {
          if (req.headers[header] !== undefined) options.headers[header] = req.headers[header];
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

        let upstream;
        let upstreamResponse;
        let done = false;
        const chunks = [];

        function cleanupClient() {
          req.removeListener('aborted', onClientDone);
          res.removeListener('close', onClientDone);
          res.removeListener('error', onClientDone);
          res.removeListener('finish', onClientDone);
          chunks.length = 0;
        }

        function destroyUpstream() {
          upstreamResponse?.unpipe(res);
          upstreamResponse?.destroy();
          upstream?.destroy();
        }

        function onClientDone() {
          if (done) return;
          done = true;
          cleanupClient();
          destroyUpstream();
        }

        function fail(message) {
          if (done) return;
          done = true;
          cleanupClient();
          destroyUpstream();
          if (res.destroyed || res.writableEnded) return;
          if (res.headersSent) {
            res.destroy();
            return;
          }
          // 上游可能已经发了头但尚未发正文，不能把旧长度/范围留在 502 上。
          for (const header of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Location']) {
            res.removeHeader(header);
          }
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(message);
        }

        function onRequestError() { fail('proxy error'); }
        function onResponseError() { fail('upstream error'); }
        function onTimeout() { fail('proxy timeout'); }
        function onPlaylistData(chunk) { chunks.push(chunk); }
        function onPlaylistEnd() {
          if (done || res.destroyed || res.writableEnded) return;
          const out = rewriteM3u8(Buffer.concat(chunks).toString('utf8'), targetUrl.href);
          chunks.length = 0;
          res.end(out);
        }

        // req.close 也会在正常 GET 读完时触发，不能把它当作客户端取消。
        req.once('aborted', onClientDone);
        res.once('close', onClientDone);
        res.once('error', onClientDone);
        res.once('finish', onClientDone);
        if (req.aborted || res.destroyed) {
          onClientDone();
          return;
        }

        try {
          upstream = mod.request(targetUrl, options, (up) => {
            upstreamResponse = up;
            up.on('error', onResponseError);
            up.once('aborted', onResponseError);
            up.once('close', () => {
              if (!up.complete) onResponseError();
              up.removeListener('error', onResponseError);
              up.removeListener('aborted', onResponseError);
              up.removeListener('data', onPlaylistData);
              up.removeListener('end', onPlaylistEnd);
            });
            if (done) {
              up.destroy();
              return;
            }

            res.statusCode = up.statusCode || 502;
            // 保留重定向状态码，目标仍通过代理访问。
            if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
              let redirected;
              try {
                redirected = new URL(up.headers.location, targetUrl).href;
              } catch (e) {
                fail('bad redirect');
                return;
              }
              res.setHeader('Location', proxyUrl(redirected));
              res.end();
              return;
            }

            const ct = (up.headers['content-type'] || '').toLowerCase();
            const isM3u8 =
              ct.includes('mpegurl') ||
              /\.m3u8(\?|$)/i.test(targetUrl.pathname + targetUrl.search);

            // 只重写完整的成功清单；206 部分正文和 404 等错误必须原样透传。
            if (isM3u8 && up.statusCode === 200) {
              res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
              up.on('data', onPlaylistData);
              up.once('end', onPlaylistEnd);
            } else {
              // 仅未重写的正文才能复用上游的长度/字节范围。
              for (const header of ['content-type', 'content-range', 'accept-ranges', 'content-length']) {
                if (up.headers[header] !== undefined) res.setHeader(header, up.headers[header]);
              }
              up.pipe(res);
            }
          });
          upstream.on('error', onRequestError);
          // destroy 后还可能触发 error；等 close 后再移除，避免未处理的异步错误。
          upstream.once('close', () => {
            upstream.removeListener('error', onRequestError);
            upstream.removeListener('timeout', onTimeout);
          });
          upstream.setTimeout(30000, onTimeout);
          upstream.end();
        } catch (e) {
          onRequestError();
        }
      });
    }
  };
}

export default defineConfig({
  base: './',
  // 不再复制 public/ 到 dist：里面只有 public/default.m3u（原内置「广东联通」源），
  // 那是一条私人 IPTV 网关地址、还带着账号 token，不该随包分发。
  // 文件本身留在仓库里——scripts/ 下的台标复用和网关探测脚本都靠它当数据源，
  // 路径不变，那些脚本照旧能跑。
  publicDir: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  build: {
    outDir: 'dist',
    target: 'chrome79',
    emptyOutDir: true,
    modulePreload: false,
    // IIFE 单块输出时 Vite 默认把 CSS 塞进 JS 运行时注入；关掉拆分才会产出独立的 <link>。
    cssCodeSplit: false,
    rollupOptions: {
      output: { format: 'iife', inlineDynamicImports: true }
    }
  },
  server: {
    port: 5173,
    host: true
  },
  plugins: [webosAssets(), devProxy(), classicScript()]
});
