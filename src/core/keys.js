// LG webOS 遥控器键码映射
export const KEY = {
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  OK: 13,
  BACK: 461,
  // 数字键
  NUM_0: 48,
  NUM_9: 57,
  // 彩色键
  RED: 403,
  GREEN: 404,
  YELLOW: 405,
  BLUE: 406,
  // 媒体键
  PLAY: 415,
  PAUSE: 19,
  STOP: 413,
  FF: 417,
  RW: 412,
  PLAY_PAUSE: 10252,
  // 频道 +/-
  CH_UP: 33,
  CH_DOWN: 34,
  // 其它
  INFO: 457,
  MENU: 18
};

// 判断是否数字键，返回 0-9 或 null
export function digitOf(keyCode) {
  if (keyCode >= KEY.NUM_0 && keyCode <= KEY.NUM_9) return keyCode - KEY.NUM_0;
  return null;
}
