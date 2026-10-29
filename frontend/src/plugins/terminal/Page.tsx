// 终端页（TERM-01b，SPEC-terminal-1）：整页都是终端，没有顶栏；上面一排标签，下面是当前标签的格子，每个标签最多 2x2 四格。
// 每格一个后端 pty 会话。格子目录是项目原型目录时，格子头上能启停那个原型（经 core/data 调项目插件的接口）。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cls } from '../../core/ui'
import { errorText, useFsShortcuts, useProjects, useTerminalProtoAction, useTerminalPrototypes, type TerminalPrototype } from '../../core/data'
import {
  MAX_PANES, activeTab, layoutClass, protoForCwd, shortPath, tabName, type Pane, type TermTab,
} from './model'
import {
  activateTab, closePane, closeTab, focusTerminalPane, initTerminal, markStarted, newTerminalTab, renameTerminalTab, reopenPane,
  setPaneCwd, showNotice, splitPane, useTerminalState,
} from './store'
import { XTerm } from './XTerm'
import './terminal.css'

const svg = (w: number, children: ReactNode) => <svg viewBox="0 0 16 16" width={w} height={w} aria-hidden="true">{children}</svg>
const IconX = ({ size = 9 }: { size?: number }) => svg(size, <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />)
const IconPlus = () => svg(12, <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />)
const IconSplitRow = () => svg(12, <><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 3v10" stroke="currentColor" strokeWidth="1.4" /></>)
const IconSplitCol = () => svg(12, <><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2 8h12" stroke="currentColor" strokeWidth="1.4" /></>)
const IconPlay = () => svg(10, <path d="M5 3.5v9l7-4.5z" fill="currentColor" />)
const IconStop = () => svg(10, <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />)

export default function TerminalPage() {
  const { layout, ready, busy, notice } = useTerminalState()
  const projects = useProjects()
  const shortcuts = useFsShortcuts(true)
  const protos = useTerminalPrototypes()
  const protoAction = useTerminalProtoAction()
  const [renaming, setRenaming] = useState<string | null>(null)
  const cancelRename = useRef(false)

  const home = shortcuts.data?.find((s) => s.label === '主目录')?.path ?? ''
  // 新标签的目录：第一个有目录的项目，都没有用主目录（后端收到空串就是主目录）
  const defaultCwd = projects.data?.data.find((p) => p.workdir?.startsWith('/'))?.workdir ?? ''
  const projectsSettled = !projects.isPending

  useEffect(() => {
    if (projectsSettled) void initTerminal(defaultCwd)
  }, [projectsSettled, defaultCwd])

  const tab = activeTab(layout)
  const running = (p: Pane) => { const x = protoForCwd(protos.data, p.cwd); return x?.status === 'running' ? x : undefined }

  // 关格、关标签时停掉从这一格启动、还在跑的原型
  const stopStarted = (panes: Pane[]) => {
    for (const p of panes) {
      for (const id of p.started) {
        const x = protos.data?.find((y) => y.id === id)
        if (x && (x.status === 'running' || x.status === 'starting')) protoAction.mutate({ projectId: x.project_id, protoId: x.id, action: 'stop' })
      }
    }
  }
  const onCloseTab = (t: TermTab) => { stopStarted(t.panes); closeTab(t.id, defaultCwd) }
  const onClosePane = (p: Pane) => { stopStarted([p]); closePane(p.id, defaultCwd) }
  const onProto = (p: Pane, x: TerminalPrototype, action: 'start' | 'stop') => {
    protoAction.mutate({ projectId: x.project_id, protoId: x.id, action }, {
      onSuccess: () => markStarted(p.id, x.id, action === 'start'),
      onError: (e) => showNotice(`${action === 'start' ? '启动' : '停止'}「${x.name}」失败：${errorText(e)}`),
    })
  }
  const canSplit = !!tab && tab.panes.length < MAX_PANES && !busy

  return (
    <div className="term-page">
      <div className="term-tabs" role="tablist" aria-label="终端标签页">
        {layout.tabs.map((t) => {
          const on = t.id === tab?.id
          return (
            <div key={t.id} role="tab" aria-selected={on} className={cls('term-tab', on && 'on')} title="双击改名"
              onClick={() => activateTab(t.id)} onDoubleClick={() => setRenaming(t.id)}>
              {t.panes.some(running) && <span className="term-dot" aria-label="有原型在跑" />}
              {renaming === t.id ? (
                <input autoFocus className="term-tab-input" aria-label="标签名" defaultValue={tabName(t)} onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => { if (!cancelRename.current) renameTerminalTab(t.id, e.target.value); cancelRename.current = false; setRenaming(null) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') { cancelRename.current = true; e.currentTarget.blur() }
                  }} />
              ) : <span className="term-ellipsis">{tabName(t)}</span>}
              {t.panes.length > 1 && <span className="term-tab-n">{t.panes.length}</span>}
              <button type="button" className="term-tab-x" title="关闭标签页" aria-label="关闭标签页"
                onClick={(e) => { e.stopPropagation(); onCloseTab(t) }}>
                <IconX />
              </button>
            </div>
          )
        })}
        <button type="button" className="term-tab-add" title="新标签页" aria-label="新标签页" disabled={busy || !ready}
          onClick={() => void newTerminalTab(defaultCwd)}>
          <IconPlus />
        </button>
        {notice && <span className="term-notice" role="status">{notice}</span>}
      </div>
      {!ready && <div className="term-empty">正在连接终端…</div>}
      {/* 每个标签的格子都挂着，切走只是藏起来：输出、滚动位置和连接都留着 */}
      {layout.tabs.map((t) => (
        <div key={t.id} className={cls('term-grid', layoutClass(t))} hidden={t.id !== tab?.id}>
          {t.panes.map((p) => {
            const x = protoForCwd(protos.data, p.cwd)
            const live = x && (x.status === 'running' || x.status === 'starting')
            return (
              <div key={p.id} className={cls('term-pane', p.id === t.focus && 'focus')} onMouseDown={() => focusTerminalPane(p.id)}>
                <div className="term-pane-head">
                  <span className="term-cwd term-ellipsis" title={p.cwd}>{shortPath(p.cwd, home)}</span>
                  {x && live && (
                    <span className={cls('term-run', x.status === 'starting' && 'starting')}>
                      <span className="term-dot" />{x.name} :{x.port}
                    </span>
                  )}
                  {x && (
                    <button type="button" className="term-act term-proto-btn" disabled={protoAction.isPending}
                      title={live ? `停止「${x.project_title} / ${x.name}」` : `启动「${x.project_title} / ${x.name}」（${x.command}）`}
                      onClick={(e) => { e.stopPropagation(); onProto(p, x, live ? 'stop' : 'start') }}>
                      {live ? <><IconStop />停止原型</> : <><IconPlay />启动原型</>}
                    </button>
                  )}
                  <span className="term-spacer" />
                  <button type="button" className="term-btn" disabled={!canSplit || t.id !== tab?.id} title="向右拆分（⌘D）" aria-label="向右拆分"
                    onClick={(e) => { e.stopPropagation(); focusTerminalPane(p.id); void splitPane('row') }}>
                    <IconSplitRow />
                  </button>
                  <button type="button" className="term-btn" disabled={!canSplit || t.id !== tab?.id} title="向下拆分（⇧⌘D）" aria-label="向下拆分"
                    onClick={(e) => { e.stopPropagation(); focusTerminalPane(p.id); void splitPane('col') }}>
                    <IconSplitCol />
                  </button>
                  <button type="button" className="term-btn" title="关闭窗格" aria-label="关闭窗格"
                    onClick={(e) => { e.stopPropagation(); onClosePane(p) }}>
                    <IconX size={11} />
                  </button>
                </div>
                <XTerm key={p.session} session={p.session} active={t.id === tab?.id} focused={p.id === t.focus}
                  onFocus={() => focusTerminalPane(p.id)} onCwd={(cwd) => setPaneCwd(p.id, cwd)}
                  onSplit={(dir) => { if (canSplit) void splitPane(dir) }}
                  onReopen={(gone) => void reopenPane(p.id, !gone)} onClose={() => onClosePane(p)} />
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
