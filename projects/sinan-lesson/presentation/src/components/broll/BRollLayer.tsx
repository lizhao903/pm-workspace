// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { CSSProperties, ReactNode } from "react";
import { STAGE_H, STAGE_W } from "../../stage.config";
import { progress, useShotClock } from "../../media/clock";
import type { MediaItem, Shot } from "../../media/types";
import { MediaView } from "./MediaView";
import "./broll.css";

interface Props {
  /** 当前步的 B-roll；undefined = A-roll，本层不渲染 */
  shot: Shot | undefined;
  /** 唯一标识这个镜头（换步就变），时钟据此归零 */
  shotKey: string;
  media: Record<string, MediaItem>;
  /** 镜头预计停留秒数（推拉 / 叠卡的时间轴长度）。渲染器会用真实时长覆盖 */
  span: number;
  withSound: boolean;
}

const PORTRAIT = STAGE_H > STAGE_W;

/**
 * B-roll 层：盖在章节 scene 之上（同在 .stage-frame 里），按 shot.layout
 * 摆素材。所有动效读 useShotClock，见 media/clock.ts。
 * 章节组件完全不知道 B-roll 的存在 —— 改素材编排只动 shots.ts。
 */
export function BRollLayer({ shot, shotKey, media, span, withSound }: Props) {
  const t = useShotClock(shot ? shotKey : "");
  if (!shot) return null;
  const spanSec = readSpanOverride() ?? span;
  const ctx: Ctx = { shot, t, span: spanSec, media, withSound };
  const body = LAYOUTS[shot.layout]?.(ctx) ?? (
    <div className="broll-missing">未知 layout：{shot.layout}</div>
  );
  if (shot.layout === "pip") {
    return <div className="broll-layer broll-layer--pip">{body}</div>;
  }
  return (
    <div className="broll-layer" style={transitionStyle(shot, t)}>
      {body}
    </div>
  );
}

/* ───────────────────────── helpers ───────────────────────── */

interface Ctx {
  shot: Shot;
  t: number;
  span: number;
  media: Record<string, MediaItem>;
  withSound: boolean;
}

function readSpanOverride(): number | null {
  const v = (window as unknown as { __wvpClock?: { span?: number } }).__wvpClock?.span;
  return typeof v === "number" && v > 0 ? v : null;
}

function transitionStyle(shot: Shot, t: number): CSSProperties {
  const kind = shot.transition ?? "fade";
  const p = progress(t, 0, 0.45);
  switch (kind) {
    case "cut":
      return {};
    case "push":
      return PORTRAIT
        ? { transform: `translateY(${(1 - p) * 100}%)` }
        : { transform: `translateX(${(1 - p) * 100}%)` };
    case "zoom":
      return { opacity: p, transform: `scale(${1.08 - 0.08 * p})` };
    default:
      return { opacity: p };
  }
}

function view(ctx: Ctx, idx: number, extra: Partial<Parameters<typeof MediaView>[0]> = {}) {
  const id = ctx.shot.media[idx] ?? "";
  return (
    <MediaView
      key={`${id}-${idx}`}
      id={id}
      item={ctx.media[id]}
      shot={ctx.shot}
      t={ctx.t}
      span={ctx.span}
      withSound={ctx.withSound && idx === 0}
      {...extra}
    />
  );
}

function Caption({ text, t }: { text?: string; t: number }) {
  if (!text) return null;
  return (
    <div className="broll-caption" style={{ opacity: progress(t, 0.5, 0.5) }}>
      {text}
    </div>
  );
}

/**
 * 逐个出现的节奏：第 i 个元素在 start + i * gap 秒出现。gap 按镜头时长压缩，
 * 保证 n 个元素在镜头前 70% 内出完（口播短时不会最后几个还没出来就切走）。
 */
function stagger(span: number, n: number, start: number, preferred: number): number {
  if (n <= 1) return preferred;
  return Math.max(0.12, Math.min(preferred, (span * 0.7 - start) / (n - 1)));
}

/** 单调稳定的伪随机：同一素材 id 每次得到同样的旋转 / 偏移 */
function seeded(key: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/* ───────────────────────── layouts ───────────────────────── */

const LAYOUTS: Record<Shot["layout"], (ctx: Ctx) => ReactNode> = {
  fullbleed(ctx) {
    const kb = ctx.shot.kenBurns ?? true;
    return (
      <>
        {view(ctx, 0, { className: "broll-fill", kenBurns: kb })}
        <Caption text={ctx.shot.caption} t={ctx.t} />
      </>
    );
  },

  split(ctx) {
    const { shot, t } = ctx;
    const mediaFirst = (shot.side ?? "left") === "left";
    const points = shot.points ?? [];
    const gap = stagger(ctx.span, points.length, 0.6, 0.5);
    const text = (
      <div className="broll-split__text">
        {shot.title && (
          <h2 className="broll-split__title" style={{ opacity: progress(t, 0.2, 0.5) }}>
            {shot.title}
          </h2>
        )}
        <ul className="broll-split__points">
          {points.map((p, i) => {
            const k = progress(t, 0.6 + i * gap, 0.45);
            return (
              <li key={i} style={{ opacity: k, transform: `translateY(${(1 - k) * 24}px)` }}>
                {p}
              </li>
            );
          })}
        </ul>
      </div>
    );
    const pane = view(ctx, 0, { className: "broll-split__media", kenBurns: shot.kenBurns ?? false });
    return (
      <div className={`broll-split ${PORTRAIT ? "is-portrait" : ""}`}>
        {mediaFirst ? pane : text}
        {mediaFirst ? text : pane}
      </div>
    );
  },

  grid(ctx) {
    const n = Math.min(6, Math.max(1, ctx.shot.media.length));
    const [cols, rows] = gridShape(n);
    return (
      <>
        <div
          className="broll-grid"
          style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
        >
          {ctx.shot.media.slice(0, n).map((_, i) => {
            const k = progress(ctx.t, 0.1 + i * 0.15, 0.4);
            return (
              <div key={i} className="broll-grid__cell" style={{ opacity: k, transform: `scale(${0.94 + 0.06 * k})` }}>
                {view(ctx, i, { className: "broll-fill" })}
              </div>
            );
          })}
        </div>
        <Caption text={ctx.shot.caption} t={ctx.t} />
      </>
    );
  },

  collage(ctx) {
    const items = ctx.shot.media.slice(0, 6);
    const slots = collageSlots(items.length);
    const gap = stagger(ctx.span, items.length, 0.15, 0.35);
    return (
      <div className="broll-collage">
        {items.map((id, i) => {
          const k = progress(ctx.t, 0.15 + i * gap, 0.55);
          const rot = (seeded(id, 1) - 0.5) * 14;
          const [x, y] = slots[i]!;
          const style: CSSProperties = {
            left: `${x * 100}%`,
            top: `${y * 100}%`,
            opacity: k,
            transform: `translate(-50%, -50%) translateY(${(1 - k) * 80}px) rotate(${rot * k + (1 - k) * rot * 2}deg) scale(${1.15 - 0.15 * k})`,
            zIndex: i + 1,
          };
          return (
            <div key={`${id}-${i}`} className="broll-polaroid" style={style}>
              {view(ctx, i, { className: "broll-polaroid__img" })}
            </div>
          );
        })}
        <Caption text={ctx.shot.caption} t={ctx.t} />
      </div>
    );
  },

  stack(ctx) {
    const items = ctx.shot.media;
    const n = Math.max(1, items.length);
    const every = Math.max(0.6, (ctx.span - 0.6) / n);
    return (
      <div className="broll-stack">
        {items.map((id, i) => {
          const k = progress(ctx.t, i * every, 0.5);
          if (k <= 0 && i > 0) return null;
          const shown = items.filter((_, j) => progress(ctx.t, j * every, 0.5) > 0).length;
          const depth = shown - 1 - i; // 越早出现的卡越靠后
          const rot = (seeded(id, 7) - 0.5) * 8;
          const style: CSSProperties = {
            zIndex: i + 1,
            opacity: i === 0 ? 1 : k,
            transform: `translate(-50%, -50%) translateX(${(1 - k) * 60}%) rotate(${rot}deg) scale(${1 - Math.min(depth, 3) * 0.04})`,
            filter: depth > 0 ? `brightness(${1 - Math.min(depth, 3) * 0.12})` : undefined,
          };
          return (
            <div key={`${id}-${i}`} className="broll-stack__card" style={style}>
              {view(ctx, i, { className: "broll-fill" })}
            </div>
          );
        })}
        <Caption text={ctx.shot.caption} t={ctx.t} />
      </div>
    );
  },

  pip(ctx) {
    const k = progress(ctx.t, 0, 0.45);
    const corner = ctx.shot.corner ?? (PORTRAIT ? "br" : "tr");
    // 小窗比例跟随素材本身，不裁；宽度按「舞台方向 × 素材方向」取一个不压图解的值
    const item = ctx.media[ctx.shot.media[0] ?? ""];
    const aspect = item?.width && item?.height ? item.width / item.height : 16 / 9;
    const mediaPortrait = aspect < 1;
    const width = PORTRAIT ? (mediaPortrait ? 46 : 70) : mediaPortrait ? 20 : 34;
    return (
      <div
        className={`broll-pip broll-pip--${corner}`}
        style={{
          width: `${width}%`,
          aspectRatio: String(aspect),
          opacity: k,
          transform: `scale(${0.85 + 0.15 * k})`,
        }}
      >
        {view(ctx, 0, { className: "broll-fill" })}
        {ctx.shot.caption && <div className="broll-pip__caption">{ctx.shot.caption}</div>}
      </div>
    );
  },

  compare(ctx) {
    const { t, span, shot } = ctx;
    // 先从左扫到右露出 after，再回到中线停住，前后两半同屏
    const sweep = progress(t, 0.4, Math.max(0.8, span * 0.35));
    const settle = progress(t, 0.4 + Math.max(0.8, span * 0.35), 0.8);
    const pos = (sweep - 0.5 * settle) * 100;
    const [before, after] = shot.points ?? [];
    return (
      <div className="broll-compare">
        {view(ctx, 0, { className: "broll-fill" })}
        <div className="broll-compare__after" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          {view(ctx, 1, { className: "broll-fill" })}
        </div>
        <div className="broll-compare__bar" style={{ left: `${pos}%` }} />
        {before && <div className="broll-compare__tag broll-compare__tag--r">{before}</div>}
        {after && (
          <div className="broll-compare__tag broll-compare__tag--l" style={{ opacity: sweep }}>
            {after}
          </div>
        )}
      </div>
    );
  },

  annotate(ctx) {
    const id = ctx.shot.media[0] ?? "";
    const item = ctx.media[id];
    const box = fitBox(item, 0.86);
    const anns = ctx.shot.annotations ?? [];
    const gap = stagger(ctx.span, anns.length, 0.6, 0.8);
    return (
      <div className="broll-annotate">
        <div className="broll-annotate__frame" style={box}>
          {view(ctx, 0, { className: "broll-fill", fit: "contain" })}
          {anns.map((a, i) => {
            const k = progress(ctx.t, a.at ?? 0.6 + i * gap, 0.4);
            const [x, y, w, h] = a.box;
            return (
              <div
                key={i}
                className="broll-annotate__box"
                style={{
                  left: `${x * 100}%`,
                  top: `${y * 100}%`,
                  width: `${w * 100}%`,
                  height: `${h * 100}%`,
                  opacity: k,
                  transform: `scale(${1.2 - 0.2 * k})`,
                }}
              >
                {a.label && <span className="broll-annotate__label">{a.label}</span>}
              </div>
            );
          })}
        </div>
        <Caption text={ctx.shot.caption} t={ctx.t} />
      </div>
    );
  },
};

function gridShape(n: number): [number, number] {
  if (PORTRAIT) {
    if (n <= 1) return [1, 1];
    if (n === 2) return [1, 2];
    if (n === 3) return [1, 3];
    if (n === 4) return [2, 2];
    return [2, 3];
  }
  if (n <= 1) return [1, 1];
  if (n === 2) return [2, 1];
  if (n === 3) return [3, 1];
  if (n === 4) return [2, 2];
  return [3, 2];
}

/** 拍立得落点（舞台归一化中心坐标），按张数给一组手工排过的位置 */
function collageSlots(n: number): [number, number][] {
  const land: Record<number, [number, number][]> = {
    1: [[0.5, 0.5]],
    2: [[0.34, 0.48], [0.66, 0.53]],
    3: [[0.25, 0.5], [0.5, 0.45], [0.75, 0.53]],
    4: [[0.27, 0.36], [0.72, 0.34], [0.3, 0.68], [0.7, 0.67]],
    5: [[0.2, 0.38], [0.5, 0.33], [0.8, 0.39], [0.35, 0.68], [0.66, 0.69]],
    6: [[0.2, 0.33], [0.5, 0.3], [0.8, 0.34], [0.2, 0.7], [0.5, 0.67], [0.8, 0.7]],
  };
  const port: Record<number, [number, number][]> = {
    1: [[0.5, 0.5]],
    2: [[0.46, 0.33], [0.55, 0.66]],
    3: [[0.5, 0.24], [0.42, 0.5], [0.58, 0.76]],
    4: [[0.32, 0.3], [0.68, 0.37], [0.33, 0.64], [0.67, 0.71]],
    5: [[0.3, 0.22], [0.7, 0.3], [0.5, 0.5], [0.3, 0.72], [0.7, 0.78]],
    6: [[0.3, 0.2], [0.7, 0.24], [0.3, 0.48], [0.7, 0.52], [0.3, 0.76], [0.7, 0.8]],
  };
  const table = PORTRAIT ? port : land;
  return table[Math.min(6, Math.max(1, n))]!;
}

/** 让带标注的图按自身比例完整放进舞台，返回定位样式（标注框按图本身坐标） */
function fitBox(item: MediaItem | undefined, ratio: number): CSSProperties {
  const aw = STAGE_W * ratio;
  const ah = STAGE_H * ratio;
  if (!item || !item.width || !item.height) return { width: aw, height: ah };
  const s = Math.min(aw / item.width, ah / item.height);
  return { width: item.width * s, height: item.height * s };
}
