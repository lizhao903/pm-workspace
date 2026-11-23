// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useSafeCue } from "../../hooks/useSafeCue";
import { narrations } from "./narrations";
import type { ChapterStepProps } from "../../registry/types";
import "./AskAi.css";

export default function AskAi({ step }: ChapterStepProps) {
  const cue = useSafeCue(narrations[step] ?? "");
  const d1 = cue.delay("s1");
  const d2 = cue.delay("s2");
  const d3 = cue.delay("s3");
  const picked = cue.on("s2");

  // 同一个提问框节点跨四步存活：空框、写满、缩成短问句、收成对照表最后一行。
  const boxClass =
    step === 0 ? " aa-box-empty" :
    step === 1 ? " aa-box-filled" :
    step === 2 ? " aa-box-short" :
    " aa-box-row" + (picked ? " aa-pick" : "");

  return (
    <div className="aa-scene scene-pad">
      <div className="aa-axis" aria-hidden="true"><span>北</span><span>南</span></div>

      <div className={"aa-stage" + (step === 3 ? " aa-stage-rows" : "")}>
        <div className={"aa-box" + boxClass}>
          {step === 0 && <span className="aa-caret" />}
          {step === 1 && (
            <>
              <span className="aa-word mask-reveal in" style={{ animationDelay: d1 }}>古代行军，</span>
              <span className="aa-word mask-reveal in" style={{ animationDelay: d2 }}>在大雾里怎么辨别方向？</span>
            </>
          )}
          {step === 2 && <span>怎么办？</span>}
          {step === 3 && (
            <>
              <span className="hl-sweep" style={{ animationDelay: d2 }}>古代行军，在大雾里怎么辨别方向</span>
              <span className="aa-check" />
            </>
          )}
        </div>

        {step === 0 && (
          <>
            <div className="aa-kicker">把问题说清楚</div>
            <div className="aa-note wipe-up" style={{ animationDelay: d2 }}>先别急着猜，再去问人工智能</div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="aa-kicker">一句完整的提问</div>
            <div className="aa-chips">
              {["时间 · 古代", "地点 · 行军途中", "条件 · 大雾"].map((t, i) => (
                <span key={t} className="aa-chip wipe-up" style={{ animationDelay: [d1, d2, d3][i] }}>{t}</span>
              ))}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="aa-kicker">只问一半</div>
            <div className="aa-answer" style={{ animationDelay: d2 }}>
              可以试试多看、多想、多问
              <span className="aa-answer-tail" />
            </div>
            <div className="aa-note wipe-up" style={{ animationDelay: d2 }}>这句回答，拿不来用</div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="aa-kicker">三种问法</div>
            <div className={"aa-row wipe-up" + (picked ? " focus-dim" : "")} style={{ animationDelay: d1 }}>怎么办</div>
            <div className={"aa-row wipe-up" + (picked ? " focus-dim" : "")} style={{ animationDelay: d1 }}>怎么看方向</div>
          </>
        )}
      </div>
    </div>
  );
}
