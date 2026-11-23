// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useSafeCue } from "../../hooks/useSafeCue";
import { narrations } from "./narrations";
import type { ChapterStepProps } from "../../registry/types";
import "./Fog.css";

/**
 * 母题：南北基准线。四步同树常驻 —— 首步只从底部升起一小截、北字留空，
 * 此后补齐长度并在末步由暗转亮，位置始终不动。
 */
function Axis({ lit, north }: { lit: boolean; north: boolean }) {
  return (
    <svg className={"fg-axis" + (lit ? " fg-axis-lit" : "")} viewBox="0 0 220 900" aria-hidden="true">
      <line className={"fg-axis-line" + (north ? "" : " fg-axis-short")} x1="110" y1="60" x2="110" y2="840" />
      <text className={"fg-axis-label" + (north ? "" : " fg-axis-north-hide")} x="110" y="46" textAnchor="middle">北</text>
      <text className="fg-axis-label fg-axis-south" x="110" y="890" textAnchor="middle">南</text>
    </svg>
  );
}

function People() {
  return (
    <svg viewBox="0 0 420 200" aria-hidden="true">
      {[70, 200, 330].map((x) => (
        <g key={x} className="fg-person">
          <circle cx={x} cy="52" r="22" />
          <line x1={x} y1="78" x2={x} y2="150" />
          <line x1={x} y1="110" x2={x - 30} y2="140" />
          <line x1={x} y1="110" x2={x + 30} y2="140" />
          <line x1={x} y1="150" x2={x - 24} y2="190" />
          <line x1={x} y1="150" x2={x + 24} y2="190" />
        </g>
      ))}
    </svg>
  );
}

export default function Fog({ step }: ChapterStepProps) {
  const cue = useSafeCue(narrations[step] ?? "");
  const d1 = cue.delay("s1");
  const d2 = cue.delay("s2");
  const d3 = cue.delay("s3");

  return (
    <div className="fg-scene scene-pad">
      <Axis lit={step >= 3} north={step >= 1} />

      {step === 0 && (
        <div className="fg-body">
          <div className="fg-tag fg-rise" style={{ animationDelay: d1 }}>情境 · 浓雾</div>
          <svg className="fg-hills" viewBox="0 0 1200 400" aria-hidden="true">
            <path className="fg-hill" d="M0 400 L250 150 L470 400 Z" />
            <path className="fg-hill fg-hill-mid" d="M320 400 L690 80 L1080 400 Z" />
            <path className="fg-hill" d="M780 400 L1010 190 L1200 400 Z" />
            <rect className="fg-mist" x="-260" y="170" width="1720" height="230" style={{ animationDelay: d1 }} />
          </svg>
          <div className="fg-h fg-rise" style={{ animationDelay: d2 }}>
            哪边是<span className="hl-sweep fg-em" style={{ animationDelay: d3 }}>南</span>？
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="fg-body fg-pair">
          <div className={"fg-orb-wrap wipe-up" + (cue.on("s2") ? " focus-dim" : "")} style={{ animationDelay: d1 }}>
            <svg className="fg-orb" viewBox="0 0 200 200" aria-hidden="true">
              <circle className="fg-orb-shape" cx="100" cy="100" r="46" />
              {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
                <line key={a} className="fg-ray" x1="100" y1="30" x2="100" y2="12" transform={`rotate(${a} 100 100)`} />
              ))}
            </svg>
            <div className="fg-orb-name">看太阳</div>
            <div className="fg-strike" style={{ animationDelay: d1 }} />
          </div>
          <div className="fg-orb-wrap wipe-up" style={{ animationDelay: d2 }}>
            <svg className="fg-orb fg-punch" viewBox="0 0 200 200" aria-hidden="true" style={{ animationDelay: d2 }}>
              <path className="fg-orb-shape" d="M100 24 L120 80 L178 100 L120 120 L100 176 L80 120 L22 100 L80 80 Z" />
            </svg>
            <div className="fg-orb-name">看星星</div>
            <div className="fg-strike" style={{ animationDelay: d2 }} />
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="fg-body">
          <div className="fg-people fg-rise" style={{ animationDelay: d1 }}><People /></div>
          <div className="fg-ground" style={{ animationDelay: d2 }} />
          <div className="fg-halt fg-rise" style={{ animationDelay: d2 }}>队伍停下了</div>
        </div>
      )}

      {step === 3 && (
        <div className="fg-body fg-center">
          <div className="fg-hero blur-in" style={{ animationDelay: d1 }}>
            把<span className="fg-em">南</span>找出来
          </div>
          <div className="fg-rule" style={{ animationDelay: d2 }} />
        </div>
      )}
    </div>
  );
}
