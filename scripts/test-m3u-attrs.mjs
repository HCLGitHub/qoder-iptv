// Run: node --test scripts/test-m3u-attrs.mjs
// M3U 属性扩展（catchup-type / tvg-rec / 头部级 catchup 默认 / tvg-shift / tvg-chno）、
// EPG 时移平移视图、回看地址沿用源时间轴的单元测试。无网络、无 DOM 依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U, renumberChannels } from '../src/core/m3uParser.js';
import { buildCatchupUrl } from '../src/core/catchup.js';
import { epgStore as store } from '../src/core/epgStore.js';

test('header-level catchup defaults apply to channels without their own attributes', () => {
  const { channels } = parseM3U([
    '#EXTM3U catchup="default" catchup-source="http://gw/{utc}-{utcend}" catchup-days="3"',
    '#EXTINF:-1 tvg-id="a" group-title="G",A',
    'http://a.m3u8',
    '#EXTINF:-1 tvg-id="b" group-title="G" catchup="append" catchup-days="14",B',
    'http://b.m3u8'
  ].join('\n'));
  assert.equal(channels[0].catchup, 'default');
  assert.equal(channels[0].catchupSource, 'http://gw/{utc}-{utcend}');
  assert.equal(channels[0].catchupDays, 3);
  assert.equal(channels[1].catchup, 'append'); // 频道级类型覆盖头部
  assert.equal(channels[1].catchupDays, 14); // 频道级天数覆盖头部
});

test('catchup-type and tvg-rec aliases resolve like tivimate-style sources', () => {
  const { channels } = parseM3U([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="a" group-title="G" catchup-type="flussonic",A',
    'http://a.m3u8',
    '#EXTINF:-1 tvg-id="b" group-title="G" tvg-rec="14",B',
    'http://b.m3u8'
  ].join('\n'));
  assert.equal(channels[0].catchup, 'flussonic');
  assert.equal(channels[1].catchup, 'default'); // 只写天数没写类型 → default
  assert.equal(channels[1].catchupDays, 14);
});

test('legacy timeshift alias keeps day semantics and is not overridden by header days', () => {
  const { channels } = parseM3U([
    '#EXTM3U catchup-days="2"',
    '#EXTINF:-1 group-title="G",A',
    'http://a.m3u8',
    '#EXTINF:-1 group-title="G" timeshift="5",B',
    'http://b.m3u8'
  ].join('\n'));
  assert.equal(channels[0].catchupDays, 2);
  assert.equal(channels[0].catchup, 'default');
  assert.equal(channels[1].catchupDays, 5); // 频道级 timeshift 仍优先于头部天数
});

test('header catchup-source backfills while channel catchup-days wins', () => {
  const { channels } = parseM3U([
    '#EXTM3U catchup-source="?utc={utc}&lutc={lutc}" catchup-days="7"',
    '#EXTINF:-1 group-title="G" catchup-days="1",A',
    'http://a.m3u8'
  ].join('\n'));
  assert.equal(channels[0].catchupSource, '?utc={utc}&lutc={lutc}');
  assert.equal(channels[0].catchupDays, 1);
});

test('tvg-shift resolves per channel with header fallback and defaults to 0', () => {
  const { channels } = parseM3U([
    '#EXTM3U tvg-shift="2"',
    '#EXTINF:-1 group-title="G",A',
    'http://a.m3u8',
    '#EXTINF:-1 group-title="G" tvg-shift="-5",B',
    'http://b.m3u8',
    '#EXTINF:-1 group-title="G" tvg-shift="junk",C',
    'http://c.m3u8'
  ].join('\n'), 'http://x/list.m3u');
  assert.equal(channels[0].tvgShift, 2); // 头部默认兜底
  assert.equal(channels[1].tvgShift, -5); // 频道级覆盖，支持负数
  assert.equal(channels[2].tvgShift, 2); // 非法值回落到头部默认
  const bare = parseM3U('#EXTINF:-1 group-title="G",D\nhttp://d.m3u8').channels;
  assert.equal(bare[0].tvgShift, 0);
});

test('tvg-shift merges from the first source that declares it', () => {
  const { channels } = parseM3U([
    '#EXTM3U',
    '#EXTINF:-1 group-title="G",Same',
    'http://a.m3u8',
    '#EXTINF:-1 group-title="G" tvg-shift="3",Same',
    'http://b.m3u8'
  ].join('\n'));
  assert.equal(channels.length, 1);
  assert.equal(channels[0].tvgShift, 3);
});

function chan(chnoRaw) {
  return { chnoRaw, group: 'G' };
}

test('renumber without any tvg-chno keeps sequential per-group numbering', () => {
  const list = [chan(0), chan(0), chan(0)];
  renumberChannels(list);
  assert.deepEqual(list.map((c) => c.chno), ['1', '2', '3']);
  assert.deepEqual(list.map((c) => c.index), [1, 2, 3]);
});

test('declared tvg-chno is preserved; duplicates and gaps are auto-filled', () => {
  const list = [chan(0), chan(5), chan(5), chan(0), chan(12)];
  renumberChannels(list);
  // 5 保留一次；重复者与未声明者按出现顺序补未占用号
  assert.deepEqual(list.map((c) => c.chno), ['1', '5', '2', '3', '12']);
  // index 仍按分组顺序连编，作内部序号
  assert.deepEqual(list.map((c) => c.index), [1, 2, 3, 4, 5]);
});

test('non-numeric tvg-chno is ignored and its channel gets a free number', () => {
  const list = [chan(9), chan(-3), chan(0)];
  renumberChannels(list);
  assert.deepEqual(list.map((c) => c.chno), ['9', '1', '2']);
});

test('tvg-chno stays stable when main.js renumbers a filtered subset', () => {
  const list = [chan(0), chan(101), chan(0), chan(103)];
  renumberChannels(list.filter((c) => c.chnoRaw !== 103)); // 模拟隐藏分组后的可见子集
  assert.deepEqual(list.filter((c) => c.chno).map((c) => c.chno), ['1', '101', '2']);
});

test('shifted EPG view offsets times, exposes originals via _epg and caches by identity', () => {
  const base = new Date(2026, 8, 10, 8).getTime();
  const raw = [
    { start: base, stop: base + 3600000, title: 'A', desc: '' },
    { start: base + 3600000, stop: NaN, title: 'B', desc: '' }
  ];
  store.clear();
  store.mode = 'xmltv';
  store.loaded = true;
  store.programmes.set('tv', raw);
  const channel = { key: 'tv', name: 'TV', epgName: 'TV', tvgId: 'tv', tvgShift: 2 };
  const two = store.getList(channel);
  assert.equal(two[0].start, base + 2 * 3600000);
  assert.equal(two[0].stop, base + 3 * 3600000);
  assert.equal(two[1].stop + 2 * 3600000, NaN); // NaN stop 平移后仍为 NaN
  assert.equal(two[0]._epg, raw[0]); // 原始节目对象挂回 _epg 供回看使用
  assert.equal(store.getList(channel), two); // 同一底层数组 → 命中平移缓存
  assert.equal(store.getList({ ...channel, tvgShift: 0 })[0], raw[0]); // 无时移原样返回
  assert.equal(raw[0].start, base); // 原始数据不被写入
  const one = store.getList({ ...channel, tvgShift: 1 });
  assert.equal(one[0].start, base + 3600000);
  assert.equal(store.getList({ ...channel, tvgShift: 2 }), two); // 换查别的频道后再回来仍命中
  store.clear();
  store.mode = 'xmltv';
  store.loaded = true;
  assert.deepEqual(store.getList(channel), []); // clear 后缓存与数据一并失效
});

test('catchup URLs use the source timeline (_epg), not the shifted display time', () => {
  const base = new Date(Date.UTC(2026, 8, 10, 0)).getTime();
  const shifted = {
    start: base + 5 * 3600000,
    stop: base + 6 * 3600000,
    title: 'A',
    _epg: { start: base, stop: base + 3600000 }
  };
  const url = buildCatchupUrl(
    { url: 'http://gw/live.m3u8', catchup: 'append' },
    shifted
  );
  assert.equal(url, 'http://gw/live.m3u8?utc=' + base / 1000 + '&lutc=' + Math.floor(Date.now() / 1000));
  // 无 _epg 的普通节目（探测路径）行为不变
  const plain = buildCatchupUrl(
    { url: 'http://gw/live.m3u8', catchup: 'append' },
    { start: base, stop: base + 3600000 }
  );
  assert.equal(plain, 'http://gw/live.m3u8?utc=' + base / 1000 + '&lutc=' + Math.floor(Date.now() / 1000));
});
