// 四栏呼出菜单：分组 | 频道 | 日期 | 节目单（过往节目可回看）
import { KEY } from '../core/keys.js';
import { epgStore } from '../core/epgStore.js';
import { isCatchupAvailable } from '../core/catchup.js';
import { isFavorite, favVersion } from '../core/storage.js';
import { fmtTime, fmtDayLabel, esc, logoHtml } from '../core/util.js';
import { t, getLang, groupLabel } from '../core/i18n.js';

// 日期范围：当日前 7 天 .. 今天 .. 后 4 天
const DAY_OFFSETS = [];
for (let i = -7; i <= 4; i++) DAY_OFFSETS.push(i);
const TODAY_POS = DAY_OFFSETS.indexOf(0);

// 列索引：0=分组 1=频道 2=日期 3=节目单
const COL_GROUP = 0;
const COL_CHAN = 1;
const COL_DATE = 2;
const COL_EPG = 3;

export class ChannelMenu {
  constructor(el) {
    this.el = el;
    this.channels = [];
    this.groups = []; // [{ name, channels }]
    this.col = COL_CHAN;
    this.groupIdx = 0;
    this.chanIdx = 0;
    this.dayPos = TODAY_POS;
    this.epgIdx = 0;
    this.epgList = [];
    this.currentKey = null;
    this.settingsFocused = false; // 分组栏「设置」入口是否聚焦

    this.onPlayLive = null;
    this.onPlayCatchup = null;
    this.onOpenSettings = null;
    this.onClose = null;
    // 日期/节目单栏展开时回调，用于探测该频道所在网关支不支持回看（见 main.js）
    this.onProbeCatchup = null;

    // 鼠标：事件委托（点击选择/进入）
    this.el.addEventListener('click', (e) => this._onClick(e));
  }

  _onClick(e) {
    const item = e.target.closest('[data-role]');
    if (!item) {
      // 日期/节目单未展开时，点击频道栏右侧空白区域（不在任何可见列内）退出菜单，回到播放内容
      if (this.col !== COL_DATE && this.col !== COL_EPG && !e.target.closest('.cm-col:not(.hidden)')) {
        this.close();
      }
      return;
    }
    const role = item.dataset.role;
    const idx = parseInt(item.dataset.idx, 10);
    if (role !== 'settings') this.settingsFocused = false;
    if (role === 'group') {
      this.groupIdx = idx;
      this.chanIdx = 0;
      this.col = COL_CHAN;
      this._loadEpg();
      this.render();
    } else if (role === 'chan') {
      this.col = COL_CHAN;
      this.chanIdx = idx;
      this._confirm();
    } else if (role === 'expand') {
      // 点频道行右侧「节目单/回看 ›」= 遥控按右键：展开日期栏 + 节目单栏
      this.chanIdx = idx;
      this.col = COL_DATE;
      this.dayPos = TODAY_POS;
      this._loadEpg();
      this.render();
    } else if (role === 'day') {
      this.col = COL_DATE;
      this.dayPos = idx;
      this._loadEpg();
      this.render();
    } else if (role === 'epg') {
      this.col = COL_EPG;
      this.epgIdx = idx;
      this._confirm();
    } else if (role === 'settings') {
      this._openSettings();
    }
  }

  _openSettings() {
    if (this.onOpenSettings) {
      this.close();
      this.onOpenSettings();
    }
  }

  _buildGroups() {
    const favChannels = this.channels.filter((c) => isFavorite(c.key));
    const map = new Map();
    for (const ch of this.channels) {
      if (!map.has(ch.group)) map.set(ch.group, []);
      map.get(ch.group).push(ch);
    }
    const groups = [];
    if (favChannels.length) groups.push({ name: t('cm.favGroup'), channels: favChannels });
    for (const [name, list] of map.entries()) {
      groups.push({ name, channels: list });
    }
    this.groups = groups;
  }

  open(channels, currentKey) {
    this.channels = channels;
    this.currentKey = currentKey;
    this._buildGroups();

    // 定位到当前频道所在分组
    let g = 0, c = 0;
    for (let gi = 0; gi < this.groups.length; gi++) {
      const idx = this.groups[gi].channels.findIndex((ch) => ch.key === currentKey);
      if (idx >= 0) { g = gi; c = idx; break; }
    }
    this.groupIdx = g;
    this.chanIdx = c;
    this.dayPos = TODAY_POS;
    this.col = COL_CHAN;
    this.settingsFocused = false;
    this._loadEpg();
    this.el.classList.remove('hidden');
    this.render();
  }

  _curGroup() {
    return this.groups[this.groupIdx] || { name: '', channels: [] };
  }
  _curChannel() {
    return this._curGroup().channels[this.chanIdx] || null;
  }
  _curOffset() {
    return DAY_OFFSETS[this.dayPos];
  }

  _loadEpg() {
    const ch = this._curChannel();
    const off = this._curOffset();
    this.epgList = ch ? epgStore.getDayProgrammes(ch, off) : [];
    // 今天默认聚焦正在播放的节目，其它日期聚焦到首条
    let idx = 0;
    if (off === 0) {
      const now = Date.now();
      const f = this.epgList.findIndex(
        (p) => now >= p.start && now < (isNaN(p.stop) ? p.start + 3600000 : p.stop)
      );
      if (f >= 0) idx = f;
    }
    this.epgIdx = idx;
  }

  render() {
    this._ensureSkeleton();
    this._renderGroups();
    this._renderChannels();
    this._renderDateEpg();
    this._scrollToFocused();
  }

  // 骨架只建一次：四列容器常驻（日期/节目单列用 .hidden 显隐），
  // 这样切换焦点/展开时不重建频道列，频道 logo 的 <img> 得以保留、不重新加载。
  _ensureSkeleton() {
    // 骨架里的列标题是建骨架时写死的文案，切换语言后必须重建
    if (this._skeletonLang === getLang() && this.el.querySelector('#cm-chan-list')) return;
    this.el.innerHTML = `
      <div class="cm-col cm-groups">
        <div class="cm-title">${t('cm.group')}</div>
        <div class="cm-list" id="cm-group-list"></div>
        <div class="cm-settings" id="cm-settings" data-role="settings"><span class="ico">⚙</span><span>${t('cm.settings')}</span></div>
      </div>
      <div class="cm-col cm-channels">
        <div class="cm-title" id="cm-chan-title"></div>
        <div class="cm-list" id="cm-chan-list"></div>
      </div>
      <div class="cm-col cm-dates hidden" id="cm-dates-col">
        <div class="cm-title">${t('cm.date')}</div>
        <div class="cm-list" id="cm-date-list"></div>
      </div>
      <div class="cm-col cm-epg hidden" id="cm-epg-col">
        <div class="cm-title" id="cm-epg-title"></div>
        <div class="cm-list" id="cm-epg-list"></div>
      </div>`;
    this._skeletonLang = getLang();
    this._chanSig = null; // 骨架重建后频道列需强制重绘
    this._chanArr = null;
    this._paintedFoc = null;
  }

  _renderGroups() {
    const listEl = this.el.querySelector('#cm-group-list');
    if (listEl) {
      listEl.innerHTML = this.groups
        .map((grp, i) => {
          const cls =
            'cm-group-item' +
            (i === this.groupIdx ? ' active' : '') +
            (this.col === COL_GROUP && !this.settingsFocused && i === this.groupIdx ? ' focused' : '');
          return `<div class="${cls}" data-role="group" data-idx="${i}"><span>${esc(groupLabel(grp.name))}</span><span class="badge">${grp.channels.length}</span></div>`;
        })
        .join('');
    }
    const setEl = this.el.querySelector('#cm-settings');
    if (setEl) setEl.classList.toggle('focused', this.col === COL_GROUP && this.settingsFocused);
  }

  // 频道列（含 logo）：内容签名不变则只更新焦点态，不重建 DOM——避免每次导航都重载图标。
  _renderChannels() {
    const chans = this._curGroup().channels;
    const titleEl = this.el.querySelector('#cm-chan-title');
    if (titleEl) titleEl.innerHTML = t('cm.channels', { n: chans.length });
    const listEl = this.el.querySelector('#cm-chan-list');
    if (!listEl) return;

    const sig = this._channelsSig(chans);
    // 数组身份也要比：分组对象每次 open() 都是新建的，而上面那些版本号可能
    // 一个都没变（同一个源重新开菜单）——光看版本号会认为可以沿用旧 DOM，
    // 而骨架重建后旧 DOM 已经不在了。
    if (sig !== this._chanSig || chans !== this._chanArr) {
      this._chanSig = sig;
      this._chanArr = chans;
      listEl.innerHTML = chans.map((ch, i) => this._channelItemHtml(ch, i)).join('');
      // 重建时 focused 类是直接写进 HTML 的，把重绘基准对齐到这个事实上
      this._paintedFoc = this.col === COL_CHAN ? this.chanIdx : -1;
    } else {
      this._updateChanFocus(listEl); // 仅移动焦点：logo 原样保留
    }
  }

  // 频道列内容签名：O(1)，只看几个版本号与标量，不含焦点索引。
  //
  // 原来这里逐频道取一遍 getNowNext()、再拼成一个长字符串（几千个台就是上百 KB），
  // 而它全部的作用只是回答「要不要重建 DOM」这个是非题。代价是：每按一下方向键
  // 都要 O(频道数 × 节目数) 地扫一遍节目表、逐频道读一遍 localStorage 查收藏，
  // 再扒一个百 KB 的字符串出来扔掉。电视的弱 CPU 上这就是导航卡顿的主因。
  //
  // 现在改看「会改变条目内容」的那几个源头：语言、正在播的台、收藏表版本、
  // 节目数据版本。它们一定覆盖得住：条目上除了频道自身的字段（随数组身份一起变），
  // 变量就只有★收藏标、当前节目名、playing 高亮、和国际化文案这四项。
  _channelsSig(chans) {
    return (
      getLang() +
      '|' +
      (this.currentKey || '') +
      '|' +
      favVersion() +
      '|' +
      epgStore.version +
      '|' +
      chans.length
    );
  }

  _channelItemHtml(ch, i) {
    const nn = epgStore.getNowNext(ch);
    const nowTitle = nn.now ? nn.now.title : '';
    const fav = isFavorite(ch.key) ? '<span class="fav">★</span>' : '';
    const multi = ch.sources && ch.sources.length > 1
      ? `<span class="src-badge">${t('cm.srcBadge', { n: ch.sources.length })}</span>` : '';
    const cls =
      'cm-channel-item' +
      (ch.key === this.currentKey ? ' playing' : '') +
      (this.col === COL_CHAN && i === this.chanIdx ? ' focused' : '');
    // 提示每行都渲染、由 CSS 控制显隐（焦点行常显 / 鼠标 hover 行也显），
    // 同时它本身是个可点入口：鼠标点它 = 遥控按右键，展开日期+节目单栏。
    return `
          <div class="${cls}" data-role="chan" data-idx="${i}">
            <div class="num">${esc(String(ch.chno || ch.index))}</div>
            <div class="logo">${logoHtml(ch)}</div>
            <div class="meta">
              <div class="name">${esc(ch.name)} ${fav} ${multi}</div>
              <div class="now">${esc(nowTitle)}</div>
            </div>
            <div class="cm-chan-hint" data-role="expand" data-idx="${i}">${t('cm.channelHint')}</div>
          </div>`;
  }

  // 仅更新频道列焦点态（不动 <img>）：切 focused 类即可，提示的显隐交给 CSS。
  // 只动「离开的那行」和「新进的那行」：几千个台的分组里逐个 toggle 一遍，
  // 就是每按一下方向键几千次 DOM 操作，而真正变了的最多两行。
  _updateChanFocus(listEl) {
    const items = listEl.children;
    const foc = this.col === COL_CHAN ? this.chanIdx : -1;
    if (this._paintedFoc === foc) return;
    if (this._paintedFoc != null && items[this._paintedFoc]) {
      items[this._paintedFoc].classList.remove('focused');
    }
    if (foc >= 0 && items[foc]) items[foc].classList.add('focused');
    this._paintedFoc = foc;
  }

  // 日期栏 + 节目单栏：焦点进入才显示（否则隐藏保持界面清爽）；内容无图，重建廉价。
  _renderDateEpg() {
    const show = this.col === COL_DATE || this.col === COL_EPG;
    const datesCol = this.el.querySelector('#cm-dates-col');
    const epgCol = this.el.querySelector('#cm-epg-col');
    if (datesCol) datesCol.classList.toggle('hidden', !show);
    if (epgCol) epgCol.classList.toggle('hidden', !show);
    if (!show) return;

    const dateListEl = this.el.querySelector('#cm-date-list');
    if (dateListEl) {
      dateListEl.innerHTML = DAY_OFFSETS.map((off, i) => {
        const cls =
          'cm-date-item' +
          (i === this.dayPos ? ' active' : '') +
          (this.col === COL_DATE && i === this.dayPos ? ' focused' : '');
        return `<div class="${cls}" data-role="day" data-idx="${i}">${fmtDayLabel(off)}</div>`;
      }).join('');
    }

    const ch = this._curChannel();
    // 日期栏一展开就顺手探一次回看能力：在线源没写 catchup 属性，探到了才亮回看标记。
    // 这里每次 render 都会调到，去重和缓存在 main.js 那侧做。
    if (ch && !ch.catchup && this.onProbeCatchup) this.onProbeCatchup(ch);
    const titleEl = this.el.querySelector('#cm-epg-title');
    if (titleEl) titleEl.innerHTML = ch ? esc(ch.name) + ' · ' + fmtDayLabel(this._curOffset()) : t('cm.epg');
    const epgListEl = this.el.querySelector('#cm-epg-list');
    if (!epgListEl) return;
    const now = Date.now();
    epgListEl.innerHTML = this.epgList.length
      ? this.epgList
          .map((p, i) => {
            const playing = now >= p.start && now < (isNaN(p.stop) ? p.start + 3600000 : p.stop);
            const canCatchup = isCatchupAvailable(ch, p, ch.catchupDays || 7);
            const cls =
              'cm-epg-item' +
              (playing ? ' now' : '') +
              (this.col === COL_EPG && i === this.epgIdx ? ' focused' : '');
            const badge = canCatchup ? `<span class="catchup">${t('cm.catchup')}</span>` : '';
            return `<div class="${cls}" data-role="epg" data-idx="${i}"><span class="t">${fmtTime(p.start)}</span><span class="p">${esc(p.title)}</span>${badge}</div>`;
          })
          .join('')
      : `<div class="cm-epg-item"><span class="p" style="color:#808a94">${t('cm.noEpg')}</span></div>`;
  }

  _scrollToFocused() {
    const focused = this.el.querySelector('.focused');
    if (focused && focused.scrollIntoView) {
      focused.scrollIntoView({ block: 'center' });
    }
  }

  // EPG 异步数据（diyp 按天懒加载）到达后调用：重新载入当前频道+日期的节目单再渲染。
  // 保留当前焦点（仅越界时夹回），避免数据到达时打断用户浏览。
  refreshEpg() {
    if (!this.isOpen()) return;
    const ch = this._curChannel();
    const off = this._curOffset();
    this.epgList = ch ? epgStore.getDayProgrammes(ch, off) : [];
    if (this.epgIdx >= this.epgList.length) this.epgIdx = Math.max(0, this.epgList.length - 1);
    this.render();
  }

  handleKey(code) {
    switch (code) {
      case KEY.UP:
        this._move(-1);
        break;
      case KEY.DOWN:
        this._move(1);
        break;
      case KEY.LEFT:
        this._switchCol(-1);
        break;
      case KEY.RIGHT:
        this._switchCol(1);
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

  _move(dir) {
    if (this.col === COL_GROUP) {
      // 焦点在「设置」时，上下键返回分组列表
      if (this.settingsFocused) { this.settingsFocused = false; this.render(); return; }
      const n = this.groups.length;
      this.groupIdx = (this.groupIdx + dir + n) % n;
      this.chanIdx = 0;
      this._loadEpg();
    } else if (this.col === COL_CHAN) {
      const n = this._curGroup().channels.length;
      if (!n) return;
      this.chanIdx = (this.chanIdx + dir + n) % n;
      this._loadEpg();
    } else if (this.col === COL_DATE) {
      const n = DAY_OFFSETS.length;
      this.dayPos = Math.min(n - 1, Math.max(0, this.dayPos + dir));
      this._loadEpg();
    } else if (this.col === COL_EPG) {
      const n = this.epgList.length;
      if (!n) return;
      this.epgIdx = (this.epgIdx + dir + n) % n;
    }
    this.render();
  }

  _switchCol(dir) {
    if (this.col === COL_GROUP) {
      // 左键：分组栏 -> 跳到「设置」入口
      if (dir < 0) {
        if (!this.settingsFocused) { this.settingsFocused = true; this.render(); }
        return;
      }
      // 右键：若在「设置」上，先退回分组列表
      if (this.settingsFocused) { this.settingsFocused = false; this.render(); return; }
    }
    const next = this.col + dir;
    if (next < COL_GROUP || next > COL_EPG) return;
    if (next === COL_EPG && !this.epgList.length) return;
    this.col = next;
    // 首次展开日期栏时，为当前频道+日期重新加载节目单，避免右侧回看栏空白
    if (next === COL_DATE) this._loadEpg();
    this.render();
  }

  _confirm() {
    if (this.col === COL_GROUP) {
      // 「设置」入口 -> 打开设置
      if (this.settingsFocused) {
        this._openSettings();
        return;
      }
      // 分组 -> 进入频道列
      this.col = COL_CHAN;
      this.render();
    } else if (this.col === COL_CHAN) {
      // 频道 -> 直接播直播
      const ch = this._curChannel();
      if (ch && this.onPlayLive) {
        this.currentKey = ch.key;
        this.onPlayLive(ch);
        this.close();
      }
    } else if (this.col === COL_DATE) {
      // 选定日期 -> 进入节目单列
      if (this.epgList.length) {
        this.col = COL_EPG;
        this.render();
      }
    } else if (this.col === COL_EPG) {
      const ch = this._curChannel();
      const p = this.epgList[this.epgIdx];
      if (!ch || !p) return;
      const now = Date.now();
      const playing = now >= p.start && now < (isNaN(p.stop) ? p.start + 3600000 : p.stop);
      if (playing) {
        if (this.onPlayLive) { this.onPlayLive(ch); this.close(); }
      } else if (isCatchupAvailable(ch, p, ch.catchupDays || 7)) {
        if (this.onPlayCatchup) { this.onPlayCatchup(ch, p); this.close(); }
      }
    }
  }

  close() {
    this.el.classList.add('hidden');
    if (this.onClose) this.onClose();
  }

  isOpen() {
    return !this.el.classList.contains('hidden');
  }
}
