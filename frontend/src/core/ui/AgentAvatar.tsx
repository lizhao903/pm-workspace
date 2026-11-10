// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Agent 头像（照原型 web-next/src/agents.tsx AgentAvatar）：上传的图片 / 内置图标 / 文字，底色是 Agent 的 color。
// 会话页和外壳的快速新建共用；设置页的头像编辑器另有一份（AG-01b5）。
import type { ReactNode } from 'react'
import './agentAvatar.css'

const ICON_PATH: Record<string, ReactNode> = {
  robot: <><rect x="3" y="5" width="10" height="8" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 2.5V5M6 9h.01M10 9h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></>,
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  doc: <><path d="M4 1.8h5.5L12.5 5v9.2H4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M6 8h4.5M6 10.5h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
  chart: <path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  flow: <><rect x="1.8" y="2.5" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="9.8" y="9.9" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.2 4.3h2a1.6 1.6 0 0 1 1.6 1.6v4" fill="none" stroke="currentColor" strokeWidth="1.4" /></>,
  search: <><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  mail: <><rect x="2" y="3.5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m2.5 4.5 5.5 4 5.5-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></>,
  calendar: <><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
  shield: <path d="M8 1.8 13 3.8v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  spark: <path d="M8 2 9.4 6.6 14 8 9.4 9.4 8 14 6.6 9.4 2 8 6.6 6.6Z" fill="currentColor" />,
}

export type AgentAvatarSource = { name: string; color: string; avatar?: { kind: string; value: string } }

export function AgentAvatar({ agent, size = 28 }: { agent: AgentAvatarSource; size?: number }) {
  const av = agent.avatar
  if (av?.kind === 'image' && av.value) return <img className="agent-av agent-av-img" src={av.value} alt="" style={{ width: size, height: size }} />
  return (
    <span className="agent-av" aria-hidden="true" style={{ width: size, height: size, background: agent.color || 'var(--faint)', fontSize: size * 0.42 }}>
      {av?.kind === 'icon' && ICON_PATH[av.value]
        ? <svg viewBox="0 0 16 16" width={size * 0.56} height={size * 0.56}>{ICON_PATH[av.value]}</svg>
        : (av?.kind === 'text' && av.value) || (agent.name.trim() || 'A').slice(0, 1)}
    </span>
  )
}
