// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { CSSProperties, ReactNode } from "react";

interface Props {
  show: boolean;
  /** 毫秒数，或 cue.delay("x") 返回的 "3.42s"（跟口播走的时刻用提示点） */
  delay?: number | string;
  duration?: number;
  className?: string;
  children: ReactNode;
}

/**
 * clip-path text wipe. Pair with `.mask-reveal` and `.mask-reveal.in` from
 * animations.css. Use for any text that should appear (not fade).
 */
export function MaskReveal({
  show,
  delay = 0,
  duration,
  className,
  children,
}: Props) {
  const cls = ["mask-reveal", show ? "in" : "", className]
    .filter(Boolean)
    .join(" ");
  const style: CSSProperties = {
    display: "inline-block",
    animationDelay: show ? (typeof delay === "number" ? `${delay}ms` : delay) : "0ms",
    ...(duration ? { animationDuration: `${duration}ms` } : null),
  };
  return (
    <span className={cls} style={style}>
      {children}
    </span>
  );
}
