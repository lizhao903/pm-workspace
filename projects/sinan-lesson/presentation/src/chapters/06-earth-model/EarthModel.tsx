// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useState } from "react";
import { useCueProgress } from "../../hooks/useStepClock";
import { useSafeCue } from "../../hooks/useSafeCue";
import { narrations } from "./narrations";
import type { ChapterStepProps } from "../../registry/types";
import "./EarthModel.css";

const LAB = `${import.meta.env.BASE_URL}sinan-sim.html`;

/** 与模拟实验网页同构的剖面：磁铁沿地轴贯穿，北端 S、南端 N。 */
function Earth({ empty = false }: { empty?: boolean }) {
  return (
    <svg className="em-earth" viewBox="0 0 560 460" aria-hidden="true">
      <circle className="em-globe" cx="280" cy="230" r="150" />
      <circle className="em-core" cx="280" cy="230" r="66" />
      <defs>
        <clipPath id={empty ? "em-clip-empty" : "em-clip-full"}>
          <circle cx="280" cy="230" r="149" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${empty ? "em-clip-empty" : "em-clip-full"})`}>
        {empty ? (
          <rect className="em-empty-box" x="252" y="80" width="56" height="300" />
        ) : (
          <>
            <rect className="em-s" x="252" y="80" width="56" height="150" />
            <rect className="em-n" x="252" y="230" width="56" height="150" />
          </>
        )}
      </g>
      {!empty && (
        <>
          <text className="em-pole" x="280" y="160" textAnchor="middle">S</text>
          <text className="em-pole" x="280" y="300" textAnchor="middle">N</text>
        </>
      )}
      {empty && <text className="em-empty-label" x="280" y="238" textAnchor="middle">无磁铁</text>}
    </svg>
  );
}

// 0° 来自 article「有磁铁偏离南北 0 度」；无磁铁只有 30~90° 的范围口径，
// 每次运行都是随机值，不能写成可复现的具体度数，故用「偏了」占位并标注模拟口径。
const ON_ROWS = [["东侧", "0°", "是"], ["西侧", "0°", "是"], ["西南侧", "0°", "是"]];
const OFF_ROWS = [["东侧", "偏了", "否"], ["西侧", "偏了", "否"], ["西南侧", "偏了", "否"]];

/** 只在 step7 挂载，避免 useCueProgress 在别的步里设 busyUntil。 */
function Recap({ merged }: { merged: boolean }) {
  const cue = useSafeCue(narrations[6] ?? "");
  const grow = useCueProgress("s1", 1.2);
  return (
    <div className="em-body em-center">
      <div className={"em-stats" + (merged ? " shrink-out" : "")}>
        <div className="em-stat">
          <div className="em-num">{Math.round(grow * 3)}<span> / 3</span></div>
          <div className="em-bar"><i style={{ width: `${grow * 100}%` }} /></div>
          <div className="em-stat-label">有磁铁组 · 沿南北</div>
        </div>
        <div className="em-stat em-stat-empty">
          <div className="em-num">0<span> / 3</span></div>
          <div className="em-bar"><i style={{ width: "0%" }} /></div>
          <div className="em-stat-label">无磁铁组 · 沿南北</div>
        </div>
      </div>
      <div className="em-caveat wipe-up" style={{ animationDelay: cue.delay("s2") }}>
        模型能解释现象，但它只是个假设
      </div>
    </div>
  );
}

export default function EarthModel({ step }: ChapterStepProps) {
  const cue = useSafeCue(narrations[step] ?? "");
  const d1 = cue.delay("s1");
  const d2 = cue.delay("s2");
  const d3 = cue.delay("s3");
  const merged = step === 6 && cue.on("s2");
  const [labOpen, setLabOpen] = useState(false);

  const sheet = (rows: string[][], off: boolean) => (
    <div className="em-sheet">
      <div className="em-tr em-th"><span>位置</span><span>偏离南北</span><span>是否指南北</span></div>
      {rows.map((r, i) => (
        <div key={r[0]} className={"em-tr wipe-up" + (off ? " em-off-row" : "")}
          style={{ animationDelay: [d1, d2, d3][i] }}>
          <span>{r[0]}</span><span>{r[1]}</span><span>{r[2]}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="em-scene scene-pad">
      {/* 母题：南北基准线常驻，末步统计条收拢后由它接住画面。 */}
      <div className={"em-axis" + (merged ? " em-axis-lit" : "")} aria-hidden="true">
        <span>北</span><span>南</span>
        {step >= 6 && <span className="em-axis-q">?</span>}
      </div>

      <button className="em-lab-btn" type="button" data-no-advance onClick={() => setLabOpen((v) => !v)}>
        打开实验台
      </button>

      {/* 同一枚地球剖面 step1 至 step3 不卸载：只做放入 / 拿走与数量变化。 */}
      <div className={"em-earth-layer" + (step >= 3 ? " em-earth-layer-away" : "")}>
        <div className={"em-figure" + (step === 1 ? " focus-dim" : "")}>
          <Earth />
          <span className="em-cap">{step === 2 ? "放进去" : "有巨大磁铁"}</span>
        </div>
        {step === 2 && (
          <div className="em-figure wipe-up" style={{ animationDelay: d2 }}>
            <Earth empty />
            <span className="em-cap">拿走</span>
          </div>
        )}
      </div>

      {step === 0 && (
        <div className="em-body em-center">
          <div className="em-h blur-in" style={{ animationDelay: d1 }}>地球里面，也许有一块巨大磁铁</div>
          <div className="em-caveat wipe-up" style={{ animationDelay: d2 }}>假设模型，不是地球的真实结构</div>
        </div>
      )}

      {step === 1 && (
        <div className="em-body em-center">
          <div className="em-switches">
            <div className="em-switch em-switch-on wipe-up" style={{ animationDelay: d1 }}>有巨大磁铁</div>
            <div className="em-switch wipe-up" style={{ animationDelay: d2 }}>无巨大磁铁</div>
          </div>
          <div className="em-note wipe-up" style={{ animationDelay: d2 }}>只改这一个条件，亲手试一试</div>
        </div>
      )}

      {step === 2 && (
        <div className="em-body em-center">
          <div className="em-note">剖面轮廓不变，只把磁铁<span className="hl-sweep" style={{ animationDelay: d2 }}>放进去或拿走</span></div>
        </div>
      )}

      {step === 3 && (
        <div className="em-body em-lab">
          <div className="em-frame-wrap" data-no-advance>
            <iframe className="em-frame" src={LAB} title="司南模拟实验" />
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="em-body em-center">
          <div className="em-kicker">有磁铁组 · 示例记录</div>
          {sheet(ON_ROWS, false)}
          <div className="em-sheet-note">模拟口径：偏离 0°，三次全部回正</div>
          <div className="em-figure-inline wipe-up" style={{ animationDelay: d3 }}>三次，全都指北</div>
        </div>
      )}

      {step === 5 && (
        <div className="em-body em-center">
          <div className="em-kicker">无磁铁组 · 示例记录</div>
          {sheet(OFF_ROWS, true)}
          <div className="em-sheet-note">模拟口径：偏离 30~90°，每次运行数值不同</div>
          <div className="em-figure-inline wipe-up" style={{ animationDelay: d3 }}>三次里，一次都没指对</div>
        </div>
      )}

      {step === 6 && <Recap merged={merged} />}

      {labOpen && (
        <div className="em-overlay" data-no-advance>
          <div className="em-frame-wrap" data-no-advance>
            <iframe className="em-frame" src={LAB} title="司南模拟实验" />
          </div>
          <button className="em-close" type="button" data-no-advance onClick={() => setLabOpen(false)}>关闭实验台</button>
        </div>
      )}
    </div>
  );
}
