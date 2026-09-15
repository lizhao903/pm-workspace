// 输入条上方的三个控件：模型、输出目录、会话。
import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui'
import FolderPicker from '../FolderPicker'
import { useWorkspace } from '../../hooks/workspace'
import type { UseAgentChat } from './useAgentChat'

export interface DockControlsProps {
  chat: UseAgentChat
  onCollapse: () => void
}

export default function DockControls({ chat, onCollapse }: DockControlsProps) {
  const { setNav } = useWorkspace()
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const {
    providers, providerId, setProvider,
    sessions, sessionId, openSession, removeSession,
    workdir, setWorkdir, workdirCheck, checkingWorkdir, checkWorkdir, recentDirs,
  } = chat

  const badDir = !!workdirCheck && !(workdirCheck.exists && workdirCheck.is_dir && workdirCheck.writable)
  const cur = sessions.find((s) => s.id === sessionId)

  // 选完还要再 check 一次——选择器只给得出真实存在且可写的目录，但它可能在「选」和「发」
  // 之间被删掉。checkWorkdir 闭包里读的是 workdir state，所以得等 state 真的变成新值再调；
  // 用 ref 记「等谁」，避免为此多起一轮渲染。
  const pending = useRef<string | null>(null)
  useEffect(() => {
    if (pending.current === null || pending.current !== workdir) return
    pending.current = null
    void checkWorkdir()
  }, [workdir, checkWorkdir])

  /** 选中或点最近使用：路径没变就直接确认，变了交给上面那个 effect。 */
  const pickDir = (p: string) => {
    if (p && p === workdir) { void checkWorkdir(); return }
    pending.current = p || null
    setWorkdir(p)
  }

  return (
    <div className="ag-head">
      <div className="ag-head-row">
        {/* 模型：选项来自已配置的供应商，默认那个排在最前 */}
        {providers.length ? (
          <select
            className="select ag-select"
            aria-label="模型"
            value={providerId}
            onChange={(e) => setProvider(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name} · {p.model}</option>
            ))}
          </select>
        ) : (
          <span className="ag-unconfigured">
            未配置模型 · 首次发送将自动接入本机 ollama
            <button
              type="button"
              className="ag-link"
              onClick={() => setNav({ kind: 'page', page: 'settings', section: 'agent' })}
            >
              去设置
            </button>
          </span>
        )}

        {/* 会话切换 */}
        <select
          className="select ag-select ag-select-session"
          aria-label="会话"
          value={sessionId ?? ''}
          onChange={(e) => openSession(e.target.value || null)}
        >
          <option value="">新对话</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || '未命名'}（{s.message_count} 条）
            </option>
          ))}
        </select>
        <Button small onClick={() => openSession(null)}>新对话</Button>
        <Button
          small
          variant="ghost"
          disabled={!sessionId}
          onClick={() => setConfirmDel(sessionId)}
        >
          删除
        </Button>

        <span className="ag-head-push" />
        <Button small variant="ghost" onClick={onCollapse} title="收起（Esc）">收起</Button>
      </div>

      {/* 输出目录：浏览器拿不到本地绝对路径，目录树由后端给，这里只负责挑。
          不再留手打入口，也就不需要「检查」按钮了——选择器给不出不存在的目录。 */}
      <div className="ag-head-row">
        <span className="ag-label">输出目录</span>
        <FolderPicker
          value={workdir}
          allowEmpty
          placeholder="不填则 Agent 不写文件"
          onChange={pickDir}
        />
        {checkingWorkdir ? <span className="ag-hint">检查中…</span> : null}
        {workdirCheck && !checkingWorkdir ? (
          <span className={badDir ? 'ag-dir-bad' : 'ag-dir-ok'}>
            {badDir
              ? (workdirCheck.message
                || (!workdirCheck.exists ? '目录不存在'
                  : !workdirCheck.is_dir ? '不是目录' : '不可写'))
              : '存在 · 是目录 · 可写'}
          </span>
        ) : null}
        {cur?.workdir && cur.workdir !== workdir ? (
          <span className="ag-hint">会话记录的目录：{cur.workdir}</span>
        ) : null}
      </div>

      {/* 有数据支持的只有「给明确文件名」这一条。这里不写任何比较级——
          不光是「比点名 write_file 更好使」那种明着的对比证不出来（点名工具照样能成，
          模型调不调 write_file 在同一输入上本身就有运行间方差），
          连「最容易成功」这种软比较也不要：它同样在暗示别的说法更差，
          会把用户从一种其实可能有效的表达上劝退。只陈述可行做法，不排他。
          只在目录可用时提示：没目录时说这个没意义。 */}
      {workdir.trim() && !badDir ? (
        <div className="ag-head-row ag-tip">
          让它写文件时，给个明确的文件名，比如「把刚才的内容写成 plan.md 保存下来」
        </div>
      ) : null}

      {recentDirs.length ? (
        <div className="ag-head-row ag-recent">
          <span className="ag-label">最近</span>
          {recentDirs.map((d) => (
            <button
              key={d}
              type="button"
              className="chip ag-chip"
              title={d}
              onClick={() => pickDir(d)}
            >
              {d}
            </button>
          ))}
        </div>
      ) : null}

      {confirmDel ? (
        <div className="ag-confirm" role="alertdialog" aria-label="删除会话">
          <span>删除这个会话？消息与产物记录一并移除，不可撤销。</span>
          <Button small onClick={() => setConfirmDel(null)}>取消</Button>
          <Button
            small
            variant="danger"
            onClick={() => { const id = confirmDel; setConfirmDel(null); void removeSession(id) }}
          >
            删除
          </Button>
        </div>
      ) : null}
    </div>
  )
}
