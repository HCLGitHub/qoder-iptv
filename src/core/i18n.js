// 轻量 i18n：中文/英文双语字典 + t(key, params) 取词（支持 {name} 占位）。
// settings.language 为 auto | zh | en；auto 按系统语言解析，切换时用 setLang 更新。
import { getSettings } from './storage.js';

const DICT = {
  zh: {
    // 设置
    'settings.title': '设置',
    'settings.aspect': '画面比例',
    'settings.decoder': '解码方式',
    'settings.autoPlay': '开机自动播放上次频道',
    'settings.netSpeed': '显示当前视频网速',
    'settings.fontScale': '字号',
    'settings.language': '语言',
    'settings.refreshEpg': '刷新 EPG 节目单',
    'settings.clearEpg': '清理 EPG 缓存',
    'settings.sourceManager': '直播源管理',
    'settings.groupManager': '分组显示管理',
    'settings.hint':
      '上下选择，左右调整数值，OK 执行按钮项，返回键关闭。<br>鼠标：点行切换/执行，点 ◄ ► 调值，点面板外或右上角 ✕ 关闭。',
    'label.fill': '填充',
    'label.auto': '自动',
    'label.native': '原生',
    'label.on': '开',
    'label.off': '关',
    'label.small': '小',
    'label.medium': '中',
    'label.large': '大',

    // 播放器参数调优（hls.js）
    'settings.playerTuning': '播放器参数（真机调优）',
    'settings.deviceInfo': '设备信息',
    'startup.data': '有帧',
    'startup.frame': '呈帧',
    'startup.seek': '定位',
    'startup.play': '开播',
    'startup.motion': '推进',
    'startup.waitPlay': '待播',
    'startup.ahead': '连续缓冲 {seconds}s',
    'startup.buffer': '等待可播数据',
    'startup.seeking': '定位中',
    'startup.ready': '有缓冲未推进',
    'startup.dependency': '等待当前片或音轨',
    'startup.moving': '已连续播放',
    'startup.timeout': '起播观察结束',
    'startup.nudged': '正在校正边界',
    'startup.corrected': '已校正起播边界',
    'startup.native': '原生',
    'startup.nativeNudged': '正在微调原生起播位置',
    'startup.nativeCorrected': '已尝试原生起播微调',
    'startup.bufferUnknown': '原生未报告缓冲',
    'startup.error': '媒体错误',
    'startup.fallback.media': '媒体错误',
    'startup.fallback.codec': '编码错误',
    'startup.fallback.hevc': 'HEVC 不受 MSE 支持',
    'startup.fallback.audio': '音轨不受 MSE 支持',
    'tune.title': '播放器参数',
    'tune.reset': '↺ 恢复默认全部参数',
    'tune.pathHls': '当前解码：hls.js —— 缓冲预热门槛可即时调整',
    'tune.pathNative': '当前解码：系统原生 —— hls.js 参数无效；预热闸门需系统提供缓冲信息',
    'tune.pathIdle': '当前没在播放 —— 参数已保存，下次起播生效',
    'tune.modified': '已改动',
    'tune.allDefault': '全部为默认值',
    'tune.hint': '上下选择，左右或点击箭头调值。邻台缓冲三项立即生效；其他参数关闭后重新起播。',
    'tune.prefetchStartBuffer': '邻台预热启动余量',
    'tune.prefetchStartBuffer.d': '当前频道至少还可连续播放多少秒，才启动或恢复邻台分片下载；不是固定等待时长。调小更早预热，但更容易争抢带宽。自适应开启时这是下限，实际门槛看上方。',
    'tune.prefetchHoldBuffer': '邻台预热暂停余量',
    'tune.prefetchHoldBuffer.d': '可播余量低于此值时暂停启动新的邻台分片，已在下载的片不取消。必须小于启动余量，降低启动余量时会自动调整。自适应开启时暂停门槛也可能提高。',
    'tune.prefetchAdaptive': '邻台自适应安全余量',
    'tune.prefetchAdaptive.d': '开：按当前分片时长和下载耗时提高门槛，例如 6 秒分片会要求至少 9 秒缓冲。关：严格使用上面两项设定值，可更早预热，但卡顿风险增加；发生卡顿仍会让路。',
    'tune.prefetchStatus': '实际可播 {ahead}s · 预热启动 ≥{resume}s / 暂停 <{hold}s',
    'tune.prefetchIdle': '播放后显示实际预热门槛；以下邻台缓冲三项修改立即生效。',
    'toast.tuningApplied': '播放器参数已应用，正在重新起播…',
    'toast.tuningReset': '已恢复默认参数',
    'tune.liveSyncDuration': '起播回退量',
    'tune.liveSyncDuration.d':
      '离直播最前沿退多少秒开始播。调小延迟低但缓冲垫薄、更容易卡；调大更稳但落后直播更多。',
    'tune.startOnSegmentBoundary': '起播对齐分片',
    'tune.startOnSegmentBoundary.d':
      '开：尽量从首个可播缓冲区间的起点开始，减少片内定位等待；源的关键帧与音视频时间戳仍会影响起播。关：允许从分片中间开始。',
    'tune.prefetchSegmentBytes': '邻台预热单片上限',
    'tune.prefetchSegmentBytes.d':
      '当前台达到预热缓冲门槛后，把上下相邻两个台起播位置附近的连续 2 个分片拉进内存；启动/暂停余量与自适应保护可在下方调整。用 CH+/- 切过去时不再现下分片，而是让播放器直接从内存里已有的那一片开始播——实测命中时起播 0.4 秒，未命中 4 秒。起播点会退到已缓存的那一片上，但首帧提前的时间和退后的时间基本相等，所以直播延迟几乎不变。这里设的是单片上限，比它大的分片直接跳过，所以必须比你的源的实际片大小大，否则一片都存不下（实测这批源单片 5~6MB，设 8MB 合适）。效果看网速角标的起播秒数后面：⚡ = 命中；✕ 后面是换台那刻存着几片，加字母说明卡在哪（b 单片超上限，往大调；s 缓存的片已滑出这个台的清单窗口，停留太久了；w 后面再跟一位说明这个台的预热走到哪步：- 没排进预热，连按翻台越过了相邻台；0 排进队了但没轮到下就被换台清空（停留时间不够，属时间墙：单片 2.4 秒，先排的方向约 2.6 秒就绪、后排的约 5 秒，所以会优先热你刚才翻台的那个方向）；a 换台那刻正在下、被让路掐掉；e 请求被服务器拒；b 都超上限；k 存进去了却对不上；m 清单没拉到）。后台流量约为本值×4；如果当前台或新台反而变慢，说明预热在抢带宽，设 0 关掉。',
    'tune.fragParallel': '分片并行下载',
    'tune.lanes': ' 路',
    'tune.fragParallel.d':
      '把一个分片拆成几段、用多条连接同时下，再拼回整段。实测这批源的网关是按「单条连接不超过节目码率的 1.9 倍」限速的，而线路总吞吐远高于此，所以多条一起下能吃满线路。真机实测：高清台起播从 3 秒多降到 1 秒出头，4K 台从 6 秒降到 3 秒左右。这也是「无论什么台都要等 3 秒」的真正原因：额度恒为码率的 1.9 倍，6 秒的分片永远要 3 秒才下完，跟画质无关。邻台预热也走这条路，路数用一半，免得后台预热挤到正在看的台。路数越多越吃线路，也越占连接；默认 6 是真机上试出来的，4 → 6 还在降，8 路没验证过，可以自己试。源不支持分段下载时会自动退回整片下载；怀疑它导致花屏或卡顿就设 0 关掉。',
    'tune.maxBufferLength': '前向缓冲',
    'tune.maxBufferLength.d': '前向缓存的目标时长，调大更抗网络抖动；并非起播前必须攒满的时长。',
    'tune.backBufferLength': '后向缓冲',
    'tune.backBufferLength.d': '播过的内容保留多少秒。内存小的机型调小可减轻压力。',
    'tune.abrEwmaDefaultEstimate': '初始带宽估计',
    'tune.abrEwmaDefaultEstimate.d':
      '起播瞬间假定的带宽。多码率源上调高会一上来就选高清档；估得比实际高会立刻卡。',
    'tune.startFragPrefetch': '首片预取',
    'tune.startFragPrefetch.d': '开：不等解码器就绪就先下载第一片，起播更快。',
    'tune.fragLoadingTimeOut': '分片超时',
    'tune.fragLoadingMaxRetry': '分片重试次数',
    'tune.fragLoadingTimeOut.d': '单个分片下载多久算超时。源慢的话调大，可减少被误判成失败。',
    'tune.fragLoadingMaxRetry.d': '分片下载失败后重试几次。源不稳定时调大更能撑住不中断。',
    'tune.liveSyncOnStallIncrease': '卡顿后加厚',
    'tune.liveSyncOnStallIncrease.d': '每卡一次就把起播回退量临时加大这么多秒，避免在同一处反复卡。',
    'tune.enableWorker': 'Worker 解封装',
    'tune.enableWorker.d': '开：把解封装放到后台线程，主线程（界面）更流畅。个别机型不支持时可关掉试试。',

    // 源管理
    'sm.title': '直播源管理',
    'sm.inUse': '（使用中）',
    'sm.testing': '测试中…',
    'sm.test': '⟳ 测试',
    'sm.delete': '✕ 删除',
    'sm.empty': '还没有直播源，请在上方添加。',
    'sm.name': '名称',
    'sm.m3uUrl': 'M3U 地址',
    'sm.epgUrl': 'EPG 地址（可选）',
    'sm.namePlaceholder': '例如：我的IPTV',
    'sm.m3uPlaceholder': 'http://.../playlist.m3u',
    'sm.epgPlaceholder': '留空则用 M3U 内地址，都没有时用内置 EPG',
    'sm.save': '＋ 保存并使用',
    'sm.saved': '已保存的源',
    'sm.navigateHint': '上下选择名称 / M3U / EPG / 保存，OK 开始输入；EPG 可留空。',
    'sm.inputHint': '正在输入：{field} · 方向键选字，OK 确认字符；键盘回车到下一项，返回结束输入。',
    'sm.hint':
      '收起键盘后，上下可往返修改任意输入项，OK 重新输入；到保存按钮后按 OK 保存。绿色键编辑，蓝色键删除，非输入时返回关闭。<br>鼠标：点行使用，点 ✎ 编辑、⟳ 测试、✕ 删除，点面板外或右上角 ✕ 关闭。',
    'sm.unnamed': '未命名源',
    'sm.pulling': '正在拉取源…',
    'sm.testingProgress': '测试中 {done}/{total}…',
    'sm.testDone': '测试完成：保留 {kept} 个频道，剔除 {dead} 个失效频道',
    'sm.testDoneGroups': '（含 {n} 个整组失效已移除）',
    'sm.testFailed': '测试失败：{msg}',
    'sm.noTestable': '该源没有可测试的频道',
    'sm.netError': '网络错误',
    'sm.edit': '✎ 编辑',
    'sm.saveEdit': '✓ 保存修改',
    'sm.editing': '正在编辑：{name}',
    'sm.cancelEdit': '取消编辑',

    // 分组显示管理
    'gm.title': '分组显示管理',
    'gm.sub': '当前源：{name} · 显示 {n}/{total} 个分组',
    'gm.rowShown': '{n} 个频道 · 显示',
    'gm.rowHidden': '{n} 个频道 · 已隐藏',
    'gm.showAll': '↺ 全部显示',
    'gm.keepOne': '至少要保留一个显示的分组',
    'gm.empty': '当前源没有可管理的分组',
    'gm.hint':
      '上下选择分组，OK（或左右键）切换显示/隐藏，返回键关闭并生效。<br>隐藏的分组不出现在频道菜单，也不参与上下键换台；设置只对当前源生效。',
    'toast.groupsApplied': '分组已更新：显示 {n} 个频道',
    'toast.noGroups': '当前源还没有加载到分组',

    // 退出确认
    'exit.title': '退出应用',
    'exit.sub': '确定要退出直播，返回电视主界面吗？',
    'exit.cancel': '取消',
    'exit.exit': '退出',

    // toast 提示
    'toast.noCatchup': '该节目暂不支持回看',
    'toast.catchup': '正在回看：{title}',
    'toast.catchupDetected': '已开启回看（可回看最近 {span}）',
    'unit.hours': '{n} 小时',
    'unit.days': '{n} 天',
    'toast.backToLive': '已回到直播',
    'toast.sourceSwitch': '源 {n}/{total}：{label}',
    'toast.channelNotFound': '未找到频道 {num}',
    'toast.noChannels': '该源没有解析到任何频道',
    'toast.addSourceFirst': '还没有直播源，请先添加一个（填名称和 M3U 地址后保存）',
    'toast.loadFailed': '加载失败：{msg}',
    'toast.noEpgUrl': '没有可用的 EPG 地址',
    'toast.refreshingEpg': '正在刷新节目单…',
    'toast.epgUpdated': '节目单已更新',
    'toast.epgFailed': '节目单刷新失败',
    'toast.epgLoadFailed': '节目单加载失败，暂无节目信息',
    'toast.noEpgData': '尚未加载到节目单数据',
    'toast.faved': '已收藏：{name}',
    'toast.unfaved': '已取消收藏',
    'toast.offline': '网络已断开',
    'toast.online': '网络已恢复，正在重连…',
    'toast.tryingBackup': '正在尝试备用源 {n}/{total}…',
    'toast.channelUnavailable': '该频道暂时无法播放',

    // fetch 错误说明
    'err.timeout': '请求超时，服务器没有响应。可能是源站太慢，或电视走了不通的 IPv6 线路',
    'err.httpRejected': '{msg}，服务器拒绝了请求',
    'err.connBase': '连不上该地址。请检查：地址是否已失效、是否写错',
    'err.connHttps':
      '；HTTPS 常见三种原因：证书不被电视信任、域名解析失败、IPv6 线路不通。可试：改用 http:// 地址、网络设置里关掉 IPv6、DNS 改成 223.5.5.5',
    'err.connOther': '；以及电视网络是否正常',

    // 分组提示
    'hint.group': '分组',

    // 频道菜单
    'cm.favGroup': '★ 收藏',
    'cm.channelHint': '节目单/回看 ›',
    'cm.srcBadge': '{n}源',
    'cm.catchup': '⟲回看',
    'cm.noEpg': '暂无节目单数据',
    'cm.settings': '设置',
    'cm.date': '日期',
    'cm.epg': '节目单',
    'cm.group': '分组',
    'cm.channels': '频道（{n}）',

    // EPG 指南
    'eg.catchup': '⟲可回看',
    'eg.noEpg': '该日暂无节目单数据',
    'eg.title': '节目指南',

    // 状态栏
    'sb.noSource': '未选择源',
    'sb.channelCount': '共 {n} 个频道',
    'sb.online': '● 已联网',
    'sb.offline': '● 网络断开',

    // 回看控制条
    'cb.catchup': '回看',
    'cb.title': '⟲ 回看 · {title}',

    // OSD
    'osd.catchup': '回看',
    'osd.nowPlaying': '正在播放：{title} {time}',
    'osd.latency': '延迟 {s}s',
    'osd.nowPlayingNone': '正在播放：暂无节目信息',
    'osd.nextPlaying': '即将播放：{title} {time}',
    'osd.source': '◀ 源 {n}/{total}：{label} ▶',

    // 日期 / 星期
    'date.today': '今天',
    'date.tomorrow': '明天',
    'date.yesterday': '昨天',
    'date.weekFmt': '周{d}',
    'date.week.0': '日',
    'date.week.1': '一',
    'date.week.2': '二',
    'date.week.3': '三',
    'date.week.4': '四',
    'date.week.5': '五',
    'date.week.6': '六',

    // 音频编码标签
    'audio.dolbyPlus': '杜比+',
    'audio.dolby': '杜比',

    // 播放错误
    'perr.generic': '播放出错',
    'perr.aborted': '播放被中止',
    'perr.network': '网络错误，无法加载',
    'perr.decode': '解码失败（格式不支持）',
    'perr.srcUnsupported': '源不可用或格式不支持',
    'perr.hevcUnsupported': '该频道为 H.265/HEVC，当前设备不支持解码',
    'perr.networkLost': '网络中断，无法加载该频道',
    'perr.decodeFailed': '解码持续失败，无法播放该频道',
    'perr.playFailed': '播放失败：{detail}',
    'perr.unknown': '未知错误',

    // EPG 节目
    'epg.unknownProgramme': '未知节目',
    'group.ungrouped': '未分组',
    'label.system': '跟随系统（{lang}）',

    // 设备信息
    'di.err.noBridge': '不在 webOS 环境（PC 预览时正常）',
    'di.err.timeout': '桥无响应（超时）',
    'di.err.badJson': '返回不是合法 JSON',
    'di.err.callThrow': '调用当场抛异常',
    'di.err.unknownMethod': '方法不存在（名字错了）',
    'di.err.denied': '方法存在但没有权限 —— 这条路走不通',
    'di.err.notHandled': '有权限，只是参数不对（可以再调）',
    'di.noProbes': '没有探测记录',
    'di.detecting': '正在检测…',
    'di.failed': '检测失败',
    'di.serial': '序列号',
    'di.wiredMac': '有线 MAC',
    'di.wifiMac': '无线 MAC',
    'di.macFailed': '取 MAC 失败',
    'di.model': '型号',
    'di.firmware': '固件',
    'di.sysFailed': '取系统信息失败',
    'di.appVersion': '应用版本',
    'di.openSource': '开源组件',
    'di.again': '↻ 重新检测',
    'di.rawShow': '▼ 原始返回',
    'di.rawHide': '▲ 收起原始返回',
    'di.hint': '左右键选按钮，OK 执行，上下键翻看信息，返回键关闭。',

    // 网速角标诊断
    'ns.align.nowin': '清单滑走，缓存片不在窗口内',
    'ns.align.ok': '已对齐却未命中（落位被改）',
    'ns.align.nodet': '拿不到分片列表',
    'ns.align.old': '缓存片太旧，不值得对齐',
    'ns.align.off': '预热额度为 0',
    'ns.align.err': '对齐抛异常',
    'ns.alignCode': '对齐{code}',
    'ns.noAlign': '未跑对齐',
    'ns.est': '估预热{warm} 自下{own}',
    'ns.guess': '(猜)',
    'ns.takeover': '在途预热片被直接接管（已下{age}ms）',
    'ns.giveUp': '等{budget}ms 后放弃在途预热片',
    'ns.noCache': '缓存里没有本台的片 · 窗口{lo}~{hi}({n}片)',
    'ns.inWinMiss': '号在窗口内却未匹配(地址规则)',
    'ns.slidOut': '缓存片真的滑出窗口',
    'ns.window': '{why} · 窗口{lo}~{hi}({n}片) 存{seg}',
    'ns.stale': '{align} · 缓存只有无关残留片（要{want} 存{top}）',
    'ns.seg': '{align} · 要{want} 存{top}',
    'ns.phase': '清单{manifest} · 首片{frag} · 缓冲{buffer} · '
  },

  en: {
    // Settings
    'settings.title': 'Settings',
    'settings.aspect': 'Aspect Ratio',
    'settings.decoder': 'Decoder',
    'settings.autoPlay': 'Auto-play last channel on start',
    'settings.netSpeed': 'Show network speed',
    'settings.fontScale': 'Font Size',
    'settings.language': 'Language',
    'settings.refreshEpg': 'Refresh EPG',
    'settings.clearEpg': 'Clear EPG Cache',
    'settings.sourceManager': 'Live Source Manager',
    'settings.groupManager': 'Group Visibility',
    'settings.hint':
      'Up/Down to select, Left/Right to adjust, OK to run button items, Back to close.<br>Mouse: click a row to switch/run, click ◄ ► to adjust, click outside or ✕ to close.',
    'label.fill': 'Fill',
    'label.auto': 'Auto',
    'label.native': 'Native',
    'label.on': 'On',
    'label.off': 'Off',
    'label.small': 'Small',
    'label.medium': 'Medium',
    'label.large': 'Large',

    // Player Tuning (hls.js)
    'settings.playerTuning': 'Player Tuning (on-device)',
    'settings.deviceInfo': 'Device Info',
    'startup.data': 'Data ',
    'startup.frame': 'Frame ',
    'startup.seek': 'Seek ',
    'startup.play': 'Play ',
    'startup.motion': 'Moving ',
    'startup.waitPlay': 'Wait ',
    'startup.ahead': 'Buffer {seconds}s',
    'startup.buffer': 'Waiting for playable data',
    'startup.seeking': 'Seeking',
    'startup.ready': 'Buffered, not advancing',
    'startup.dependency': 'Waiting for segment or audio',
    'startup.moving': 'Playback advancing',
    'startup.timeout': 'Startup observation ended',
    'startup.nudged': 'Adjusting start boundary',
    'startup.corrected': 'Start boundary adjusted',
    'startup.native': 'Native',
    'startup.nativeNudged': 'Adjusting native start position',
    'startup.nativeCorrected': 'Native startup nudge attempted',
    'startup.bufferUnknown': 'Native buffer not reported',
    'startup.error': 'Media error',
    'startup.fallback.media': 'media error',
    'startup.fallback.codec': 'codec error',
    'startup.fallback.hevc': 'HEVC unsupported by MSE',
    'startup.fallback.audio': 'audio unsupported by MSE',
    'tune.title': 'Player Tuning',
    'tune.reset': '↺ Reset All to Defaults',
    'tune.pathHls': 'Decoder: hls.js — prefetch buffer thresholds can be adjusted immediately',
    'tune.pathNative': 'Native decoder — hls.js settings have no effect; prefetch gating requires reported buffer data',
    'tune.pathIdle': 'Nothing playing — saved settings apply on next start',
    'tune.modified': 'Modified',
    'tune.allDefault': 'All at defaults',
    'tune.hint': 'Up/Down to select; Left/Right or arrows to adjust. Prefetch buffer settings apply instantly; other changes restart playback on close.',
    'tune.prefetchStartBuffer': 'Prefetch Start Buffer',
    'tune.prefetchStartBuffer.d': 'Continuous playback seconds required before starting or resuming neighbour downloads, not a fixed delay. Lower values allow earlier prefetch but compete more for bandwidth. With adaptive safety on, this is a minimum; see actual thresholds above.',
    'tune.prefetchHoldBuffer': 'Prefetch Pause Buffer',
    'tune.prefetchHoldBuffer.d': 'Below this buffer level, no new neighbour segment starts; in-flight downloads are kept. Must be lower than the start buffer and is reduced automatically if needed. Adaptive safety may raise this threshold.',
    'tune.prefetchAdaptive': 'Adaptive Prefetch Safety',
    'tune.prefetchAdaptive.d': 'On: raise thresholds using segment duration and download time; 6-second segments require at least 9 seconds of buffer. Off: use the two configured values exactly, allowing earlier prefetch at greater stall risk. Stalls still block new prefetch tasks.',
    'tune.prefetchStatus': 'Buffered {ahead}s · Prefetch start ≥{resume}s / pause <{hold}s',
    'tune.prefetchIdle': 'Actual thresholds appear during playback. The three prefetch buffer settings apply instantly.',
    'toast.tuningApplied': 'Tuning applied, restarting playback…',
    'toast.tuningReset': 'Defaults restored',
    'tune.liveSyncDuration': 'Live Edge Offset',
    'tune.liveSyncDuration.d':
      'How many seconds behind the live edge to start. Lower means less delay but a thinner buffer and more stalls; higher is steadier but further behind live.',
    'tune.startOnSegmentBoundary': 'Start on Segment Boundary',
    'tune.startOnSegmentBoundary.d':
      'On: start near the beginning of the first playable buffered range to reduce mid-segment seeking. Keyframes and audio/video timestamps still affect startup. Off: allow starting mid-segment.',
    'tune.prefetchSegmentBytes': 'Neighbour Prefetch Cap (per segment)',
    'tune.prefetchSegmentBytes.d':
      'Once the current buffer meets the prefetch threshold, 2 consecutive segments around the startup point of the previous/next channel are pulled into memory. Adjust start/pause buffers and adaptive safety below; zapping with CH+/- no longer downloads a segment — the player is told to start from a segment already in memory. Measured 0.4s startup on a hit versus 4s on a miss. The start point shifts back to the cached segment, but the first frame arrives earlier by about the same amount, so live latency is essentially unchanged. This is a PER-SEGMENT cap — anything bigger is skipped, so it must exceed your source\'s actual segment size or nothing gets cached (measured ~5-6MB here, so 8MB works). Watch the tag after the startup time in the speed badge: ⚡ = hit; after ✕ comes how many segments were held at zap time plus letters (b = segment over the cap, raise it; s = the cached segments have slid out of this channel\'s playlist window, you dwelled too long; w plus one more letter telling how far this channel\'s prefetch got: - never queued, you surfed past the immediate neighbours; 0 queued but no segment even started before the zap cleared the queue (you did not dwell long enough — a hard time wall: 2.4s per segment, so the first-queued direction is ready at ~2.6s and the other at ~5s, which is why the direction you last zapped in is prefetched first); a it was mid-download at zap time and got cancelled to yield bandwidth; e the request was rejected; b all segments over the cap; k downloaded and stored but the paths do not match; m the playlist could not be fetched). Background traffic is roughly 4× this value; if the current or the new channel gets slower instead, the prefetch is stealing bandwidth — set 0 to disable.',
    'tune.fragParallel': 'Parallel Segment Download',
    'tune.lanes': ' lanes',
    'tune.fragParallel.d':
      'Split each segment into parts and fetch them over several connections at once, then reassemble. Measured on these sources: the gateway caps a single connection at about 1.9x the programme bitrate while the line itself is far faster, so several connections together can saturate it. Measured on the TV: HD channels start in just over 1s instead of 3s+, and 4K channels in about 3s instead of 6s. This is also the real reason every channel takes about 3 seconds: at 1.9x the bitrate a 6-second segment always needs ~3 seconds, regardless of picture quality. Neighbour prefetch uses the same mechanism at half the lane count, so background prefetching does not crowd out the channel you are watching. More lanes use more of the line and more connections; the default of 6 comes from testing on the TV (4 to 6 still helped, 8 is untested — feel free to try). Falls back to a single whole-segment download when the source does not support ranged requests; set to Off if you suspect it causes artefacts or stalling.',
    'tune.maxBufferLength': 'Forward Buffer',
    'tune.maxBufferLength.d':
      'Target duration buffered ahead. Higher resists network jitter; playback does not wait for this entire buffer before starting.',
    'tune.backBufferLength': 'Back Buffer',
    'tune.backBufferLength.d': 'Seconds of played content kept. Lower it on low-memory devices.',
    'tune.abrEwmaDefaultEstimate': 'Initial Bandwidth Estimate',
    'tune.abrEwmaDefaultEstimate.d':
      'Assumed bandwidth at start. On multi-bitrate sources, a higher value picks HD right away; overestimating causes an immediate stall.',
    'tune.startFragPrefetch': 'Prefetch First Segment',
    'tune.startFragPrefetch.d': 'On: fetch the first segment without waiting for the decoder, starting faster.',
    'tune.fragLoadingTimeOut': 'Segment Timeout',
    'tune.fragLoadingTimeOut.d':
      'How long a segment download may take before timing out. Raise it for slow sources to avoid false failures.',
    'tune.fragLoadingMaxRetry': 'Segment Retries',
    'tune.fragLoadingMaxRetry.d':
      'Retry count after a failed segment download. Raise it on flaky sources to survive dropouts.',
    'tune.liveSyncOnStallIncrease': 'Buffer Bump on Stall',
    'tune.liveSyncOnStallIncrease.d':
      'Seconds added to the live edge offset after each stall, to avoid stalling repeatedly at the same spot.',
    'tune.enableWorker': 'Worker Demuxing',
    'tune.enableWorker.d':
      'On: demux on a background thread, keeping the UI smoother. Turn off if a device does not support it.',

    // Source Manager
    'sm.title': 'Live Source Manager',
    'sm.inUse': '(In Use)',
    'sm.testing': 'Testing…',
    'sm.test': '⟳ Test',
    'sm.delete': '✕ Delete',
    'sm.empty': 'No live sources yet. Add one above.',
    'sm.name': 'Name',
    'sm.m3uUrl': 'M3U URL',
    'sm.epgUrl': 'EPG URL (optional)',
    'sm.namePlaceholder': 'e.g. My IPTV',
    'sm.m3uPlaceholder': 'http://.../playlist.m3u',
    'sm.epgPlaceholder': 'Leave blank to use the URL in M3U, or built-in EPG',
    'sm.save': '＋ Save & Use',
    'sm.saved': 'Saved Sources',
    'sm.navigateHint': 'Up/Down: Name / M3U / EPG / Save. OK starts typing. EPG is optional.',
    'sm.inputHint': 'Typing: {field} · Arrows select keys, OK types a character. Keyboard Enter: next field. Back: finish typing.',
    'sm.hint':
      'After closing the keyboard, use Up/Down to revisit any field and OK to edit. Press OK on Save to save. Green to edit, Blue to delete, Back outside input to close.<br>Mouse: click a row to use, ✎ to edit, ⟳ to test, ✕ to delete, outside or top-right ✕ to close.',
    'sm.unnamed': 'Unnamed Source',
    'sm.pulling': 'Fetching source…',
    'sm.testingProgress': 'Testing {done}/{total}…',
    'sm.testDone': 'Done: kept {kept} channels, removed {dead} dead channels',
    'sm.testDoneGroups': ' (incl. {n} whole groups removed)',
    'sm.testFailed': 'Test failed: {msg}',
    'sm.noTestable': 'No testable channels in this source',
    'sm.netError': 'Network error',
    'sm.edit': '✎ Edit',
    'sm.saveEdit': '✓ Save Changes',
    'sm.editing': 'Editing: {name}',
    'sm.cancelEdit': 'Cancel',

    // Group Visibility
    'gm.title': 'Group Visibility',
    'gm.sub': 'Current source: {name} · {n}/{total} groups shown',
    'gm.rowShown': '{n} channels · Shown',
    'gm.rowHidden': '{n} channels · Hidden',
    'gm.showAll': '↺ Show All',
    'gm.keepOne': 'At least one group must stay visible',
    'gm.empty': 'No groups to manage in this source',
    'gm.hint':
      'Up/Down to select a group, OK (or Left/Right) to toggle shown/hidden, Back to close and apply.<br>Hidden groups are excluded from the channel menu and from Up/Down zapping; the setting applies to the current source only.',
    'toast.groupsApplied': 'Groups updated: {n} channels shown',
    'toast.noGroups': 'No groups loaded for the current source yet',

    // Exit dialog
    'exit.title': 'Exit App',
    'exit.sub': 'Exit live TV and return to the TV home screen?',
    'exit.cancel': 'Cancel',
    'exit.exit': 'Exit',

    // toast
    'toast.noCatchup': 'Catch-up is not available for this programme',
    'toast.catchup': 'Catching up: {title}',
    'toast.catchupDetected': 'Catch-up enabled (last {span} available)',
    'unit.hours': '{n}h',
    'unit.days': '{n}d',
    'toast.backToLive': 'Back to live',
    'toast.sourceSwitch': 'Source {n}/{total}: {label}',
    'toast.channelNotFound': 'Channel {num} not found',
    'toast.noChannels': 'No channels parsed from this source',
    'toast.addSourceFirst': 'No playlist yet — add one first (enter a name and M3U URL, then save)',
    'toast.loadFailed': 'Load failed: {msg}',
    'toast.noEpgUrl': 'No EPG URL available',
    'toast.refreshingEpg': 'Refreshing EPG…',
    'toast.epgUpdated': 'EPG updated',
    'toast.epgFailed': 'EPG refresh failed',
    'toast.epgLoadFailed': 'EPG failed to load; no programme info',
    'toast.noEpgData': 'No EPG data loaded yet',
    'toast.faved': 'Favorited: {name}',
    'toast.unfaved': 'Removed from favorites',
    'toast.offline': 'Network disconnected',
    'toast.online': 'Network restored, reconnecting…',
    'toast.tryingBackup': 'Trying backup source {n}/{total}…',
    'toast.channelUnavailable': 'This channel is currently unavailable',

    // fetch errors
    'err.timeout':
      'Request timed out; the server did not respond. The origin may be too slow, or the TV is stuck on a dead IPv6 route',
    'err.httpRejected': '{msg}; the server rejected the request',
    'err.connBase': 'Cannot reach this URL. Check: whether it is dead or mistyped',
    'err.connHttps':
      '; three common HTTPS causes: certificate not trusted by the TV, DNS failure, or a dead IPv6 route. Try an http:// URL, disabling IPv6, or DNS 223.5.5.5',
    'err.connOther': '; and whether the TV network is working',

    // group hint
    'hint.group': 'Group',

    // Channel Menu
    'cm.favGroup': '★ Favorites',
    'cm.channelHint': 'EPG / Catch-up ›',
    'cm.srcBadge': '{n} src',
    'cm.catchup': '⟲Catch-up',
    'cm.noEpg': 'No EPG data',
    'cm.settings': 'Settings',
    'cm.date': 'Date',
    'cm.epg': 'EPG',
    'cm.group': 'Groups',
    'cm.channels': 'Channels ({n})',

    // EPG Guide
    'eg.catchup': '⟲Catch-up',
    'eg.noEpg': 'No EPG data for this day',
    'eg.title': 'EPG Guide',

    // Status Bar
    'sb.noSource': 'No source',
    'sb.channelCount': '{n} channels',
    'sb.online': '● Online',
    'sb.offline': '● Offline',

    // Catch-up Bar
    'cb.catchup': 'Catch-up',
    'cb.title': '⟲ Catch-up · {title}',

    // OSD
    'osd.catchup': 'Catch-up',
    'osd.nowPlaying': 'Now: {title} {time}',
    'osd.latency': 'Delay {s}s',
    'osd.nowPlayingNone': 'Now: no programme info',
    'osd.nextPlaying': 'Next: {title} {time}',
    'osd.source': '◀ Source {n}/{total}: {label} ▶',

    // Date / Weekday
    'date.today': 'Today',
    'date.tomorrow': 'Tomorrow',
    'date.yesterday': 'Yesterday',
    'date.weekFmt': '{d}',
    'date.week.0': 'Sun',
    'date.week.1': 'Mon',
    'date.week.2': 'Tue',
    'date.week.3': 'Wed',
    'date.week.4': 'Thu',
    'date.week.5': 'Fri',
    'date.week.6': 'Sat',

    // Audio codec labels
    'audio.dolbyPlus': 'Dolby+',
    'audio.dolby': 'Dolby',

    // Playback errors
    'perr.generic': 'Playback error',
    'perr.aborted': 'Playback aborted',
    'perr.network': 'Network error, unable to load',
    'perr.decode': 'Decode failed (unsupported format)',
    'perr.srcUnsupported': 'Source unavailable or format unsupported',
    'perr.hevcUnsupported': 'This channel is H.265/HEVC, not supported by this device',
    'perr.networkLost': 'Network interrupted, unable to load this channel',
    'perr.decodeFailed': 'Decoding keeps failing, cannot play this channel',
    'perr.playFailed': 'Playback failed: {detail}',
    'perr.unknown': 'Unknown error',

    // EPG programme
    'epg.unknownProgramme': 'Unknown programme',
    'group.ungrouped': 'Ungrouped',
    'label.system': 'System ({lang})',

    // Device Info
    'di.err.noBridge': 'Not running on webOS (normal in PC preview)',
    'di.err.timeout': 'Bridge did not respond (timeout)',
    'di.err.badJson': 'Response is not valid JSON',
    'di.err.callThrow': 'Call threw an exception',
    'di.err.unknownMethod': 'Method does not exist (wrong name)',
    'di.err.denied': 'Method exists but permission is denied',
    'di.err.notHandled': 'Permitted, but the parameters are wrong (can retry)',
    'di.noProbes': 'No probe records',
    'di.detecting': 'Detecting…',
    'di.failed': 'Detection failed',
    'di.serial': 'Serial Number',
    'di.wiredMac': 'Wired MAC',
    'di.wifiMac': 'Wi-Fi MAC',
    'di.macFailed': 'MAC lookup failed',
    'di.model': 'Model',
    'di.firmware': 'Firmware',
    'di.sysFailed': 'System info lookup failed',
    'di.appVersion': 'App Version',
    'di.openSource': 'Open Source',
    'di.again': '↻ Detect Again',
    'di.rawShow': '▼ Raw Output',
    'di.rawHide': '▲ Hide Raw Output',
    'di.hint': 'Left/Right to choose a button, OK to run, Up/Down to scroll, Back to close.',

    // Speed badge diagnostics
    'ns.align.nowin': 'Playlist slid; cached segments outside window',
    'ns.align.ok': 'Aligned but missed (start position changed)',
    'ns.align.nodet': 'No segment list',
    'ns.align.old': 'Cached segments too old to align',
    'ns.align.off': 'Prefetch cap is 0',
    'ns.align.err': 'Alignment threw an error',
    'ns.alignCode': 'Align {code}',
    'ns.noAlign': 'Alignment not run',
    'ns.est': 'est. prefetch {warm}, own {own}',
    'ns.guess': ' (guess)',
    'ns.takeover': 'In-flight prefetch segment taken over ({age}ms downloaded)',
    'ns.giveUp': 'Gave up in-flight prefetch segment after {budget}ms',
    'ns.noCache': 'No cached segments for this channel · window {lo}~{hi} ({n} segs)',
    'ns.inWinMiss': 'In window but unmatched (URL rule)',
    'ns.slidOut': 'Cached segments slid out of window',
    'ns.window': '{why} · window {lo}~{hi} ({n} segs), cached {seg}',
    'ns.stale': '{align} · only unrelated stale segments cached (want {want}, have {top})',
    'ns.seg': '{align} · want {want}, have {top}',
    'ns.phase': 'Playlist {manifest} · First seg {frag} · Buffer {buffer} · '
  }
};

// m3uParser 给缺少 group-title 的频道填的分组名；它也是隐藏分组设置的键，只能在显示时翻译。
const UNGROUPED = '未分组';

let pref = normalizePref(getSettings().language);
let lang = resolveLang(pref);

function normalizePref(p) {
  return p === 'zh' || p === 'en' ? p : 'auto';
}

function systemLocale() {
  try {
    const w = typeof window !== 'undefined' ? window : null;
    const sys = w && (w.webOSSystem || w.PalmSystem);
    if (sys && sys.locale) return String(sys.locale);
  } catch (e) {}
  if (typeof navigator === 'undefined') return '';
  return (navigator.languages && navigator.languages[0]) || navigator.language || '';
}

// 中文系统（含繁体地区）显示中文，其它语言一律英文。
export function resolveLang(p) {
  const v = normalizePref(p);
  if (v !== 'auto') return v;
  return /^zh(?:[-_]|$)/i.test(systemLocale()) ? 'zh' : 'en';
}

export function getLang() {
  return lang;
}

export function getLangPref() {
  return pref;
}

// 返回实际显示语言是否改变，调用方据此决定要不要重渲染。
export function setLang(p) {
  pref = normalizePref(p);
  const next = resolveLang(pref);
  const changed = next !== lang;
  lang = next;
  return changed;
}

export function groupLabel(name) {
  return name === UNGROUPED ? t('group.ungrouped') : name;
}

// 取词：找不到当前语言的键就回退到中文，再找不到就原样返回 key。
// params 里的字段会替换文案里的 {name} 占位符。
export function t(key, params) {
  const table = DICT[lang] || DICT.zh;
  let s = table[key];
  if (s == null) s = DICT.zh[key];
  if (s == null) s = key;
  if (params) {
    for (const k in params) {
      // 用 split/join 而不是 new RegExp：占位符是固定字面量，用不上正则。
      // 而这个函数在频道列里是逐条目调的，每条都现编译一个正则纯属浪费。
      const ph = '{' + k + '}';
      if (s.indexOf(ph) >= 0) s = s.split(ph).join(params[k]);
    }
  }
  return s;
}
