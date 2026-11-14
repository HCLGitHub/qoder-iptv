import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rememberHeaders,
  headersFor,
  applyHeaders,
  withHeaders,
  clearHeaders
} from '../src/core/reqHeaders.js';

function fakeXhr(reject) {
  const got = {};
  return {
    got,
    setRequestHeader(k, v) {
      if (reject && reject.includes(k)) throw new Error('forbidden');
      got[k] = v;
    }
  };
}

test('按 origin 登记，源内任意路径都能取到', () => {
  clearHeaders();
  rememberHeaders('http://h:8080/live/index.m3u8?token=1', {
    'User-Agent': 'okhttp/3.12.11',
    Referer: 'http://h:8080/'
  });
  assert.deepEqual(headersFor('http://h:8080/live/a.ts'), {
    'User-Agent': 'okhttp/3.12.11',
    Referer: 'http://h:8080/'
  });
  assert.equal(headersFor('http://other:8080/live/a.ts'), null);
});

test('空头不覆盖已有登记，也不新建空登记', () => {
  clearHeaders();
  rememberHeaders('http://h/live/a.m3u8', { Referer: 'http://h/' });
  rememberHeaders('http://h/live/b.m3u8', { Referer: '' });
  rememberHeaders('http://h2/live/a.m3u8', {});
  assert.deepEqual(headersFor('http://h/x.ts'), { Referer: 'http://h/' });
  assert.equal(headersFor('http://h2/x.ts'), null);
});

test('applyHeaders 逐个设置，被拒绝的头不影响其它头', () => {
  clearHeaders();
  rememberHeaders('http://h/live/a.m3u8', { Referer: 'http://h/', 'X-Test': '1' });
  const xhr = fakeXhr(['Referer']);
  applyHeaders(xhr, 'http://h/live/a.ts');
  assert.deepEqual(xhr.got, { 'X-Test': '1' });
});

test('withHeaders 合并时调用方的头优先，无登记时原样返回', () => {
  clearHeaders();
  assert.deepEqual(withHeaders('http://h/a.ts', { Range: 'bytes=0-1' }), { Range: 'bytes=0-1' });
  assert.equal(withHeaders('http://h/a.ts'), undefined);
  rememberHeaders('http://h/a.m3u8', { Referer: 'http://h/', Range: 'bytes=9-9' });
  assert.deepEqual(withHeaders('http://h/a.ts', { Range: 'bytes=0-1' }), {
    Referer: 'http://h/',
    Range: 'bytes=0-1'
  });
});
