// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { Narration } from "../../registry/types";

/**
 * 每一步口播文本，来自 script.md 对应段落；{{s1}}/{{s2}}/{{s3}} 为画面提示点，
 * {{hold:秒}} 为留白，送 TTS 前会被剥掉。数组长度 = 本章 step 数。
 */
export const narrations: Narration[] = [
  "先别急着猜。{{s1}}把问题说清楚，{{s2}}再去问人工智能。",
  "古代行军，{{s1}}在大雾里怎么辨别方向。{{s2}}这样一句，{{s3}}条件都在里头。",
  "要是只问怎么办，{{s1}}回答就会飘，{{s2}}拿不来用。",
  "学生试了好几种问法。{{s1}}问得越具体，{{s2}}答案越能直接用。",
];
