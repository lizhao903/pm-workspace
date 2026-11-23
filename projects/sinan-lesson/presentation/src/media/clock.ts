// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useSyncExternalStore } from "react";

/**
 * B-roll 时间源。B-roll 层里所有随时间变化的东西（推拉、逐张飞入、视频播放
 * 位置、入场转场）都只读这一个时钟，不用 CSS transition / animation —— 这样
 * 定格渲染器（render-video-frames.mjs）可以把时间拨到任意一帧再截图，B-roll
 * 的动效和视频画面在逐帧渲染里也是确定的。
 *
 * 两种模式：
 *   live   （默认）按真实时间走，每换一个镜头（shotKey 变）从 0 开始
 *   manual （URL 带 ?clock=manual，渲染器用）时间只由 window.__wvpClock.seek(t) 改
 *
 * 渲染器协议：
 *   await window.__wvpClock.seek(t, span)  // 拨到第 t 秒；span = 本镜头总秒数
 *   resolve 时视频已 seeked、画面已提交
 */

type Listener = () => void;

const listeners = new Set<Listener>();
const pendingSeeks = new Set<Promise<void>>();

const manual =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("clock") === "manual";

let current = 0; // 当前镜头内的秒数
let startedAt = 0; // live 模式下当前镜头开始的 performance.now()
let activeKey = "";
let raf = 0;

function emit() {
  for (const l of listeners) l();
}

function tick() {
  current = (performance.now() - startedAt) / 1000;
  emit();
  raf = requestAnimationFrame(tick);
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot() {
  return current;
}

const nextFrame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => r()));

/** 视频元素在 manual 模式下 seek 时登记，seek() 会等它们全部完成 */
export function registerSeek(p: Promise<void>) {
  pendingSeeks.add(p);
  void p.finally(() => pendingSeeks.delete(p));
}

export const isManualClock = () => manual;

if (typeof window !== "undefined") {
  (window as unknown as { __wvpClock: unknown }).__wvpClock = {
    manual,
    /** 渲染器告诉 B-roll 层这个镜头的真实停留秒数（推拉 / 叠卡按它铺时间轴） */
    span: 0,
    async seek(this: { span: number }, t: number, span?: number) {
      if (typeof span === "number") this.span = span;
      current = Math.max(0, t);
      emit();
      await nextFrame(); // 让 React 提交这一帧
      while (pendingSeeks.size) await Promise.all([...pendingSeeks]);
      await nextFrame();
      await nextFrame(); // 再等一帧确保视频新画面已上屏
    },
  };
}

/**
 * 在 B-roll 组件里读当前镜头内的秒数。shotKey 变 = 新镜头，时间归零。
 * shotKey 为空 = 当前步没有 B-roll，停掉 rAF 省电。
 */
export function useShotClock(shotKey: string): number {
  useEffect(() => {
    if (shotKey === activeKey) return;
    activeKey = shotKey;
    cancelAnimationFrame(raf);
    current = 0;
    emit();
    if (!shotKey || manual) return;
    startedAt = performance.now();
    raf = requestAnimationFrame(tick);
  }, [shotKey]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 时间段进度：从 start 秒开始、持续 dur 秒，返回缓出后的 0~1 */
export function progress(t: number, start: number, dur: number): number {
  if (dur <= 0) return t >= start ? 1 : 0;
  const x = Math.min(1, Math.max(0, (t - start) / dur));
  return 1 - Math.pow(1 - x, 3);
}
