// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 会话模块（SPEC-sessions，AG-01a、AG-01b8）：没有二级菜单，进来就是会话页（左边会话清单，右边会话窗口）；
// 清单底部两个并排按钮去执行记录、产出结果，那两页标题上的「会话」点了回来。路由挂在 conversations/* 下：
// /conversations 会话（?s= 当前会话），/conversations/runs 执行记录（?run= 定位到一条），/conversations/outputs 产出结果。
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useAgentRunCounts } from '../../core/data'
import { ChatsView } from './ChatsView'
import { OutputsView } from './OutputsView'
import { RunsView } from './RunsView'
import './conversations.css'

type View = 'chats' | 'runs' | 'outputs'
const SUBPATH: Record<View, string> = { chats: '', runs: 'runs', outputs: 'outputs' }
const WAITING = ['waiting']

export default function Page() {
  const rest = useParams()['*'] ?? ''
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  // 会话清单底部「执行记录」按钮的红点：有等你确认的执行记录（SPEC-sessions-0.2）
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
  const openAgent = (id: string, tab?: string) => navigate(`/settings/agents/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ''}`)

  return (
    <div className="conv-mod">
      {view === 'chats' && (
        <ChatsView current={current} onOpen={openSession} onOpenAgent={openAgent}
          onOpenRuns={() => select('runs')} onOpenOutputs={() => select('outputs')} runsWaiting={waiting} />
      )}
      {view === 'runs' && (
        <RunsView focus={params.get('run')} onOpenSession={toSession} onBack={() => select('chats')}
          onFocused={() => { const next = new URLSearchParams(params); next.delete('run'); setParams(next, { replace: true }) }} />
      )}
      {view === 'outputs' && <OutputsView onOpenSession={toSession} onBack={() => select('chats')} />}
    </div>
  )
}
