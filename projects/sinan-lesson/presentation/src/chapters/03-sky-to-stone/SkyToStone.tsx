// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useSafeCue } from "../../hooks/useSafeCue";
import { narrations } from "./narrations";
import type { ChapterStepProps } from "../../registry/types";
import "./SkyToStone.css";

const DIPPER = [[60, 150], [150, 90], [250, 110], [330, 70], [410, 130], [500, 100], [570, 170]];

function Sun() {
  return (
    <svg className="ss-icon" viewBox="0 0 200 200" aria-hidden="true">
      <circle className="ss-sun" cx="100" cy="100" r="44" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line key={a} className="ss-ray" x1="100" y1="34" x2="100" y2="14" transform={`rotate(${a} 100 100)`} />
      ))}
    </svg>
  );
}

function Star() {
  return (
    <svg className="ss-icon" viewBox="0 0 200 200" aria-hidden="true">
      <path className="ss-star" d="M100 22 L120 80 L178 100 L120 120 L100 178 L80 120 L22 100 L80 80 Z" />
    </svg>
  );
}

function Needle({ className = "" }: { className?: string }) {
  return (
    <svg className={"ss-needle " + className} viewBox="0 0 120 320" aria-hidden="true">
      <path className="ss-n" d="M60 10 L40 140 L60 155 L80 140 Z" />
      <path className="ss-s" d="M60 310 L40 180 L60 165 L80 180 Z" />
      <circle className="ss-pivot" cx="60" cy="160" r="12" />
      <text className="ss-pole" x="60" y="46" textAnchor="middle">N</text>
      <text className="ss-pole" x="60" y="294" textAnchor="middle">S</text>
    </svg>
  );
}

export default function SkyToStone({ step }: ChapterStepProps) {
  const cue = useSafeCue(narrations[step] ?? "");
  const d1 = cue.delay("s1");
  const d2 = cue.delay("s2");
  const d3 = cue.delay("s3");

  // 太阳与星星是同一组常驻节点：step0 亮起、step1 夜格连线自绘、step2 被雾压住并逐个划掉、step3 起收拢让位。
  return (
    <div className="ss-scene scene-pad">
      <div className="ss-axis" aria-hidden="true" />

      <div className={"ss-artifacts" + (step >= 3 ? " ss-artifacts-away fade-out" : "") + (step === 2 ? " focus-dim" : "")}>
        <div className={"ss-cell ss-cell-day" + (step === 0 && cue.on("s1") ? " ss-cell-lit" : "")}>
          <Sun /><span>白天 · 看太阳</span>
        </div>
        <div className={"ss-cell ss-cell-night" + (step === 0 && cue.on("s2") ? " ss-cell-lit" : "")}>
          <Star />
          {step === 1 && (
            <svg className="ss-dipper" viewBox="0 0 620 240" aria-hidden="true">
              <polyline className="ss-dipper-line" points={DIPPER.map((p) => p.join(",")).join(" ")}
                style={{ animationDelay: d1 }} />
              {DIPPER.map(([x, y], i) => (
                <circle key={i} className="ss-dipper-dot" cx={x} cy={y} r="10"
                  style={{ animationDelay: cue.delay("s1", i * 0.08) }} />
              ))}
            </svg>
          )}
          <span>{step >= 1 ? "夜里 · 找北斗" : "夜里 · 看星星"}</span>
        </div>
      </div>

      {step === 0 && (
        <div className="ss-body ss-caption">
          <div className="ss-kicker wipe-up" style={{ animationDelay: d1 }}>答案里给的办法</div>
        </div>
      )}

      {step === 1 && (
        <div className="ss-body ss-caption">
          <div className="ss-kicker wipe-up" style={{ animationDelay: d1 }}>白天看太阳，夜里找北斗</div>
          <div className="ss-note">晴天<span className="hl-sweep" style={{ animationDelay: d2 }}>都够用</span></div>
        </div>
      )}

      {step === 2 && (
        <div className="ss-body">
          <div className="ss-fog" style={{ animationDelay: d1 }} />
          <div className="ss-fail">
            {["看太阳", "看星星", "找北斗"].map((t, i) => (
              <div key={t} className="ss-fail-item wipe-up" style={{ animationDelay: [d1, d2, d3][i] }}>
                {t}<span className="ss-fail-strike" style={{ animationDelay: [d1, d2, d3][i] }} />
              </div>
            ))}
          </div>
          <div className="ss-note wipe-up" style={{ animationDelay: d3 }}>浓雾把天全糊住了</div>
        </div>
      )}

      {step === 3 && (
        <div className="ss-body ss-stone">
          <svg className="ss-stone-svg wipe-up" style={{ animationDelay: d1 }} viewBox="0 0 600 380" aria-hidden="true">
            <path className="ss-rock" d="M180 300 L160 170 L250 90 L400 110 L470 210 L430 310 Z" />
            {[[70, 120], [90, 250], [510, 90], [540, 260]].map(([x, y], i) => (
              <rect key={i} className="ss-iron" x={x} y={y} width="34" height="12" rx="4"
                style={{ animationDelay: i < 2 ? d1 : d2 }} />
            ))}
          </svg>
          <div className="ss-note wipe-up" style={{ animationDelay: d2 }}>天然磁石 · 吸铁，也能指南北</div>
        </div>
      )}

      {step === 4 && (
        <div className="ss-body ss-two">
          <div className="ss-cell ss-rise" style={{ animationDelay: d1 }}><Needle /><span>磨成磁针</span></div>
          <div className="ss-cell ss-rise" style={{ animationDelay: d2 }}>
            <svg className="ss-spoon" viewBox="0 0 320 220" aria-hidden="true">
              <ellipse className="ss-spoon-bowl" cx="130" cy="110" rx="100" ry="66" />
              <path className="ss-spoon-handle" d="M220 100 L300 86 L300 134 L220 120 Z" />
            </svg>
            <span>做成勺形司南</span>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="ss-body ss-paths">
          <svg className="ss-fork" viewBox="0 0 900 400" aria-hidden="true">
            <path className="ss-fork-line" d="M40 200 L340 200 L560 80" />
            <path className="ss-fork-line" d="M340 200 L560 320" />
            <circle className="ss-fork-dot" cx="340" cy="200" r="14" />
          </svg>
          <div className={"ss-path ss-path-old wipe-up" + (cue.on("s2") ? " focus-dim" : "")} style={{ animationDelay: d1 }}>看天</div>
          <div className={"ss-path ss-path-new wipe-up" + (cue.on("s2") ? " ss-path-lit" : "")} style={{ animationDelay: d2 }}>磁石 · 另一条路</div>
        </div>
      )}
    </div>
  );
}
