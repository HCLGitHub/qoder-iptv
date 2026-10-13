// 设置菜单：画面比例、解码方式、开机自动播放、字号、语言、刷新/清理、源管理
import { KEY } from '../core/keys.js';
import { getSettings, saveSettings, clearEpgCache } from '../core/storage.js';
import { t, resolveLang } from '../core/i18n.js';

const ASPECTS = ['16:9', '4:3', 'fill'];
const DECODERS = ['auto', 'native', 'hls'];
const FONT_SCALES = [0.9, 1, 1.1];
const LANGS = ['auto', 'zh', 'en'];

const aspectLabel = (v) => (v === 'fill' ? t('label.fill') : v);
const decoderLabel = (v) => (v === 'auto' ? t('label.auto') : v === 'native' ? t('label.native') : 'hls.js');
const fontLabel = (v) => (v === 0.9 ? t('label.small') : v === 1.1 ? t('label.large') : t('label.medium'));
const langName = (v) => (v === 'en' ? 'English' : '中文');
const langLabel = (v) =>
  v === 'zh' || v === 'en' ? langName(v) : t('label.system', { lang: langName(resolveLang('auto')) });

export class Settings {
  constructor(el) {
    this.el = el;
    this.focusIdx = 0;
    this.s = getSettings();

    this.onChange = null; // (settings) => void
    this.onRefreshEpg = null;
    this.onOpenSources = null;
    this.onOpenGroups = null;
    this.onOpenTuning = null;
    this.onOpenDevice = null;
    this.onClose = null;

    // 鼠标：事件委托（点行切换/执行，点箭头调值，点面板外关闭）
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
    const rowEl = hit.closest('[data-idx]');
    const idx = rowEl ? parseInt(rowEl.dataset.idx, 10) : NaN;
    if (isNaN(idx)) return;
    this.focusIdx = idx;
    this.render(); // 先同步高亮，后续键盘操作能从这里接上
    if (role === 'dec') this._cycle(-1);
    else if (role === 'inc') this._cycle(1);
    else this._confirm(); // 行本体：select 递增 / button 执行
  }

  // 行定义
  _rows() {
    return [
      { key: 'aspect', type: 'select', label: t('settings.aspect'), value: aspectLabel(this.s.aspect) },
      { key: 'decoder', type: 'select', label: t('settings.decoder'), value: decoderLabel(this.s.decoder) },
      { key: 'autoPlay', type: 'select', label: t('settings.autoPlay'), value: this.s.autoPlayLast ? t('label.on') : t('label.off') },
      { key: 'netSpeed', type: 'select', label: t('settings.netSpeed'), value: this.s.showNetSpeed ? t('label.on') : t('label.off') },
      { key: 'fontScale', type: 'select', label: t('settings.fontScale'), value: fontLabel(this.s.fontScale) },
      { key: 'language', type: 'select', label: t('settings.language'), value: langLabel(this.s.language) },
      { key: 'refreshEpg', type: 'button', label: t('settings.refreshEpg') },
      { key: 'clearEpg', type: 'button', label: t('settings.clearEpg') },
      { key: 'groups', type: 'button', label: t('settings.groupManager') },
      { key: 'sources', type: 'button', label: t('settings.sourceManager') },
      { key: 'tuning', type: 'button', label: t('settings.playerTuning') },
      { key: 'device', type: 'button', label: t('settings.deviceInfo') }
    ];
  }

  open() {
    this.s = getSettings();
    this.focusIdx = 0;
    this.el.classList.remove('hidden');
    this.render();
  }

  render() {
    const rows = this._rows();
    const html = rows
      .map((r, i) => {
        const cls = 'form-row' + (i === this.focusIdx ? ' focused' : '');
        const val =
          r.type === 'select'
            ? `<span class="value"><b class="arrow" data-role="dec">◄</b>${r.value}<b class="arrow" data-role="inc">►</b></span>`
            : '';
        return `<div class="${cls}" data-role="row" data-idx="${i}"><span class="label">${r.label}</span>${val}</div>`;
      })
      .join('');
    this.el.innerHTML = `
      <div class="panel">
        <div class="panel-close" data-role="close">✕</div>
        <h2>${t('settings.title')}</h2>
        <div class="src-list">${html}</div>
        <div class="hint">${t('settings.hint')}</div>
      </div>
    `;
    // 行数已超过面板高度上限，靠滚动容器容纳；焦点移到视口外时把它带回来
    const focused = this.el.querySelector('.focused');
    if (focused && focused.scrollIntoView) focused.scrollIntoView({ block: 'center' });
  }

  _cycle(dir) {
    const cyc = (arr, cur) => {
      const i = arr.indexOf(cur);
      return arr[(i + dir + arr.length) % arr.length];
    };
    const row = this._rows()[this.focusIdx];
    if (!row || row.type !== 'select') return;
    switch (row.key) {
      case 'aspect':
        this.s.aspect = cyc(ASPECTS, this.s.aspect);
        break;
      case 'decoder':
        this.s.decoder = cyc(DECODERS, this.s.decoder);
        break;
      case 'autoPlay':
        this.s.autoPlayLast = !this.s.autoPlayLast;
        break;
      case 'netSpeed':
        this.s.showNetSpeed = !this.s.showNetSpeed;
        break;
      case 'fontScale':
        this.s.fontScale = cyc(FONT_SCALES, this.s.fontScale);
        break;
      case 'language':
        this.s.language = cyc(LANGS, this.s.language || 'auto');
        break;
      default:
        return;
    }
    saveSettings(this.s);
    if (this.onChange) this.onChange(this.s);
    this.render();
  }

  _confirm() {
    const row = this._rows()[this.focusIdx];
    if (!row) return;
    switch (row.key) {
      case 'refreshEpg':
        if (this.onRefreshEpg) this.onRefreshEpg();
        break;
      case 'clearEpg':
        clearEpgCache();
        if (this.onRefreshEpg) this.onRefreshEpg();
        break;
      case 'groups':
        this.close();
        if (this.onOpenGroups) this.onOpenGroups();
        break;
      case 'sources':
        this.close();
        if (this.onOpenSources) this.onOpenSources();
        break;
      case 'tuning':
        this.close();
        if (this.onOpenTuning) this.onOpenTuning();
        break;
      case 'device':
        this.close();
        if (this.onOpenDevice) this.onOpenDevice();
        break;
      default:
        this._cycle(1); // select 项 OK 也可切换
    }
  }

  handleKey(code) {
    switch (code) {
      case KEY.UP:
        this.focusIdx = Math.max(0, this.focusIdx - 1);
        this.render();
        break;
      case KEY.DOWN:
        this.focusIdx = Math.min(this._rows().length - 1, this.focusIdx + 1);
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
    this.el.classList.add('hidden');
    if (this.onClose) this.onClose();
  }

  isOpen() {
    return !this.el.classList.contains('hidden');
  }
}
