// EPG 台名归一化与兜底匹配：不依赖网络与 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { epgStore as store, normalizeEpgName } from '../src/core/epgStore.js';

test('归一化：空格、标点、画质后缀', () => {
  assert.equal(normalizeEpgName('CCTV-1 高清'), 'cctv1');
  assert.equal(normalizeEpgName('CCTV1综合'), 'cctv1');
  assert.equal(normalizeEpgName('深圳卫视 4K'), '深圳卫视');
  assert.equal(normalizeEpgName('湖南卫视HD'), '湖南卫视');
  assert.equal(normalizeEpgName('CHC 高清电影'), 'chc电影');
});

test('归一化：央视台号与中文频道名', () => {
  assert.equal(normalizeEpgName('CCTV-05'), 'cctv5');
  assert.equal(normalizeEpgName('CCTV5体育'), 'cctv5');
  assert.equal(normalizeEpgName('CCTV5+体育赛事'), 'cctv5+');
  assert.equal(normalizeEpgName('CCTV4欧洲'), 'cctv4欧洲');
  assert.equal(normalizeEpgName('CCTV4欧洲高清'), 'cctv4欧洲');
  assert.equal(normalizeEpgName('中央电视台综合频道'), 'cctv1');
  assert.equal(normalizeEpgName('中央13台'), 'cctv13');
  assert.equal(normalizeEpgName('中央广播电视总台'), '中央广播电视总台');
});

test('tvg-id 与精确名都没命中时，按归一化台名兜底', () => {
  store._ingestRaw({
    channels: [{ id: 'cctv1.hd', name: '中央电视台综合频道' }],
    programmes: [['cctv1.hd', [{ start: 1, stop: 2, title: 'x' }]]]
  });
  const ch = { tvgId: '', name: 'CCTV-1 高清', epgName: 'CCTV-1 高清' };
  assert.equal(store._key(ch), 'cctv1.hd');
});

test('归一化不把 CCTV5 与 CCTV5+ 混为一谈', () => {
  store._ingestRaw({
    channels: [{ id: 'c5', name: 'CCTV5体育' }, { id: 'c5p', name: 'CCTV5+体育赛事' }],
    programmes: [['c5', [{ start: 1, stop: 2, title: 'a' }]], ['c5p', [{ start: 1, stop: 2, title: 'b' }]]]
  });
  assert.equal(store._key({ tvgId: '', name: 'CCTV5', epgName: 'CCTV5' }), 'c5');
  assert.equal(store._key({ tvgId: '', name: 'CCTV5+', epgName: 'CCTV5+' }), 'c5p');
});

test('精确匹配优先于归一化兜底', () => {
  store._ingestRaw({
    channels: [{ id: 'a', name: 'CCTV1' }, { id: 'b', name: 'CCTV-1 综合' }],
    programmes: [['a', [{ start: 1, stop: 2, title: 'a' }]], ['b', [{ start: 1, stop: 2, title: 'b' }]]]
  });
  assert.equal(store._key({ tvgId: '', name: 'CCTV1', epgName: 'CCTV1' }), 'a');
});
