// 解码后的 PCM 存放 + WSOLA 变速不变调。
// 都是纯计算，不碰 DOM/Web Audio，单测在 node 里直接跑。

/**
 * 按「内容时间」存 PCM。下标是采样序号（秒 × 采样率取整），
 * 读的时候按任意起点、任意长度取，缺数据的地方补 0。
 */
export class PcmStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.sr = 0;
    this.ch = 0;
    this.blocks = []; // {s0, n, data: Float32Array[]}，按 s0 升序
  }

  get empty() {
    return !this.blocks.length;
  }

  /** 已存数据覆盖的总时长（秒），用来给内存兜底 */
  get seconds() {
    if (!this.sr) return 0;
    let n = 0;
    for (const b of this.blocks) n += b.n;
    return n / this.sr;
  }

  insert(startSec, data, sr) {
    if (!data || !data.length || !data[0].length) return;
    // 采样率/声道变了：新旧数据没法拼着读，旧的丢掉
    if (this.sr && (sr !== this.sr || data.length !== this.ch)) this.reset();
    if (!this.sr) {
      this.sr = sr;
      this.ch = data.length;
    }
    const s0 = Math.round(startSec * sr);
    const n = data[0].length;
    const e = s0 + n;
    const list = this.blocks;
    // 被新块完整盖住的旧块直接删：hls.js 切档/回填时会把同一段再 append 一遍
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (b.s0 >= s0 && b.s0 + b.n <= e) list.splice(i, 1);
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].s0 <= s0) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, { s0, n, data });
  }

  /** 删掉中点落在 [a,b) 秒内的块（对应 SourceBuffer.remove） */
  removeSec(a, b) {
    if (!this.sr) return;
    const sa = a * this.sr;
    const sb = b * this.sr;
    this.blocks = this.blocks.filter((blk) => {
      const mid = blk.s0 + blk.n / 2;
      return mid < sa || mid >= sb;
    });
  }

  /** 第一个「结尾在 s 之后」的块的下标 */
  _first(s) {
    const list = this.blocks;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].s0 <= s) lo = mid + 1;
      else hi = mid;
    }
    let i = Math.max(0, lo - 1);
    while (i > 0 && list[i - 1].s0 + list[i - 1].n > s) i--;
    return i;
  }

  /**
   * 从采样 s 起往后，数据连续到哪儿。块间缝隙小于 tol（AAC 时间戳的正常抖动）当作连续。
   * s 本身不在任何块里就原样返回 s。
   */
  contiguousEnd(s, tol) {
    const list = this.blocks;
    if (!list.length) return s;
    const gap = tol != null ? tol : Math.round(this.sr * 0.05);
    let end = s;
    let covered = false;
    for (let i = this._first(s); i < list.length; i++) {
      const b = list[i];
      if (b.s0 + b.n <= s) continue;
      if (b.s0 > end + (covered ? gap : 0)) break;
      covered = true;
      if (b.s0 + b.n > end) end = b.s0 + b.n;
    }
    return end;
  }

  /** 读 [s, s+n) 到 out（每声道一条 Float32Array，长度 ≥ n） */
  read(s, n, out) {
    for (let c = 0; c < out.length; c++) out[c].fill(0, 0, n);
    const list = this.blocks;
    const e = s + n;
    for (let i = this._first(s); i < list.length; i++) {
      const b = list[i];
      if (b.s0 >= e) break;
      const be = b.s0 + b.n;
      if (be <= s) continue;
      const from = Math.max(s, b.s0);
      const to = Math.min(e, be);
      for (let c = 0; c < out.length; c++) {
        const src = b.data[Math.min(c, b.data.length - 1)];
        out[c].set(src.subarray(from - b.s0, to - b.s0), from - s);
      }
    }
  }

  /** 读单声道下混（WSOLA 找拼接点用） */
  readMono(s, n, out, tmp) {
    this.read(s, n, tmp);
    const ch = tmp.length;
    if (ch === 1) {
      out.set(tmp[0].subarray(0, n));
      return;
    }
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v += tmp[c][i];
      out[i] = v / ch;
    }
  }

  /** 丢掉结尾早于 sec 的块，返回丢掉的内容时间范围（没丢返回 null） */
  evictBefore(sec) {
    if (!this.sr) return null;
    const s = sec * this.sr;
    let cut = 0;
    while (cut < this.blocks.length && this.blocks[cut].s0 + this.blocks[cut].n <= s) cut++;
    if (!cut) return null;
    const from = this.blocks[0].s0 / this.sr;
    const last = this.blocks[cut - 1];
    this.blocks.splice(0, cut);
    return [from, (last.s0 + last.n) / this.sr];
  }
}

/**
 * WSOLA（波形相似重叠相加）：按 speed 倍速吃输入、按 1× 吐输出，音调不变。
 *
 *   每一跳输出 Hs 个采样；输入名义位置前进 Ha = Hs × speed。
 *   新的一帧不硬取在名义位置，而是在 ±D 范围里找一处和「上一帧的自然延续」最像的地方，
 *   这样重叠相加时波形对得上，不会出现变速常见的「嗡嗡」相位抵消。
 *
 * 直接从 PcmStore 随机读，不自己攒输入缓冲；重新同步时 reset 到任意位置即可。
 */
export class Wsola {
  constructor(store, speed) {
    this.store = store;
    this.speed = speed;
    this.sr = 0;
  }

  _setup() {
    const sr = this.store.sr;
    const ch = this.store.ch;
    this.sr = sr;
    this.ch = ch;
    // 帧长约 40ms、搜索 ±10ms：语音和音乐都比较稳的折中
    const N = 2 * Math.round(sr * 0.02);
    const Hs = N / 2;
    this.N = N;
    this.Hs = Hs;
    this.D = Math.round(sr * 0.01);
    this.Ha = Hs * this.speed;
    // 周期 Hann：半帧重叠相加恰好处处为 1，没有音量起伏
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.acc = [];
    this.frame = [];
    this.tmp = [];
    for (let c = 0; c < ch; c++) {
      this.acc.push(new Float32Array(N));
      this.frame.push(new Float32Array(N + 2 * this.D + Hs));
      this.tmp.push(new Float32Array(N + 2 * this.D + Hs));
    }
    this.seg = new Float32Array(N + 2 * this.D + Hs);
    this.tpl = new Float32Array(Hs);
  }

  /** 从输入采样 pos 处重新开始（会有一次约 20ms 的自然淡入） */
  reset(pos) {
    if (this.sr !== this.store.sr || this.ch !== this.store.ch || !this.win) this._setup();
    for (const a of this.acc) a.fill(0);
    this.a = pos;
    this.prevP = -1;
  }

  /** 名义输入位置（采样），即下一段输出对应的内容位置 */
  get pos() {
    return this.a;
  }

  /** 把名义位置挪一点：WSOLA 本来就在找拼接点，几毫秒的挪动听不出来，用来做音画微调 */
  nudge(samples) {
    this.a += samples;
  }

  /** 需要的输入都到了吗：输入要备到本次最后一跳的帧尾 + 搜索余量 */
  ready(hops) {
    const need = Math.ceil(this.a + hops * this.Ha) + this.D + this.N;
    return this.store.contiguousEnd(Math.max(0, Math.round(this.a))) >= need;
  }

  /**
   * 产出 hops 跳的输出；输入还没到返回 null（调用方下一拍再来）。
   * @returns {Float32Array[]|null} 每声道 hops × Hs 个采样
   */
  process(hops) {
    if (!this.win || !this.ready(hops)) return null;
    const out = [];
    for (let c = 0; c < this.ch; c++) out.push(new Float32Array(hops * this.Hs));
    for (let h = 0; h < hops; h++) this._hop(out, h * this.Hs);
    return out;
  }

  _hop(out, off) {
    const { N, Hs, win, acc, frame, ch } = this;
    const base = Math.round(this.a);
    const p = this.prevP >= 0 ? this._search(base, this.prevP + Hs) : base;
    this.store.read(p, N, frame);
    for (let c = 0; c < ch; c++) {
      const a = acc[c];
      const f = frame[c];
      for (let i = 0; i < N; i++) a[i] += f[i] * win[i];
      out[c].set(a.subarray(0, Hs), off);
      a.copyWithin(0, Hs);
      a.fill(0, N - Hs);
    }
    this.prevP = p;
    this.a += this.Ha;
  }

  /**
   * 在 [base-D, base+D] 里找和模板最像的起点。
   * 先在单声道下混上隔 4 点粗搜，再在最优点附近逐点细调：
   * 电视 CPU 上逐点全搜每秒要上千万次乘加，粗搜能压到几百万。
   */
  _search(base, tplPos) {
    const { Hs, D, seg, tpl, tmp } = this;
    const L = Hs;
    const len = 2 * D + L;
    this.store.readMono(base - D, len, seg, tmp);
    this.store.readMono(tplPos, L, tpl, tmp);
    let te = 0;
    for (let j = 0; j < L; j += 4) te += tpl[j] * tpl[j];
    if (te < 1e-9) return base; // 模板是静音：哪里拼都一样，取名义位置
    const score = (k, step) => {
      let xy = 0;
      let xx = 0;
      for (let j = 0; j < L; j += step) {
        const x = seg[k + j];
        xy += x * tpl[j];
        xx += x * x;
      }
      return xx > 1e-12 ? xy / Math.sqrt(xx) : -Infinity;
    };
    let best = D;
    let bestS = -Infinity;
    for (let k = 0; k <= 2 * D; k += 4) {
      const s = score(k, 4);
      if (s > bestS) {
        bestS = s;
        best = k;
      }
    }
    const lo = Math.max(0, best - 3);
    const hi = Math.min(2 * D, best + 3);
    bestS = -Infinity;
    let fine = best;
    for (let k = lo; k <= hi; k++) {
      const s = score(k, 1);
      if (s > bestS) {
        bestS = s;
        fine = k;
      }
    }
    return base - D + fine;
  }
}
