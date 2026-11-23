// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useRef } from "react";

export type PlaybackMode = "manual" | "audio" | "auto";

interface Options {
  /** Audio file path. `null` = no audio for this step (silent). */
  src: string | null;
  /** `manual` = no playback. `audio` = play but don't auto-advance.
   *  `auto` = play and auto-advance when finished. */
  mode: PlaybackMode;
  /** Breathing pad (ms) after audio finishes before advancing, in `auto`
   *  mode. Default 200ms. App.tsx adds the step's {{hold:秒}} markers and the
   *  chapter-end tail on top of it (see narrationMarkup.ts). */
  trailMs?: number;
  /** Fallback duration (ms) for `auto` mode when the audio file is missing
   *  or fails to play. Typically computed from text length. */
  estimateFallbackMs?: number;
  /** Called when `auto` mode determines the step is finished. */
  onAutoAdvance: () => void;
  /** Has the user started auto playback? (Browsers block autoplay until
   *  the page receives a user gesture; the AutoStartGate flips this.) */
  autoStarted: boolean;
  /** B-roll 步的停留规则（见 media/timing.ts planStep）。三项都缺省 =
   *  纯口播驱动，与 A-roll 行为一致。
   *    minHoldMs  至少停这么久（口播先讲完也等）
   *    maxHoldMs  最多停这么久（到点就切，口播没讲完也截断）
   *    waitAudio  是否等口播结束；false = 只看 min/max 计时 */
  minHoldMs?: number;
  maxHoldMs?: number | null;
  waitAudio?: boolean;
}

/**
 * Per-step audio playback for the presentation.
 *
 * Manages a single hidden `<audio>` element. Switches `src` whenever the
 * current step changes.
 *
 * In `auto` mode:
 *   • Audio file present → advance `trailMs` after the audio's `ended` event.
 *   • Audio file missing / blocked / src = null → advance after
 *     `estimateFallbackMs` (so previews and silent steps still work).
 *
 * For A-roll steps audio playback is the sole driver of step duration. If a
 * chapter's visual animation needs more time, write longer narration, split
 * the step, or speed the animation up. The min/max hold options exist only
 * for B-roll steps, where a video clip has its own length (fit rules in
 * media/timing.ts); App passes them from planStep(), chapters never do.
 */
export function useAudioPlayer({
  src,
  mode,
  trailMs = 200,
  estimateFallbackMs = 1500,
  onAutoAdvance,
  autoStarted,
  minHoldMs = 0,
  maxHoldMs = null,
  waitAudio = true,
}: Options) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Latest callback ref so timers don't capture stale closures.
  const onAdvanceRef = useRef(onAutoAdvance);
  onAdvanceRef.current = onAutoAdvance;

  useEffect(() => {
    const prev = audioRef.current;
    if (prev) {
      prev.pause();
      prev.removeAttribute("src");
      prev.load();
      audioRef.current = null;
    }

    if (mode === "manual") return;
    if (mode === "auto" && !autoStarted) return;

    let advanced = false;
    let timer: number | null = null;
    let backstop: number | null = null;
    let maxTimer: number | null = null;
    const startedAt = performance.now();

    const advanceAfter = (ms: number) => {
      if (mode !== "auto" || advanced) return;
      timer = window.setTimeout(() => {
        if (advanced) return;
        advanced = true;
        onAdvanceRef.current();
      }, Math.max(0, ms));
    };

    // 口播（或其估时）结束：还没到最短停留就补足剩余时间再推进
    const audioDone = (delayMs: number) => {
      if (!waitAudio) return;
      const elapsed = performance.now() - startedAt;
      advanceAfter(Math.max(delayMs, minHoldMs - elapsed));
    };

    if (mode === "auto") {
      if (maxHoldMs != null) {
        maxTimer = window.setTimeout(() => {
          if (advanced) return;
          advanced = true;
          onAdvanceRef.current();
        }, Math.max(0, maxHoldMs));
      }
      if (!waitAudio && maxHoldMs == null) advanceAfter(minHoldMs);
    }

    const clearBackstop = () => {
      if (backstop != null) {
        clearTimeout(backstop);
        backstop = null;
      }
    };

    // Backstop timer: forces advance if `ended` never fires (rare Chromium
    // headless audio race observed during programmatic recording). Sized to
    // audio.duration + 5s margin once metadata loads; falls back to a coarse
    // ceiling before metadata is available.
    const armBackstop = (ms: number) => {
      if (mode !== "auto" || !waitAudio) return;
      clearBackstop();
      backstop = window.setTimeout(() => {
        if (advanced) return;
        console.warn(
          `useAudioPlayer backstop fired after ${ms}ms — audio.ended never arrived`,
          src,
        );
        advanceAfter(0);
      }, Math.max(0, ms));
    };

    if (src) {
      const audio = new Audio(src);
      audioRef.current = audio;
      audio.preload = "auto";

      audio.addEventListener("loadedmetadata", () => {
        // 告诉步内时钟（useStepClock）口播真实时长，提示点按它校正
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          window.dispatchEvent(
            new CustomEvent("wvp:narration-duration", { detail: audio.duration }),
          );
        }
        if (mode !== "auto") return;
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          armBackstop(audio.duration * 1000 + 5000);
        }
      });

      audio.addEventListener("ended", () => {
        clearBackstop();
        audioDone(trailMs);
      });
      audio.addEventListener("error", () => {
        // Audio file missing or undecodable — fall back to estimate.
        clearBackstop();
        if (mode === "auto") audioDone(estimateFallbackMs);
      });

      audio.play().catch((err) => {
        // Autoplay blocked (rare, AutoStartGate should prevent this) or
        // file missing — fall back to estimate in auto mode.
        console.warn("audio play failed:", err);
        clearBackstop();
        if (mode === "auto") audioDone(estimateFallbackMs);
      });

      // Coarse initial backstop in case loadedmetadata never fires.
      // Tightened by armBackstop once we know audio.duration.
      armBackstop(Math.max(estimateFallbackMs, 30_000) + 10_000);
    } else if (mode === "auto") {
      // No audio for this step (silent / empty narration) — use estimate.
      audioDone(estimateFallbackMs);
    }

    return () => {
      advanced = true;
      if (timer != null) clearTimeout(timer);
      if (maxTimer != null) clearTimeout(maxTimer);
      clearBackstop();
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.removeAttribute("src");
        a.load();
        audioRef.current = null;
      }
    };
  }, [src, mode, trailMs, estimateFallbackMs, autoStarted, minHoldMs, maxHoldMs, waitAudio]);
}
