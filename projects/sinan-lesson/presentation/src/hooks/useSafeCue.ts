// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useCue, type CueApi } from "./useStepClock";

const MARK = /\{\{\s*([A-Za-z][\w-]*)\s*\}\}/g;

/**
 * 跨步常驻的主体会读到本步口播里没有的提示点（例如某章只有 step2 写了 {{s3}}）。
 * useCue 遇到缺失名字会 console.warn 并回落 0s，于是画面在无提示点的步里抢跑。
 * 这里先按本步口播原文判一次存在性：只有真写了该提示点才去读时刻。
 *
 * 方法名仍是 on / at / delay，check-chapters.mjs 的提示点静态校验照常生效。
 */
export function useSafeCue(narration: string): CueApi {
  const cue = useCue();
  const declared = new Set<string>();
  for (const m of narration.matchAll(MARK)) declared.add(m[1]);
  return {
    on: (name) => declared.has(name) && cue.on(name),
    at: (name, off = 0) => (declared.has(name) ? cue.at(name, off) : 0),
    delay: (name, off = 0) => (declared.has(name) ? cue.delay(name, off) : "0s"),
  };
}
