// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 消息抽屉里的链接（im 0.32.0，SPEC-messages-2.57）：「复制链接」复制这条消息在工作台里的深链，打开就回到这条消息；
// 原平台拼得出链接时给「在 Slack 打开」，新窗口打开原消息。
import { useEffect, useState } from 'react'
import type { ImMessage } from '../../core/data'
import { messageURL, permalinkLabel, permalinkOf } from './linkModel'

export function MessageLinks({ msg, chLabel }: { msg: ImMessage; chLabel: string }) {
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('')
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(''), 1500)
    return () => window.clearTimeout(t)
  }, [copied])
  const copy = () => {
    const url = messageURL(msg.id, window.location.origin)
    if (!navigator.clipboard) { setCopied('fail'); return }
    navigator.clipboard.writeText(url).then(() => setCopied('ok'), () => setCopied('fail'))
  }
  const permalink = permalinkOf(msg)
  return (
    <div className="im-act-row im-links">
      <button type="button" className="im-act im-act-quiet" onClick={copy} title="复制这条消息在工作台里的链接，打开就回到这条消息">
        {copied === 'ok' ? '已复制' : copied === 'fail' ? '没复制成功' : '复制链接'}
      </button>
      {permalink && (
        <a className="im-act im-act-quiet" href={permalink} target="_blank" rel="noreferrer" title={`在 ${chLabel} 里打开原消息`}>
          {permalinkLabel(chLabel)}
        </a>
      )}
    </div>
  )
}
