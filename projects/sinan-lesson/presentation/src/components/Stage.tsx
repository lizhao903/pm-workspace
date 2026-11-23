// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { CSSProperties, ReactNode } from "react";
import { useStageScale } from "../hooks/useStageScale";
import { STAGE_W, STAGE_H } from "../stage.config";

interface Props {
  onAdvance(): void;
  children: ReactNode;
}

/**
 * The configured stage (landscape 1920×1080 / portrait 1080×1920 /
 * square 1080×1080). Click anywhere except interactive children = advance.
 *
 * 舞台宽高来自 ../stage.config（scaffold 时按 --orientation 注入），
 * **不要**在这里硬编码 1920×1080 —— 否则切到竖屏 / 方形会破。
 *
 * Layout structure (3 nested elements):
 *   .app-shell    ← full viewport, flex-centers the fitter
 *   .stage-fitter ← sized to ACTUAL VISIBLE px (STAGE_W*scale × STAGE_H*scale)
 *                   so the layout system honestly sees what's on screen
 *                   and centers it bulletproof on every viewport / DPR.
 *   .stage-frame  ← raw STAGE_W×STAGE_H box, scaled from top-left into
 *                   the fitter. CSS 自定义属性 --stage-w / --stage-h 由
 *                   :root[data-orientation="..."] 选段注入（见 base.css）。
 *
 * Surface colors come from the active theme's CSS custom properties
 * (var(--shell), var(--surface)) — see themes/<id>/tokens.css.
 */
export function Stage({ onAdvance, children }: Props) {
  const scale = useStageScale(STAGE_W, STAGE_H);
  const fitterStyle: CSSProperties = {
    width: STAGE_W * scale,
    height: STAGE_H * scale,
  };
  const frameStyle: CSSProperties = {
    transform: `scale(${scale})`,
  };
  return (
    <div className="app-shell">
      <div className="stage-fitter" style={fitterStyle}>
        <div
          className="stage-frame"
          style={frameStyle}
          onClick={(e) => {
            const t = e.target as HTMLElement;
            if (t.closest("button, a, input, [data-no-advance]")) return;
            onAdvance();
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
