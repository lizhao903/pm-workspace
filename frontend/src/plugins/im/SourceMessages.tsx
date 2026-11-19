// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务详情里的「来源消息」（im 0.32.0，SPEC-tasks-4.84）：经 core/plugin 的对象区块登记，摆在基础信息标签末尾。
// 列出建出这条任务的 IM 消息（转任务、SOP 流程建的、会话里拆出来的），按发送时间正序：发信人、会话、时间、正文摘要。
// 点一行去消息页打开这条消息的抽屉（回到原消息）；原平台拼得出链接时另给「在 Slack 打开」。
// 没有来源消息、IM 插件没装或停用（接口 404）、还在加载时整块不显示。
import { useNavigate } from 'react-router'
import { useImTaskMessages } from '../../core/data/im'
import type { ObjectSectionProps } from '../../core/plugin'
import { channelOf, channelTable, shortTime, whoName } from './model'
import { digest, messagePath, permalinkLabel, permalinkOf } from './linkModel'
import './sourceMessages.css'

const channels = channelTable(undefined)

export default function SourceMessages({ object }: ObjectSectionProps) {
  const navigate = useNavigate()
  const q = useImTaskMessages(object.id)
  const rows = q.data ?? []
  if (!rows.length) return null
  return (
    <section className="imsrc" aria-label="来源消息" data-section="source-messages">
      <div className="imsrc-head">
        <span className="imsrc-title">来源消息</span>
        <span className="imsrc-hint">这条任务是从这些 IM 消息建的，点开回到原消息</span>
      </div>
      {rows.map((m) => {
        const ch = channelOf(channels, m.channel)
        const permalink = permalinkOf(m)
        return (
          <div key={m.id} className="imsrc-row">
            <button type="button" className="imsrc-open" onClick={() => navigate(messagePath(m.id))} title="打开这条消息">
              <span className="imsrc-meta">
                <b>{whoName(m) || m.sender_id}</b>
                <span>{m.conversation || '私聊'}</span>
                <span>{ch.label}</span>
                <time dateTime={m.at}>{shortTime(m.at)}</time>
              </span>
              <span className="imsrc-text">{digest(m.text) || '（没有正文）'}</span>
            </button>
            {permalink && (
              <a className="imsrc-link" href={permalink} target="_blank" rel="noreferrer" title={`在 ${ch.label} 里打开原消息`}>
                {permalinkLabel(ch.label)}
              </a>
            )}
          </div>
        )
      })}
    </section>
  )
}
