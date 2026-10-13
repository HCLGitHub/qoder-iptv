// 顶部状态栏：源名、频道总数、当前时间/日期、网络状态
import { fmtClock, fmtDate } from '../core/util.js';
import { t } from '../core/i18n.js';

export class StatusBar {
  constructor(el) {
    this.el = el;
    this.sourceName = '';
    this.channelCount = 0;
    this.timer = null;
    this.hideTimer = null;
  }

  setSource(name, count) {
    this.sourceName = name || '';
    this.channelCount = count || 0;
  }

  _render() {
    const online = navigator.onLine;
    this.el.innerHTML = `
      <div class="sb-source">${this.sourceName || t('sb.noSource')}</div>
      <div class="sb-mid">${t('sb.channelCount', { n: this.channelCount })}</div>
      <div class="sb-right">
        <span class="sb-net ${online ? 'online' : 'offline'}">${online ? t('sb.online') : t('sb.offline')}</span>
        <span class="sb-date">${fmtDate()}</span>
        <span class="sb-clock">${fmtClock()}</span>
      </div>
    `;
  }

  show(duration = 5000) {
    this._render();
    this.el.classList.remove('hidden');
    clearInterval(this.timer);
    this.timer = setInterval(() => this._render(), 1000);
    // 自动隐藏定时器必须存句柄：show() 会被多处重复调用，
    // 不清掉上一次的会让状态栏按更早的那次提前消失。
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (duration > 0) {
      this.hideTimer = setTimeout(() => this.hide(), duration);
    }
  }

  hide() {
    clearInterval(this.timer);
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.el.classList.add('hidden');
  }

  isVisible() {
    return !this.el.classList.contains('hidden');
  }
}
