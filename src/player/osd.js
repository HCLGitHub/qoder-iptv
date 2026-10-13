// 换台 OSD 信息条：频道号、台标、频道名、正在/即将播放、进度、时间
import { epgStore } from '../core/epgStore.js';
import { fmtTime, fmtClock, esc, logoHtml } from '../core/util.js';
import { t } from '../core/i18n.js';

// 实际解码尺寸 → 画质标签（IPTV 常见 3840×2160 / 2560×1440 / 1920×1080 / 1280×720 / 720×576）
function resLabel(w, h) {
  if (!w || !h) return '';
  if (w >= 3000 || h >= 1700) return '4K';
  if (w >= 2000 || h >= 1200) return '2K';
  if (h >= 1000) return '1080P';
  if (h >= 700) return '720P';
  if (h >= 500) return '576P';
  return h + 'P';
}

// 音频编码串 → 简称。mp4a.a5=AC-3、mp4a.a6=E-AC-3、mp4a.40.34=MP3，
// 注意先判 MP3/杜比再落到 AAC，否则会被 mp4a 前缀误归为 AAC。
function audioLabel(codec) {
  const c = String(codec || '').toLowerCase();
  if (!c) return '';
  if (/ec-?3|mp4a\.a6/.test(c)) return t('audio.dolbyPlus');
  if (/ac-?3|mp4a\.a5|dolby/.test(c)) return t('audio.dolby');
  if (/mp4a\.40\.34|mp4a\.6b|mp3|mpeg-?1/.test(c)) return 'MP3';
  if (/mp4a\.40\.5|he-?aac/.test(c)) return 'HE-AAC';
  if (/mp4a|aac/.test(c)) return 'AAC';
  if (/opus/.test(c)) return 'Opus';
  if (/dts/.test(c)) return 'DTS';
  return c.length <= 8 ? codec.toUpperCase() : '';
}

// 视频编码串 → 简称（HEVC/H.264/AV1/VP9）；认不出返回空串
function videoLabel(codec) {
  const c = String(codec || '').toLowerCase();
  if (!c) return '';
  if (/hvc1|hev1|hevc|h\.?265/.test(c)) return 'HEVC';
  if (/av01|av1/.test(c)) return 'AV1';
  if (/avc1|avc3|h\.?264/.test(c)) return 'H.264';
  if (/vp0?9/.test(c)) return 'VP9';
  return '';
}

export class Osd {
  constructor(el) {
    this.el = el;
    this.hideTimer = null;
    this.latTimer = null;
    this.getLatency = null; // 由外部注入：() => 落后直播的秒数，或 null
    this.mediaInfo = null; // { width, height, videoCodec, audioCodec }
  }

  // 画质/编码标签；信息未就绪时返回空串（不占位）
  _fmtHtml() {
    const mi = this.mediaInfo || {};
    const res = resLabel(mi.width, mi.height);
    const vid = videoLabel(mi.videoCodec);
    const aud = audioLabel(mi.audioCodec);
    let html = '';
    if (res) html += `<span class="osd-tag${res === '4K' ? ' tag-4k' : ''}">${esc(res)}</span>`;
    if (vid) html += `<span class="osd-tag tag-video">${esc(vid)}</span>`;
    if (aud) html += `<span class="osd-tag tag-audio">${esc(aud)}</span>`;
    return html;
  }

  // 距直播边缘的延迟标签（跟在画质/编码标签后面）。值会随播放变化，
  // 所以单独成一个 span，OSD 显示期间每秒刷新，不动整条 OSD（免得重置隐藏定时器）。
  _latHtml() {
    if (!this.getLatency) return '';
    const s = this.getLatency();
    if (s == null || !isFinite(s)) return '';
    return `<span class="osd-tag tag-latency">${esc(t('osd.latency', { s: Math.round(s) }))}</span>`;
  }

  _updateLat() {
    const box = this.el.querySelector('.osd-lat');
    if (box) box.innerHTML = this._latHtml();
  }

  _startLatTimer() {
    clearInterval(this.latTimer);
    this.latTimer = setInterval(() => this._updateLat(), 1000);
  }

  // 媒体信息到达（通常晚于换台瞬间）：只局部刷标签，
  // 不重渲整条 OSD，以免重置自动隐藏定时器。
  setMediaInfo(info) {
    this.mediaInfo = info || null;
    const box = this.el.querySelector('.osd-fmt');
    if (box) box.innerHTML = this._fmtHtml();
  }

  // 显示某频道的 OSD。duration 统一走这里的默认值，调用方一般不用传。
  show(channel, { catchup = false, programme = null, duration = 8000 } = {}) {
    const nn = epgStore.getNowNext(channel);
    const nowProg = programme || nn.now;
    const nextProg = nn.next;

    let progressHtml = '';
    if (catchup && programme && !isNaN(programme.start)) {
      progressHtml = `<div class="osd-badge">${t('osd.catchup')}</div>`;
    }
    
    const nowText = nowProg
      ? t('osd.nowPlaying', { title: esc(nowProg.title), time: fmtTime(nowProg.start) + '-' + fmtTime(nowProg.stop) })
      : t('osd.nowPlayingNone');
    const nextText = nextProg ? t('osd.nextPlaying', { title: esc(nextProg.title), time: fmtTime(nextProg.start) }) : '';
    
    // 多源指示：显示当前源序号与名称，提示左右键可切换
    let srcHtml = '';
    if (channel.sources && channel.sources.length > 1) {
      const cur = channel.sources[channel.sourceIdx] || channel.sources[0];
      srcHtml = `<div class="osd-src">${t('osd.source', { n: channel.sourceIdx + 1, total: channel.sources.length, label: esc(cur.label) })}</div>`;
    }

    this.el.innerHTML = `
      <div class="osd-num">${esc(String(channel.chno || channel.index))}</div>
      <div class="osd-logo">${logoHtml(channel)}</div>
      <div class="osd-info">
        <div class="osd-name">
          <span class="osd-cname">${esc(channel.name)}</span>
          ${progressHtml}
          <span class="osd-fmt">${this._fmtHtml()}</span>
          <span class="osd-lat">${this._latHtml()}</span>
        </div>
        <div class="osd-prog">${nowText}</div>
        <div class="osd-next">${nextText}</div>
        ${srcHtml}
      </div>
      <div class="osd-time">${fmtClock()}</div>
    `;
    this.el.classList.remove('hidden');
    this._startLatTimer();
    this._autoHide(duration);
  }

  _autoHide(duration) {
    clearTimeout(this.hideTimer);
    if (duration > 0) {
      this.hideTimer = setTimeout(() => this.hide(), duration);
    }
  }

  hide() {
    clearTimeout(this.hideTimer);
    clearInterval(this.latTimer);
    this.latTimer = null;
    this.el.classList.add('hidden');
  }

  isVisible() {
    return !this.el.classList.contains('hidden');
  }
}
