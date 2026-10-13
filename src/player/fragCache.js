// 起播分片缓存 + 自定义分片加载器。
//
// 目的：把「换台时现下整个起播分片」这一步省掉。预热阶段就把 hls.js 起播真正会请求的
// 那一个分片整段拉进内存，切过去时由自定义加载器直接喂给 hls.js，起播只剩解封装+解码。
//
// 为什么不靠浏览器 HTTP 缓存：① IPTV 服务器对分片普遍下发 no-cache；
// ② Chromium 对超过缓存分区单条上限的大条目直接拒绝入盘；③ 预热请求本身带 no-store。
// 三条里任一条成立，靠 HTTP 缓存的做法就是空转，所以自己存在内存里。
//
// 只接管分片（挂在 hls.js 的 fLoader 上），不碰 loader：
// 一是清单/字幕没必要走缓存，二是动 config.loader 会让 hls.js 打印
// 「Custom loader detected」并连带改动它自己的加载策略，不该有这种副作用。
//
// 关键约束：hls.js 开 worker 时会把分片 ArrayBuffer **转移**给 worker 线程
// （transmuxer-interface.ts 注释原文 "post fragment payload as transferable objects"），
// 转移后原 buffer 被 detach 变成 0 字节。所以缓存必须「取一次就删」，
// 同一个 buffer 绝不能喂给两次加载，否则第二次拿到的是空数据。

import { rangeLoad, resetRangeLog } from './rangeLoad.js';

// 分片留多久。取值依据：直播窗口只有 6 片左右（约 22 秒），而起播对齐时
// 超过一轮预热覆盖长度（约 11 秒）的老片会被判定「太旧不对齐」——也就是说
// 存再久也用不上。原来设 120 秒，结果是老片长期占着字节预算，把刚热好的片挤掉。
const TTL_MS = 30000;

const store = new Map(); // url -> { buf: ArrayBuffer, ms: number, at: number }

// 正在下载途中的预热片：key -> { p, startedAt, abort }（p 无论成败都会 settle）。
//
// 存在的理由：换台那一刻，预热很可能正下到一半，而下的恰好就是新频道要的那一片
// （实测单片 5MB、2.1MB/s 要 2.4 秒，而停留常常只有 2~4 秒，撞上的概率很高）。
// 原先换台先 abort 再让 hls.js 重新发一次请求，等于把下了一大半的数据扔掉重来。
// 改成算一笔账再定：它快下完了就等（白赚一片），刚开始下就掐掉自己下（见 waitBudget）。
const pending = new Map();

// 等在途预热片：等多久，取决于它**还剩多少**，而不是它已经等了多久。
//
// 固定上限（曾经写死 800 毫秒）算不过账。设预热单片 2.5 秒、自己全路数 1.2 秒，
// 换台时刻在这 2.5 秒里是均匀分布的：
//   固定等 800 毫秒 → 只有开始超过 1.7 秒的那 32% 能等到，其余 68% 白等 800 毫秒
//     再自己下一遍。期望 ≈ 1.5 秒，**比压根不等（1.2 秒）还差**。
//     最坏的一种是把已经下到九成的那片掐掉从零重来——实测的 3.2 秒就是这么来的。
//   按剩余时间判断 → 只在「剩下的比自己下一遍还短」时才等。期望 ≈ 0.9 秒。
// 所以判据是：预计剩余 < 自己下一遍的耗时 → 等；否则立刻掐掉它自己下，一毫秒都不等。
//
// 两个耗时都用实测滚动平均（见 warmMs / ownMs），不猜。冷启动没有样本时用下面的缺省值。
const WARM_MS_GUESS = 2500;
const OWN_MS_GUESS = 1200;
// 估计值总有偏差，给一点余量再放弃
const WAIT_SLACK_MS = 300;

// 单片耗时的滚动平均：预热的（一半路数）和自己下的（全路数）分开记。
// 只有这两个数是同源实测的，「等还是不等」才算得准。
let warmMs = 0;
let ownMs = 0;
function ema(prev, v) {
  return prev ? prev * 0.6 + v * 0.4 : v;
}

// 记一次预热单片的耗时。只该拿「每个台的第一片」来记：那一片用满路数下，
// 和自己下一片是同一个量级，估算才有意义；后续片用一半路数、慢一倍，
// 混进来会把 exp 抬高，让 waitBudget 误判「它还剩很多」而白白接管。
export function noteWarmMs(ms) {
  if (ms > 0) warmMs = ema(warmMs, ms);
}

// 还该等多久（毫秒）。0 = 别等了，立刻自己下。
function waitBudget(ent) {
  const exp = warmMs || WARM_MS_GUESS;
  const self = ownMs || OWN_MS_GUESS;
  const elapsed = ent.startedAt ? Date.now() - ent.startedAt : 0;
  const remain = exp - elapsed;
  // 剩下的比自己重下一遍还长：等它纯亏，何况它还占着自己现在最需要的那几路带宽
  if (remain > self) return 0;
  // 等，但绝不超过「自己下一遍」的耗时。remain 已经是负数说明它超期了（大概卡住了），
  // 那就只给一点宽限，别陪着它一起卡死。
  return Math.max(200, Math.min(self, remain + WAIT_SLACK_MS));
}

let bytes = 0; // 当前占用字节
let budget = 0; // 总字节预算，0 = 停用
let hits = 0; // 本次换台命中的分片数（角标显示用）
let missLogged = false; // 本次换台是否已经打过未命中日志（避免播放途中每片都打）
let missKind = ''; // 本次换台起播片未命中的形态（见 classifyMiss）
// 未命中时的两个片号，要显示到屏幕角标上（电视上取不到控制台日志，
// 只有把它们摊到屏上，才分得清「预热片滑出清单」和「对齐跑了却被改掉」）。
let missWant = NaN; // hls.js 要的那一片的序号
let missTop = NaN; // 同目录里我们缓存过的最大序号
// 起播片撞上「在途预热片」时的处置。必须单独记：这个结局原本只体现在
// Player 的 g 字母上，而缓存里只要还撑着任意一片残留，g 就会被 s±N 盖掉，
// 屏上只剩下一个荒谬的差值——真正的成因（预热片被中途取消）完全看不见。
let waitAct = ''; // '' 没撞上 / 'over' 直接接管 / 'give' 等过又放弃 / 'wait' 等到了
let waitAge = 0; // 撞上那一刻它已经下了多少毫秒
let waitMs = 0; // 算出来的等待额度（0 = 一毫秒也不等）

// 换台时归零：命中数要按「这一次起播」来算，不能累计上一个台的
export function resetSegHits() {
  hits = 0;
  missLogged = false;
  missKind = '';
  missWant = NaN;
  missTop = NaN;
  waitAct = '';
  waitAge = 0;
  waitMs = 0;
  resetRangeLog();
}

export function segHits() {
  return hits;
}

// 当前缓存里存着几片。换台那一刻记一次，用来分辨两种完全不同的失败：
// 0 = 预热压根没存进来；>0 = 存进来了但 hls.js 要的不是这些地址。
// 先清一遍过期的：过期片既没法用，还占着字节预算把新片挤掉，
// 顺带让角标上的数字如实反映「真正还能用的片数」。
export function segCount() {
  sweep();
  return store.size;
}

export function missNote() {
  return missKind;
}

// 未命中的两个片号（差值的来源）。NaN = 取不到序号或压根没走到分类那一步。
export function missDetail() {
  return { want: missWant, top: missTop };
}

// 缓存里现存的分片序号（升序）。refUrl 给定时只算同目录的。
//
// 必须按目录过滤：这个网关的分片编号是全网关共享的递增计数，不同频道
// 在同一时刻的片号天然就落在同一个区间里。不过滤的话，别的台的片会“恰好”
// 落进本台的清单窗口，把结论整个带反。
export function cachedSegNums(refUrl) {
  const ref = refUrl ? splitUrl(refUrl).dir : null;
  const out = [];
  for (const k of store.keys()) {
    const s = splitUrl(k);
    if (ref && s.dir !== ref) continue;
    const n = segNum(s.file);
    if (!isNaN(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

// 从地址里取分片序号。规则与 classifyMiss 内部一致，供上层做窗口对比。
export function urlSegNum(url) {
  if (!url) return NaN;
  return segNum(splitUrl(url).file);
}

// 「等不等在途预热片」的现场账。两个滚动平均必须一并交出去上屏：
// 放弃在途片本身不是 bug，但它完全建立在这两个估值上——估得不准就会系统性地
// 把快下完的片取消掉重下。看不到它们，“接管”到底是算对了还是算错了无从判断。
export function waitDiag() {
  return {
    act: waitAct,
    age: waitAge,
    budget: waitMs,
    warm: Math.round(warmMs || WARM_MS_GUESS),
    own: Math.round(ownMs || OWN_MS_GUESS),
    // own 是不是真测出来的。为 false 时上面那个 own 只是缺省猜值，
    // 所有「自己下更快」的结论都不可信
    ownReal: ownMs > 0
  };
}

// 缓存键：把地址归一化后再存取。
//
// 必须归一化的原因（实测）：网关给分片地址挂了每次请求都变的 token，
// 预热时拿到的清单和换台时 hls.js 拿到的清单里，同一个分片的查询串不一样。
// 拿原始地址当键的话，明明是同一片也对不上——屏幕上表现为
// 「71774700.ts ← 71774700.ts」却判成未命中，白丢一次命中。
//
// 只在路径本身足以标识分片时才丢查询串（末尾是 .ts/.m4s 这类扩展名）。
// 有些源把分片序号放在查询串里，那种情况丢了就会张冠李戴喂错数据，所以保留原样。
// 开发模式下 proxied() 会把真实地址包进 /__proxy__?u=，先解出来再判断。
function segKey(url) {
  if (!url) return url;
  let u = url;
  const P = '/__proxy__?u=';
  if (u.indexOf(P) === 0) {
    try {
      u = decodeURIComponent(u.slice(P.length));
    } catch (e) {}
  }
  const q = u.indexOf('?');
  if (q < 0) return u;
  const path = u.slice(0, q);
  return /\.(ts|m4s|mp4|m4v|m4a|aac|mpg|mpeg)$/i.test(path) ? path : u;
}

function splitUrl(u) {
  const q = u.indexOf('?');
  const path = q < 0 ? u : u.slice(0, q);
  const i = path.lastIndexOf('/');
  return { dir: path.slice(0, i + 1), file: path.slice(i + 1) };
}

// 文件名里最后一段连续数字：分片名基本都是 xxx-1234.ts 或 1699999999.ts 这种，
// 拿它当序号用于算「差了多少片」。取不到就放弃（不影响分类，只是少个数字）。
function segNum(file) {
  const m = file.match(/\d+/g);
  return m ? parseInt(m[m.length - 1], 10) : NaN;
}

// 缓存里明明有货却没对上时，判断是「哪一种」对不上。三种成因的修法完全不同：
//   x 去掉查询串后地址完全一致 → 每次请求都换 token/session，靠地址匹配这条路走不通
//   s 目录相同、文件名不同     → 序号不对，后面跟着差值（见下）
//   w 连目录都不同             → 拿错了流：master 清单里 hls.js 选的是另一个清晰度变体
//
// s 后面的差值 = hls.js 要的序号 − 我们存过的最大序号，符号决定了两条完全相反的修法：
//   正数 → 它要的比我们存的更新：预热之后清单往前滑了，提前下载的片必然过时，
//          只能靠「连同清单一起缓存」让起播落回预热时那一份清单（代价是延迟）
//   负数 → 它要的比我们存的更旧：是 _startSegIndex 算得太靠前，属于纯逻辑错，改算法即可
function classifyMiss(want) {
  if (!store.size || !want) return '';
  const w = splitUrl(want);
  const wn = segNum(w.file);
  missWant = wn;
  let top = NaN; // 同目录里我们存过的最大序号
  for (const k of store.keys()) {
    const s = splitUrl(k);
    // 目录必须先比。这个网关的分片编号是**全网关共享**的递增计数，
    // 不同频道在同一时刻的片名天然就一样（要 2070290/71775224.ts，
    // 缓存里存着 334548/71775224.ts）。先比文件名会稳定误判成 x，
    // 把真正的归因整个盖掉——实测就踩过这个坑。
    if (s.dir !== w.dir) continue;
    if (s.file === w.file) return 'x'; // 同目录同文件名却没取到 → 只差查询串
    const n = segNum(s.file);
    if (!isNaN(n) && (isNaN(top) || n > top)) top = n;
  }
  missTop = top;
  if (isNaN(top)) return 'w';
  if (isNaN(wn)) return 's';
  const diff = wn - top;
  return 's' + (diff > 0 ? '+' + diff : diff);
}

export function setSegBudget(n) {
  budget = n > 0 ? n : 0;
  if (!budget) clearSegCache();
  else trim();
}

export function segBudget() {
  return budget;
}

export function clearSegCache() {
  store.clear();
  bytes = 0;
}

// 清掉过期的：留着既用不上，还占字节预算把新热好的片挤出去
function sweep() {
  const now = Date.now();
  for (const [k, e] of store) {
    if (now - e.at > TTL_MS) {
      store.delete(k);
      bytes -= e.buf.byteLength;
    }
  }
  if (bytes < 0) bytes = 0;
}

// 超预算时淘汰最早存入的（Map 迭代顺序即插入顺序）
function trim() {
  sweep();
  while (bytes > budget && store.size) {
    const k = store.keys().next().value;
    const e = store.get(k);
    store.delete(k);
    bytes -= e ? e.buf.byteLength : 0;
  }
  if (bytes < 0) bytes = 0;
}

// ms 是预热时这一片的真实下载耗时，命中时要拿它回填 stats，
// 否则 hls.js 会以为「这片是 0 毫秒下完的」，把带宽估计推成天文数字，
// 多码率源上会直接跳到最高档。
export function putSeg(url, buf, ms) {
  if (!budget || !url || !buf || !buf.byteLength) return;
  if (buf.byteLength > budget) return;
  const k = segKey(url);
  takeSeg(k); // 同址覆盖：先扣掉旧的字节数
  store.set(k, { buf, ms: ms > 0 ? ms : 1, at: Date.now() });
  bytes += buf.byteLength;
  trim();
}

// 登记「这一片正在下」。传 null 表示注销。promise 必须保证一定会 settle
// （失败也要 resolve），否则等它的那次分片加载会永远挂着。
// info: { startedAt, abort } —— 开始时刻用来估算它还剩多少，abort 是决定自己下时掐它的手柄。
export function setPending(url, p, info) {
  const k = segKey(url);
  if (!p) {
    pending.delete(k);
    return;
  }
  const ent = {
    p,
    startedAt: (info && info.startedAt) || Date.now(),
    abort: info && info.abort
  };
  pending.set(k, ent);
  const clear = () => {
    if (pending.get(k) === ent) pending.delete(k);
  };
  p.then(clear, clear);
}

// 这一片是不是正在下载途中。起播选片时也算它「有」——
// 撞上就省掉一整片的下载；撞不上时加载器会算账决定等还是自己下（waitBudget）。
export function pendingSeg(url) {
  return pending.has(segKey(url));
}

// 光看在不在，不取出、不删除。用于起播前挑「从哪一片开始播」：
// 那时候还没到加载分片的阶段，不能把货动掉。
export function hasSeg(url) {
  const e = store.get(segKey(url));
  return !!e && Date.now() - e.at <= TTL_MS;
}

// 取出并删除。过期的直接丢弃，让调用方走正常网络加载。
export function takeSeg(url) {
  const k = segKey(url);
  const e = store.get(k);
  if (!e) return null;
  store.delete(k);
  bytes -= e.buf.byteLength;
  if (bytes < 0) bytes = 0;
  if (Date.now() - e.at > TTL_MS) return null;
  return e;
}

// 用 hls.js 的默认加载器作基类，只在命中缓存时短路，其余一律交回基类。
// 基类构造函数里建好的 this.stats 必须保留——hls.js 在 load() 之前就把
// frag.stats 指向了它（fragment-loader.ts: `frag.stats = loader.stats`）。
export function makeCachedFragLoader(Base) {
  return class CachedFragLoader extends Base {
    load(context, config, callbacks) {
      if (this._cancelled || (this._loadState && this._loadState.done)) return;
      // pending resume 会重入 load，但仍是同一次加载，不能重置终结/取消状态。
      if (!this._loadState) this._loadState = { context, callbacks, done: false };
      this.context = context;
      // 带 Range 的请求（#EXT-X-BYTERANGE 分片）不参与：缓存里存的是整段
      const ranged = context && (context.rangeStart || context.rangeEnd);
      const hit = ranged ? null : takeSeg(context && context.url);
      if (!hit) {
        // 这一片正在预热途中：值不值得等，看它还剩多少（见 waitBudget）。
        // 等到了就白赚一整片的下载；判定等不到就立刻掐掉它自己下——它占着的那几路
        // 正是自己现在最需要的带宽，留着它只会两败俱伤。
        const k = ranged ? null : segKey(context && context.url);
        const ent = k ? pending.get(k) : null;
        if (ent) {
          const budgetMs = waitBudget(ent);
          const age = ent.startedAt ? Date.now() - ent.startedAt : 0;
          if (!waitAct) {
            waitAge = age;
            waitMs = budgetMs;
          }
          try {
            console.log(
              '[warm] in flight ' + age + 'ms warm~' + Math.round(warmMs || WARM_MS_GUESS) +
                ' own~' + Math.round(ownMs || OWN_MS_GUESS) + ' → ' +
                (budgetMs ? 'wait ' + budgetMs + 'ms' : 'take over') + ' ' + context.url
            );
          } catch (e) {}
          if (!budgetMs) {
            // 掐掉它，然后走下面的常规路径自己下。注意要先摘掉 pending，
            // 否则它那条链结束时的清理会晚一步，期间的重入又会走回这条分支。
            if (!waitAct) waitAct = 'over';
            pending.delete(k);
            if (ent.abort) { try { ent.abort(); } catch (e) {} }
          } else {
            this._waiting = true;
            let settled = false;
            const resume = (giveUp) => {
              if (settled) return;
              settled = true;
              clearTimeout(this._waitTimer);
              this._waitTimer = null;
              if (!this._waiting || this._cancelled) return; // 期间被 abort/destroy 了
              if (pending.get(k) === ent) pending.delete(k);
              this._waiting = false;
              if (!waitAct) waitAct = giveUp ? 'give' : 'wait';
              if (giveUp) {
                try { console.log('[warm] give up waiting ' + context.url); } catch (e) {}
                // 结果已经没人要了，它再占着带宽就是纯拖累
                if (ent.abort) { try { ent.abort(); } catch (e) {} }
              }
              this.load(context, config, callbacks); // 再走一遍：这时该命中了；没下成就自然落到网络加载
            };
            this._waitTimer = setTimeout(() => resume(true), budgetMs);
            ent.p.then(() => resume(false), () => resume(false));
            return;
          }
        }
        // 起播那一片没命中时打一行：把 hls.js 要的地址和缓存里存的地址一起打出来，
        // 光看「有没有闪电」分不清是地址算错了还是目标片算错了，对比这两行就一目了然。
        // （只进控制台。这两行曾经也弹到屏幕上，实测阶段过了就撤掉了。）
        if (!missLogged) {
          missLogged = true;
          missKind = classifyMiss(context && context.url);
          try {
            console.log(
              '[warm] MISS(' +
                missKind +
                ') want=' +
                (context && context.url) +
                ' have=' +
                JSON.stringify([...store.keys()])
            );
          } catch (e) {}
        }
        // 缓存没有、也不在预热途中：交给并行分段下载试试。它自己判断适不适用
        // （源不支持 Range、片太小、开关没开都会退回），不适用就是原来的整片下载。
        if (!ranged && this._tryRange(context, config, callbacks)) return;
        this._loadSelf(context, config, callbacks);
        return;
      }
      const st = this.stats;
      const now = self.performance.now();
      hits++;
      try { console.log('[warm] HIT ' + context.url); } catch (e) {}
      st.loading.start = now - hit.ms; // 回填预热时的真实耗时，见 putSeg 注释
      st.loading.first = st.loading.start + 1;
      st.loading.end = now;
      st.loaded = st.total = hit.buf.byteLength;
      st.chunkCount = 1;
      st.bwEstimate = (hit.buf.byteLength * 8000) / hit.ms;
      // 异步回调：hls.js 在 load() 里同步收到 onSuccess 会造成状态机重入
      this._hitTimer = setTimeout(() => {
        this._hitTimer = null;
        if (this._cancelled || this._loadState.done) return;
        this._loadState.done = true;
        callbacks.onSuccess(
          { url: context.url, data: hit.buf },
          st,
          context,
          null
        );
      }, 0);
    }

    abort() {
      const state = this._loadState;
      const notify = state && !state.done;
      const stats = this.stats;
      // 先锁定终结状态；onAbort 会同步触发 Hls 的 resetLoader -> destroy。
      if (state) state.done = true;
      if (notify) stats.aborted = true;
      this._clearHit();
      // 基类 onAbort 只收集参数，等自身和基类都清理完再统一通知。
      if (notify) state.aborting = true;
      try {
        super.abort();
      } finally {
        if (notify) state.aborting = false;
      }
      if (notify && state.callbacks.onAbort) {
        state.callbacks.onAbort(...(state.abortArgs || [stats, state.context, null]));
      }
    }

    destroy() {
      // 即便基类 destroy 内部调用 this.abort，也必须保持静默。
      if (this._loadState) this._loadState.done = true;
      this._clearHit();
      super.destroy();
    }

    // 整片下载（走基类）。包一层只为了把耗时记进 ownMs。
    //
    // 原来只在并行分段那条路上记，于是源不支持 Range（或开关没开、片太小）时
    // ownMs 永远是 0，waitBudget 一直拿 1200ms 的缺省猜值当「自己下一遍要多久」——
    // 而实测首片要 2.7 秒。低估自己的耗时会让它系统性地得出「自己下更快」，
    // 把快下完的在途预热片一律取消重下，正是屏上 0g 和「已对齐却未命中」的成因。
    //
    // 错误与重试仍归基类；取消后所有回调都作废，不能再更新统计或重启旧加载。
    _loadSelf(context, config, callbacks) {
      const state = this._loadState;
      if (this._cancelled || state.done) return;
      const cb = {};
      for (const key in callbacks) {
        const orig = callbacks[key];
        cb[key] = typeof orig !== 'function' ? orig : (...args) => {
          if (key === 'onAbort' && state.aborting) {
            if (!state.abortArgs) state.abortArgs = args;
            return;
          }
          if (this._cancelled || state.done) return;
          if (key === 'onSuccess' || key === 'onError' || key === 'onTimeout' || key === 'onAbort') {
            state.done = true;
          }
          if (key === 'onSuccess') {
            try {
              const l = args[1] && args[1].loading;
              const ms = l ? l.end - l.start : 0;
              if (ms > 0) ownMs = ema(ownMs, ms);
            } catch (e) {}
          }
          return orig(...args);
        };
      }
      super.load(context, config, cb);
    }

    // 并行分段下载这一片。返回「是否已接管」：接管了调用方就不要再走整片下载。
    // 开关没开/已知不支持 Range 时同步返回 null，直接走整片；200 整片响应直接复用。
    // 探路后才发现片太小或失败，则只用剩余的时间额度回退。
    _tryRange(context, config, callbacks) {
      // 超时沿用 hls.js 给这次加载定的额度，别自己另定一套：
      // 用户在调优里改了 fragLoadingTimeOut，分段下载也应该跟着改。
      const to =
        config && config.loadPolicy ? config.loadPolicy.maxLoadTimeMs : config && config.timeout;
      const started = self.performance.now();
      const job = rangeLoad(context && context.url, to);
      if (!job) return false;
      this.context = context;
      this._rangeJob = job;
      job.promise.then((res) => {
        if (this._cancelled || this._rangeJob !== job) return;
        this._rangeJob = null;
        if (!res) {
          // 并行和整片回退共享一次加载的总额度，不能各花一整份超时时间。
          const elapsed = Math.max(0, self.performance.now() - started);
          const remaining = Number.isFinite(to) && to > 0 ? Math.max(0, to - elapsed) : to;
          if (remaining === 0 && to > 0) {
            const st = this.stats;
            st.loading.start = started;
            st.aborted = true;
            // hls.js 的签名是 (stats, context, networkDetails)，由它决定后续重试。
            this._loadState.done = true;
            callbacks.onTimeout(st, context, null);
            return;
          }
          // 基类会改 config.timeout，不能污染 Hls 原配置或共享的 loadPolicy。
          const fallback = { ...config };
          if (Number.isFinite(remaining) && remaining > 0) {
            fallback.timeout = remaining;
            if (config.loadPolicy) {
              const first = config.loadPolicy.maxTimeToFirstByteMs;
              fallback.loadPolicy = {
                ...config.loadPolicy,
                maxLoadTimeMs: remaining,
                // 新请求仍有首字节期限，但它也不能超过剩余的总时间。
                maxTimeToFirstByteMs: first > 0 && Number.isFinite(first)
                  ? Math.min(first, remaining) : remaining
              };
            }
          } else if (config && config.loadPolicy) {
            fallback.loadPolicy = { ...config.loadPolicy };
          }
          this._loadSelf(context, fallback, callbacks);
          return;
        }
        const st = this.stats;
        const now = self.performance.now();
        // 记下自己下一片要多久（全路数）。waitBudget 拿它和预热耗时比，
        // 才知道「等在途那片」和「自己下一遍」哪个更快。
        if (res.ms > 0) ownMs = ema(ownMs, res.ms);
        st.loading.start = now - res.ms;
        st.loading.first = st.loading.start + res.ttfb;
        st.loading.end = now;
        st.loaded = st.total = res.buf.byteLength;
        st.chunkCount = 1;
        // 带宽估计如实填并行的实测值。hls.js 拿它判断「这条线够不够快」，
        // 填单连接的数字会让它一直低估，多码率源上会白白降档。
        st.bwEstimate = (res.buf.byteLength * 8000) / res.ms;
        // 这里已经在 promise 回调里，天然晚于 load() 返回，不必再排一次 setTimeout
        this._loadState.done = true;
        callbacks.onSuccess({ url: context.url, data: res.buf }, st, context, null);
      });
      return true;
    }

    _clearHit() {
      this._cancelled = true;
      this._waiting = false; // 别再去等在途的那一片了
      if (this._waitTimer) {
        clearTimeout(this._waitTimer);
        this._waitTimer = null;
      }
      if (this._hitTimer) {
        clearTimeout(this._hitTimer);
        this._hitTimer = null;
      }
      // 掐掉在途的分段下载。必须先置空、再 abort：上面的回调靠
      // `this._rangeJob !== job` 认出自己已作废，顺序反了它会在 abort 之后
      // 又去发起一次整片下载，等于换台后还在给旧频道下数据。
      if (this._rangeJob) {
        const j = this._rangeJob;
        this._rangeJob = null;
        j.abort();
      }
    }
  };
}
