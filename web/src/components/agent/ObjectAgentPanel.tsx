// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 详情抽屉「AI 助手」页签里的对话面板：对象内的对话，和底部那个全局对话框各聊各的。
//
// 和 AgentDock 的唯一区别是它知道自己挂在哪个对象上，并把 object_id 一起发给后端——
// 用户在这个页签里说「这个需求怎么推进」，「这个」就有确定的指向，不必再报编号。
// object_id 同时决定了会话列表取哪一份：这里只列这个对象的会话，底部只列全局的。
//
// 注意它只传 id，不传正文：正文由模型自己调 get_object 现取。抽屉左边就是可编辑的正文，
// 用户随时可能改，把正文塞进请求里，模型手上那份在他按下发送的那一刻就已经是旧的了。
import { useCallback, useMemo, useRef, useState } from 'react'
import { Button } from '../ui'
import { useWorkspace } from '../../hooks/workspace'
import type { WorkObject } from '../../lib/types'
import { useEffectiveWorkdir } from '../taskrun/workdir'
import DockControls from './DockControls'
import MessageList from './MessageList'
import { useAgentChat } from './useAgentChat'

export interface ObjectAgentPanelProps {
  object: WorkObject
  /** 没设工作区时跳回详情 Tab 去设，和「执行」Tab 走的是同一个入口 */
  onGoDetail?: () => void
}

export default function ObjectAgentPanel({ object, onGoDetail }: ObjectAgentPanelProps) {
  const { reloadObjects, reloadCounts } = useWorkspace()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const onDataChanged = useCallback(() => {
    void reloadObjects()
    void reloadCounts()
  }, [reloadObjects, reloadCounts])

  // 产物落到哪：用对象自己的工作区，任务没设就继承所属项目的——和详情 Tab 的「工作区」
  // 字段、「执行」Tab 用的是同一个判断（useEffectiveWorkdir）。
  //
  // 这里不摆底部那个「输出目录」选择器，是因为摆了就有两个真相：详情 Tab 设了 A，
  // 这儿又选了 B，用户看着 A 却发现文件落在 B。工作区是对象的属性，不是这次对话的属性，
  // 所以这儿只显示、不给改，改在它本来该在的地方。
  const eff = useEffectiveWorkdir(object)
  // owner 里这两件事是同一句话的两半：这条对话挂在这个对象名下，所以会话记在它名下、
  // 产物也落到它的工作区。useMemo 只为稳住引用，hook 里读的是里面那两个字符串。
  const owner = useMemo(() => ({ objectId: object.id, workdir: eff.value }), [object.id, eff.value])
  const chat = useAgentChat(onDataChanged, object.id, owner)

  const submit = useCallback(() => {
    const text = draft
    if (!text.trim() || chat.streaming) return
    setDraft('')
    void chat.send(text)
  }, [draft, chat])

  const check = chat.workdirCheck
  const badDir = !!check && !(check.exists && check.is_dir && check.writable)

  return (
    <>
      <DockControls chat={chat} compact>
        <div className="ag-head-row ag-objdir">
          <span className="ag-label">工作区</span>
          {eff.value ? (
            <>
              <span className="mono truncate" title={eff.value}>{eff.value}</span>
              <span className="ag-hint">
                {eff.source === 'inherited'
                  ? `继承自项目${eff.fromProject ? `「${eff.fromProject}」` : ''}`
                  : '本对象专属'}
              </span>
            </>
          ) : (
            <span className="ag-hint">
              {eff.loading ? '读取项目工作区…' : '未设置，它写不了文件'}
              {!eff.loading && onGoDetail ? (
                <button type="button" className="ag-link" onClick={onGoDetail}>去详情 Tab 设置</button>
              ) : null}
            </span>
          )}
          {badDir ? (
            <span className="ag-dir-bad">
              {check.message
                || (!check.exists ? '目录不存在' : !check.is_dir ? '不是目录' : '不可写')}
            </span>
          ) : null}
        </div>
      </DockControls>

      <MessageList
        items={chat.items}
        streaming={chat.streaming}
        workdir={chat.workdir}
        onRetry={chat.retry}
        onPick={chat.pickOption}
        onSubmitAnswers={chat.submitAnswers}
        emptyTitle={`聊聊 ${object.ref}`}
        emptyHint="问它这件事该怎么推进，它会读完正文、关联对象和改动记录再给方案；拿不准的地方会回过头来问你。"
      />

      <div className="ag-compose">
        <textarea
          ref={inputRef}
          className="ag-input"
          rows={1}
          spellCheck={false}
          // 不写「问 AI…」这种泛泛的提示：这个页签挂在一条具体的对象上，
          // 提示语直接把最该问的那件事说出来，用户不必自己想开场白。
          placeholder="这件事该怎么推进？（Enter 发送，Shift+Enter 换行）"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {chat.streaming ? (
          <Button variant="danger" small onClick={chat.stop}>停止</Button>
        ) : (
          <Button variant="primary" small onClick={submit} disabled={!draft.trim()}>发送</Button>
        )}
      </div>
    </>
  )
}
