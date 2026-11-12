// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useQuery } from '@tanstack/react-query'
import { errorText, imApi, useNotifyChange, type Connector } from '../../../core/data'

/** 每次成功测试后同步一次；只取当前连接器最近三条消息，新的在前。 */
export function LatestMessage({ connector, testedAt }: { connector: Pick<Connector, 'id' | 'config'>; testedAt: number }) {
  const notify = useNotifyChange()
  const preview = useQuery({
    queryKey: ['connector-message-preview', connector.id, testedAt, 3],
    queryFn: async ({ signal }) => {
      if (!connector.config.webhook_url?.trim()) {
        try {
          await imApi.syncConnector(connector.id, signal)
        } finally {
          void notify({ kind: 'im-message' })
          void notify({ kind: 'connector' })
        }
      }
      return imApi.latest(connector.id, signal)
    },
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const messages = preview.data ?? []
  return (
    <section className="cn-group cn-message-preview" aria-label="最新消息" aria-busy={preview.isFetching}>
      <div className="cn-group-title">最近 3 条消息</div>
      <div aria-live="polite">
        {preview.isPending ? <div className="cn-faint">正在读取最新消息…</div>
          : preview.isError ? <div className="danger-text" role="alert">消息读取失败：{errorText(preview.error)}</div>
            : messages.length ? <div className="cn-message-table-wrap" tabIndex={0} role="region" aria-label="最新消息详情">
              <table className="cn-message-table" aria-label="最新消息">
                <colgroup><col className="cn-message-sender-col" /><col className="cn-message-time-col" /><col className="cn-message-chat-col" /><col /></colgroup>
                <thead><tr><th scope="col">发信人</th><th scope="col">时间</th><th scope="col">会话</th><th scope="col">消息内容</th></tr></thead>
                <tbody>{messages.map((message) => <tr key={message.id}>
                  <td>{message.sender_name || message.sender_id || '未知发信人'}</td>
                  <td><time dateTime={message.at}>{new Date(message.at).toLocaleString('zh-CN', { hour12: false })}</time></td>
                  <td>{message.conversation || (message.conversation_kind === 'direct'
                    ? `与 ${message.sender_name || message.sender_id || '未知发信人'} 的私聊`
                    : message.conversation_external_id || '未知会话')}</td>
                  <td>
                    <div className="cn-message-content">{message.text || (message.attachments.length ? '附件消息' : '无文本内容')}</div>
                    {message.attachments.length > 0 && <div className="cn-faint cn-message-attachments">附件：{message.attachments.map((a) => a.name || '未命名附件').join('、')}</div>}
                  </td>
                </tr>)}</tbody>
              </table>
            </div> : <div className="cn-faint">暂无消息。向这个 Bot 发一条消息后，再点「测试连接」。</div>}
      </div>
    </section>
  )
}
