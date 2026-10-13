import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

function withLocale(locale, webOSLocale) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: locale, languages: [locale] },
    configurable: true,
    writable: true
  });
  globalThis.window = webOSLocale ? { webOSSystem: { locale: webOSLocale } } : {};
}

const { resolveLang, setLang, getLang, getLangPref, t, groupLabel } = await import('../src/core/i18n.js');
const { getSettings, saveSettings } = await import('../src/core/storage.js');

test('跟随系统：中文地区显示中文，其他语言显示英文', () => {
  for (const loc of ['zh-CN', 'zh_CN', 'zh-TW', 'zh-Hans-CN', 'zh']) {
    withLocale(loc);
    assert.equal(resolveLang('auto'), 'zh', loc);
  }
  for (const loc of ['en-US', 'ko-KR', 'ja-JP', 'de-DE', 'zu-ZA', '']) {
    withLocale(loc);
    assert.equal(resolveLang('auto'), 'en', loc);
  }
});

test('webOS 系统 locale 优先于浏览器语言', () => {
  withLocale('zh-CN', 'en-US');
  assert.equal(resolveLang('auto'), 'en');
  withLocale('en-US', 'zh-CN');
  assert.equal(resolveLang('auto'), 'zh');
});

test('手动选择不受系统语言影响，未知值按跟随系统处理', () => {
  withLocale('en-US');
  assert.equal(resolveLang('zh'), 'zh');
  withLocale('zh-CN');
  assert.equal(resolveLang('en'), 'en');
  assert.equal(resolveLang(undefined), 'zh');
  assert.equal(resolveLang('fr'), 'zh');
});

test('setLang 只在实际显示语言变化时返回 true', (t2) => {
  t2.after(() => setLang('zh'));
  withLocale('en-US');
  setLang('en');
  assert.equal(setLang('auto'), false);
  assert.equal(getLangPref(), 'auto');
  assert.equal(setLang('zh'), true);
  assert.equal(getLang(), 'zh');
  assert.equal(t('settings.deviceInfo'), '设备信息');
  assert.equal(groupLabel('未分组'), '未分组');
  setLang('en');
  assert.equal(t('settings.deviceInfo'), 'Device Info');
  assert.equal(groupLabel('未分组'), 'Ungrouped');
  assert.equal(groupLabel('央视'), '央视');
});

test('旧版写入的默认中文迁移为跟随系统，迁移后手动中文保留', () => {
  store.clear();
  assert.equal(getSettings().language, 'auto');

  store.set('iptv:settings', JSON.stringify({ aspect: '4:3', language: 'zh' }));
  const migrated = getSettings();
  assert.equal(migrated.language, 'auto');
  assert.equal(migrated.aspect, '4:3');

  store.set('iptv:settings', JSON.stringify({ language: 'en' }));
  assert.equal(getSettings().language, 'en');

  store.clear();
  saveSettings({ language: 'zh' });
  assert.equal(getSettings().language, 'zh');
});

test('中英文词典键完全一致', async () => {
  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/core/i18n.js', import.meta.url), 'utf8')
  );
  const body = src.slice(src.indexOf('const DICT'), src.indexOf('const UNGROUPED'));
  const zh = body.slice(body.indexOf('zh: {'), body.indexOf('en: {'));
  const en = body.slice(body.indexOf('en: {'));
  const keys = (s) => new Set([...s.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
  const zk = keys(zh);
  const ek = keys(en);
  assert.deepEqual([...zk].filter((k) => !ek.has(k)), []);
  assert.deepEqual([...ek].filter((k) => !zk.has(k)), []);
});
