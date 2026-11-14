// 上次可用源的持久化：用内存版 localStorage，不碰真实存储。
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = Object.create(null);
globalThis.localStorage = {
  get length() { return Object.keys(mem).length; },
  key: (i) => Object.keys(mem)[i],
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }
};

const { getLastSourceIdx, setLastSourceIdx } = await import('../src/core/storage.js');

test('默认 0，写入后能读回', () => {
  assert.equal(getLastSourceIdx('ch:央视|CCTV1'), 0);
  setLastSourceIdx('ch:央视|CCTV1', 2);
  assert.equal(getLastSourceIdx('ch:央视|CCTV1'), 2);
});

test('非法值不写入', () => {
  setLastSourceIdx('k', -1);
  setLastSourceIdx('k', 1.5);
  setLastSourceIdx('k', NaN);
  assert.equal(getLastSourceIdx('k'), 0);
});

test('同一频道更新时保留最新值', () => {
  setLastSourceIdx('k2', 1);
  setLastSourceIdx('k2', 3);
  assert.equal(getLastSourceIdx('k2'), 3);
});

test('映射有上限，超出时淘汰最早写入的', () => {
  for (let i = 0; i < 405; i++) setLastSourceIdx('cap' + i, 1);
  const map = JSON.parse(localStorage.getItem('iptv:lastSource'));
  assert.equal(Object.keys(map).length, 400);
  assert.equal(map.cap0, undefined);
  assert.equal(map.cap404, 1);
});

test('存储内容损坏时退回 0', () => {
  localStorage.setItem('iptv:lastSource', 'not-json');
  assert.equal(getLastSourceIdx('k2'), 0);
  localStorage.setItem('iptv:lastSource', '[1,2]');
  assert.equal(getLastSourceIdx('k2'), 0);
});
