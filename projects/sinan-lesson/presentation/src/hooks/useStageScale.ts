// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useState } from "react";

/**
 * Compute the scale needed to fit the configured stage inside the current
 * viewport. The stage fills `fillRatio` of the limiting viewport axis
 * (default 0.90 = 10% breathing letterbox split across both sides), so
 * full-screen recording captures the stage near-edge without feeling
 * cramped. Pass extra fixed margins if a project needs chrome outside.
 *
 * **调用方应当从 `../stage.config` import STAGE_W / STAGE_H 传进来**，
 * 不要依赖默认值（默认 1920×1080 只是为向后兼容老的横屏项目保留）。
 * scaffold 在每个项目里把 stage.config.ts 的 ORIENTATION / STAGE_W /
 * STAGE_H 替换成对应方向的值。
 */
export function useStageScale(
  baseW = 1920,
  baseH = 1080,
  marginX = 0,
  marginY = 0,
  fillRatio = 0.9,
) {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    function update() {
      const usefulW = Math.max(320, window.innerWidth * fillRatio - marginX * 2);
      const usefulH = Math.max(180, window.innerHeight * fillRatio - marginY * 2);
      setScale(Math.min(usefulW / baseW, usefulH / baseH));
    }
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [baseW, baseH, marginX, marginY, fillRatio]);

  return scale;
}
