// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

/**
 * 舞台尺寸 —— scaffold 时按 --orientation 注入，单方向单一真相源。
 *
 * scaffold.sh 会把下面三个 {{...}} 占位符按所选 orientation 替换成
 * 实际值（landscape: 1920×1080 / portrait: 1080×1920 / square: 1080×1080）。
 *
 * **不允许**在章节代码 / Stage 组件 / CSS 之外的任何地方硬编码舞台宽高。
 * 想要在不同方向都跑，必须 scaffold 出独立项目（共享 workspace 根的
 * article.md / script.md，但 presentation 项目是两个）。
 *
 * Stage.tsx / useStageScale 应当从这里 import，不要写死 1920/1080。
 */
export const ORIENTATION = "landscape" as
  | "landscape"
  | "portrait"
  | "square";
export const STAGE_W = 1920;
export const STAGE_H = 1080;
