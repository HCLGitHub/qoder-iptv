// 回看控制条：上一行进度、下一行倍速。
// 交互：上/下 = 在两行间切焦点；进度行左/右 = 快退/快进（长按累积预览位置，停手 400ms 后一次性跳转），
// 倍速行左/右 = 换档（停手 600ms 后按当前位置重载一次）；OK = 立即提交快进。
import { KEY } from '../core/keys.js';
import { t } from '../core/i18n.js';

const HIDE_MS = 6000;
const RATES = [0.5, 1, 1.25, 1.5, 1.75, 2, 2.5];

function fmtSec(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

function fmtRate(r) {
  return r + '×';
}

export class CatchupBar {
  constructor(el, player, badgeEl) {
    this.el = el;
    this.player = player;
    this.badge = badgeEl || null; // 非 1× 时控制条收起后的常驻角标
    this.programme = null;
    this._row = 'progress';
    this._active = false;
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
    this._active = true;
    this._row = 'progress';
    this._preview = null;
    this._previewDir = 0;
    this._repeat = 0;
    this.el.classList.remove('hidden');
    this.render();
    this._startTick();
    this._scheduleHide();
    this._syncBadge();
  }

  hide() {
    this._commitSeek(); // 关闭前落实未提交的快进
    this.el.classList.add('hidden');
    this._row = 'progress'; // 再唤出时左右键默认还是快进快退
    this._stopTick();
    clearTimeout(this._hideTimer);
    this._syncBadge();
  }

  // 离开回看：控制条和倍速角标一起收掉
  close() {
    this._active = false;
    this.hide();
  }

  isOpen() {
    return !this.el.classList.contains('hidden');
  }

  // 倍速被播放器改动过（引擎失败回 1× 等）：刷新倍速行和角标
  syncRate() {
    this._renderSpeed();
    this._syncBadge();
  }

  _syncBadge() {
    if (!this.badge) return;
    const r = this.player.rate;
    const on = this._active && !this.isOpen() && this.player.isCatchup() && r !== 1;
    if (on) this.badge.textContent = fmtRate(r);
    this.badge.classList.toggle('hidden', !on);
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
  // 长按快进期间用预览位置（_preview）而非真实位置，保证进度条跟手
  _progress() {
    const v = this.video;
    let dur = v && isFinite(v.duration) ? v.duration : NaN;
    if (!isFinite(dur) && this.programme && this.programme.stop && this.programme.start) {
      dur = (this.programme.stop - this.programme.start) / 1000;
    }
    const cur = this._preview != null ? this._preview : this.player.position();
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

    const from = this._preview != null ? this._preview : this.player.position();
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
    this.player.seekTo(target);
    this._tick();
  }

  // 按档位表左右挪一格。音频上下文必须在按键回调里同步唤醒，否则倍速时没声
  _stepRate(dir) {
    this.player.primeAudio();
    let i = RATES.indexOf(this.player.rate);
    if (i < 0) i = RATES.indexOf(1);
    const j = Math.min(RATES.length - 1, Math.max(0, i + dir));
    if (j !== i) this._setRate(RATES[j]);
  }

  _setRate(r) {
    this.player.setRate(r);
    this._renderSpeed();
  }

  _focusRow(row) {
    if (row !== this._row) this._commitSeek();
    this._row = row;
    this.el.querySelectorAll('[data-role]').forEach((n) => {
      n.classList.toggle('focused', n.dataset.role === row);
    });
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
    this._updateSpeedNote();
  }

  // 倍速行右侧：能倍速时给操作提示/引擎诊断，不能时写原因
  _updateSpeedNote() {
    const note = this.el.querySelector('.cb-note');
    if (!note) return;
    const p = this.player;
    const reason = p.speedBlocked();
    const pending = p.rateSettling();
    const on = this.el.querySelector('.cb-rate.on');
    if (on) on.classList.toggle('pending', pending);
    let text = t('cb.speedHint');
    if (reason && reason !== 'live') {
      text = t('rate.' + reason);
    } else {
      const s = p.rateStats();
      if (s) text = this._diag(s);
    }
    note.textContent = text;
    note.classList.toggle('warn', !!reason);
  }

  _diag(s) {
    const parts = [s.path];
    if (isFinite(s.drift)) parts.push('drift ' + Math.round(s.drift * 1000) + 'ms');
    parts.push('under ' + (s.underruns || 0));
    if (s.decErrors) parts.push('err ' + s.decErrors);
    if (isFinite(s.dropped)) parts.push('drop ' + (s.dropped * 100).toFixed(1) + '%');
    return parts.join(' · ');
  }

  _speedInner() {
    const cur = this.player.rate;
    const items = RATES.map(
      (r) => `<span class="cb-rate${r === cur ? ' on' : ''}" data-rate="${r}">${fmtRate(r)}</span>`
    ).join('');
    return `<span class="cb-label">${t('cb.speed')}</span><div class="cb-rates">${items}</div><span class="cb-note"></span>`;
  }

  _renderSpeed() {
    const row = this.el.querySelector('.cb-speed-row');
    if (!row) return;
    row.innerHTML = this._speedInner();
    this._updateSpeedNote();
  }

  render() {
    const { cur, dur, pct } = this._progress();
    const title = this.programme ? this.programme.title : t('cb.catchup');
    const f = (row) => (this._row === row ? ' focused' : '');

    this.el.innerHTML = `
      <div class="cb-title">${t('cb.title', { title: this._esc(title) })}</div>
      <div class="cb-progress-row${f('progress')}" data-role="progress">
        <span class="cb-cur">${fmtSec(cur)}</span>
        <div class="cb-bar"><i class="cb-fill" style="width:${pct}%"></i><b class="cb-knob" style="left:${pct}%"></b></div>
        <span class="cb-dur">${isFinite(dur) && dur > 0 ? fmtSec(dur) : '--:--'}</span>
      </div>
      <div class="cb-speed-row${f('speed')}" data-role="speed">${this._speedInner()}</div>
    `;
    this._updateSpeedNote();
  }

  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );
  }

  handleKey(code) {
    switch (code) {
      // 上/下键在回看态里仍然由控制条吃掉：交回上层会走到「切换频道」，
      // 那等于丢掉当前回看位置，误触代价太大。收起时只唤出，展开时在两行间切换。
      case KEY.UP:
      case KEY.DOWN:
        if (this.isOpen()) this._focusRow(this._row === 'progress' ? 'speed' : 'progress');
        else this._ensureVisible();
        this._scheduleHide();
        return true;
      case KEY.LEFT:
      case KEY.RIGHT: {
        const dir = code === KEY.LEFT ? -1 : 1;
        this._ensureVisible();
        if (this._row === 'speed') this._stepRate(dir);
        else this._seekBy(dir);
        this._scheduleHide();
        return true;
      }
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

  // 鼠标点击（Magic Remote 指针）：点倍速档直接换档，点行只切焦点与续时
  onClick(e) {
    const rate = e.target.closest('[data-rate]');
    if (rate) {
      this.player.primeAudio();
      this._ensureVisible();
      this._focusRow('speed');
      this._setRate(Number(rate.dataset.rate));
      this._scheduleHide();
      return true;
    }
    const item = e.target.closest('[data-role]');
    if (!item) return false;
    this._ensureVisible();
    this._focusRow(item.dataset.role);
    this._scheduleHide();
    return true;
  }

  _ensureVisible() {
    if (!this.isOpen()) {
      this.el.classList.remove('hidden');
      this.render();
      this._startTick();
      this._syncBadge();
    }
  }
}
