// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useSyncExternalStore } from "react";
import { estimateSeconds, parseNarration, type ParsedNarration } from "./narrationMarkup";

/**
 * useStepClock.ts — 步内时钟：让画面跟着口播的「提示点」走，而不是手写秒数。
 *
 * 为什么需要它：一步口播常常 10~20 秒，画面要在念到某个词时才亮起。以前靠
 * `animationDelay: "8.5s"` 去猜，TTS 一重合成、语速一变，全片错位。现在在
 * narrations.ts 里写 {{name}} 标记（规则见 narrationMarkup.ts），章节里：
 *
 *   const cue = useCue();                       // 本步的提示点
 *   <div className={cue.on("in") ? "x in" : "x"} />          // 到点切 class
 *   <div style={{ animationDelay: cue.delay("in") }} />      // 到点开始 CSS 动画
 *   const p = useCueProgress("grow", 1.2);      // 提示点后 1.2 秒内 0→1（缓出）
 *
 * 优先用 cue.delay(...)：只是把 CSS 动画的起点换成提示点时刻，不触发逐帧重渲染，
 * 逐帧渲染器也能确定地拨到任意一帧。
 *
 * 时间来源：
 *   live   （默认）从本步开始按真实时间走；口播时长先用估时，<audio> 加载出真实
 *            时长后（useAudioPlayer 派发 wvp:narration-duration 事件）自动校正
 *   manual （?clock=manual，render-video-frames.mjs 用）时间只由
 *            window.__wvpStepClock.seek(t, { T, narr }) 决定；seek 同时把页面上
 *            所有 CSS animation / transition 暂停并拨到对应时刻 → 逐帧确定
 *
 * App.tsx 每步调用一次 useStepClockDriver(key, rawNarration)。老项目的 App.tsx
 * 没接 driver 时，useCue 一律返回「已到点」（画面直接全显示），不会报错。
 */

type Listener = () => void;

const manual =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("clock") === "manual";

interface ClockState {
  key: string;
  parsed: ParsedNarration | null;
  /** 当前步内秒数 */
  t: number;
  /** 口播真实时长（秒）；null = 还不知道，用估时 */
  narrSec: number | null;
  startedAt: number;
  /** 每次 key / 时长变化 +1，让依赖提示点时刻的订阅者重新取值 */
  version: number;
}

const st: ClockState = {
  key: "",
  parsed: null,
  t: 0,
  narrSec: null,
  startedAt: 0,
  version: 0,
};

const listeners = new Set<Listener>();
let raf = 0;
/** useCueProgress 这类 JS 驱动的连续效果在本步内要跑到第几秒（逐帧渲染器据此判定画面是否定住） */
let busyUntil = 0;

function emit() {
  for (const l of listeners) l();
}
function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function narrationSeconds(): number {
  if (st.narrSec != null) return st.narrSec;
  return estimateSeconds(st.parsed?.text ?? "");
}

const warned = new Set<string>();

/** 提示点在本步内的秒数；不存在的提示点返回 0（直接显示）并警告一次 */
export function cueSeconds(name: string): number {
  if (!st.parsed) return 0;
  const c = st.parsed.cues.find((x) => x.name === name);
  if (!c) {
    const k = `${st.key}|${name}`;
    if (!warned.has(k)) {
      warned.add(k);
      console.warn(`[useCue] 本步（${st.key}）口播里没有提示点 {{${name}}}，按 0 秒处理`);
    }
    return 0;
  }
  return c.ratio * narrationSeconds();
}

function lastCueSeconds(): number {
  if (!st.parsed || st.parsed.cues.length === 0) return 0;
  return Math.max(...st.parsed.cues.map((c) => c.ratio)) * narrationSeconds();
}

function tick() {
  st.t = (performance.now() - st.startedAt) / 1000;
  emit();
  // 过了最后一个提示点 + 本步口播后几秒就停表，省电；切步会重新起表
  if (st.t < Math.max(lastCueSeconds(), narrationSeconds()) + 4) {
    raf = requestAnimationFrame(tick);
  } else {
    raf = 0;
  }
}

/** 切到新的一步：解析口播、时间归零（渲染期同步调用，子组件同一帧就能读到） */
function prepare(key: string, raw: string) {
  st.key = key;
  st.parsed = parseNarration(raw);
  st.t = 0;
  st.narrSec = null;
  st.version++;
  busyUntil = 0;
}

let liveKey = "";

/** 提交后起表（live 模式） */
function start() {
  st.t = 0;
  cancelAnimationFrame(raf);
  raf = 0;
  if (!manual) {
    st.startedAt = performance.now();
    raf = requestAnimationFrame(tick);
  }
  emit();
}

if (typeof window !== "undefined") {
  // useAudioPlayer 拿到 <audio> 真实时长后派发（用事件而不是 import，老项目的
  // useAudioPlayer 软链到新版也不会因为缺这个文件而挂）
  window.addEventListener("wvp:narration-duration", (e) => {
    const sec = (e as CustomEvent<number>).detail;
    if (manual || !Number.isFinite(sec) || sec <= 0) return;
    st.narrSec = sec;
    st.version++;
    emit();
  });

  const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  // 动画对象 → 它出生时的全片时间（秒）。切步时元素被卸载，旧动画对象自然被回收
  const birth = new WeakMap<Animation, number>();

  (window as unknown as { __wvpStepClock: unknown }).__wvpStepClock = {
    manual,
    /**
     * 渲染器协议：拨到本步第 t 秒。
     *   T    全片时间（秒），用来给跨步存活的动画定出生时刻；缺省 = t
     *   narr 本步口播真实时长（秒）；null = 无口播用估时
     * 返回 settled：本步再往后画面不会变了（有限动画都播完、没有未到的提示点），
     * 渲染器据此提前结束逐帧截图，剩余时长用最后一帧定格。
     */
    async seek(t: number, opts: { T?: number; narr?: number | null } = {}) {
      st.t = Math.max(0, t);
      if (opts.narr !== undefined && opts.narr !== st.narrSec) {
        st.narrSec = opts.narr;
        st.version++;
      }
      emit();
      await nextFrame(); // 让 React 提交（到点的 class / delay 生效，新动画诞生）
      await nextFrame();
      const T = opts.T ?? t;
      let settled = st.t >= lastCueSeconds() && st.t >= busyUntil;
      for (const a of document.getAnimations()) {
        let b = birth.get(a);
        if (b === undefined) {
          b = T;
          birth.set(a, b);
        }
        a.pause();
        const local = Math.max(0, (T - b) * 1000);
        a.currentTime = local;
        const end = a.effect?.getComputedTiming().endTime;
        if (typeof end === "number" && Number.isFinite(end) && local < end) settled = false;
      }
      await nextFrame();
      return { settled };
    },
    /** 调试用：当前步的提示点时刻 */
    cues() {
      return (st.parsed?.cues ?? []).map((c) => ({ name: c.name, at: cueSeconds(c.name) }));
    },
  };
}

/** App.tsx 每步调用：key 变 = 新的一步，时钟归零 */
export function useStepClockDriver(key: string, rawNarration: string) {
  // 渲染期同步：子组件在同一次渲染里就要读到本步的提示点
  if (key !== st.key && typeof window !== "undefined") prepare(key, rawNarration);
  useEffect(() => {
    if (key === liveKey) return;
    liveKey = key;
    start();
  }, [key]);
}

/** 本步内的秒数（每帧重渲染，只给真正需要连续值的地方用） */
export function useStepTime(): number {
  return useSyncExternalStore(subscribe, () => st.t, () => 0);
}

export interface CueApi {
  /** 是否已念到这个提示点 */
  on(name: string): boolean;
  /** 提示点时刻（秒） */
  at(name: string, offsetSec?: number): number;
  /** 写进 style.animationDelay / transitionDelay 的字符串，如 "3.42s" */
  delay(name: string, offsetSec?: number): string;
}

const driverMissing = () => st.parsed === null;

/**
 * 读本步提示点。on() 只在跨过提示点那一刻触发重渲染；delay() 不触发逐帧重渲染。
 * 老项目 App.tsx 没接 driver：on() 恒 true、delay() 恒 "0s"。
 */
export function useCue(): CueApi {
  // 订阅「已到点的提示点集合」，只有集合变化才重渲染
  const sig = useSyncExternalStore(
    subscribe,
    () => {
      if (driverMissing()) return "nodriver";
      const on = (st.parsed?.cues ?? [])
        .filter((c) => st.t >= c.ratio * narrationSeconds())
        .map((c) => c.name)
        .join("|");
      return `${st.key}#${st.version}#${on}`;
    },
    () => "ssr",
  );
  void sig;
  return {
    on: (name) => driverMissing() || st.t >= cueSeconds(name),
    at: (name, off = 0) => (driverMissing() ? 0 : Math.max(0, cueSeconds(name) + off)),
    delay: (name, off = 0) =>
      `${(driverMissing() ? 0 : Math.max(0, cueSeconds(name) + off)).toFixed(3)}s`,
  };
}

/**
 * 提示点之后 durSec 秒内从 0 走到 1（三次缓出）。数字滚动、进度条生长这类
 * 需要连续值的效果用它；跑动期间每帧重渲染。
 */
export function useCueProgress(name: string, durSec: number): number {
  return useSyncExternalStore(
    subscribe,
    () => {
      // hooks 必须无条件调用，别的步里拿不到这个提示点很正常：直接给终值，不报警
      // （名字拼错由 check-chapters.mjs 静态检查兜）
      if (driverMissing() || !st.parsed?.cues.some((c) => c.name === name)) return 1;
      const start = cueSeconds(name);
      busyUntil = Math.max(busyUntil, start + Math.max(0, durSec));
      if (durSec <= 0) return st.t >= start ? 1 : 0;
      const x = Math.min(1, Math.max(0, (st.t - start) / durSec));
      return 1 - Math.pow(1 - x, 3);
    },
    () => 1,
  );
}
