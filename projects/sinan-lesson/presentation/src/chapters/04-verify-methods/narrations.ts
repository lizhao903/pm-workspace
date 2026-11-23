// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { Narration } from "../../registry/types";

/**
 * 每一步口播文本，来自 script.md 对应段落；{{s1}}/{{s2}}/{{s3}} 为画面提示点，
 * {{hold:秒}} 为留白，送 TTS 前会被剥掉。数组长度 = 本章 step 数。
 */
export const narrations: Narration[] = [
  "先拿条形磁铁做实验。{{s1}}看它是不是{{s2}}真能指南北。",
  "把磁铁放平，{{s1}}让它自己旋转。{{s2}}停下来，两头总对着南北。",
  "换个地方再试，{{s1}}换个人再试，{{s2}}结果{{s3}}还是一样。",
  "古人还有别的办法。{{s1}}把磁铁吊起来，{{s2}}叫悬挂法。",
  "或者让它浮在{{s1}}水面上，{{s2}}叫水浮法。",
  "学生自己动手，{{s1}}一种方法{{s2}}一种方法{{s3}}地试。",
  "每次停在哪、偏了多少，{{s1}}都{{s2}}记{{s3}}进{{s4}}表里。",
];
