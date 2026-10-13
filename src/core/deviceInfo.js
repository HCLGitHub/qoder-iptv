// 设备信息采集：序列号、网卡 MAC、型号与固件，供设备信息面板展示。
//
// 注意 appinfo.json 的 requiredPermissions 对第三方应用是**不起作用**的
// （1.1.15 已实测撤回过 media 权限），所以 network.query 写在那里并不构成保证。
// getinfo 到底能不能调通只能在真机上试——这也是这个面板存在的意义：
// 把 LS2 的原始返回和错误文本直接摊到屏上，电视上取不到控制台日志。

// ---- LS2 桥 ----
// 直接用 PalmServiceBridge，不引 webOSTV.js。
// 实例必须在回调返回前一直被引用住，提前被 GC 就永远收不到响应——
// 所以下面把 bridge 放在闭包里，并且 timer 也持有它。
function lunaCall(uri, params, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let bridge;
    try {
      bridge = new window.PalmServiceBridge();
    } catch (e) {
      resolve({ ok: false, err: 'no-bridge' });
      return;
    }
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // 显式解引用：调用结束后不再需要，且要确保它活到这一刻
      bridge = null;
      resolve(v);
    };
    const timer = setTimeout(() => finish({ ok: false, err: 'timeout' }), timeoutMs);
    bridge.onservicecallback = (msg) => {
      try {
        const j = JSON.parse(msg);
        // returnValue 为 false 时 errorText 才是有意义的诊断信息，原样交出去：
        // Unknown method=名字错了 / Denied=没权限 / not handled=有权限但参数不对
        if (j && j.returnValue === false) {
          finish({ ok: false, err: j.errorText || 'returnValue=false', raw: j });
          return;
        }
        finish({ ok: true, data: j });
      } catch (e) {
        finish({ ok: false, err: 'bad-json' });
      }
    };
    try {
      bridge.call(uri, JSON.stringify(params || {}));
    } catch (e) {
      finish({ ok: false, err: 'call-throw' });
    }
  });
}

function normMac(v) {
  if (!v || typeof v !== 'string') return '';
  const s = v.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  // 全 0 的 MAC 是「网卡存在但没拿到地址」，当没有
  if (s.length !== 12 || /^0+$/.test(s)) return '';
  return s;
}

// 深度遍历整个返回找 MAC，不再逐个猜字段名。
//
// 1.1.29 真机实测：getinfo 明明调通了（没报任何错），但按 macAddress / mac
// 这些名字一个都没命中。继续猜名字是没有尽头的——各固件版本的字段名和嵌套
// 层级都不一样。改成「凡是长得像 MAC 的字符串就收下，并记住它在哪个路径」，
// 路径本身就够判断这是有线还是无线网卡了。
const MAC_RE = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;

function scanMacs(node, path, out, depth) {
  if (!node || depth > 6) return;
  if (typeof node === 'string') {
    if (MAC_RE.test(node.trim())) {
      const m = normMac(node);
      if (m) out.push({ path, mac: m });
    }
    return;
  }
  if (typeof node !== 'object') return;
  for (const k of Object.keys(node)) {
    scanMacs(node[k], path ? path + '.' + k : k, out, depth + 1);
  }
}

// 把返回压成一行文本上屏。电视上取不到控制台日志，原始返回不上屏就无从判断
// 字段藏在哪。截断是必须的——getinfo 的返回能有好几百字符，撑爆面板。
function brief(obj, max = 260) {
  let s;
  try {
    s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  } catch (e) {
    s = String(obj);
  }
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// 序列号这类值可能返回占位串，要当成没取到
function cleanId(v) {
  if (!v || typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length < 4) return '';
  if (/^(unknown|n\/a|none|null|undefined|0+)$/i.test(s)) return '';
  return s;
}

// ---- 对外 ----

// 采集一次设备信息。每一项都带来源标记和原始返回，面板要把它们全显示出来。
export async function collectDevice() {
  const out = {
    serial: '',
    serialFrom: '',
    wiredMac: '',
    wifiMac: '',
    macPath: '', // MAC 在返回里的字段路径，用来核对扫到的是不是真网卡
    netErr: '',
    model: '',
    firmware: '',
    sysErr: '',
    probes: [], // 每个接口的原始返回，供屏上核对
    ua: ''
  };

  const probe = async (name, uri, params) => {
    const r = await lunaCall(uri, params);
    out.probes.push({
      name,
      ok: !!r.ok,
      err: r.ok ? '' : r.err || 'unknown',
      text: r.ok ? brief(r.data) : brief(r.raw || '')
    });
    return r;
  };

  // 1) 序列号。这条路优先级最高：它不是网卡属性，换网线、切 Wi-Fi、重装都不变。
  // 上一版实测证明 tv.systemproperty 这个服务对我们**是有权限的**（型号固件都取到了），
  // 所以单独再调一次问 serialNumber。必须单独调——把它和其他 key 混在一批里，
  // 一个不支持的 key 可能让整批返回失败，就白白丢了型号固件。
  const ser = await probe(
    'systemproperty serialNumber',
    'luna://com.webos.service.tv.systemproperty/getSystemInfo',
    { keys: ['serialNumber'] }
  );
  if (ser.ok) {
    const v = cleanId((ser.data || {}).serialNumber);
    if (v) {
      out.serial = v;
      out.serialFrom = 'systemproperty';
    }
  }

  // 2) 网卡 MAC。深度扫描整个返回，路径一起记下来。
  const net = await probe('connectionmanager getinfo', 'luna://com.webos.service.connectionmanager/getinfo', {});
  const macs = [];
  if (net.ok) scanMacs(net.data, '', macs, 0);
  else out.netErr = net.err || 'unknown';

  // getinfo 里扫不到就换 getStatus 再试一次，两个接口的返回结构不一样
  if (!macs.length) {
    const st = await probe('connectionmanager getStatus', 'luna://com.webos.service.connectionmanager/getStatus', {});
    if (st.ok) scanMacs(st.data, '', macs, 0);
  }

  for (const m of macs) {
    const p = m.path.toLowerCase();
    if (!out.wiredMac && /wired|eth/.test(p)) { out.wiredMac = m.mac; out.macPath = m.path; }
    else if (!out.wifiMac && /wifi|wlan/.test(p)) { out.wifiMac = m.mac; if (!out.macPath) out.macPath = m.path; }
  }
  // 扫到了 MAC 但路径里没有有线/无线字样：仍然收下，当有线用。
  // 一个不知道属于哪块网卡的 MAC，也比退回本地随机串强得多。
  if (!out.wiredMac && !out.wifiMac && macs.length) {
    out.wiredMac = macs[0].mac;
    out.macPath = macs[0].path;
  }

  // 3) LG 设备 ID。按已有认知它需要 LG 签名应用，大概率会返回 Denied；
  // 顺手试一次，万一通了它比 MAC 和序列号都好。原始错误会显示在探测列表里。
  const ids = await probe('sm deviceid getIDs', 'luna://com.webos.service.sm/deviceid/getIDs', {
    idType: ['LGUDID']
  });
  if (ids.ok && !out.serial) {
    const arr = (ids.data || {}).idList;
    if (Array.isArray(arr) && arr.length) {
      const v = cleanId(arr[0].idValue || arr[0].value);
      if (v) { out.serial = v; out.serialFrom = 'LGUDID'; }
    }
  }

  // 4) 型号/固件。取不到只是面板上少两行。
  const sys = await lunaCall('luna://com.webos.service.tv.systemproperty/getSystemInfo', {
    keys: ['modelName', 'firmwareVersion', 'sdkVersion']
  });
  if (sys.ok) {
    const d = sys.data || {};
    out.model = d.modelName || '';
    out.firmware = d.firmwareVersion || d.sdkVersion || '';
  } else {
    out.sysErr = sys.err || 'unknown';
    // 退一步用 PalmSystem.deviceInfo，它是个 JSON 串，不需要任何权限
    try {
      const pd = JSON.parse(window.PalmSystem.deviceInfo);
      out.model = out.model || pd.modelName || '';
      out.firmware = out.firmware || pd.platformVersion || '';
    } catch (e) {}
  }

  try { out.ua = navigator.userAgent || ''; } catch (e) {}
  return out;
}
