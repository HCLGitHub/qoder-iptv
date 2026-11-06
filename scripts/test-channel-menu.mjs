// Run: node --test scripts/test-channel-menu.mjs
// 频道列虚拟化（窗口化渲染）的行为测试：无真实 DOM，用最小假元素模拟
// ChannelMenu 用到的接口（classList / children / scrollTop / innerHTML 行数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelMenu } from '../src/ui/ChannelMenu.js';

const CHAN_ROW_H = 100; // 与 ChannelMenu.js 内常量一致
const ROWS = 5000;

// node 下没有 rAF：同步执行，让 scroll 事件路径的合帧逻辑立即可断言
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
globalThis.cancelAnimationFrame = () => {};

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : !!force;
    if (want) this.set.add(c); else this.set.delete(c);
  }
}

class FakeStyle {
  constructor() { this.vars = {}; }
  setProperty(k, v) { this.vars[k] = v; }
}

class FakeEl {
  // rowClass：该容器行的顶层类名（如 'cm-channel-item'），用于从 innerHTML
  // 解析出行数与每行初始 class；null 表示纯容器（title/列壳），children 恒空。
  constructor(rowClass = null) {
    this.classList = new FakeClassList();
    this.children = [];
    this.style = new FakeStyle();
    this.scrollTop = 0;
    this.clientHeight = 900; // 视口 9 行
    this.textContent = '';
    this.dataset = {};
    this._listeners = {};
    this._htmlSets = 0;
    this._rowClass = rowClass;
  }
  set innerHTML(html) {
    this._htmlSets++;
    this._html = html;
    if (!this._rowClass) { this.children = []; return; }
    const re = new RegExp('class="(' + this._rowClass + '[^"]*)"', 'g');
    const kids = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      const el = new FakeEl(this._rowClass);
      for (const c of m[1].split(/\s+/)) if (c) el.classList.add(c);
      kids.push(el);
    }
    this.children = kids;
  }
  get innerHTML() { return this._html || ''; }
  addEventListener(type, fn) { this._listeners[type] = fn; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  scrollIntoView() {}
}

class FakeMenuRoot {
  constructor() {
    this.classList = new FakeClassList();
    this._listeners = {};
    this.byId = {
      'cm-group-list': new FakeEl('cm-group-item'),
      'cm-chan-list': new FakeEl('cm-channel-item'),
      'cm-chan-title': new FakeEl(),
      'cm-dates-col': new FakeEl(),
      'cm-epg-col': new FakeEl(),
      'cm-date-list': new FakeEl('cm-date-item'),
      'cm-epg-title': new FakeEl(),
      'cm-epg-list': new FakeEl('cm-epg-item'),
      'cm-settings': new FakeEl()
    };
  }
  addEventListener(type, fn) { this._listeners[type] = fn; }
  querySelector(sel) {
    if (sel.startsWith('#')) return this.byId[sel.slice(1)] || null;
    return null; // '.focused:not(...)' 等查询：跳过其它列的滚动定位
  }
}

function makeChannels() {
  const groups = ['A', 'B'];
  const channels = [];
  let n = 0;
  for (const g of groups) {
    for (let i = 0; i < ROWS / 2; i++) {
      n++;
      channels.push({
        key: 'ch:' + g + '|' + n,
        name: g + '-' + i,
        epgName: g + '-' + i,
        group: g,
        sources: [{ url: 'http://s/' + n }],
        sourceIdx: 0,
        chno: String(n),
        index: n
      });
    }
  }
  return channels;
}

function setup() {
  const el = new FakeMenuRoot();
  const menu = new ChannelMenu(el);
  const channels = makeChannels();
  const played = [];
  menu.onPlayLive = (ch) => played.push(ch.key);
  menu.onClose = () => { menu._closed = true; };
  return { el, menu, channels, played };
}

test('opening a 5000-channel group renders only the window, padding spans full height', () => {
  const { el, menu, channels } = setup();
  menu.open(channels, channels[0].key);
  const list = el.byId['cm-chan-list'];
  const inGroup = ROWS / 2; // 菜单定位到当前频道所在分组（A 组）
  assert.equal(menu.isOpen(), true);
  assert.equal(list.children.length, 19); // 视口 9 行 + 上下各 5 缓冲
  assert.equal(list.style.vars['--sp-top'], '0px');
  assert.equal(list.style.vars['--sp-bottom'], (inGroup - 19) * CHAN_ROW_H + 'px');
  assert.equal(menu._winStart, 0);
  menu.close();
});

test('arrow navigation moves focus classes without rebuilding the channel DOM', () => {
  const { el, menu, channels } = setup();
  menu.open(channels, channels[0].key);
  const list = el.byId['cm-chan-list'];
  const firstRow = list.children[0];
  const builds = list._htmlSets;
  menu.handleKey(40); // DOWN
  menu.handleKey(40);
  assert.equal(list._htmlSets, builds, 'no innerHTML rebuild while focus stays in window');
  assert.equal(list.children[0], firstRow, 'row elements are reused (logos not reloaded)');
  assert.equal(list.children.length, 19);
  assert.equal(menu.chanIdx, 2);
  assert.equal(list.children[2].classList.contains('focused'), true);
  assert.equal(list.children[0].classList.contains('focused'), false);
  menu.close();
});

test('focus beyond the viewport shifts the window and syncs scrollTop', () => {
  const { el, menu, channels } = setup();
  menu.open(channels, channels[0].key);
  const list = el.byId['cm-chan-list'];
  for (let i = 0; i < 10; i++) menu.handleKey(40); // 第 9 步焦点顶到视口底沿触发平移
  assert.equal(menu.chanIdx, 10);
  assert.equal(menu._winStart, 5); // i=9 越出 9 行视口 → 平移到 9-4
  assert.equal(list.scrollTop, 5 * CHAN_ROW_H);
  assert.equal(list.children.length, 19);
  assert.equal(list.children[5].classList.contains('focused'), true); // 10 - 5
  menu.close();
});

test('opening near the end of the list centers the window without overrunning', () => {
  const { el, menu, channels } = setup();
  const target = channels[ROWS - 5]; // B 组成员：组内索引 = 全表索引 - 2500
  menu.open(channels, target.key);
  const list = el.byId['cm-chan-list'];
  const inGroup = ROWS - 5 - ROWS / 2;
  assert.equal(menu.chanIdx, inGroup);
  assert.equal(menu._winStart, inGroup - 4);
  assert.equal(list.scrollTop, menu._winStart * CHAN_ROW_H);
  assert.equal(list.children.length, 9); // 贴尾：B 组只剩从 2491 到末尾的 9 行
  assert.equal(list.children[4].classList.contains('focused'), true);
  menu.close();
});

test('clicking a channel row plays it and closes the menu', () => {
  const { el, menu, channels, played } = setup();
  menu.open(channels, channels[0].key);
  menu._onClick({ target: { closest: () => ({ dataset: { role: 'chan', idx: '3' } }) } });
  assert.deepEqual(played, [channels[3].key]);
  assert.equal(menu.isOpen(), false);
  assert.equal(menu._closed, true);
});

test('switching groups re-anchors the window to the top of the new group', () => {
  const { el, menu, channels } = setup();
  menu.open(channels, channels[0].key);
  for (let i = 0; i < 30; i++) menu.handleKey(40); // 深入 A 组
  menu.handleKey(37); // LEFT -> 分组列
  menu.handleKey(40); // DOWN -> B 组
  menu.handleKey(39); // RIGHT -> 回频道列
  assert.equal(menu.groupIdx, 1);
  assert.equal(menu.chanIdx, 0);
  const list = el.byId['cm-chan-list'];
  assert.equal(menu._winStart, 0);
  assert.equal(list.scrollTop, 0);
  assert.equal(list.children.length, 19);
  menu.close();
});

test('scroll events re-anchor the window by scrollTop (mouse wheel path)', () => {
  const { el, menu, channels } = setup();
  menu.open(channels, channels[0].key);
  const list = el.byId['cm-chan-list'];
  list.scrollTop = 2000 * CHAN_ROW_H;
  list._listeners.scroll();
  assert.equal(menu._winStart, 2000 - 5);
  assert.equal(list.children.length, 19);
  // 滚回顶部
  list.scrollTop = 0;
  list._listeners.scroll();
  assert.equal(menu._winStart, 0);
  menu.close();
});

test('date column shows the escaped catch-up probe note and re-asks only when it opens or switches channel', () => {
  const { el, menu, channels } = setup();
  const probed = [];
  menu.onProbeCatchup = (ch, opts) => probed.push({ key: ch.key, recheck: !!(opts && opts.recheck) });
  menu.catchupNote = (ch) => 'No catch-up <' + ch.name + '>';
  menu.open(channels, channels[0].key);
  assert.equal(probed.length, 0, 'channel column alone does not probe');
  menu.handleKey(39); // RIGHT -> 日期栏
  const title = el.byId['cm-epg-title'].innerHTML;
  assert.ok(probed.some((p) => p.key === channels[0].key));
  assert.equal(probed[0].recheck, true, 'expanding the date column asks for a fresh check');
  assert.match(title, /<span class="cm-cu-note">No catch-up &lt;A-0&gt;<\/span>$/);

  menu.render(); // 探测结果写回后的重渲染
  assert.equal(probed.length, 2);
  assert.equal(probed[1].recheck, false, 'plain re-render does not ask again');

  menu.handleKey(37); // LEFT -> 回到频道栏
  menu.handleKey(39); // 再次展开
  assert.equal(probed.at(-1).recheck, true, 'reopening asks again');
  menu.close();
});

test('date column title has no note span when nothing to report', () => {
  const { el, menu, channels } = setup();
  menu.catchupNote = () => '';
  menu.open(channels, channels[0].key);
  menu.handleKey(39);
  assert.doesNotMatch(el.byId['cm-epg-title'].innerHTML, /cm-cu-note/);
  menu.close();
});
