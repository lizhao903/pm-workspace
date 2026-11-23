// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { MediaItem, Shot } from "./types";

/**
 * 一步的停留规则 —— 运行时（useAudioPlayer）和渲染器共用同一套口径。
 * 渲染器侧的 JS 镜像在 scripts/lib/timeline.mjs 的 planStep()，改这里要同步改那里。
 *
 * 返回：
 *   minSec   至少停这么久（口播先结束也要等）
 *   maxSec   最多停这么久（到点就切，口播没讲完也截断）；null = 不设上限
 *   waitAudio 是否等口播结束
 */
export interface StepPlan {
  minSec: number;
  maxSec: number | null;
  waitAudio: boolean;
}

export const DEFAULT_IMAGE_HOLD = 3;

/** 片段实际可播时长（考虑入出点） */
export function clipSeconds(shot: Shot, item: MediaItem | undefined): number {
  if (!item || item.kind !== "video") return 0;
  const start = shot.clip?.in ?? 0;
  const end = Math.min(shot.clip?.out ?? item.duration, item.duration);
  return Math.max(0, end - start);
}

export function planStep(
  hasNarration: boolean,
  shot: Shot | undefined,
  media: Record<string, MediaItem>,
): StepPlan {
  if (!shot) return { minSec: 0, maxSec: null, waitAudio: hasNarration };
  const lead = media[shot.media[0] ?? ""];
  const clip = clipSeconds(shot, lead);
  const hold = shot.hold ?? 0;

  if (!hasNarration) {
    const sec = clip > 0 ? clip : shot.hold ?? DEFAULT_IMAGE_HOLD;
    return { minSec: Math.max(sec, hold), maxSec: Math.max(sec, hold), waitAudio: false };
  }
  const fit = shot.fit ?? "narration";
  if (fit === "clip" && clip > 0) {
    const sec = Math.max(clip, hold);
    return { minSec: sec, maxSec: sec, waitAudio: false };
  }
  if (fit === "max" && clip > 0) {
    return { minSec: Math.max(clip, hold), maxSec: null, waitAudio: true };
  }
  return { minSec: hold, maxSec: null, waitAudio: true };
}
