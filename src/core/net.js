// 网络助手：开发预览时，把跨域/自签证书的外部地址转发到本地 Vite 代理；
// 生产（webOS 电视）环境无同源限制，直接使用原始地址。
export function resolveMediaUrl(uri, baseUrl) {
  const resolved = new URL(uri, baseUrl);
  if (import.meta.env?.DEV && uri.startsWith('/__proxy__?')) {
    return resolved.searchParams.get('u') || resolved.href;
  }
  return resolved.href;
}

export function proxied(url) {
  if (!url) return url;
  try {
    if (import.meta && import.meta.env && import.meta.env.DEV) {
      if (/^https?:\/\//i.test(url)) {
        return '/__proxy__?u=' + encodeURIComponent(url);
      }
    }
  } catch (e) {}
  return url;
}
