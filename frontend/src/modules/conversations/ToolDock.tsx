// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 会话旁边的工具（SPEC-sessions-1.34 到 1.38）：会话头部右上角的「终端」「浏览器」入口，点了在对话右边展开插件给的面板。
// 入口和面板都来自插件登记（core/plugin 的 sessionTools），插件停用了入口就没有。面板打开过就一直挂着，收起、切到另一个工具只是藏起来，
// 终端的输出和网页都留着；离开会话页才卸载（终端会话、浏览器标签在插件那边，回来还在）。
import { Component, Suspense, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import type { PluginSessionTool } from '../../core/plugin'
import { Button, ErrorState, IconButton, IconClose, LoadingState, cls } from '../../core/ui'
import type { DockState } from './dockModel'

class Boundary extends Component<{ what: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`${this.props.what}渲染出错`, error)
  }

  render() {
    if (this.state.error) return <ErrorState compact title={`${this.props.what}出错了`} error={this.state.error} />
    return this.props.children
  }
}

/** 会话头部右上角的入口；插件都停用了就什么都不放 */
export function ToolButtons({ tools, dock, workdir, links, onToggle }: {
  tools: readonly PluginSessionTool[]
  dock: DockState
  workdir: string
  links: readonly string[]
  onToggle: (key: string) => void
}) {
  if (!tools.length) return null
  return (
    <span className="chat-tools">
      {tools.map((t) => {
        const on = dock.open === t.key
        const Icon = t.icon
        return (
          <Button key={t.key} size="sm" variant="outline" className={cls('chat-tool-btn', on && 'on')} aria-pressed={on}
            title={on ? `收起${t.label}` : t.hint?.({ workdir, links }) ?? `在对话旁边打开${t.label}`} onClick={() => onToggle(t.key)}>
            <Icon /><span className="chat-tool-label">{t.label}</span>
          </Button>
        )
      })}
    </span>
  )
}

type DockProps = {
  tools: readonly PluginSessionTool[]
  dock: DockState
  sessionId: string
  workdir: string
  links: readonly string[]
  onSwitch: (key: string) => void
  onCollapse: () => void
}

/** 对话右边的面板：头部切换、整页打开、收起；下面是各插件的面板。一个都没打开过时什么都不放 */
export function ToolDock(p: DockProps) {
  const live = p.tools.filter((t) => p.dock.mounted.includes(t.key))
  return live.length ? <DockFrame {...p} live={live} /> : null
}

function DockFrame({ tools, dock, sessionId, workdir, links, onSwitch, onCollapse, live }: DockProps & { live: PluginSessionTool[] }) {
  const navigate = useNavigate()
  const cur = tools.find((t) => t.key === dock.open)
  return (
    <section className="chat-dock" hidden={!cur} aria-label={cur ? `会话旁边的${cur.label}` : undefined}>
      <div className="chat-dock-head">
        <div className="chat-dock-seg" role="tablist" aria-label="会话旁边的工具">
          {tools.map((t) => {
            const Icon = t.icon
            return (
              <button key={t.key} type="button" role="tab" aria-selected={t.key === dock.open} className={cls(t.key === dock.open && 'on')}
                onClick={() => onSwitch(t.key)}>
                <Icon />{t.label}
              </button>
            )
          })}
        </div>
        <span className="spacer" />
        {cur?.page && (
          <Button size="sm" title={`去一级菜单「${cur.label}」整页看，标签和这里是同一套`} onClick={() => navigate(cur.page!)}>整页打开</Button>
        )}
        <IconButton size="sm" label="收起（终端和网页都留着）" onClick={onCollapse}><IconClose /></IconButton>
      </div>
      <div className="chat-dock-body">
        {live.map((t) => {
          const Panel = t.panel
          const hidden = t.key !== dock.open
          return (
            <div key={t.key} className="chat-dock-pane" hidden={hidden} data-tool={t.key}>
              <Boundary what={`「${t.label}」面板`}>
                <Suspense fallback={<LoadingState />}>
                  <Panel sessionId={sessionId} workdir={workdir} links={links} request={dock.req[t.key] ?? 0} hidden={hidden} />
                </Suspense>
              </Boundary>
            </div>
          )
        })}
      </div>
    </section>
  )
}
