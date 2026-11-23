// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

/**
 * extract-narrations.ts — collect every chapter's narration array and emit
 * a flat segment list that the TTS pipeline can consume.
 *
 * Run via:
 *   npm run extract-narrations           # writes audio-segments.json
 *   npm run extract-narrations -- --print # also prints to stdout
 *
 * Reads chapter order from src/registry/chapters.ts via a simple regex
 * (no React/CSS evaluation needed). For each chapter it dynamically
 * imports `src/chapters/<NN>-<id>/narrations.ts` (which is React-free)
 * and flattens to:
 *
 *   [
 *     { chapter, step, text, audio: "<chapter>/<step>.mp3" },
 *     ...
 *   ]
 *
 * Step indices in the JSON are 1-indexed, matching the audio file naming
 * convention (`public/audio/<chapter>/<N>.mp3`).
 *
 * Empty narration strings are skipped (silent steps don't need a TTS file).
 *
 * Also writes timeline.json — one row per step, silent steps included, with
 * the chapter's B-roll shot for that step (from optional shots.ts) and the
 * metadata of every media item the shots reference (from src/media/manifest.ts).
 * Renderers read it to know the full step list, per-step duration rules and
 * which clip audio to mix in. See references/AB-ROLL.md.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Prefer cwd (npm run sets it to the project's package.json dir) so the
// script works when `scripts/` is a symlink into shared/presentation/.
// Fallback to __dirname-based resolution if cwd isn't a presentation dir.
const CWD_ROOT = process.cwd();
const ROOT = existsSync(resolve(CWD_ROOT, "src/registry/chapters.ts"))
  ? CWD_ROOT
  : resolve(__dirname, "..");
const REGISTRY_PATH = resolve(ROOT, "src/registry/chapters.ts");
const CHAPTERS_DIR = resolve(ROOT, "src/chapters");
const OUT_PATH = resolve(ROOT, "audio-segments.json");
const TIMELINE_PATH = resolve(ROOT, "timeline.json");
const MANIFEST_PATH = resolve(ROOT, "src/media/manifest.ts");
const LAYOUTS = ["fullbleed", "split", "grid", "collage", "stack", "pip", "compare", "annotate"];

interface TimelineStep {
  chapter: string;
  step: number; // 0-based, matches the runtime cursor
  text: string; // markers stripped
  audio: string | null;
  shot: Record<string, unknown> | null;
  /** {{cue}} / {{sfx:x}} markers: ratio 0~1 of the narration */
  cues: { name: string; kind: string; ratio: number; sfx?: string }[];
  /** {{hold:秒}} total, seconds of extra hold after the narration */
  hold: number;
  /** last step of its chapter (renderers add the chapter-end tail) */
  chapterEnd: boolean;
}

type Parsed = {
  text: string;
  cues: TimelineStep["cues"];
  hold: number;
  errors: string[];
};

/**
 * Director markers in narration text — {{cue}} / {{sfx:name}} / {{hold:0.8}} —
 * are parsed by src/hooks/narrationMarkup.ts (same code the runtime uses).
 * Old projects that don't have that file yet fall back to "no markers".
 */
async function loadParser(): Promise<(raw: string) => Parsed> {
  const file = resolve(ROOT, "src/hooks/narrationMarkup.ts");
  if (existsSync(file)) {
    const mod = await import(pathToFileURL(file).href);
    return mod.parseNarration as (raw: string) => Parsed;
  }
  return (raw) => ({
    text: raw,
    cues: [],
    hold: 0,
    errors: raw.includes("{{")
      ? ["narration 里有 {{...}} 标记，但项目缺 src/hooks/narrationMarkup.ts（老项目跑一次 link-presentation.sh --relink 或从模板拷）"]
      : [],
  });
}

interface Segment {
  chapter: string;
  step: number;
  text: string;
  audio: string;
}

/** Parse `src/registry/chapters.ts` to learn chapter id order. */
async function readChapterOrder(): Promise<{ id: string; folder: string }[]> {
  const src = await readFile(REGISTRY_PATH, "utf8");
  // Match: id: "..."   AND   from "../chapters/<folder>/narrations"
  const ids: string[] = [];
  const folders: Record<string, string> = {};

  for (const m of src.matchAll(/id:\s*["']([^"']+)["']/g)) ids.push(m[1]!);
  for (const m of src.matchAll(
    /from\s+["']\.\.\/chapters\/([^"'\/]+)\/narrations["']/g,
  )) {
    // We map by import order; pair 1:1 with `ids`. Both orders are the
    // chapter declaration order in CHAPTERS so they line up.
    const folder = m[1]!;
    folders[folder] = folder;
  }

  // Map id → folder by reading each chapter's narrations.ts existence.
  // Folders are typically `<NN>-<id>`; fall back to plain `<id>` if not.
  const result: { id: string; folder: string }[] = [];
  for (const id of ids) {
    const candidates = Object.keys(folders).filter((f) => f.endsWith(`-${id}`));
    const folder = candidates[0] ?? Object.keys(folders).find((f) => f === id);
    if (!folder) {
      throw new Error(
        `chapter id "${id}" registered but no matching folder found ` +
          `under src/chapters/. Expected something like NN-${id}/narrations.ts`,
      );
    }
    result.push({ id, folder });
  }
  return result;
}

async function loadNarrations(folder: string): Promise<unknown[]> {
  const file = join(CHAPTERS_DIR, folder, "narrations.ts");
  if (!existsSync(file)) {
    throw new Error(`missing narrations.ts: ${file}`);
  }
  const url = pathToFileURL(file).href;
  const mod = await import(url);
  if (!Array.isArray(mod.narrations)) {
    throw new Error(
      `narrations.ts in ${folder} must export an array named "narrations"`,
    );
  }
  return mod.narrations as unknown[];
}

async function loadShots(folder: string): Promise<Record<string, Record<string, unknown>>> {
  const file = join(CHAPTERS_DIR, folder, "shots.ts");
  if (!existsSync(file)) return {};
  const mod = await import(pathToFileURL(file).href);
  if (!mod.shots || typeof mod.shots !== "object") {
    throw new Error(`shots.ts in ${folder} must export an object named "shots"`);
  }
  return mod.shots as Record<string, Record<string, unknown>>;
}

async function loadManifest(): Promise<Record<string, Record<string, unknown>>> {
  if (!existsSync(MANIFEST_PATH)) return {};
  const mod = await import(pathToFileURL(MANIFEST_PATH).href);
  return (mod.MEDIA ?? {}) as Record<string, Record<string, unknown>>;
}

async function loadStage(): Promise<{ w: number; h: number } | null> {
  const file = resolve(ROOT, "src/stage.config.ts");
  if (!existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  return { w: Number(mod.STAGE_W), h: Number(mod.STAGE_H) };
}

async function main() {
  const print = process.argv.includes("--print");
  const order = await readChapterOrder();
  const manifest = await loadManifest();
  const stage = await loadStage();
  const stageAspect = stage ? stage.w / stage.h : 16 / 9;
  const parse = await loadParser();

  const segments: Segment[] = [];
  const timeline: TimelineStep[] = [];
  const usedMedia = new Set<string>();
  const problems: string[] = [];
  let silentSteps = 0;
  let brollSteps = 0;
  for (const { id, folder } of order) {
    const arr = await loadNarrations(folder);
    const shots = await loadShots(folder);
    for (const key of Object.keys(shots)) {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i >= arr.length) {
        problems.push(`${id}: shots.ts 的 step ${key} 超出范围（本章 0..${arr.length - 1}）`);
      }
    }
    arr.forEach((entry, i) => {
      const parsed = typeof entry === "string" ? parse(entry) : null;
      for (const e of parsed?.errors ?? []) problems.push(`${id} step ${i}: ${e}`);
      const shot = shots[i] ?? null;
      if (shot) {
        brollSteps++;
        const layout = String(shot.layout ?? "");
        if (!LAYOUTS.includes(layout)) problems.push(`${id} step ${i}: 未知 layout "${layout}"`);
        const ids = Array.isArray(shot.media) ? (shot.media as string[]) : [];
        if (ids.length === 0) problems.push(`${id} step ${i}: shot.media 为空`);
        if (layout === "compare" && ids.length < 2) problems.push(`${id} step ${i}: compare 需要 2 个素材`);
        for (const m of ids) {
          usedMedia.add(m);
          const item = manifest[m] as { width?: number; height?: number } | undefined;
          if (!item) {
            problems.push(`${id} step ${i}: 素材 "${m}" 不在 manifest（先跑 ingest）`);
            continue;
          }
          // 满屏铺素材时，素材与舞台比例差太多 = 裁掉一大半（横素材进竖屏只剩中间一条）
          if ((layout === "fullbleed" || layout === "compare") && item.width && item.height) {
            const r = item.width / item.height / stageAspect;
            if (r > 1.6 || r < 1 / 1.6) {
              problems.push(
                `${id} step ${i}: ${layout} 用了比例不合的 "${m}"（${item.width}x${item.height}），满屏会裁掉大半，换 split / pip / grid 或换素材`,
              );
            }
          }
        }
      }
      const spoken = parsed?.text ?? "";
      timeline.push({
        chapter: id,
        step: i,
        text: spoken,
        audio: spoken !== "" ? `${id}/${i + 1}.mp3` : null,
        shot,
        cues: parsed?.cues ?? [],
        hold: parsed?.hold ?? 0,
        chapterEnd: i === arr.length - 1,
      });
    });
    arr.forEach((entry, i) => {
      const step = i + 1;
      if (typeof entry !== "string") {
        throw new Error(
          `chapter "${id}" step ${step}: narration must be a string ` +
            `(got ${typeof entry}). The {text, minHoldMs} form was removed; ` +
            `if your animation is longer than the narration, write longer ` +
            `narration, split the step, or speed the animation up.`,
        );
      }
      const spoken = parse(entry).text;
      if (spoken === "") {
        // Silent step — no TTS needed; runtime falls back to estimate.
        silentSteps++;
        return;
      }
      segments.push({
        chapter: id,
        step,
        text: spoken, // markers stripped — TTS never sees {{...}}
        audio: `${id}/${step}.mp3`,
      });
    });
  }

  await writeFile(OUT_PATH, JSON.stringify(segments, null, 2) + "\n", "utf8");

  const media: Record<string, unknown> = {};
  for (const m of usedMedia) if (manifest[m]) media[m] = manifest[m];
  await writeFile(
    TIMELINE_PATH,
    JSON.stringify({ steps: timeline, media }, null, 2) + "\n",
    "utf8",
  );
  const cueSteps = timeline.filter((s) => s.cues.length > 0).length;
  if (cueSteps > 0) console.error(`✓ cues: ${cueSteps} steps carry {{...}} markers`);
  if (brollSteps > 0) {
    console.error(`✓ timeline: ${timeline.length} steps (${brollSteps} B-roll, ${usedMedia.size} media)`);
  }
  for (const p of problems) console.error(`⚠ ${p}`);

  console.error(
    `✓ extracted ${segments.length} segments from ${order.length} chapters` +
      (silentSteps > 0 ? ` (skipped ${silentSteps} silent steps)` : ""),
  );
  console.error(`  → ${OUT_PATH}`);
  if (print) console.log(JSON.stringify(segments, null, 2));
}

main().catch((err) => {
  console.error(`✗ ${err.message ?? err}`);
  process.exit(1);
});
