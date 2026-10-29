// 会话模块（SPEC-sessions，AG-01a）：二级菜单 + 会话 / 产出结果。路由挂在 conversations/* 下：
// /conversations 会话（?s= 当前会话），/conversations/outputs 产出结果。
// 执行记录（SPEC-sessions-2）要等 Agent 配置和触发器（AG-01b）落地，后端还没有这类记录，这里先不放。
import { useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { Button, InSubnavHost, Subnav } from '../../core/ui'
import { ChatsView } from './ChatsView'
import { OutputsView } from './OutputsView'
import './conversations.css'

function IconPlus() {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
}

type View = 'chats' | 'outputs'
const SUBPATH: Record<View, string> = { chats: '', outputs: 'outputs' }

export default function Page() {
  const rest = useParams()['*'] ?? ''
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  // 二级菜单底部「新会话」点一次加一，会话页据此打开新会话面板
  const [pickRequest, setPickRequest] = useState(0)
  const view: View | null = rest === '' ? 'chats' : rest === 'outputs' ? 'outputs' : null
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

  return (
    <div className="conv-mod">
      <InSubnavHost>
        <Subnav<View> title="会话" active={view} onSelect={select} items={[
          { key: 'chats', label: '会话', desc: '和 Agent 的对话' },
          { key: 'outputs', label: '产出结果', desc: '写的文件、登记的链接' },
        ]}>
          <Button className="subnav-new" onClick={() => { if (view !== 'chats') select('chats'); setPickRequest((n) => n + 1) }}><IconPlus />新会话</Button>
        </Subnav>
      </InSubnavHost>
      {view === 'chats'
        ? <ChatsView current={current} onOpen={openSession} pickRequest={pickRequest} />
        : <OutputsView onOpenSession={(id) => navigate(`${root}?s=${encodeURIComponent(id)}`)} />}
    </div>
  )
}
