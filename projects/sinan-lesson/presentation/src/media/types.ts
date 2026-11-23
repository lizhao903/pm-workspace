// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

/**
 * A-roll / B-roll 数据模型（素材混剪型视频）。
 *
 *   A-roll = 章节组件本身（口播驱动的动态图解），不需要声明。
 *   B-roll = 某一步用真实图片 / 视频素材盖住或叠在 A-roll 上，
 *            在章节目录的 `shots.ts` 里按 step 声明（稀疏，没写的步就是 A-roll）。
 *
 * 原片放在项目根的 media/（与 presentation/ 同级），由 scripts/media.mjs ingest
 * 处理后拷进 public/media/ 并生成 src/media/manifest.ts。shots 里用素材 id 引用，
 * id = 素材在项目 media/ 下的相对路径（例 "landscape/images/factory-01.jpg"）。
 */

export type MediaKind = "image" | "video";

export interface MediaItem {
  id: string;
  kind: MediaKind;
  /** public/ 下的 URL 路径（不含 BASE_URL），例 "media/landscape/images/a.jpg" */
  src: string;
  width: number;
  height: number;
  /** 视频时长（秒），图片为 0 */
  duration: number;
  /** 视频是否带音轨 */
  hasAudio: boolean;
  /** 视频封面帧（public/ 下路径） */
  poster?: string;
}

export type ShotLayout =
  | "fullbleed" // 满屏（图片可推拉 / 视频）
  | "split" // 素材 + 文字要点 分屏
  | "grid" // 2~6 宫格
  | "collage" // 拍立得散落贴图，逐张飞入
  | "stack" // 叠卡，逐张翻出
  | "pip" // 画中画：A-roll 可见，素材在角落小窗
  | "compare" // 前后对比滑块（需 2 个素材）
  | "annotate"; // 图上圈点标注

/**
 * 这一步停多久（见 references/AB-ROLL.md「时长规则」）：
 *   narration — 口播主导（默认）：停留 = 口播时长；视频长了截掉，短了按 overflow 定格 / 循环
 *   clip      — 视频主导：停留 = 片段时长；口播长了会被截断
 *   max       — 取两者较长：口播讲完视频继续放完，或视频放完定格等口播
 * 没有口播的步：有视频按 clip，纯图片按 hold（缺省 3 秒）。
 */
export type ShotFit = "narration" | "clip" | "max";

/** 视频原声怎么进成片：mute 静音（默认）/ duck 压低垫在口播下 / full 原音量 */
export type ShotAudio = "mute" | "duck" | "full";

export type ShotTransition = "cut" | "fade" | "push" | "zoom";

export interface KenBurns {
  /** 起止缩放，默认 1 → 1.12 */
  from?: number;
  to?: number;
  /** 推拉方向的起止焦点（0~1 归一化坐标），默认居中 */
  fromFocus?: [number, number];
  toFocus?: [number, number];
}

export interface Annotation {
  /** 归一化坐标框 [x, y, w, h]（0~1，相对素材本身） */
  box: [number, number, number, number];
  label?: string;
  /** 第几秒出现，缺省按顺序每 0.8s 一个 */
  at?: number;
}

export interface Shot {
  layout: ShotLayout;
  /** 素材 id 列表。fullbleed / split / pip / annotate 取第 1 个；compare 取前 2 个 */
  media: string[];
  /** split 的文字：标题 + 要点 */
  title?: string;
  points?: string[];
  /** split 时素材在哪一侧（竖屏项目里 left=上 / right=下） */
  side?: "left" | "right";
  /** 图注（fullbleed / pip / grid 左下角小字） */
  caption?: string;
  /** 图片推拉；true = 默认参数。视频忽略 */
  kenBurns?: boolean | KenBurns;
  /** pip 小窗位置 */
  corner?: "tl" | "tr" | "bl" | "br";
  /** annotate 的标注框 */
  annotations?: Annotation[];
  /** 视频片段入出点（秒）。缺省整段 */
  clip?: { in?: number; out?: number };
  fit?: ShotFit;
  /** 视频比停留时长短时：freeze 定格最后一帧（默认）/ loop 循环 */
  overflow?: "freeze" | "loop";
  audio?: ShotAudio;
  transition?: ShotTransition;
  /** 无口播纯图片步的停留秒数，或任何步的最短停留秒数 */
  hold?: number;
}

/** chapter 目录下 shots.ts 的导出形状：step 下标（0 起）→ Shot */
export type ShotMap = Record<number, Shot>;
