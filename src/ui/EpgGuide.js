// 全屏 EPG 节目指南：日期切换 × 频道 × 节目，支持选中过往节目回看
import { KEY } from '../core/keys.js';
import { epgStore } from '../core/epgStore.js';
import { isCatchupAvailable } from '../core/catchup.js';
import { fmtTime, fmtDayLabel, esc } from '../core/util.js';
import { t, getLang } from '../core/i18n.js';

// 日期范围：前 7 天 .. 今天 .. 后 2 天
const DAY_OFFSETS = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2];

export class EpgGuide {
  constructor(el) {
    this.el = el;
    this.channels = [];
    this.zone = 1; // 0=日期 1=频道 2=节目
    this.dayPos = 7; // 指向 DAY_OFFSETS 中"今天"
    this.chanIdx = 0;
    this.progIdx = 0;
    this.progList = [];

    this.onPlayLive = null;
    this.onPlayCatchup = null;
    this.onClose = null;
    // 渲染时回调，用于探测该频道所在网关支不支持回看（见 main.js）
    this.onProbeCatchup = null;

    // 鼠标：事件委托（点击选择/进入）
    this.el.addEventListener('click', (e) => this._onClick(e));
  }

  _onClick(e) {
    const item = e.target.closest('[data-role]');
    if (!item) return;
    const role = item.dataset.role;
    const idx = parseInt(item.dataset.idx, 10);
    if (role === 'day') {
      this.zone = 0;
      this.dayPos = idx;
      this._loadProg();
      this.render();
    } else if (role === 'chan') {
      this.zone = 1;
      this.chanIdx = idx;
      this._loadProg();
      this.render();
    } else if (role === 'prog') {
      this.zone = 2;
      this.progIdx = idx;
      this._confirm();
    }
  }

  open(channels, currentKey) {
    // 保留有 EPG 匹配名的频道（DIYP 按名匹配，几乎都有）
    this.channels = channels.filter((c) => c.epgName || c.tvgId);
    if (!this.channels.length) this.channels = channels;
    this.dayPos = 7;
    this.zone = 1;
    let idx = this.channels.findIndex((c) => c.key === currentKey);
    this.chanIdx = idx >= 0 ? idx : 0;
    this.progIdx = 0;
    this._loadProg();
    this.el.classList.remove('hidden');
    this.render();
  }

  _curChannel() {
    return this.channels[this.chanIdx] || null;
  }
  _curOffset() {
    return DAY_OFFSETS[this.dayPos];
  }

  _loadProg() {
    const ch = this._curChannel();
    this.progList = ch ? epgStore.getDayProgrammes(ch, this._curOffset()) : [];
    this.progIdx = 0;
  }

  // 异步 EPG 到达时重新查询当前频道/日期，按开始时间保留节目焦点，不切换导航区。
  refreshEpg() {
    if (!this.isOpen()) return;
    const focused = this.progList[this.progIdx];
    const ch = this._curChannel();
    this.progList = ch ? epgStore.getDayProgrammes(ch, this._curOffset()) : [];
    const idx = focused ? this.progList.findIndex((p) => p.start === focused.start) : -1;
    const oldIdx = Number.isInteger(this.progIdx) ? this.progIdx : 0;
    this.progIdx = idx >= 0 ? idx : this.progList.length
      ? Math.min(Math.max(0, oldIdx), this.progList.length - 1) : -1;
    this.render();
  }

  render() {
    this._ensureSkeleton();
    this._renderDays();
    this._renderChans();
    this._renderProgs();
    const f = this.el.querySelector('.focused');
    if (f && f.scrollIntoView) f.scrollIntoView({ block: 'center' });
  }

  // 骨架只建一次，三个列表各自更新。
  // 原来每次 render() 都把整个面板 innerHTML 重写一遍，而频道列可以有上千行：
  // 在节目列里按一下上/下键（只动了一个焦点）也要把上千个频道 div 拆了重建。
  // 电视的弱 CPU 上这直接表现为按键延迟。
  _ensureSkeleton() {
    // 标题是建骨架时写死的文案，切换语言后必须重建
    if (this._skeletonLang === getLang() && this.el.querySelector('#eg-chan-col')) return;
    this.el.innerHTML = `
      <div class="eg-head">
        <div class="eg-title">${t('eg.title')}</div>
        <div class="eg-days" id="eg-day-list"></div>
      </div>
      <div class="eg-body">
        <div class="eg-chan-col" id="eg-chan-col"></div>
        <div class="eg-prog-col" id="eg-prog-col"></div>
      </div>`;
    this._skeletonLang = getLang();
    this._chanSig = null; // 骨架重建后频道列需强制重绘
    this._chanArr = null;
    this._paintedAct = null;
    this._paintedFoc = null;
  }

  _renderDays() {
    const el = this.el.querySelector('#eg-day-list');
    if (!el) return;
    el.innerHTML = DAY_OFFSETS.map((off, i) => {
      const cls =
        'eg-day' +
        (i === this.dayPos ? ' active' : '') +
        (this.zone === 0 && i === this.dayPos ? ' focused' : '');
      return `<div class="${cls}" data-role="day" data-idx="${i}">${fmtDayLabel(off)}</div>`;
    }).join('');
  }

  // 频道列：内容（频道集合 + 语言）没变就只改高亮类，不重建 DOM。
  // 条目里只有台号和台名，与 EPG 数据无关，所以节目单到达也不需要重建它。
  _renderChans() {
    const el = this.el.querySelector('#eg-chan-col');
    if (!el) return;
    const sig = getLang() + '|' + this.channels.length;
    if (sig !== this._chanSig || this.channels !== this._chanArr) {
      this._chanSig = sig;
      this._chanArr = this.channels;
      el.innerHTML = this.channels
        .map(
          (ch, i) =>
            `<div class="eg-chan" data-role="chan" data-idx="${i}">${esc(String(ch.chno || ch.index))}. ${esc(ch.name)}</div>`
        )
        .join('');
      this._paintedAct = null; // innerHTML 抹掉了所有类，下面按当前状态重新点亮
      this._paintedFoc = null;
    }
    // 高亮只动「变化的那两个条目」，不遍历全列：几千行上逐个 toggle 一遍
    // 同样是几千次 DOM 操作，而每次按键真正改变状态的最多两行。
    const items = el.children;
    const set = (i, cls, on) => {
      const n = i >= 0 && items[i];
      if (n) n.classList.toggle(cls, on);
    };
    if (this._paintedAct !== this.chanIdx) {
      if (this._paintedAct != null) set(this._paintedAct, 'active', false);
      set(this.chanIdx, 'active', true);
      this._paintedAct = this.chanIdx;
    }
    const foc = this.zone === 1 ? this.chanIdx : -1;
    if (this._paintedFoc !== foc) {
      if (this._paintedFoc != null) set(this._paintedFoc, 'focused', false);
      set(foc, 'focused', true);
      this._paintedFoc = foc;
    }
  }

  _renderProgs() {
    const el = this.el.querySelector('#eg-prog-col');
    if (!el) return;
    const ch = this._curChannel();
    // 顺手探一次回看能力（去重和缓存在 main.js 那侧做）
    if (ch && !ch.catchup && this.onProbeCatchup) this.onProbeCatchup(ch);
    const now = Date.now();
    el.innerHTML = this.progList.length
      ? this.progList
          .map((p, i) => {
            const playing = now >= p.start && now < (isNaN(p.stop) ? p.start + 3600000 : p.stop);
            const canCatchup = isCatchupAvailable(ch, p, ch.catchupDays || 7);
            const cls =
              'eg-prog' +
              (playing ? ' now' : '') +
              (this.zone === 2 && i === this.progIdx ? ' focused' : '');
            const badge = canCatchup ? `<span class="catchup">${t('eg.catchup')}</span>` : '';
            return `<div class="${cls}" data-role="prog" data-idx="${i}"><span class="t">${fmtTime(p.start)}-${fmtTime(p.stop)}</span><span class="p">${esc(p.title)}</span>${badge}</div>`;
          })
          .join('')
      : `<div class="eg-prog"><span class="p" style="color:#808a94">${t('eg.noEpg')}</span></div>`;
  }

  handleKey(code) {
    switch (code) {
      case KEY.UP:
        this._move(-1);
        break;
      case KEY.DOWN:
        this._move(1);
        break;
      case KEY.LEFT:
        this._horizontal(-1);
        break;
      case KEY.RIGHT:
        this._horizontal(1);
        break;
      case KEY.OK:
        this._confirm();
        break;
      case KEY.BACK:
        this.close();
        break;
      default:
        return false;
    }
    return true;
  }

  _move(dir) {
    if (this.zone === 0) {
      // 日期区上下 -> 切到频道区
      if (dir === 1) { this.zone = 1; this.render(); }
      return;
    }
    if (this.zone === 1) {
      const n = this.channels.length;
      if (!n) return;
      this.chanIdx = (this.chanIdx + dir + n) % n;
      this._loadProg();
    } else if (this.zone === 2) {
      const n = this.progList.length;
      if (!n) return;
      this.progIdx = (this.progIdx + dir + n) % n;
    }
    this.render();
  }

  _horizontal(dir) {
    if (this.zone === 0) {
      const n = DAY_OFFSETS.length;
      this.dayPos = Math.min(n - 1, Math.max(0, this.dayPos + dir));
      this._loadProg();
    } else if (this.zone === 1) {
      if (dir === 1) this.zone = 2; // 频道 -> 节目
      else this.zone = 0; // 频道 -> 日期
    } else if (this.zone === 2) {
      if (dir === -1) this.zone = 1; // 节目 -> 频道
    }
    this.render();
  }

  _confirm() {
    const ch = this._curChannel();
    if (!ch) return;
    if (this.zone === 2) {
      const p = this.progList[this.progIdx];
      if (!p) return;
      const now = Date.now();
      const playing = now >= p.start && now < (isNaN(p.stop) ? p.start + 3600000 : p.stop);
      if (playing) {
        if (this.onPlayLive) { this.onPlayLive(ch); this.close(); }
      } else if (isCatchupAvailable(ch, p, ch.catchupDays || 7)) {
        if (this.onPlayCatchup) { this.onPlayCatchup(ch, p); this.close(); }
      }
    } else {
      // 在频道区确认 -> 直接播直播
      if (this.onPlayLive) { this.onPlayLive(ch); this.close(); }
    }
  }

  close() {
    this.el.classList.add('hidden');
    if (this.onClose) this.onClose();
  }

  isOpen() {
    return !this.el.classList.contains('hidden');
  }
}
