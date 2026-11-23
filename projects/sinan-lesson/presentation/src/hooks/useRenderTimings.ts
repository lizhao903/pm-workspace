// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useCallback, useEffect, useRef } from "react";
import type { PlaybackMode } from "./useAudioPlayer";

interface Args {
  mode: PlaybackMode;
  autoStarted: boolean;
  chapterId: string;
  step: number;
  isLastStep: boolean;
  onAdvance(): void;
}

/**
 * Emits console marks the render-video pipeline (scripts/render-video.mjs)
 * reads to align audio to the recorded video timeline. Side-effect free
 * outside auto mode.
 *
 *   __AUTO_START                            (t=0 anchor, fires once)
 *   __STEP_START <chapter> <step> <secs>    (every step transition)
 *   __AUTO_DONE <secs>                      (after final step's advance)
 *   window.__autoDone = true                (waitForFunction signal)
 *
 * Wraps the caller's `onAdvance` so the final step doesn't try to advance
 * past itself — instead it raises the done flag.
 */
export function useRenderTimings({
  mode,
  autoStarted,
  chapterId,
  step,
  isLastStep,
  onAdvance,
}: Args): { onAutoAdvance: () => void } {
  const t0Ref = useRef<number | null>(null);
  const lastKeyRef = useRef<string>("");

  useEffect(() => {
    if (mode !== "auto" || !autoStarted) return;
    if (t0Ref.current === null) {
      t0Ref.current = performance.now();
      console.log("__AUTO_START");
    }
    const key = `${chapterId}:${step}`;
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key;
      const elapsed = ((performance.now() - t0Ref.current) / 1000).toFixed(3);
      console.log(`__STEP_START ${chapterId} ${step} ${elapsed}`);
    }
  }, [mode, autoStarted, chapterId, step]);

  const onAutoAdvance = useCallback(() => {
    if (isLastStep && t0Ref.current !== null) {
      const elapsed = ((performance.now() - t0Ref.current) / 1000).toFixed(3);
      console.log(`__AUTO_DONE ${elapsed}`);
      (window as unknown as { __autoDone: boolean }).__autoDone = true;
      return;
    }
    onAdvance();
  }, [isLastStep, onAdvance]);

  return { onAutoAdvance };
}
