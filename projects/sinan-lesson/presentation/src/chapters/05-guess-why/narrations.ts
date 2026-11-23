// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { Narration } from "../../registry/types";

/**
 * 每一步口播文本，来自 script.md 对应段落；{{s1}}/{{s2}}/{{s3}} 为画面提示点，
 * {{hold:秒}} 为留白，送 TTS 前会被剥掉。数组长度 = 本章 step 数。
 */
export const narrations: Narration[] = [
  "试完了，问题来了。{{s1}}磁铁为什么{{s2}}会指南北。{{hold:0.8}}",
  "有人猜是风，{{s1}}有人猜是光。{{s2}}还有人说，磁铁自己{{s3}}记得方向。",
  "把猜想{{s1}}一条条摆出来，{{s2}}再{{s3}}想怎么验。",
  "要是周围什么都没有，{{s1}}它还会自己{{s2}}旋转回去吗。",
];
