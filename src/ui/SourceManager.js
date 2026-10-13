// 源管理：添加/切换/删除 M3U 直播源与 EPG 地址
import { KEY } from '../core/keys.js';
import { getSources, saveSources, getActiveSourceId, setActiveSourceId } from '../core/storage.js';
import { parseM3U } from '../core/m3uParser.js';
import { proxied, resolveMediaUrl } from '../core/net.js';
import { esc } from '../core/util.js';
import { t } from '../core/i18n.js';

// 从播放列表文本里取第一个 URI（变体清单或切片），相对地址基于 baseUrl 补全
function firstUri(text, baseUrl) {
  for (let ln of text.split(/\r?\n/)) {
    ln = ln.trim();
    if (!ln || ln.startsWith('#')) continue;
    try {
      return resolveMediaUrl(ln, baseUrl);
    } catch (e) {
      return ln;
    }
  }
  return '';
}

function checkAbort(signal) {
  if (signal.aborted) {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }
}

// 每层请求继承测试任务的取消，同时保留自己的超时；收尾也中止未读的响应体。
function requestScope(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal) {
    parentSignal.addEventListener('abort', abort, { once: true });
    if (parentSignal.aborted) abort();
  }
  const timer = setTimeout(abort, timeoutMs);
  return {
    controller,
    dispose() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abort);
      abort();
    }
  };
}

// 不等待 cancel：某些流的底层取消 Promise 可能一直不结束。
function cancelStream(stream) {
  if (!stream) return;
  try { Promise.resolve(stream.cancel()).catch(() => {}); } catch (e) {}
}

async function getText(res, signal, limit = Infinity) {
  checkAbort(signal);
  if (!res.body) {
    const text = await res.text();
    checkAbort(signal);
    return text.slice(0, limit);
  }
  const reader = res.body.getReader();
  const abort = () => cancelStream(reader);
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let result = '';
  let finished = false;
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) {
        finished = true;
        return result + decoder.decode();
      }
      result += decoder.decode(value, { stream: true });
      if (result.length >= limit) return result.slice(0, limit);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (!finished) cancelStream(reader);
    reader.releaseLock();
  }
}

// 与 M3U 加载器一致：重定向后的 URL 才是基准，开发代理需取回 u。
function responseBaseUrl(res, requestedUrl) {
  try {
    const finalUrl = new URL(res.url);
    return finalUrl.pathname.endsWith('/__proxy__')
      ? finalUrl.searchParams.get('u') || requestedUrl
      : finalUrl.href;
  } catch (e) {
    return requestedUrl;
  }
}

async function withResponse(url, signal, timeoutMs, read, headers) {
  const scope = requestScope(signal, timeoutMs);
  const requestSignal = scope.controller.signal;
  let res;
  try {
    checkAbort(requestSignal);
    res = await fetch(proxied(url), { signal: requestSignal, headers });
    checkAbort(requestSignal);
    const value = await read(res, requestSignal);
    checkAbort(requestSignal);
    return value;
  } finally {
    cancelStream(res && res.body);
    scope.dispose();
  }
}

// 单次请求（含读体）1.2s，整条 HLS 链路2.5s，最多下钻一个变体与切片。
// 主动取消返回 null，不把取消当作地址失效；超时仍计为失效。
async function probeUrl(url, perReqMs = 1200, totalMs = 2500, signal) {
  const scope = requestScope(signal, totalMs);
  try {
    const result = await _probeInner(url, perReqMs, scope.controller.signal);
    checkAbort(scope.controller.signal);
    return result;
  } catch (e) {
    return signal && signal.aborted ? null : false;
  } finally {
    scope.dispose();
  }
}

async function _probeInner(url, perReqMs, signal) {
  const get = (u, headOnly = false) => withResponse(u, signal, perReqMs, async (res, requestSignal) => {
    if (!res.ok) return { ok: false };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isM3u8 = /\.m3u8(\?|$)/i.test(u) || /mpegurl|octet-stream|text\/plain/.test(ct);
    const direct = !isM3u8 && (/^video\//.test(ct) || /mp4|mpeg|flv/.test(ct));
    return {
      ok: true, isM3u8, direct, base: responseBaseUrl(res, u),
      text: headOnly || direct ? '' : await getText(res, requestSignal, 512000)
    };
  }, headOnly ? { Range: 'bytes=0-1' } : undefined);

  const r = await get(url);
  if (!r.ok) return false;
  if (r.direct) return true;
  if (!r.isM3u8) return r.text.includes('#EXT');
  let { text, base } = r;
  if (!(text.includes('#EXTM3U') || text.includes('#EXT-X'))) return false;
  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const variant = firstUri(text, base);
    if (!variant) return false;
    const vr = await get(variant);
    if (!vr.ok) return false;
    text = vr.text;
    base = vr.base;
    if (!(text.includes('#EXTM3U') || text.includes('#EXT-X'))) return false;
  }
  const seg = firstUri(text, base);
  if (!seg) return false;
  return (await get(seg, true)).ok;
}

// 并发池：每次出队前检查任务/源版本，取消后不再启动下一条。
async function runPool(items, size, worker, isCurrent) {
  let i = 0;
  const runners = new Array(Math.min(size, items.length)).fill(0).map(async () => {
    while (i < items.length && isCurrent()) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

// 新增源时 M3U 地址预填的协议前缀。
// 遥控器打这 7 个字符很费劲——软键盘上 : 和 / 都要翻到符号页去找，而所有远程源
// 都以它开头。EPG 地址**不预填**：那个框留空是有语义的（留空才会回退到默认 EPG），
// 填上 http:// 会把「留空」这个状态毁掉。
const URL_PREFIX = 'http://';

function blankForm() {
  return { name: '', m3uUrl: URL_PREFIX, epgUrl: '' };
}

// 只剩协议前缀没有主机名，等同于没填——否则用户一进面板直接按保存
// 就会存进一个内容是 "http://" 的垃圾源。
function isBlankUrl(v) {
  const s = (v || '').trim();
  return !s || /^https?:\/\/$/i.test(s);
}

export class SourceManager {
  constructor(el) {
    this.el = el;
    this.sources = [];
    this.focusIdx = 0; // 0名称 1:M3U 2:EPG 3:保存按钮 4..:源列表
    this.form = blankForm();
    this.editingInput = false;

    this.onUseSource = null; // (source) => void
    this.onClose = null;

    this.testing = false; // 正在测试某个源
    this.testingIdx = -1; // 正在测试的源在列表中的下标
    this.testMsg = ''; // 测试进度/结果提示
    this._testRun = null; // 唯一活动任务；对象身份隔离关闭/重开后的迟到回调
    this.editingId = null; // 正在编辑的源 id（null=新增模式）

    // 鼠标：事件委托（点输入框编辑、点源使用、点 ✕ 删除，点面板外关闭）
    this.el.addEventListener('click', (e) => this._onClick(e));
  }

  _onClick(e) {
    // 鼠标用户没有返回键：点面板外的遮罩区即关闭
    if (!e.target.closest('.panel')) {
      this.close();
      return;
    }
    const hit = e.target.closest('[data-role]');
    if (!hit) return;
    const role = hit.dataset.role;
    if (role === 'close') {
      this.close();
      return;
    }
    // 取消编辑：退出编辑态，表单清空
    if (role === 'cancel-edit') {
      this._cancelEdit();
      return;
    }
    const rowEl = hit.closest('[data-idx]');
    const idx = rowEl ? parseInt(rowEl.dataset.idx, 10) : NaN;
    if (isNaN(idx)) return;
    // 测试按钮：不改变使用中的源，只对该行远程源做连通性检测
    if (role === 'test') {
      this._testSource(idx - 4);
      return;
    }
    // 编辑按钮：把该源载入顶部表单进入编辑态
    if (role === 'edit') {
      this._editSource(idx - 4);
      return;
    }
    // 正在编辑的输入框被再次点击：不重渲，避免打断输入与光标
    if (role === 'row' && idx <= 2 && this.editingInput && this.focusIdx === idx) return;
    this.focusIdx = idx;
    if (role === 'del') {
      this._deleteFocused();
      return;
    }
    this.render(); // 先同步高亮，后续键盘操作能从这里接上
    this._confirm(); // 输入框进编辑 / 保存按钮 / 使用该源
  }

  open() {
    this._cancelTest();
    this.sources = getSources();
    this.focusIdx = this.sources.length ? 4 : 0;
    this.form = blankForm();
    this.editingInput = false;
    this.editingId = null;
    this.el.classList.remove('hidden');
    this.render();
  }

  _rowCount() {
    return 4 + this.sources.length;
  }

  render() {
    if (this._testRun) {
      const src = this._currentTestSource(this._testRun);
      if (!src) this._cancelTest();
      else this.testingIdx = this.sources.indexOf(src);
    }
    const activeId = getActiveSourceId();
    const f = (i) => (this.focusIdx === i ? ' focused' : '');
    const editing = this.editingId
      ? this.sources.find((s) => s.id === this.editingId)
      : null;

    const listHtml = this.sources.length
      ? this.sources
          .map((s, i) => {
            const active = s.id === activeId ? t('sm.inUse') : '';
            const isRemote = /^https?:\/\//i.test(s.m3uUrl);
            const testing = this.testing && this.testingIdx === i;
            const valueText = testing ? esc(this.testMsg) : esc(s.m3uUrl).slice(0, 60) + '…';
            const testBtn = isRemote
              ? `<span class="row-test" data-role="test">${testing ? t('sm.testing') : t('sm.test')}</span>`
              : '';
            return `<div class="form-row${f(4 + i)}" data-role="row" data-idx="${4 + i}">
              <span class="label">${esc(s.name)} ${active}</span>
              <span class="value">${valueText}</span>
              ${testBtn}
              <span class="row-edit" data-role="edit">${t('sm.edit')}</span>
              <span class="row-del" data-role="del">${t('sm.delete')}</span>
            </div>`;
          })
          .join('')
      : `<div class="hint">${t('sm.empty')}</div>`;

    this.el.innerHTML = `
      <div class="panel">
        <div class="panel-close" data-role="close">✕</div>
        <h2>${t('sm.title')}</h2>
        ${editing ? `<div class="hint" style="color:#7fd6ff">${t('sm.editing', { name: esc(editing.name) })} <span class="row-edit" data-role="cancel-edit" style="margin-left:12px">${t('sm.cancelEdit')}</span></div>` : ''}
        <div class="form-row${f(0)}" data-role="row" data-idx="0">
          <span class="label">${t('sm.name')}</span>
          <input id="src-name" type="text" value="${esc(this.form.name)}" placeholder="${t('sm.namePlaceholder')}" />
        </div>
        <div class="form-row${f(1)}" data-role="row" data-idx="1">
          <span class="label">${t('sm.m3uUrl')}</span>
          <input id="src-m3u" type="text" value="${esc(this.form.m3uUrl)}" placeholder="${t('sm.m3uPlaceholder')}" />
        </div>
        <div class="form-row${f(2)}" data-role="row" data-idx="2">
          <span class="label">${t('sm.epgUrl')}</span>
          <input id="src-epg" type="text" value="${esc(this.form.epgUrl)}" placeholder="${t('sm.epgPlaceholder')}" />
        </div>
        <div class="btn-row">
          <div class="btn${f(3)}" data-role="row" data-idx="3">${editing ? t('sm.saveEdit') : t('sm.save')}</div>
        </div>
        <h2 style="font-size:34px;margin:32px 0 16px">${t('sm.saved')}</h2>
        <div class="src-list">${listHtml}</div>
        ${this.testMsg && !this.testing ? `<div class="hint" id="test-status" style="color:#4fd08a">${esc(this.testMsg)}</div>` : ''}
        <div class="hint">${t('sm.hint')}</div>
      </div>
    `;
    this._syncInputs();
    const focused = this.el.querySelector('.focused');
    if (focused && focused.scrollIntoView) focused.scrollIntoView({ block: 'center' });
  }

  _syncInputs() {
    // 输入框实时写回 form
    const bind = (id, key) => {
      const inp = this.el.querySelector('#' + id);
      if (inp) inp.oninput = () => { this.form[key] = inp.value; };
    };
    bind('src-name', 'name');
    bind('src-m3u', 'm3uUrl');
    bind('src-epg', 'epgUrl');
  }

  handleKey(code) {
    // 编辑输入框时，仅拦截返回键退出编辑，其余交给输入框
    if (this.editingInput) {
      if (code === KEY.BACK || code === KEY.OK) {
        this.editingInput = false;
        const active = document.activeElement;
        if (active && active.blur) active.blur();
        this.render();
        return true;
      }
      return false; // 让输入法处理
    }

    switch (code) {
      case KEY.UP:
        this.focusIdx = Math.max(0, this.focusIdx - 1);
        this.render();
        break;
      case KEY.DOWN:
        this.focusIdx = Math.min(this._rowCount() - 1, this.focusIdx + 1);
        this.render();
        break;
      case KEY.OK:
        this._confirm();
        break;
      case KEY.BLUE:
        this._deleteFocused();
        break;
      case KEY.GREEN:
        if (this.focusIdx >= 4) this._editSource(this.focusIdx - 4);
        break;
      case KEY.BACK:
        this.close();
        break;
      default:
        return false;
    }
    return true;
  }

  _confirm() {
    if (this.focusIdx <= 2) {
      // 聚焦到输入框并进入编辑
      const ids = ['src-name', 'src-m3u', 'src-epg'];
      const inp = this.el.querySelector('#' + ids[this.focusIdx]);
      if (inp) {
        this.editingInput = true;
        inp.focus();
        if (inp.setSelectionRange) inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    } else if (this.focusIdx === 3) {
      this._save();
    } else {
      // 使用已保存的源
      const s = this.sources[this.focusIdx - 4];
      if (s && this.onUseSource) {
        setActiveSourceId(s.id);
        this.onUseSource(s);
        this.close();
      }
    }
  }

  _save() {
    if (isBlankUrl(this.form.m3uUrl)) return;
    // 编辑态：更新原源（按 id），不新建，保存后留在面板
    if (this.editingId) {
      const s = this.sources.find((x) => x.id === this.editingId);
      if (s) {
        if (this._testRun && this._testRun.id === s.id) this._cancelTest();
        s.name = this.form.name.trim() || t('sm.unnamed');
        s.m3uUrl = this.form.m3uUrl.trim();
        s.epgUrl = this.form.epgUrl.trim();
        saveSources(this.sources);
        // 改的是正在使用的源：立即重载让改动生效
        if (getActiveSourceId() === s.id && this.onUseSource) this.onUseSource(s);
      }
      const idx = this.sources.findIndex((x) => x.id === this.editingId);
      this.editingId = null;
      this.form = blankForm();
      this.editingInput = false;
      this.focusIdx = idx >= 0 ? 4 + idx : this.sources.length ? 4 : 0;
      this.render();
      return;
    }
    const src = {
      id: 'src_' + Date.now(),
      name: this.form.name.trim() || t('sm.unnamed'),
      m3uUrl: this.form.m3uUrl.trim(),
      epgUrl: this.form.epgUrl.trim()
    };
    this.sources.push(src);
    saveSources(this.sources);
    setActiveSourceId(src.id);
    if (this.onUseSource) this.onUseSource(src);
    this.close();
  }

  // 把某个已保存源载入顶部表单进入编辑态；焦点移到名称输入框
  _editSource(srcIdx) {
    const s = this.sources[srcIdx];
    if (!s) return;
    if (this._testRun && this._testRun.id === s.id) this._cancelTest();
    this.editingId = s.id;
    this.form = {
      name: s.name || '',
      m3uUrl: s.m3uUrl || '',
      epgUrl: s.epgUrl || ''
    };
    this.focusIdx = 0;
    this.editingInput = false;
    this.render();
  }

  // 退出编辑态，清空表单
  _cancelEdit() {
    this.editingId = null;
    this.form = blankForm();
    this.editingInput = false;
    this.focusIdx = this.sources.length ? 4 : 0;
    this.render();
  }

  _deleteFocused() {
    if (this.focusIdx < 4) return;
    const idx = this.focusIdx - 4;
    const src = this.sources[idx];
    if (src && this._testRun && this._testRun.id === src.id) this._cancelTest();
    this.sources.splice(idx, 1);
    saveSources(this.sources);
    this.focusIdx = Math.min(this._rowCount() - 1, this.focusIdx);
    this.render();
  }

  _cancelTest() {
    const run = this._testRun;
    this._testRun = null;
    this.testing = false;
    this.testingIdx = -1;
    this.testMsg = '';
    if (run) run.controller.abort();
  }

  _currentTestSource(run) {
    if (this._testRun !== run || run.controller.signal.aborted || !this.isOpen()) return null;
    // 不按下标写回；同 id 被替换、M3U 被编辑，或者源已删除，均作废。
    return this.sources.find((s) => s === run.source && s.id === run.id && s.m3uUrl === run.m3uUrl) || null;
  }

  // 测试某个远程源：拉取最新 m3u，逐条实测可播性，把失效地址存入 src.deadUrls；
  // 加载该源时会据此剔除不可播频道（源全灭则删频道，空组不显示）。本地源不测试。
  async _testSource(srcIdx) {
    if (this._testRun) {
      if (this._currentTestSource(this._testRun)) return;
      this._cancelTest();
    }
    const src = this.sources[srcIdx];
    if (!this.isOpen() || !src || !/^https?:\/\//i.test(src.m3uUrl)) return;
    const run = { controller: new AbortController(), source: src, id: src.id, m3uUrl: src.m3uUrl };
    this._testRun = run;
    this.testing = true;
    this.testingIdx = srcIdx;
    this.testMsg = t('sm.pulling');
    const isCurrent = () => !!this._currentTestSource(run);
    const setRowMsg = (msg) => {
      if (!isCurrent()) return;
      this.testingIdx = this.sources.indexOf(src);
      this.testMsg = msg;
      const node = this.el.querySelector('[data-idx="' + (4 + this.testingIdx) + '"] .value');
      if (node) node.textContent = msg;
    };
    let resultMsg = '';
    try {
      this.render();
      // 源列表允许45s（与正常加载一致）；超时包括读体，关闭/编辑可立即取消。
      const { text, baseUrl } = await withResponse(run.m3uUrl, run.controller.signal, 45000, async (res, signal) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return { text: await getText(res, signal), baseUrl: responseBaseUrl(res, run.m3uUrl) };
      });
      if (!isCurrent()) return;
      const { channels } = parseM3U(text, baseUrl);
      const urlSet = new Set();
      for (const ch of channels) for (const s of ch.sources) urlSet.add(s.url);
      const urls = [...urlSet];
      if (!urls.length) throw new Error(t('sm.noTestable'));
      const dead = new Set();
      let done = 0;
      await runPool(urls, 20, async (u) => {
        const ok = await probeUrl(u, 1200, 2500, run.controller.signal);
        if (!isCurrent() || ok === null) return;
        if (!ok) dead.add(u);
        done++;
        if (done % 6 === 0 || done === urls.length) setRowMsg(t('sm.testingProgress', { done, total: urls.length }));
      }, isCurrent);
      if (!isCurrent()) return;
      // 频道级统计：所有源都失效才算该频道失效；整组全灭则连组一起移除
      let keptCh = 0;
      let deadCh = 0;
      const keptGroups = new Set();
      const deadGroups = new Set();
      for (const ch of channels) {
        const alive = ch.sources.some((s) => !dead.has(s.url));
        if (alive) {
          keptCh++;
          keptGroups.add(ch.group);
        } else {
          deadCh++;
          deadGroups.add(ch.group);
        }
      }
      let deadGroupCount = 0;
      for (const g of deadGroups) if (!keptGroups.has(g)) deadGroupCount++;
      // 只合并这个版本的测试结果，不用旧列表覆盖其它入口的新增/编辑/删除。
      const latest = getSources();
      const saved = latest.find((s) => s.id === run.id && s.m3uUrl === run.m3uUrl);
      if (!saved) {
        this._cancelTest();
        return;
      }
      src.deadUrls = [...dead];
      saved.deadUrls = src.deadUrls;
      saveSources(latest);
      resultMsg =
        t('sm.testDone', { kept: keptCh, dead: deadCh }) +
        (deadGroupCount ? t('sm.testDoneGroups', { n: deadGroupCount }) : '');
      // 回调可能同步关闭/重开面板；finally 仍需核对身份，不能重渲新任务。
      if (isCurrent() && getActiveSourceId() === run.id && this.onUseSource) this.onUseSource(saved);
    } catch (e) {
      if (isCurrent()) resultMsg = t('sm.testFailed', { msg: (e && e.message) || t('sm.netError') });
    } finally {
      const current = isCurrent();
      run.controller.abort();
      if (this._testRun === run) {
        this._testRun = null;
        this.testing = false;
        this.testingIdx = -1;
        this.testMsg = current ? resultMsg : '';
        if (current) this.render();
      }
    }
  }

  close() {
    this._cancelTest();
    this.editingInput = false;
    this.el.classList.add('hidden');
    if (this.onClose) this.onClose();
  }

  isOpen() {
    return !this.el.classList.contains('hidden');
  }
}
