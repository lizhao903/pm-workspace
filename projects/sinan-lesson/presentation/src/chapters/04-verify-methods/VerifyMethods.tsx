// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useSafeCue } from "../../hooks/useSafeCue";
import { narrations } from "./narrations";
import type { ChapterStepProps } from "../../registry/types";
import "./VerifyMethods.css";

/** 竖放的条形磁铁：N 极在上（北）、S 极在下（南），与全片南北基准线同向。 */
function Bar({ small = false }: { small?: boolean }) {
  return (
    <svg className={small ? "vm-bar vm-bar-small" : "vm-bar"} viewBox="0 0 90 320" aria-hidden="true">
      <rect className="vm-n" x="10" y="4" width="70" height="156" rx="8" />
      <rect className="vm-s" x="10" y="160" width="70" height="156" rx="8" />
      <text className="vm-pole" x="45" y="96" textAnchor="middle">N</text>
      <text className="vm-pole" x="45" y="272" textAnchor="middle">S</text>
      <circle className="vm-pin" cx="45" cy="160" r="10" />
    </svg>
  );
}

const ROWS = [
  ["平放", "南北", "第 1 次"],
  ["悬挂法", "南北", "第 2 次"],
  ["水浮法", "南北", "第 3 次"],
  ["换人再试", "还是南北", "第 4 次"],
];

export default function VerifyMethods({ step }: ChapterStepProps) {
  const cue = useSafeCue(narrations[step] ?? "");
  const d1 = cue.delay("s1");
  const d2 = cue.delay("s2");
  const d3 = cue.delay("s3");
  const d4 = cue.delay("s4");
  const straight = step >= 2 || cue.on("s2");

  // 同一枚磁铁 step1 至 step3 不卸载：只旋转、复制，step4 起收拢让位给装置图。
  return (
    <div className="vm-scene scene-pad">
      <div className="vm-axis" aria-hidden="true"><span>北</span><span>南</span></div>

      <div className={"vm-magnet" + (step >= 3 ? " vm-magnet-away" : "")}>
        <div className={"vm-holder" + (straight ? " vm-straight" : " vm-tilt")}>
          <Bar />
          {step === 2 && <span className="vm-trial-label" style={{ animationDelay: d1 }}>第 1 次</span>}
        </div>
        {step === 2 && (
          <div className="vm-copies">
            {[0, 1].map((i) => (
              <div key={i} className="vm-copy wipe-up" style={{ animationDelay: [d2, d3][i] }}>
                <Bar small /><span>第 {i + 2} 次</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {step === 0 && (
        <div className="vm-body">
          <div className="vm-note wipe-up" style={{ animationDelay: d1 }}>条形磁铁 · 放平</div>
        </div>
      )}

      {step === 1 && (
        <div className="vm-body">
          <div className="vm-note wipe-up" style={{ animationDelay: d2 }}>停下来，两头总对着南北</div>
        </div>
      )}

      {step === 2 && (
        <div className="vm-body">
          <div className="vm-note">换地方、换人，<span className="hl-sweep" style={{ animationDelay: d3 }}>结果一样</span></div>
        </div>
      )}

      {step === 3 && (
        <div className="vm-body vm-device">
          <svg className="vm-hang" viewBox="0 0 600 460" aria-hidden="true">
            <line className="vm-rig vm-draw" x1="80" y1="40" x2="520" y2="40" style={{ animationDelay: d1 }} />
            <line className="vm-rig vm-draw" x1="300" y1="40" x2="300" y2="220" style={{ animationDelay: d1 }} />
            <line className="vm-rig vm-draw" x1="300" y1="220" x2="300" y2="240" style={{ animationDelay: d2 }} />
            <rect className="vm-fade vm-n" x="265" y="240" width="70" height="80" rx="8" style={{ animationDelay: d2 }} />
            <rect className="vm-fade vm-s" x="265" y="320" width="70" height="80" rx="8" style={{ animationDelay: d2 }} />
          </svg>
          <div className="vm-label wipe-up" style={{ animationDelay: d2 }}>悬挂法 · 细线吊起</div>
        </div>
      )}

      {step === 4 && (
        <div className="vm-body vm-device">
          <svg className="vm-float" viewBox="0 0 700 400" aria-hidden="true">
            <rect className="vm-fade vm-water" x="40" y="180" width="620" height="180" rx="12" style={{ animationDelay: d1 }} />
            <path className="vm-wave vm-draw" d="M40 200 Q120 186 200 200 T360 200 T520 200 T660 200" style={{ animationDelay: d2 }} />
            <rect className="vm-fade vm-raft" x="270" y="238" width="160" height="26" rx="8" style={{ animationDelay: d2 }} />
            <rect className="vm-fade vm-n" x="325" y="170" width="50" height="34" rx="6" style={{ animationDelay: d2 }} />
            <rect className="vm-fade vm-s" x="325" y="204" width="50" height="34" rx="6" style={{ animationDelay: d2 }} />
          </svg>
          <div className="vm-label wipe-up" style={{ animationDelay: d2 }}>水浮法 · 浮在水面</div>
        </div>
      )}

      {step === 5 && (
        <div className="vm-body">
          <div className="vm-notes">
            {[1, 2, 3].map((i) => (
              <div key={i} className="vm-placeholder wipe-up" style={{ animationDelay: [d1, d2, d3][i - 1] }}>
                学生动手 · 第 {i} 组
              </div>
            ))}
          </div>
          <div className="vm-note wipe-up" style={{ animationDelay: d3 }}>一种方法一种方法地试</div>
        </div>
      )}

      {step === 6 && (
        <div className="vm-body">
          <div className="vm-sheet">
            <div className="vm-tr vm-th"><span>方法</span><span>停下的朝向</span><span>次数</span></div>
            {ROWS.map((r, i) => (
              <div key={r[0]} className="vm-tr wipe-up" style={{ animationDelay: [d1, d2, d3, d4][i] }}>
                <span>{r[0]}</span><span>{r[1]}</span><span>{r[2]}</span>
              </div>
            ))}
          </div>
          <div className="vm-note wipe-up" style={{ animationDelay: d4 }}>每次都记进表里</div>
        </div>
      )}
    </div>
  );
}
