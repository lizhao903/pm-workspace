// 会话模块（SPEC-sessions，AG-01a、AG-01b8）：二级菜单 + 会话 / 执行记录 / 产出结果。路由挂在 conversations/* 下：
// /conversations 会话（?s= 当前会话），/conversations/runs 执行记录（?run= 定位到一条），/conversations/outputs 产出结果。
import { useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useAgentRunCounts } from '../../core/data'
import { Button, InSubnavHost, Subnav } from '../../core/ui'
import { ChatsView } from './ChatsView'
import { OutputsView } from './OutputsView'
import { RunsView } from './RunsView'
import './conversations.css'

function IconPlus() {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
}

type View = 'chats' | 'runs' | 'outputs'
const SUBPATH: Record<View, string> = { chats: '', runs: 'runs', outputs: 'outputs' }
const WAITING = ['waiting']

export default function Page() {
  const rest = useParams()['*'] ?? ''
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  // 二级菜单底部「新会话」点一次加一，会话页据此打开新会话面板
  const [pickRequest, setPickRequest] = useState(0)
  // 二级菜单「执行记录」的红点：有等你确认的执行记录（SPEC-sessions-0.2）
  const waiting = useAgentRunCounts(WAITING).waiting ?? 0
  const view: View | null = rest === '' ? 'chats' : rest === 'runs' ? 'runs' : rest === 'outputs' ? 'outputs' : null
  // 模块根路径：去掉子路径，模块以后挂到别的路径下也不用改
  const root = pathname.slice(0, pathname.length - rest.length).replace(/\/+$/, '')
  if (view === null) return <Navigate to={root} replace />

  const current = params.get('s')
  const openSession = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('s', id)
    else next.delete('s')
    setParams(next, { replace: true })
  }
  const select = (v: View) => navigate(SUBPATH[v] ? `${root}/${SUBPATH[v]}` : root)
  const toSession = (id: string) => navigate(`${root}?s=${encodeURIComponent(id)}`)
  const openAgent = (id: string) => navigate(`/settings/agents/${encodeURIComponent(id)}`)

  return (
    <div className="conv-mod">
      <InSubnavHost>
        <Subnav<View> title="会话" active={view} onSelect={select} items={[
          { key: 'chats', label: '会话', desc: '和 Agent 的对话' },
          { key: 'runs', label: '执行记录', desc: '被触发后的每一次执行', alert: waiting || undefined },
          { key: 'outputs', label: '产出结果', desc: '建的任务、写的文档、发的回复' },
        ]}>
          <Button className="subnav-new" onClick={() => { if (view !== 'chats') select('chats'); setPickRequest((n) => n + 1) }}><IconPlus />新会话</Button>
        </Subnav>
      </InSubnavHost>
      {view === 'chats' && <ChatsView current={current} onOpen={openSession} onOpenAgent={openAgent} pickRequest={pickRequest} />}
      {view === 'runs' && (
        <RunsView focus={params.get('run')} onOpenSession={toSession}
          onFocused={() => { const next = new URLSearchParams(params); next.delete('run'); setParams(next, { replace: true }) }} />
      )}
      {view === 'outputs' && <OutputsView onOpenSession={toSession} />}
    </div>
  )
}
