// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useRef, type CSSProperties } from "react";
import { isManualClock, registerSeek } from "../../media/clock";
import type { KenBurns, MediaItem, Shot } from "../../media/types";

interface Props {
  item: MediaItem | undefined;
  /** 缺失时占位框里显示的 id */
  id: string;
  shot: Shot;
  t: number;
  /** 镜头总停留秒数（推拉的时间轴长度） */
  span: number;
  /** cover 铺满裁切（默认）/ contain 完整显示 */
  fit?: "cover" | "contain";
  /** 是否允许出声（只影响实时预览；成片音轨由渲染器从源文件混入） */
  withSound?: boolean;
  /** 是否对这张图做推拉（只有 fullbleed 主图默认开） */
  kenBurns?: boolean | KenBurns;
  className?: string;
  style?: CSSProperties;
}

const BASE = import.meta.env.BASE_URL;

function kenBurnsStyle(kb: boolean | KenBurns | undefined, t: number, span: number): CSSProperties {
  if (!kb) return {};
  const cfg: KenBurns = kb === true ? {} : kb;
  const from = cfg.from ?? 1;
  const to = cfg.to ?? 1.12;
  const [fx, fy] = cfg.fromFocus ?? [0.5, 0.5];
  const [tx, ty] = cfg.toFocus ?? [fx, fy];
  // 推拉用线性进度：慢镜头匀速更自然，缓出会显得“刹车”
  const p = span > 0 ? Math.min(1, Math.max(0, t / span)) : 0;
  const s = from + (to - from) * p;
  const ox = (fx + (tx - fx) * p) * 100;
  const oy = (fy + (ty - fy) * p) * 100;
  return { transform: `scale(${s})`, transformOrigin: `${ox}% ${oy}%` };
}

export function MediaView({
  item,
  id,
  shot,
  t,
  span,
  fit = "cover",
  withSound = false,
  kenBurns,
  className,
  style,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const clipIn = shot.clip?.in ?? 0;
  const clipOut = Math.min(shot.clip?.out ?? item?.duration ?? 0, item?.duration ?? 0);
  const clipLen = Math.max(0.05, clipOut - clipIn);
  const loop = shot.overflow === "loop";

  // live 模式：挂载时从入点开始播，到出点按 overflow 定格 / 循环
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !item || item.kind !== "video" || isManualClock()) return;
    v.currentTime = clipIn;
    const onTime = () => {
      if (v.currentTime >= clipOut - 0.04) {
        if (loop) v.currentTime = clipIn;
        else v.pause();
      }
    };
    v.addEventListener("timeupdate", onTime);
    void v.play().catch(() => {});
    return () => v.removeEventListener("timeupdate", onTime);
  }, [item, clipIn, clipOut, loop]);

  // 声音只在实时预览里有意义
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const a = shot.audio ?? "mute";
    v.muted = !withSound || a === "mute" || isManualClock();
    v.volume = a === "duck" ? 0.25 : 1;
  }, [withSound, shot.audio]);

  // manual 模式：时间由时钟决定，逐帧 seek
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !item || item.kind !== "video" || !isManualClock()) return;
    const local = loop ? clipIn + (t % clipLen) : clipIn + Math.min(t, clipLen - 1 / 60);
    if (Math.abs(v.currentTime - local) < 0.001 && v.readyState >= 2) return;
    registerSeek(
      new Promise<void>((resolve) => {
        const done = () => {
          v.removeEventListener("seeked", done);
          resolve();
        };
        v.addEventListener("seeked", done);
        v.currentTime = local;
        setTimeout(done, 3000); // 极端情况下 seeked 不来，别把渲染卡死
      }),
    );
  }, [t, item, clipIn, clipLen, loop]);

  if (!item) {
    return (
      <div className={`broll-missing ${className ?? ""}`} style={style}>
        <span>缺素材：{id}</span>
        <small>跑 scripts/media.mjs ingest 导入</small>
      </div>
    );
  }

  const mediaStyle: CSSProperties = {
    objectFit: fit,
    ...(item.kind === "image" ? kenBurnsStyle(kenBurns, t, span) : {}),
  };

  return (
    <div className={`broll-media ${className ?? ""}`} style={style}>
      {item.kind === "image" ? (
        <img src={BASE + item.src} alt="" draggable={false} style={mediaStyle} />
      ) : (
        <video
          ref={videoRef}
          src={BASE + item.src}
          poster={item.poster ? BASE + item.poster : undefined}
          muted
          playsInline
          preload="auto"
          style={mediaStyle}
        />
      )}
    </div>
  );
}

