// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { CSSProperties, ReactNode } from "react";
import "./ShotCamera.css";

/**
 * ShotCamera —— 截图 / 图片上的「镜头」：推近到某个区域、框选、聚光。
 *
 * 用在「讲真实界面 / 文档 / 报表截图」的步：观众看到的不是一张静态大图，
 * 而是镜头在图上走 —— 先全景，念到某个功能时推近、框出来。
 *
 *   <ShotCamera
 *     src={`${import.meta.env.BASE_URL}shots/conv.png`}
 *     imgW={2396} imgH={1800}
 *     w={1080} h={810}
 *     focus={{ x: 28, y: 6, w: 64, h: 13 }}            // 镜头对准的区域（图片百分比）
 *     focusFrom={{ rect: FULL, at: cue.delay("ask") }}  // 本步内：先全景，念到 {{ask}} 推近
 *     boxes={[{ id: "ask", x: 29, y: 8, w: 61, h: 8, at: cue.delay("ask", 0.6), label: "一句话需求" }]}
 *   />
 *
 * 镜头语言：
 *   - 跨步运镜：相邻几步渲染同一个 ShotCamera（树结构不变、不加 key），只改 focus，
 *     镜头会平滑移过去 —— 这是「匹配剪辑」，比每步换一张图连贯得多
 *   - 步内运镜：focusFrom，先停在 rect，到 at 时刻移到 focus
 *   - at 接受秒数或 cue.delay(...) 返回的字符串；跟口播走的时刻一律用提示点，别手填秒数
 *   - ring = 描边框；spot = 框外压暗（聚光灯），一屏只用一个 spot
 *
 * 颜色全走主题 token；标签字号按反向缩放保持恒定（推近 3 倍字也不会变大）。
 */
export type CamRect = { x: number; y: number; w: number; h: number };
export type CamBox = CamRect & {
  id: string;
  /** 出现时刻：秒数或 "3.2s"（cue.delay 的返回值）；缺省 0.6 秒 */
  at?: number | string;
  kind?: "ring" | "spot";
  label?: ReactNode;
  labelSide?: "top" | "bottom" | "left" | "right";
};

export const CAM_FULL: CamRect = { x: 0, y: 0, w: 100, h: 100 };

const asTime = (v: number | string | undefined, dflt: number) =>
  v == null ? `${dflt}s` : typeof v === "number" ? `${v}s` : v;

function camera(fw: number, fh: number, ar: number, r: CamRect | undefined, maxZoom: number) {
  const W0 = Math.max(fw, fh * ar);
  const H0 = W0 / ar;
  if (!r) {
    const s0 = Math.min(fw / W0, fh / H0);
    return { W0, H0, s: s0, tx: (fw - W0 * s0) / 2, ty: (fh - H0 * s0) / 2 };
  }
  const rw = (r.w / 100) * W0;
  const rh = (r.h / 100) * H0;
  const s = Math.min(fw / rw, fh / rh, maxZoom);
  const cx = ((r.x + r.w / 2) / 100) * W0;
  const cy = ((r.y + r.h / 2) / 100) * H0;
  let tx = fw / 2 - cx * s;
  let ty = fh / 2 - cy * s;
  tx = Math.min(0, Math.max(fw - W0 * s, tx));
  ty = Math.min(0, Math.max(fh - H0 * s, ty));
  if (W0 * s < fw) tx = (fw - W0 * s) / 2;
  if (H0 * s < fh) ty = (fh - H0 * s) / 2;
  return { W0, H0, s, tx, ty };
}

const tf = (k: { tx: number; ty: number; s: number }) =>
  `translate(${k.tx.toFixed(1)}px, ${k.ty.toFixed(1)}px) scale(${k.s.toFixed(4)})`;

export function ShotCamera({
  src,
  imgW,
  imgH,
  w,
  h,
  focus,
  focusFrom,
  boxes = [],
  maxZoom = 3.2,
  className,
  style,
}: {
  src: string;
  /** 图片原始像素尺寸（只用来算比例） */
  imgW: number;
  imgH: number;
  /** 镜头框在舞台上的尺寸（px） */
  w: number;
  h: number;
  focus?: CamRect;
  focusFrom?: { rect: CamRect; at: number | string };
  boxes?: CamBox[];
  maxZoom?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const ar = imgW / imgH;
  const c = camera(w, h, ar, focus, maxZoom);
  const canvasStyle = {
    width: c.W0,
    height: c.H0,
    transform: tf(c),
    "--s": c.s,
  } as CSSProperties;
  let canvasClass = "wvp-cam-canvas";
  if (focusFrom) {
    const f = camera(w, h, ar, focusFrom.rect, maxZoom);
    Object.assign(canvasStyle, {
      "--cam-from": tf(f),
      "--cam-to": tf(c),
      "--cam-at": asTime(focusFrom.at, 0),
    });
    canvasClass += " wvp-cam-canvas--move";
  }
  return (
    <div className={["wvp-cam", className].filter(Boolean).join(" ")} style={{ width: w, height: h, ...style }}>
      <div className={canvasClass} style={canvasStyle}>
        <img className="wvp-cam-img" src={src} alt="" />
        {boxes.map((b) => (
          <div
            key={b.id}
            className={`wvp-cam-box wvp-cam-box--${b.kind ?? "ring"}`}
            style={{
              left: `${b.x}%`,
              top: `${b.y}%`,
              width: `${b.w}%`,
              height: `${b.h}%`,
              animationDelay: asTime(b.at, 0.6),
            }}
          >
            {b.label ? (
              <span className={`wvp-cam-label wvp-cam-label--${b.labelSide ?? "top"}`}>{b.label}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
