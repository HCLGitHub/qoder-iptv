// 可调播放参数（hls.js）：定义表 + 持久化 + 转成 hls.js 配置片段。
//
// 存在的意义：起播速度、缓冲厚度、抗抖动这些东西在开发机上量不出来——PC 解码快、
// 公网带宽足，瓶颈根本不出现。真机（尤其 4K HEVC 高码率源）才是唯一有效的测量场地，
// 所以把这几个真正有杠杆的参数开放出来，让用户在电视上直接试。
//
// 只有走 hls.js 解码时这些参数才有意义。原生解码由电视系统媒体管线负责，
// 缓冲策略完全不受这里控制（面板里会显示当前实际走的哪条路）。
//
// 重要：不要在这里加 liveSyncDurationCount。hls.js 禁止它与 liveSyncDuration 并存，
// 同时出现会在 new Hls() 时直接 throw，播放器彻底起不来。
import { read, write } from '../core/storage.js';
import { t } from '../core/i18n.js';

const KEY = 'hlsTuning';

const onOff = (v) => (v ? t('label.on') : t('label.off'));

// values 是左右键循环的候选值（遥控器上让用户敲数字太痛苦，且限定候选能防止设出非法值）。
// def 必须与 Player.js 里 CFG.hls 的取值 / hls.js 自身默认值保持一致，否则「恢复默认」会走偏。
export const TUNING_SPECS = [
  {
    key: 'liveSyncDuration',
    values: [8, 12, 16, 20, 22, 26, 30, 40, 50],
    def: 22,
    fmt: (v) => v + 's'
  },
  {
    key: 'startOnSegmentBoundary',
    values: [true, false],
    def: true,
    fmt: onOff
  },
  // 相邻频道预热的单片上限（也不是 hls.js 的参数）。
  // 预热时从「hls.js 起播真正会请求的那一片」起连续拉几片进内存，切过去时直接喂给它，
  // 省掉换台时现下整片的时间——这是换台提速最实在的一招。
  // 这个值是**单片**上限，超过它的分片直接跳过，所以必须大于源的实际片大小，
  // 否则一片都存不下。曾经把它当作「单个邻台的总额度」由几片分摊，结果是连续预热
  // 塌回成只热一片，而实测起播要的往往是第二片，命中率直接归零——片数不能牺牲。
  // 代价是后台流量约为本值×4（两个邻台各 2 片），4K 源上要留意会不会挤当前台的带宽。
  // 收益实测很大：命中时起播 0.4 秒，未命中 4 秒。
  // 64MB 档是给 4K 台的：实测 4K 片能超过 32MB，超上限会被跳过（角标显示 wb）。
  // 但调这么大之前先算一下带宽：一片 40MB 在 3MB/s 下要 13 秒才下完，
  // 邻台停留通常没这么久，下不完等于白占当前台的带宽。
  {
    key: 'prefetchSegmentBytes',
    values: [0, 2097152, 4194304, 8388608, 16777216, 33554432, 67108864],
    def: 8388608,
    app: true,
    fmt: (v) => (v === 0 ? t('label.off') : v / 1048576 + ' MB')
  },
  {
    key: 'prefetchStartBuffer',
    values: [2, 3, 5, 8, 10, 15, 20],
    def: 5,
    app: true,
    warm: true,
    fmt: (v) => v + 's'
  },
  {
    key: 'prefetchHoldBuffer',
    values: [1, 2, 3, 5, 8, 10],
    def: 3,
    app: true,
    warm: true,
    fmt: (v) => v + 's'
  },
  {
    key: 'prefetchAdaptive',
    values: [true, false],
    def: true,
    app: true,
    warm: true,
    fmt: onOff
  },
  // 分片并行分段下载的路数（本地实现，见 rangeLoad.js）。
  // 依据是实测出来的网关限速规律：单条连接的额度只有「节目码率 × 约 1.9」，
  // 而线路总吞吐上限远高于此，所以拆成几条 Range 连接同时下能吃满线路。
  // 真机实测：高清台起播 3 秒多 → 1 秒出头，4K 台 6 秒 → 3 秒左右。
  // 注意 4K 在 PC 上量出来只有 1.1 倍（单连接已顶到线路上限），真机却有一倍——
  // 电视单条连接的吞吐比 PC 低得多，所以别拿 PC 的比值判断要不要开这项。
  // 默认 6：PC 上 8 路与 4 路持平（那时以为线路已打满），但真机上 4 → 6 首片还在降，
  // 又一次印证了「PC 的比值预测不了电视」。8 路真机未验证，留着让你自己试。
  // 邻台预热也走这条路，路数取本值的一半（见 rangeLoad.warmLanes），
  // 免得后台预热把线路吃满、挤到正在看的那个台。
  // 源不支持 Range 时会自动退回整片下载，设 0 是彻底关掉、回到原行为。
  {
    key: 'fragParallel',
    values: [0, 2, 3, 4, 6, 8],
    def: 6,
    app: true,
    fmt: (v) => (v === 0 ? t('label.off') : v + t('tune.lanes'))
  },
  {
    key: 'maxBufferLength',
    values: [10, 15, 20, 30, 45, 60],
    def: 30,
    fmt: (v) => v + 's'
  },
  {
    key: 'backBufferLength',
    values: [0, 5, 10, 30, 60, 90],
    def: 30,
    fmt: (v) => v + 's'
  },
  {
    key: 'abrEwmaDefaultEstimate',
    values: [1000000, 1500000, 3000000, 6000000, 10000000, 20000000, 40000000],
    def: 1500000,
    fmt: (v) => (v / 1000000).toFixed(v % 1000000 ? 1 : 0) + ' Mbps'
  },
  {
    key: 'startFragPrefetch',
    values: [true, false],
    def: true,
    fmt: onOff
  },
  {
    key: 'fragLoadingTimeOut',
    values: [8000, 15000, 20000, 30000, 45000, 60000],
    def: 15000,
    fmt: (v) => v / 1000 + 's'
  },
  {
    key: 'fragLoadingMaxRetry',
    values: [1, 2, 3, 5, 8],
    def: 3,
    fmt: (v) => String(v)
  },
  {
    key: 'liveSyncOnStallIncrease',
    values: [0, 1, 2, 3, 5],
    def: 1,
    fmt: (v) => v + 's'
  },
  {
    key: 'enableWorker',
    values: [true, false],
    def: true,
    fmt: onOff
  }
];

const SPEC_BY_KEY = TUNING_SPECS.reduce((m, s) => ((m[s.key] = s), m), {});

export function defaultTuning() {
  return TUNING_SPECS.reduce((o, s) => ((o[s.key] = s.def), o), {});
}

// 读取时逐项校验：候选值改动过（版本升级）或存档被改坏时回落到默认值，
// 免得把非法值喂给 hls.js。
function normalizeTuning(saved) {
  const out = defaultTuning();
  for (const s of TUNING_SPECS) {
    if (s.values.indexOf(saved[s.key]) >= 0) out[s.key] = saved[s.key];
  }
  const holdValues = SPEC_BY_KEY.prefetchHoldBuffer.values.filter((v) => v < out.prefetchStartBuffer);
  out.prefetchHoldBuffer = Math.min(out.prefetchHoldBuffer, holdValues[holdValues.length - 1]);
  return out;
}

export function getTuning() {
  return normalizeTuning(read(KEY, {}) || {});
}

export function saveTuning(obj) {
  const tuning = normalizeTuning(obj);
  write(KEY, tuning);
  return tuning;
}

export function resetTuning() {
  const d = defaultTuning();
  saveTuning(d);
  return d;
}

// 是否全部为默认值（UI 上提示用）
export function isAllDefault(tuning) {
  return TUNING_SPECS.every((s) => tuning[s.key] === s.def);
}

// 左右键循环取下一个候选值
export function cycleValue(key, cur, dir, tuning) {
  const s = SPEC_BY_KEY[key];
  if (!s) return cur;
  const values = key === 'prefetchHoldBuffer' && tuning
    ? s.values.filter((v) => v < tuning.prefetchStartBuffer)
    : s.values;
  const i = values.indexOf(cur);
  const base = i < 0 ? Math.max(0, values.indexOf(s.def)) : i;
  return values[(base + dir + values.length) % values.length];
}

export function formatValue(key, v) {
  const s = SPEC_BY_KEY[key];
  return s ? s.fmt(v) : String(v);
}

// 转成能直接展开进 new Hls({...}) 的配置片段。
// key 名与 hls.js 配置项同名，所以直接原样返回即可。
// 标了 app 的项是本地实现的参数（hls.js 不认识），必须过滤掉。
export function toHlsConfig(tuning) {
  const t2 = tuning || getTuning();
  const out = {};
  for (const s of TUNING_SPECS) {
    if (s.app) continue;
    if (t2[s.key] !== undefined) out[s.key] = t2[s.key];
  }
  return out;
}
