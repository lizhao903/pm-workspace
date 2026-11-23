// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

/**
 * narrationMarkup.ts — narrations.ts 里口播文本的「导演标记」解析（无 React 依赖）。
 *
 * 口播文本可以内嵌三种标记，TTS 前会被剥掉，观众听不到：
 *
 *   {{name}}        提示点（cue）。画面在口播念到这里时触发，章节里用
 *                   useCue("name") / cueAt("name") 读取，代替手写的秒数延时
 *   {{sfx:name}}    音效点。渲染时把 public/sfx/<name>.(mp3|wav) 混在这个时刻；
 *                   同时也是一个名为 "sfx:name" 的提示点
 *   {{hold:0.8}}    本步口播结束后额外停留 0.8 秒（金句后的留白、段落换气）。
 *                   可写多个，累加
 *
 * 例：
 *   "提示词不用长，{{ipo}}三段别漏：{{in}}输入，{{proc}}加工，{{out}}输出。{{hold:0.8}}"
 *
 * 提示点时间 = 口播实际时长 × 标记前文本的「朗读权重」占比。权重按字符估：
 * 汉字 1、英文字母 / 数字 0.45、逗号类停顿 2、句号类停顿 4。这是比例估算，
 * 不是逐字对齐 —— 对得上「念到这个词附近」，误差通常在 0.3 秒内。
 *
 * 运行时（hooks/useStepClock.ts）、extract-narrations（写 audio-segments.json /
 * timeline.json）、check-chapters 都用这一份规则；渲染脚本读 timeline.json，
 * 不再自己解析。改规则只改这里。
 */

export type CueKind = "cue" | "sfx";

export interface NarrationCue {
  /** 提示点名；音效点的名字是 "sfx:<name>" */
  name: string;
  kind: CueKind;
  /** 0~1：标记位于整段朗读权重的哪个位置 */
  ratio: number;
  /** 音效文件名（不含扩展名），只有 kind === "sfx" 时有 */
  sfx?: string;
}

export interface ParsedNarration {
  /** 剥掉标记后的纯口播文本（送 TTS / 字幕 / 估时用） */
  text: string;
  cues: NarrationCue[];
  /** 口播结束后额外停留秒数 */
  hold: number;
  /** 写错的标记（非法名字 / hold 不是数字 / 重名），extract-narrations 会报出来 */
  errors: string[];
}

const MARK_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const NAME_RE = /^[A-Za-z][\w-]*$/;

const PAUSE_SHORT = /[，,、；;：:]/;
const PAUSE_LONG = /[。．.！!？?…]/;

/** 一段文本的朗读权重（≈ 汉字数，带停顿修正） */
export function speechWeight(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (/\s/.test(ch)) w += 0.15;
    else if (PAUSE_LONG.test(ch)) w += 4;
    else if (PAUSE_SHORT.test(ch)) w += 2;
    else if (/[A-Za-z0-9]/.test(ch)) w += 0.45;
    else if (/[「」『』《》“”‘’"'()（）【】\-—]/.test(ch)) w += 0.2;
    else w += 1;
  }
  return w;
}

/** 无音频时的估时（秒），与 App.tsx 的 estimateMs 同口径：中文约 4 字 / 秒，最短 1.5 秒 */
export function estimateSeconds(text: string): number {
  if (!text) return 1.5;
  return Math.max(1.5, text.length * 0.25);
}

export function parseNarration(raw: string): ParsedNarration {
  const errors: string[] = [];
  const marks: { name: string; kind: CueKind; sfx?: string; at: number }[] = [];
  let hold = 0;
  let text = "";
  let last = 0;
  for (const m of raw.matchAll(MARK_RE)) {
    text += raw.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const body = m[1] ?? "";
    const at = text.length;
    const colon = body.indexOf(":");
    const head = colon >= 0 ? body.slice(0, colon).trim() : body.trim();
    const arg = colon >= 0 ? body.slice(colon + 1).trim() : "";
    if (colon >= 0 && head === "hold") {
      const v = Number(arg);
      if (Number.isFinite(v) && v >= 0) hold += v;
      else errors.push(`{{${body}}}：hold 后面要写秒数，如 {{hold:0.8}}`);
    } else if (colon >= 0 && head === "sfx") {
      if (NAME_RE.test(arg)) marks.push({ name: `sfx:${arg}`, kind: "sfx", sfx: arg, at });
      else errors.push(`{{${body}}}：音效名只能用字母开头的 字母 / 数字 / - / _`);
    } else if (colon < 0 && NAME_RE.test(head)) {
      marks.push({ name: head, kind: "cue", at });
    } else {
      errors.push(`{{${body}}}：无法识别的标记（可用 {{名字}} / {{sfx:名字}} / {{hold:秒}}）`);
    }
  }
  text += raw.slice(last);

  // 剥标记可能留下双空格 / 行首尾空格
  const clean = text.replace(/[ \t]{2,}/g, " ").trim();
  const lead = text.length - text.trimStart().length;
  const total = speechWeight(clean);
  const seen = new Set<string>();
  const cues: NarrationCue[] = [];
  for (const mk of marks) {
    if (mk.kind === "cue" && seen.has(mk.name)) {
      errors.push(`{{${mk.name}}}：同一步里提示点重名`);
      continue;
    }
    seen.add(mk.name);
    const before = text.slice(0, mk.at).slice(lead).replace(/[ \t]{2,}/g, " ");
    const ratio = total > 0 ? Math.min(1, speechWeight(before) / total) : 0;
    cues.push({ name: mk.name, kind: mk.kind, ratio, ...(mk.sfx ? { sfx: mk.sfx } : {}) });
  }
  return { text: clean, cues, hold, errors };
}

/** 只要纯文本（字幕 / 估时 / 老代码兼容） */
export function stripMarkup(raw: string): string {
  return parseNarration(raw).text;
}
