// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { Narration } from "../../registry/types";

/**
 * 每一步口播文本，来自 script.md 对应段落；{{s1}}/{{s2}}/{{s3}} 为画面提示点，
 * {{hold:秒}} 为留白，送 TTS 前会被剥掉。数组长度 = 本章 step 数。
 */
export const narrations: Narration[] = [
  "答案里给的办法，{{s1}}大多是看太阳，{{s2}}看星星。",
  "白天看太阳，{{s1}}夜里找北斗，{{s2}}晴天都够用。",
  "可浓雾把天全糊住了。{{s1}}这些办法，{{s2}}一个{{s3}}都用不上。",
  "古人翻出一块天然磁石。{{s1}}它吸铁，{{s2}}也能指南北。",
  "把它磨成磁针，{{s1}}或者做成勺形的{{s2}}司南。",
  "不用看天，{{s1}}不用等星星。{{s2}}这是另一条路。",
];
