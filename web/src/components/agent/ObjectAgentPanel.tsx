// 详情抽屉「AI 助手」页签里的对话面板：对象内的对话，和底部那个全局对话框各聊各的。
//
// 和 AgentDock 的唯一区别是它知道自己挂在哪个对象上，并把 object_id 一起发给后端——
// 用户在这个页签里说「这个需求怎么推进」，「这个」就有确定的指向，不必再报编号。
//
// 注意它只传 id，不传正文：正文由模型自己调 get_object 现取。抽屉左边就是可编辑的正文，
// 用户随时可能改，把正文塞进请求里，模型手上那份在他按下发送的那一刻就已经是旧的了。
import { useCallback, useRef, useState } from 'react'
import { Button } from '../ui'
import { useWorkspace } from '../../hooks/workspace'
import type { WorkObject } from '../../lib/types'
import MessageList from './MessageList'
import { useAgentChat } from './useAgentChat'

export interface ObjectAgentPanelProps {
  object: WorkObject
}

export default function ObjectAgentPanel({ object }: ObjectAgentPanelProps) {
  const { reloadObjects, reloadCounts } = useWorkspace()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const onDataChanged = useCallback(() => {
    void reloadObjects()
    void reloadCounts()
  }, [reloadObjects, reloadCounts])

  const chat = useAgentChat(onDataChanged, object.id)

  const submit = useCallback(() => {
    const text = draft
    if (!text.trim() || chat.streaming) return
    setDraft('')
    void chat.send(text)
  }, [draft, chat])

  return (
    <>
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
