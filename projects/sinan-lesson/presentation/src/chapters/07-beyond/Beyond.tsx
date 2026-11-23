// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useSafeCue } from "../../hooks/useSafeCue";
import { narrations } from "./narrations";
import type { ChapterStepProps } from "../../registry/types";
import "./Beyond.css";

function Compass() {
  return (
    <svg className="by-compass" viewBox="0 0 320 320" aria-hidden="true">
      <circle className="by-dial" cx="160" cy="160" r="140" />
      <text className="by-dir" x="160" y="52" textAnchor="middle">北</text>
      <text className="by-dir" x="160" y="292" textAnchor="middle">南</text>
      <path className="by-c-n" d="M160 42 L142 160 L160 172 L178 160 Z" />
      <path className="by-c-s" d="M160 278 L142 160 L160 148 L178 160 Z" />
      <circle className="by-pin" cx="160" cy="160" r="12" />
    </svg>
  );
}

const SCENES = ["航海", "行军", "测绘"];

export default function Beyond({ step }: ChapterStepProps) {
  const cue = useSafeCue(narrations[step] ?? "");
  const d1 = cue.delay("s1");
  const d2 = cue.delay("s2");
  const d3 = cue.delay("s3");
  const active = cue.on("s3") ? 2 : cue.on("s2") ? 1 : cue.on("s1") ? 0 : -1;

  // 母题：与第一章同形的竖直南北虚线。step4 从时间轴里长出来，step5 保持并补齐南北。
  const axisOn = step >= 3;
  const axisGrown = step === 4 || (step === 3 && cue.on("s1"));

  return (
    <div className="by-scene scene-pad">
      <div className={"by-axis" + (axisOn ? " by-axis-on" : "") + (step === 4 ? " by-axis-lit" : "")} aria-hidden="true">
        <span className="by-axis-n">北</span>
        <div className={"by-axis-line" + (axisGrown ? " by-axis-line-grown" : "")} />
        <span className="by-axis-s">南</span>
      </div>

      {step === 0 && (
        <div className="by-body by-center">
          <div className="by-question blur-in" style={{ animationDelay: d1 }}>
            地球里面，<span className="by-em hl-sweep" style={{ animationDelay: d2 }}>真有一块大磁铁</span>吗？
          </div>
          <div className="by-rule" style={{ animationDelay: d2 }} />
          <div className="by-note wipe-up" style={{ animationDelay: d2 }}>模型只是个假设</div>
        </div>
      )}

      {step === 1 && (
        <div className="by-body by-center">
          <div className="by-mark wipe-up" style={{ animationDelay: d1 }}>?</div>
          <div className="by-tag wipe-up" style={{ animationDelay: d2 }}>下一节课 · 真正的原因</div>
        </div>
      )}

      {step === 2 && (
        <div className="by-body by-split">
          <div className={"by-figure" + (cue.on("s3") ? " punch-in" : "")}><Compass /></div>
          <div className="by-scenes">
            {SCENES.map((s, i) => (
              <div key={s}
                className={"by-scene-tag wipe-up" + (active >= 0 && i !== active ? " focus-dim" : "")}
                style={{ animationDelay: [d1, d2, d3][i] }}>{s}</div>
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="by-body by-center by-timeline-step">
          <div className="by-timeline">
            {["天然磁石", "司南", "指南针"].map((t, i) => (
              <div key={t}
                className={"by-tick wipe-up" + (active >= 0 && i !== active ? " focus-dim" : "")}
                style={{ animationDelay: [d1, d2, d3][i] }}>
                <span className="by-tick-dot" /><span>{t}</span>
              </div>
            ))}
          </div>
          <div className="by-note wipe-up" style={{ animationDelay: d3 }}>刚才那几步，你也能自己再走一遍</div>
        </div>
      )}

      {step === 4 && (
        <div className="by-body by-split by-final">
          <div className="by-card wipe-up" style={{ animationDelay: d1 }}>
            <span className="by-card-kicker">带上你的猜想</span>
            <span className="by-card-text">写在记录表背面</span>
          </div>
          <div className="by-note wipe-up" style={{ animationDelay: d2 }}>带来接着验</div>
        </div>
      )}
    </div>
  );
}
