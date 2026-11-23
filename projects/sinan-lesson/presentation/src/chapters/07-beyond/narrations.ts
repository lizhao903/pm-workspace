// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { Narration } from "../../registry/types";

/**
 * 每一步口播文本，来自 script.md 对应段落；{{s1}}/{{s2}}/{{s3}} 为画面提示点，
 * {{hold:秒}} 为留白，送 TTS 前会被剥掉。数组长度 = 本章 step 数。
 */
export const narrations: Narration[] = [
  "模型只是个假设。{{s1}}地球里面，{{s2}}真有一块大磁铁吗。{{hold:0.9}}",
  "这个问题，{{s1}}下节课再说。{{s2}}真正的原因，你先自己去查。",
  "后来的人把这件事做成了指南针。{{s1}}航海、{{s2}}行军、{{s3}}测绘，都用得上。",
  "刚才那几步，{{s1}}你也能自己{{s2}}再{{s3}}走一遍。",
  "把猜想写在记录表背面，{{s1}}带来{{s2}}接着验。{{hold:0.8}}",
];
