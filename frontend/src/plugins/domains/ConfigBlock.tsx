// 生成的配置（SPEC-settings-20.20、20.33）：解析、pf、代理三段，HTTPS 开着多一段证书；数据来自 GET /api/domains/config。
// 每段是要写进 path 的内容加要用户自己执行的命令，内容和命令分别可复制
import { useState } from 'react'
import { errorText, type DomainConfig, type DomainConfigSection, type DomainSettings } from '../../core/data'
import { Button, cls } from '../../core/ui'
import { PROXY_KIND, RESOLVE_MODE } from './model'
import { Commands } from './parts'

type Part = 'resolve' | 'pf' | 'proxy_config' | 'cert'

export function ConfigBlock({ s, query, copied, onCopy }: {
  s: DomainSettings
  query: { data?: DomainConfig; error: unknown; isError: boolean }
  copied: string | null
  onCopy: (key: string, text: string) => void
}) {
  const [want, setWant] = useState<Part>('resolve')
  const cfg = query.data
  const parts: [Part, string][] = [
    ['resolve', RESOLVE_MODE[s.resolve].label],
    ['pf', 'pf 转发'],
    ['proxy_config', PROXY_KIND[s.proxy].label],
    ...(cfg?.cert ? [['cert', '证书'] as [Part, string]] : []),
  ]
  // 证书段在 HTTPS 关掉后没了，退回解析段
  const part: Part = parts.some(([k]) => k === want) ? want : 'resolve'
  const sec: DomainConfigSection | null | undefined = cfg?.[part]
  const content = sec?.content ?? ''

  return (
    <section className={cls('dm-sec', !s.enabled && 'dm-off')} aria-label="生成的配置">
      <div className="dm-sec-head">
        <div className="dm-title">生成的配置<span className="dm-title-hint">内置代理会自动应用；用 Caddy、Nginx 或改 hosts 时复制过去</span></div>
        <div className="dm-seg" role="group" aria-label="配置段">
          {parts.map(([k, l]) => (
            <button key={k} type="button" className={cls(part === k && 'on')} aria-pressed={part === k} onClick={() => setWant(k)}>{l}</button>
          ))}
        </div>
        <Button size="sm" variant="outline" disabled={!content} onClick={() => onCopy('cfg', content)}>{copied === 'cfg' ? '已复制' : '复制'}</Button>
      </div>
      {query.isError && !cfg && <div className="dm-err" role="alert">生成失败：{errorText(query.error)}</div>}
      {!cfg && !query.isError && <div className="dm-empty">生成中…</div>}
      {sec && (
        <>
          {sec.path && <div className="dm-hint">写到 <span className="mono">{sec.path}</span></div>}
          {content ? <pre className="dm-pre dm-cfg" aria-label="配置内容">{content}</pre> : <div className="dm-empty">这一段不用写文件</div>}
          {sec.note && <div className="dm-hint">{sec.note}</div>}
          <Commands id={'cmd:' + part} commands={sec.commands} copied={copied} onCopy={onCopy} />
        </>
      )}
    </section>
  )
}
