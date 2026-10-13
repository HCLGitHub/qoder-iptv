// 给回看清单补 #EXT-X-ENDLIST，让它被当成点播而不是直播。
//
// 为什么要补：回看理应是点播，可有些 IPTV 网关的 playseek 清单不带 ENDLIST。
// hls.js 见不到这个标记就把这一路按直播处理（LevelDetails 默认 live=true，
// 只有解析到 ENDLIST 才置 false），于是两处吃亏：
//   video.duration 永远是 Infinity，进度条只能拿 EPG 时长凑，不是真实时长；
//   hls.js 会整段回看期都定时重拉清单，白耗请求。
//
// 为什么不能无条件补：如果网关返回的是**滑动窗口**（只给到目前为止的一段，靠客户端
// 定时重拉清单往后长），标成点播会让 hls.js 不再刷新，播到窗口末尾就停住——
// 那是把「进度条不准」换成了「看不完」，得不偿失。
// 所以只在「清单里的分片总时长已经覆盖了这个节目」时才封口：那说明它是完整的一整段。

// 覆盖到节目时长的这个比例就认作完整。留一成余量：网关给的分片边界与 EPG 的起止
// 时刻本就对不齐（EPG 常是整分，分片是 4~10 秒一片），卡得太严会让本该封口的也漏掉。
const COVER_RATIO = 0.9;

// 返回补过 ENDLIST 的清单文本；判定不该补时原样返回。
// exp: { dur } —— 这个节目按 EPG 应该有多长（秒）。拿不到时长就不补（无从判断完整性）。
export function closeCatchupList(text, exp) {
  if (!exp || typeof text !== 'string' || text.indexOf('#EXTM3U') < 0) return text;
  if (/#EXT-X-STREAM-INF/i.test(text)) return text; // master 清单，这里没有分片可言
  if (text.indexOf('#EXT-X-ENDLIST') >= 0) return text; // 本来就有，什么都不用做
  if (!(exp.dur > 0)) {
    try { console.log('[vod] keep live (unknown programme duration)'); } catch (e) {}
    return text;
  }
  let sum = 0;
  let n = 0;
  const re = /#EXTINF:\s*([\d.]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    sum += parseFloat(m[1]) || 0;
    n++;
  }
  if (!n) return text;
  const cover = Math.round(sum) + '/' + Math.round(exp.dur) + 's';
  if (sum < exp.dur * COVER_RATIO) {
    // 还没长够：它大概是个会往后长的滑动窗口，封了口就看不完了
    try { console.log('[vod] keep live: covered ' + cover); } catch (e) {}
    return text;
  }
  try { console.log('[vod] closed list: ' + n + ' segs ' + cover); } catch (e) {}
  return text.replace(/\s*$/, '\n') + '#EXT-X-ENDLIST\n';
}

// 按基类生成清单加载器。getExpect() 在每次加载时调用（播放模式随时会变），
// 返回 null 表示这一路不该动（直播）。
export function makeVodPlaylistLoader(base, getExpect) {
  return class VodPlaylistLoader extends base {
    load(context, config, callbacks) {
      const onSuccess = callbacks.onSuccess;
      const wrapped = Object.assign({}, callbacks, {
        onSuccess: (response, stats, ctx, networkDetails) => {
          try {
            response.data = closeCatchupList(response.data, getExpect());
          } catch (e) {}
          onSuccess(response, stats, ctx, networkDetails);
        }
      });
      super.load(context, config, wrapped);
    }
  };
}
