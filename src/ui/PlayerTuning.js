// 播放器参数面板：把 hls.js 里几个真正有杠杆的参数开放给用户，在真机上直接试。
//
// 为什么要有这个面板：起播快慢、缓冲厚薄、抗抖动能力，在开发机和模拟器上根本量不出来
// ——PC 解码快、带宽足，瓶颈不出现。只有电视本机（尤其 4K HEVC 高码率源）才是有效的
// 测量场地，所以把调参权交给用户，让他一边看一边试。
//
// 面板顶部会显示「当前实际走的哪条解码路」：hls.js 的参数在系统原生解码路径下
// 一点作用都没有，不说明的话用户会白调半天。
import { KEY } from '../core/keys.js';
import { t } from '../core/i18n.js';
import {
  TUNING_SPECS,
  getTuning,
  saveTuning,
  resetTuning,
  cycleValue,
  formatValue,
  isAllDefault
} from '../player/tuning.js';

export class PlayerTuning {
  constructor(el) {
    this.el = el;
    this.focusIdx = 0;
    this.tuning = getTuning();
    this.activePath = ''; // 'hls' | 'native' | ''，由 open() 传入
    this.dirty = false; // 本次打开期间是否改过参数（决定关闭时要不要重新起播）

    this.onApply = null; // (tuning) => void，关闭时若有改动则回调，由外部重播当前频道
    this.onWarmChange = null;
    this.getWarmStatus = null;
    this.onClose = null;
    this._warmTimer = null;

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
    if (hit.dataset.role === 'close') {
      this.close();
      return;
    }
    const rowEl = hit.closest('[data-idx]');
    const idx = rowEl ? parseInt(rowEl.dataset.idx, 10) : NaN;
    if (isNaN(idx)) return;
    this.focusIdx = idx;
    this.render(); // 先同步高亮，后续键盘操作能从这里接上
    if (hit.dataset.role === 'dec') this._cycle(-1);
    else if (hit.dataset.role === 'inc') this._cycle(1);
    else this._confirm();
  }

  _specs() {
    return TUNING_SPECS.filter((s) => !s.warm || this.tuning.prefetchSegmentBytes > 0);
  }

  // 参数行 + 末尾一个「恢复默认」按钮
  _rowCount() {
    return this._specs().length + 1;
  }

  open(activePath) {
    this.activePath = activePath || '';
    this.tuning = getTuning();
    this.focusIdx = 0;
    this.dirty = false;
    this.el.classList.remove('hidden');
    this.render();
    clearInterval(this._warmTimer);
    this._warmTimer = setInterval(() => this._refreshWarmStatus(), 1000);
  }

  render() {
    const specs = this._specs();
    this.focusIdx = Math.min(this.focusIdx, specs.length);
    const rows = specs.map((s, i) => {
      const cls = 'form-row' + (i === this.focusIdx ? ' focused' : '');
      const v = this.tuning[s.key];
      // 默认值显示成灰色、改过的显示成高亮色，扫一眼就知道自己动过哪几项
      const valCls = 'value' + (v === s.def ? ' off' : '');
      return `<div class="${cls}" data-role="row" data-idx="${i}" data-key="${s.key}">
          <span class="label">${t('tune.' + s.key)}</span>
          <span class="${valCls}"><b class="arrow" data-role="dec">◄</b>${formatValue(
        s.key,
        v
      )}<b class="arrow" data-role="inc">►</b></span>
        </div>`;
    }).join('');

    // 当前解码路径提示：hls.js 才受这些参数影响
    const pathKey =
      this.activePath === 'hls'
        ? 'tune.pathHls'
        : this.activePath === 'native'
        ? 'tune.pathNative'
        : 'tune.pathIdle';
    const pathColor =
      this.activePath === 'hls' ? '#4fd08a' : this.activePath === 'native' ? '#ffb74d' : '#808a94';

    // 焦点参数的说明。放在列表下方固定一块，避免随焦点移动导致布局跳动。
    const focusSpec = specs[this.focusIdx];
    const desc = focusSpec
      ? t('tune.' + focusSpec.key + '.d')
      : t(isAllDefault(this.tuning) ? 'tune.allDefault' : 'tune.modified');

    const btnIdx = specs.length;
    this.el.innerHTML = `
      <div class="panel">
        <div class="panel-close" data-role="close">✕</div>
        <h2>${t('tune.title')}</h2>
        <div class="hint" style="color:${pathColor}">${t(pathKey)}</div>
        <div class="hint tune-warm-status${this.tuning.prefetchSegmentBytes > 0 ? '' : ' hidden'}"></div>
        <div class="src-list">${rows}</div>
        <div class="hint tune-desc">${desc}</div>
        <div class="btn-row">
          <div class="btn${this.focusIdx === btnIdx ? ' focused' : ''}" data-role="row" data-idx="${btnIdx}">${t(
      'tune.reset'
    )}</div>
        </div>
        <div class="hint">${t('tune.hint')}</div>
      </div>
    `;
    this._refreshWarmStatus();
    const focused = this.el.querySelector('.focused');
    if (focused && focused.scrollIntoView) focused.scrollIntoView({ block: 'center' });
  }

  _refreshWarmStatus() {
    if (!this.isOpen() || this.tuning.prefetchSegmentBytes <= 0) return;
    const el = this.el.querySelector('.tune-warm-status');
    if (!el) return;
    const status = this.getWarmStatus && this.getWarmStatus();
    el.textContent = status ? t('tune.prefetchStatus', {
      ahead: status.ahead.toFixed(1),
      resume: status.resume.toFixed(1),
      hold: status.hold.toFixed(1)
    }) : t('tune.prefetchIdle');
  }

  _cycle(dir) {
    const spec = this._specs()[this.focusIdx];
    if (!spec) return;
    const value = cycleValue(spec.key, this.tuning[spec.key], dir, this.tuning);
    if (value === this.tuning[spec.key]) return;
    this.tuning[spec.key] = value;
    this.tuning = saveTuning(this.tuning);
    if (spec.warm) {
      if (this.onWarmChange) this.onWarmChange(this.tuning);
    } else {
      // 解码器参数关闭面板后才重播，避免每次左右调值都打断画面。
      this.dirty = true;
    }
    this.render();
  }

  _confirm() {
    if (this.focusIdx === this._specs().length) {
      if (!isAllDefault(this.tuning)) {
        this.dirty = this.dirty || TUNING_SPECS.some((s) => !s.warm && this.tuning[s.key] !== s.def);
        this.tuning = resetTuning();
        if (this.onWarmChange) this.onWarmChange(this.tuning);
      }
      this.focusIdx = this._specs().length;
      this.render();
      return;
    }
    this._cycle(1); // 参数行按 OK 等同于右键
  }

  handleKey(code) {
    switch (code) {
      case KEY.UP:
        this.focusIdx = Math.max(0, this.focusIdx - 1);
        this.render();
        break;
      case KEY.DOWN:
        this.focusIdx = Math.min(this._rowCount() - 1, this.focusIdx + 1);
        this.render();
        break;
      case KEY.LEFT:
        this._cycle(-1);
        break;
      case KEY.RIGHT:
        this._cycle(1);
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

  close() {
    clearInterval(this._warmTimer);
    this._warmTimer = null;
    this.el.classList.add('hidden');
    // hls.js 的配置只在 new Hls() 时读一次，所以改完必须重新起播才生效。
    const changed = this.dirty;
    this.dirty = false;
    if (changed && this.onApply) this.onApply(this.tuning);
    if (this.onClose) this.onClose();
  }

  isOpen() {
    return !this.el.classList.contains('hidden');
  }
}
