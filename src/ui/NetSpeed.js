// 右下角网速指示：定时采样播放器的已下载字节数，按时间差算即时速率。
// HLS 是「整片突发下载」，单秒采样会在 0 和峰值间跳动，所以取一个几秒的滑动窗口均值。
// 同时显示本次换台的起播耗时——调播放参数时必须有客观数字，靠"感觉快了"没法比较。
import { t } from '../core/i18n.js';

const TICK_MS = 1000;
const WINDOW_MS = 3000;

// 对齐结局的人话翻译（取值见 Player.warmStatus 的 align 字段）。
// 前两条是两种完全不同的毛病：「清单滑走」是停留时间不够的时间墙，
// 「落位被改」是对齐代码本身没生效——前者无从修，后者必须修。
const ALIGN_KEYS = ['nowin', 'ok', 'nodet', 'old', 'off', 'err'];

// 序号差值超过这个数就不是「清单滑了几片」了。直播窗口就 6 片上下，
// 取 100 留足余量；超了说明拿来当基准的是一片无关残留，差值无意义。
const SANE_SEG_DIFF = 100;

export class NetSpeed {
  constructor(el, player) {
    this.el = el;
    this.player = player;
    this.timer = null;
    this.samples = []; // [{ at, bytes }]
    this.startupMs = 0; // 本次换台从发起到出画面的毫秒数（0 = 还没出画面）
    this.bps = 0;
  }

  setEnabled(on) {
    if (on) this.start();
    else this.stop();
  }

  start() {
    if (this.timer) return;
    this.reset();
    this.el.classList.remove('hidden');
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.samples = [];
    this.el.classList.add('hidden');
  }

  isOn() {
    return !!this.timer;
  }

  // 换台时清空基准：字节计数会归零，留着旧样本会算出负值或一次假尖峰
  reset() {
    this.samples = [];
    this.startupMs = 0; // 上一个台的起播耗时不能留到这个台上
    this.warm = null;
    this.phases = null;
    this.bps = 0;
    this._render();
  }

  // 起播完成（首次出画面）时由外部传入耗时，立刻显示，不等下一次采样。
  // warm：本次起播的预热情况（见 Player.warmStatus）。命中画闪电；没命中就把
  // 「换台那刻缓存里存了几片」显示出来——0 说明预热没存进来，>0 说明存了但地址没对上，
  // 这两种失败的修法完全不同，光看「没有闪电」区分不出来。
  // phases：起播各阶段耗时（见 Player.startupPhases），用第二行摊开「时间花在哪」。
  setStartupMs(ms, warm, phases) {
    this.startupMs = ms > 0 ? ms : 0;
    this.warm = warm || null;
    this.phases = phases || null;
    this._render();
  }

  _tick() {
    const bytes = this.player.getLoadedBytes();
    const now = Date.now();
    const last = this.samples[this.samples.length - 1];
    if (last && bytes < last.bytes) this.samples = []; // 计数被重置（换台/重载）
    this.samples.push({ at: now, bytes });
    while (this.samples.length > 1 && now - this.samples[0].at > WINDOW_MS) this.samples.shift();
    const first = this.samples[0];
    const dt = (now - first.at) / 1000;
    const bps = dt > 0 ? (bytes - first.bytes) / dt : 0;
    this.bps = bps > 0 ? bps : 0;
    this._render();
  }

  _render() {
    const speed = this._fmt(this.bps);
    const top = this.startupMs
      ? (this.startupMs / 1000).toFixed(1) + 's' + this._warmTag() + ' · ' + speed
      : speed;
    // playing 事件不等于画面已推进，事件耗时与起播观察分开展示。
    const phase = this._phaseLine();
    // 未命中的归因摊在第三行。电视上取不到控制台日志，不上屏就无从判断
    // s±N 到底是清单滑走了（时间墙）还是对齐被改掉了（代码问题）。
    const warm = this._warmLine();
    const startup = this._startupLines();
    let html = `<div>${top}</div>`;
    if (phase) html += `<div class="net-phase">${phase}</div>`;
    if (warm) html += `<div class="net-warm">${warm}</div>`;
    if (startup) html += startup;
    this.el.innerHTML = phase || warm || startup ? html : top;
  }

  _startupLines() {
    const d = this.player.startupStatus();
    if (!d) return '';
    const seconds = (ms) => ms === null ? '—' : (ms / 1000).toFixed(1) + 's';
    const first = d.frame === null ? t('startup.data') : t('startup.frame');
    const timing = `${first}${seconds(d.frame === null ? d.data : d.frame)} · ` +
      `${t('startup.seek')}${seconds(d.seeked)} · ${t('startup.play')}${seconds(d.playing)} · ` +
      `${t('startup.motion')}${seconds(d.motion)}`;
    const native = d.path === 'native';
    const route = native
      ? t('startup.native') + (d.fallback ? ` ← hls.js (${t('startup.fallback.' + d.fallback)}) ${seconds(d.native)}` : '')
      : 'hls.js';
    const state = t('startup.' + d.reason) +
      (d.nudged ? ' · ' + t(native ? 'startup.nativeCorrected' : 'startup.corrected') : '');
    const buffer = d.ahead === null ? t('startup.bufferUnknown') : t('startup.ahead', { seconds: d.ahead.toFixed(1) });
    return `<div class="net-phase">${route} · R${d.readyState}</div>` +
      `<div class="net-phase">${timing}</div><div class="net-warm">${buffer} · ${state}</div>`;
  }

  // 预热未命中的归因行：先报「在途预热片被取消」，再报对齐。
  //
  // 顺序不能反：在途片被取消意味着首片是从零重下的，那几秒就是起播耗时的
  // 全部去向；而同一次里 align 很可能是 'ok'（对齐确实选中了那一片，只是它
  // 后来没存进来），先报对齐会把人往「落位被改」那个错方向带。
  _warmLine() {
    const w = this.warm;
    if (!w || w.hit) return '';
    const d = w.wait || {};
    const s = (ms) => (ms / 1000).toFixed(1) + 's';
    // 估值带上「真/猜」标记：自己下的耗时没真测到时，所有「自己下更快」的结论都不可信
    const est = ' · ' + t('ns.est', { warm: s(d.warm || 0), own: s(d.own || 0) }) + (d.ownReal ? '' : t('ns.guess'));
    if (d.act === 'over') return t('ns.takeover', { age: d.age }) + est;
    if (d.act === 'give') return t('ns.giveUp', { budget: d.budget }) + est;
    // 缓存空、也没撞上在途片：主行那个字母已经说清了，不必占一行
    if (!w.held) return '';
    // 对齐报「一片都不在窗口内」时，把两个号段摆出来直接得出结论。
    // 不能只写「清单滑走」——它只是三种成因之一，而三种的修法完全相反：
    // 号落在窗口区间内却没匹配上，就不是时间墙而是缓存键本身的比法不对。
    if (w.align === 'nowin' && w.win) {
      const v = w.win;
      const have = v.have || [];
      if (!have.length) return t('ns.noCache', { lo: v.lo, hi: v.hi, n: v.n });
      const seg = have[0] + '~' + have[have.length - 1];
      const inWin = have.some((n) => n >= v.lo && n <= v.hi);
      const why = t(inWin ? 'ns.inWinMiss' : 'ns.slidOut');
      return t('ns.window', { why, lo: v.lo, hi: v.hi, n: v.n, seg });
    }
    const a = ALIGN_KEYS.indexOf(w.align) >= 0
      ? t('ns.align.' + w.align)
      : w.align ? t('ns.alignCode', { code: w.align }) : t('ns.noAlign');
    const g = w.seg || {};
    if (!isFinite(g.want) || !isFinite(g.top)) return a;
    // 差值大得远超清单窗口时，那两个片号压根不在同一个量级上（比如 +357849）。
    // 那是拿一片无关残留当了基准，差值本身没有任何含义，得明说得出来，
    // 否则会被当成「滑了好多片」而去调偏移量——完全无效。
    if (Math.abs(g.want - g.top) > SANE_SEG_DIFF)
      return t('ns.stale', { align: a, want: g.want, top: g.top });
    return t('ns.seg', { align: a, want: g.want, top: g.top });
  }

  _phaseLine() {
    const p = this.phases;
    if (!p || !this.startupMs) return '';
    const s = (ms) => (ms / 1000).toFixed(1);
    return t('ns.phase', { manifest: s(p.manifest), frag: s(p.frag), buffer: s(p.buffer) }) + t('startup.waitPlay') + s(p.render);
  }

  // 命中 → 闪电；没命中 → 叉号加上换台那刻缓存里的片数，再跟一个字母说明卡在哪里
  //（片数为 0 时是预热没存进来的原因，不为 0 时是存了却没对上的形态，含义见 Player.warmStatus）
  _warmTag() {
    if (!this.warm) return '';
    if (this.warm.hit) return '⚡';
    return '✕' + this.warm.held + (this.warm.note || '');
  }

  _fmt(bps) {
    if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
    return Math.round(bps / 1024) + ' KB/s';
  }
}
