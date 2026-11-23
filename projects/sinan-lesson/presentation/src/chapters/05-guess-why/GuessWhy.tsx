// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useSafeCue } from "../../hooks/useSafeCue";
import { narrations } from "./narrations";
import type { ChapterStepProps } from "../../registry/types";
import "./GuessWhy.css";

const GUESSES = ["是风", "是光", "磁铁自己记得方向"];

function MiniNeedle({ tilt }: { tilt: boolean }) {
  return (
    <svg className={"gw-needle" + (tilt ? " gw-tilt" : "")} viewBox="0 0 120 320" aria-hidden="true">
      <path className="gw-n" d="M60 10 L40 140 L60 155 L80 140 Z" />
      <path className="gw-s" d="M60 310 L40 180 L60 165 L80 180 Z" />
      <circle className="gw-pivot" cx="60" cy="160" r="12" />
    </svg>
  );
}

export default function GuessWhy({ step }: ChapterStepProps) {
  const cue = useSafeCue(narrations[step] ?? "");
  const d1 = cue.delay("s1");
  const d2 = cue.delay("s2");
  const active = cue.on("s3") ? 2 : cue.on("s2") ? 1 : cue.on("s1") ? 0 : -1;
  const away = step === 0 || step >= 3;

  // 三条猜想是同一组节点：step2 由卡片压成清单行，逐条点亮、前项退到背景；step4 收拢让位。
  return (
    <div className="gw-scene scene-pad">
      <div className="gw-axis" aria-hidden="true" />

      <div className={"gw-guesses " + (step === 2 ? "gw-guesses-list" : "gw-guesses-cards") + (away ? " gw-guesses-away" : "")}>
        {GUESSES.map((g, i) => {
          const lit = step === 2 || (step === 1 && cue.on(["s1", "s2", "s3"][i]));
          return (
            <div key={g}
              className={"gw-guess" + (lit ? " gw-guess-lit" : "") + (step === 2 && active >= 0 && i !== active ? " gw-dim" : "") + (step === 2 && i === active ? " gw-active" : "")}>
              <span className="gw-card-no">猜想 {i + 1}</span>
              <span className="gw-card-text">{g}</span>
              <span className="gw-check" />
              <span className="gw-line-tail">待验证</span>
            </div>
          );
        })}
      </div>

      {step === 0 && (
        <div className="gw-body gw-center">
          <div className="gw-question blur-in" style={{ animationDelay: d1 }}>
            磁铁为什么<span className="gw-em hl-sweep" style={{ animationDelay: d2 }}>会指南北</span>？
          </div>
          <div className="gw-rule" style={{ animationDelay: d2 }} />
        </div>
      )}

      {step === 1 && (
        <div className="gw-body">
          <div className="gw-kicker">大家的猜想</div>
        </div>
      )}

      {step === 2 && (
        <div className="gw-body">
          <div className="gw-kicker">一条条摆出来，再想怎么验</div>
        </div>
      )}

      {step === 3 && (
        <div className="gw-body gw-center">
          <div className="gw-empty" style={{ animationDelay: d1 }}>
            <MiniNeedle tilt={!cue.on("s2")} />
            <div className="gw-mark">?</div>
          </div>
          <div className="gw-note wipe-up" style={{ animationDelay: d2 }}>周围什么都没有，它还会摆回去吗</div>
        </div>
      )}
    </div>
  );
}
