// 设备信息面板：序列号、网卡、型号固件、应用版本与开源组件署名。
//
// 每一项都要把来源和 LS2 的原始错误文本摊在屏上——电视上取不到控制台日志，
// 不上屏就无从判断某个系统接口到底通不通。
import { KEY } from '../core/keys.js';
import Hls from 'hls.js';
import { collectDevice } from '../core/deviceInfo.js';
import { esc } from '../core/util.js';
import { t } from '../core/i18n.js';

// LS2 错误文本的确切含义（来自 luna-service2 源码，别凭直觉解读）。
// 这三句话决定下一步怎么做，必须翻译成人话显示出来。
function explainErr(err) {
  if (!err) return '';
  if (err === 'no-bridge') return t('di.err.noBridge');
  if (err === 'timeout') return t('di.err.timeout');
  if (err === 'bad-json') return t('di.err.badJson');
  if (err === 'call-throw') return t('di.err.callThrow');
  if (/Unknown method/i.test(err)) return t('di.err.unknownMethod');
  if (/Denied/i.test(err)) return t('di.err.denied');
  if (/not handled/i.test(err)) return t('di.err.notHandled');
  return err;
}

export class DeviceInfo {
  constructor(el) {
    this.el = el;
    this.info = null;
    this.loading = false;
    // 原始返回默认收起，只有某项取不到时才需要翻它
    this.showRaw = false;
    this.focus = 0; // 0=重新检测 1=原始返回
    this.scrollTop = 0; // 信息区滚动位置，render() 重建 DOM 后要还原
    this.onClose = null;

    this.el.addEventListener('click', (e) => this._onClick(e));
  }

  _onClick(e) {
    if (!e.target.closest('.panel')) {
      this.close();
      return;
    }
    const hit = e.target.closest('[data-role]');
    if (!hit) return;
    if (hit.dataset.role === 'close') this.close();
    else if (hit.dataset.role === 'again') this._load();
    else if (hit.dataset.role === 'raw') {
      this.showRaw = !this.showRaw;
      this.render();
    }
  }

  open() {
    this.el.classList.remove('hidden');
    this.focus = 0;
    this.scrollTop = 0;
    this._load();
  }

  // 滚动中间信息区。电视上没有滚轮，行数超出时不给上下键就彻底看不到下面的内容。
  // 步长取一屏的三分之一左右：一次一行太慢，一次一屏又容易看漏。
  _scroll(dy) {
    const b = this.el.querySelector('.di-body');
    if (!b) return;
    b.scrollTop += dy;
    this.scrollTop = b.scrollTop;
  }

  async _load() {
    if (this.loading) return;
    this.loading = true;
    this.render();
    try {
      this.info = await collectDevice();
    } catch (e) {
      this.info = null;
    }
    this.loading = false;
    this.render();
  }

  // 探测列表：每个接口调用的原始结果。某项取不到时，唯一的下一步线索
  // 就是这里的错误文本和原始 JSON：字段藏在哪、是没权限还是参数不对。
  _rawBlock() {
    const ps = (this.info && this.info.probes) || [];
    if (!ps.length) return `<div class="hint">${t('di.noProbes')}</div>`;
    // 不再自己开一层滚动：外面的 .di-body 已经能滚了，嵌套滚动区在电视上没法用
    // ——上下键只能作用于其中一层，另一层就成了死区。
    return (
      `<div style="margin-top:14px">` +
      ps
        .map((p) => {
          const head = p.ok
            ? `<span style="color:#4fd08a">OK</span>`
            : `<span style="color:#e2725b">FAIL</span> ${esc(explainErr(p.err))}`;
          const txt = p.text
            ? `<div style="font-size:18px;color:#8b95a3;word-break:break-all;line-height:1.4;margin-top:2px">${esc(p.text)}</div>`
            : '';
          return `<div style="margin-bottom:12px">
                    <div style="font-size:21px;color:#c9d3e0">${esc(p.name)} · ${head}</div>
                    ${txt}
                  </div>`;
        })
        .join('') +
      `</div>`
    );
  }

  render() {
    const d = this.info;
    const row = (label, value, note) =>
      `<div class="form-row"><span class="label">${label}</span>` +
      `<span class="value">${value}${note ? ' <i style="color:#7d8794;font-style:normal">' + note + '</i>' : ''}</span></div>`;

    let body;
    if (this.loading || !d) {
      body = `<div class="hint">${this.loading ? t('di.detecting') : t('di.failed')}</div>`;
    } else {
      const btn = (i, role, text) =>
        `<div class="btn${this.focus === i ? ' focused' : ''}" data-role="${role}">${text}</div>`;
      body =
        // 信息区：行数会随错误行、探测日志变化，单独滚动（.di-body 见 main.css），
        // 按钮行留在外面固定住——按钮被挤出屏幕的话这个面板就没法用了。
        `<div class="di-body">` +
        row(t('di.serial'), d.serial ? esc(d.serial) : '—', d.serialFrom ? esc(d.serialFrom) : '') +
        row(t('di.wiredMac'), d.wiredMac ? esc(d.wiredMac) : '—', d.wiredMac && d.macPath ? esc(d.macPath) : '') +
        row(t('di.wifiMac'), d.wifiMac ? esc(d.wifiMac) : '—') +
        (d.netErr ? row(t('di.macFailed'), esc(explainErr(d.netErr))) : '') +
        row(t('di.model'), d.model ? esc(d.model) : '—') +
        row(t('di.firmware'), d.firmware ? esc(d.firmware) : '—') +
        (d.sysErr ? row(t('di.sysFailed'), esc(explainErr(d.sysErr))) : '') +
        row(t('di.appVersion'), esc(typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '—')) +
        // 开源组件署名。hls.js 是 Apache-2.0，随包分发要保留声明——放在这里而不是
        // 只塞个文本文件进包，是因为电视上没人会去翻文件，上屏才算真的告知。
        // 版本号取 Hls.version（真实值），别硬编：依赖一升级硬编的那个就成了假信息。
        // 备注只写许可名：.value 是单行截断的（max-width 760px），再带上文件名会被
        // 省略号吃掉后半截，反而什么都没说清。全文在安装包内 THIRD-PARTY-NOTICES.txt。
        row(t('di.openSource'), 'hls.js ' + esc(Hls.version || ''), 'Apache-2.0') +
        (this.showRaw ? this._rawBlock() : '') +
        `</div>` +
        `<div class="btn-row">${btn(0, 'again', t('di.again'))}${btn(1, 'raw', t(this.showRaw ? 'di.rawHide' : 'di.rawShow'))}</div>`;
    }

    this.el.innerHTML = `
      <div class="panel">
        <div class="panel-close" data-role="close">✕</div>
        <h2>${t('settings.deviceInfo')}</h2>
        ${body}
        <div class="hint">${t('di.hint')}</div>
      </div>
    `;

    // innerHTML 重建会把滚动位置清零：展开日志、重新检测之后得让用户停在原处，
    // 否则每按一次按钮视图就跳回顶部。
    const b = this.el.querySelector('.di-body');
    if (b) b.scrollTop = this.scrollTop;
  }

  handleKey(code) {
    switch (code) {
      case KEY.UP:
        this._scroll(-220);
        break;
      case KEY.DOWN:
        this._scroll(220);
        break;
      case KEY.LEFT:
        if (this.focus > 0) this.focus--;
        this.render();
        break;
      case KEY.RIGHT:
        if (this.focus < 1) this.focus++;
        this.render();
        break;
      case KEY.OK:
        if (this.focus === 1) {
          this.showRaw = !this.showRaw;
          this.render();
        } else {
          this._load();
        }
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
