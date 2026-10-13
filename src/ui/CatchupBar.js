// 回看控制条：一条进度条。
// 交互：左/右 = 快退/快进（长按累积预览位置，停手 400ms 后一次性跳转）；OK = 立即提交。
import { KEY } from '../core/keys.js';
import { t } from '../core/i18n.js';

const HIDE_MS = 6000;

function fmtSec(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

export class CatchupBar {
  constructor(el, player) {
    this.el = el;
    this.player = player;
    this.programme = null;
    this._timer = null;
    this._hideTimer = null;
    // 长按连续快进：先在进度条上累积预览位置，停手后一次性跳转
    this._preview = null;
    this._previewDir = 0;
    this._repeat = 0;
    this._commitTimer = null;
  }

  get video() {
    return this.player.video;
  }

  show(programme) {
    this.programme = programme || null;
    this._preview = null;
    this._previewDir = 0;
    this._repeat = 0;
    this.el.classList.remove('hidden');
    this.render();
    this._startTick();
    this._scheduleHide();
  }

  hide() {
    this._commitSeek(); // 关闭前落实未提交的快进
    this.el.classList.add('hidden');
    this._stopTick();
    clearTimeout(this._hideTimer);
  }

  isOpen() {
    return !this.el.classList.contains('hidden');
  }

  _startTick() {
    this._stopTick();
    this._timer = setInterval(() => this._tick(), 500);
  }
  _stopTick() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _scheduleHide() {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.hide(), HIDE_MS);
  }

  // 每个节目的时长与进度：优先用媒体自身 duration，其次用 EPG 节目时长
  // 长按快进期间用预览位置（_preview）而非真实 currentTime，保证进度条跟手
  _progress() {
    const v = this.video;
    let dur = v && isFinite(v.duration) ? v.duration : NaN;
    if (!isFinite(dur) && this.programme && this.programme.stop && this.programme.start) {
      dur = (this.programme.stop - this.programme.start) / 1000;
    }
    const real = v ? v.currentTime || 0 : 0;
    const cur = this._preview != null ? this._preview : real;
    const pct = isFinite(dur) && dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
    return { cur, dur, pct };
  }

  // 连按次数越多步进越大：基准步进随 _repeat 递增（10s → 最多 5 分钟级）
  _seekStep() {
    const { dur } = this._progress();
    const base = isFinite(dur) && dur > 0 ? Math.max(10, dur * 0.02) : 30;
    const accel = Math.min(8, 1 + Math.floor(this._repeat / 3));
    return base * accel;
  }

  // 长按/连按快进：累积预览位置，停手 400ms 后真正跳转（避免每次按键都触发缓冲）
  _seekBy(dir) {
    const { dur } = this._progress();
    if (this._previewDir === dir) this._repeat += 1;
    else { this._repeat = 0; this._previewDir = dir; }

    const from = this._preview != null ? this._preview : (this.video ? this.video.currentTime || 0 : 0);
    let next = from + dir * this._seekStep();
    const max = isFinite(dur) && dur > 0 ? dur - 1 : Infinity;
    this._preview = Math.min(max, Math.max(0, next));
    this._tick();

    clearTimeout(this._commitTimer);
    this._commitTimer = setTimeout(() => this._commitSeek(), 400);
  }

  // 把预览位置真正应用到播放器
  _commitSeek() {
    clearTimeout(this._commitTimer);
    this._commitTimer = null;
    if (this._preview == null) return;
    const target = this._preview;
    this._preview = null;
    this._previewDir = 0;
    this._repeat = 0;
    try {
      this.video.currentTime = target;
    } catch (e) {}
    this._tick();
  }

  // 仅更新进度显示，避免整条重渲染打断焦点
  _tick() {
    const { cur, dur, pct } = this._progress();
    const fill = this.el.querySelector('.cb-fill');
    const knob = this.el.querySelector('.cb-knob');
    const curEl = this.el.querySelector('.cb-cur');
    const durEl = this.el.querySelector('.cb-dur');
    if (fill) fill.style.width = pct + '%';
    if (knob) knob.style.left = pct + '%';
    if (curEl) {
      curEl.textContent = fmtSec(cur);
      curEl.classList.toggle('seeking', this._preview != null);
    }
    if (durEl) durEl.textContent = isFinite(dur) && dur > 0 ? fmtSec(dur) : '--:--';
  }

  render() {
    const { cur, dur, pct } = this._progress();
    const title = this.programme ? this.programme.title : t('cb.catchup');

    // 只有一行，恒为焦点态（.focused 同时把进度条加粗、滑块放大）
    this.el.innerHTML = `
      <div class="cb-title">${t('cb.title', { title: this._esc(title) })}</div>
      <div class="cb-progress-row focused" data-role="progress">
        <span class="cb-cur">${fmtSec(cur)}</span>
        <div class="cb-bar"><i class="cb-fill" style="width:${pct}%"></i><b class="cb-knob" style="left:${pct}%"></b></div>
        <span class="cb-dur">${isFinite(dur) && dur > 0 ? fmtSec(dur) : '--:--'}</span>
      </div>
    `;
  }

  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );
  }

  handleKey(code) {
    switch (code) {
      // 上/下键在回看态里仍然由控制条吃掉：交回上层会走到「切换频道」，
      // 那等于丢掉当前回看位置，误触代价太大。只把控制条唤出来、续上隐藏倒计时。
      case KEY.UP:
      case KEY.DOWN:
        this._ensureVisible();
        this._scheduleHide();
        return true;
      case KEY.LEFT:
        this._ensureVisible();
        this._seekBy(-1);
        this._scheduleHide();
        return true;
      case KEY.RIGHT:
        this._ensureVisible();
        this._seekBy(1);
        this._scheduleHide();
        return true;
      case KEY.OK:
        // 快进预览中按 OK 立即跳转；没有待提交的预览就交回上层（开频道菜单）
        if (this._preview != null) {
          this._commitSeek();
          this._scheduleHide();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  // 鼠标点击（Magic Remote 指针）：点进度条只做唤出与续时
  onClick(e) {
    const item = e.target.closest('[data-role]');
    if (!item) return false;
    if (item.dataset.role === 'progress') {
      this._ensureVisible();
      this._scheduleHide();
      return true;
    }
    return false;
  }

  _ensureVisible() {
    if (!this.isOpen()) {
      this.el.classList.remove('hidden');
      this._startTick();
    }
  }
}
