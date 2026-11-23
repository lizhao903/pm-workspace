// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { Narration } from "../../registry/types";

/**
 * 每一步口播文本，来自 script.md 对应段落；{{s1}}/{{s2}}/{{s3}} 为画面提示点，
 * {{hold:秒}} 为留白，送 TTS 前会被剥掉。数组长度 = 本章 step 数。
 */
export const narrations: Narration[] = [
  "{{s1}}大雾把山盖住了。将军要{{s2}}往南走，可他{{s3}}分不清哪边是南。",
  "太阳{{s1}}看不见，星星{{s2}}也看不见。你替他想想，还能靠什么。",
  "队伍{{s1}}停下来了，一步都不敢{{s2}}往前迈。",
  "这节课，{{s1}}我们就替他{{s2}}把南找出来。{{hold:0.9}}",
];
