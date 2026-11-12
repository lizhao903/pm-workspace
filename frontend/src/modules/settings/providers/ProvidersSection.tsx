// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置里的「模型服务商」分节（MP-01b），照原型 web-next/src/models.tsx ProvidersPage（SPEC-settings-6）。
// 已接入的一组卡片，下面按分组列目录里的服务商，点「接入」开新建抽屉；同一类型可以接多个。
// 连接状态后端不存：卡片上是这次打开页面以来最近一次测试的结论，没测过写「未测试」。
import { useState } from 'react'
import { QueryState, useAgentProviders, useProviderChecks, useTestProvider, type AgentProvider } from '../../../core/data'
import { cls, PageTitle, Pill, Tag } from '../../../core/ui'
import { kindOf, PROVIDER_GROUPS, PROVIDER_KINDS, uiKindOf } from './catalog'
import { STATUS, statusOf, timeAgo } from './model'
import { ProviderDrawer } from './ProviderDrawer'
import { ProviderLogo } from './ProviderLogo'
import './providers.css'

// 新建成功后换成编辑同一条，slot 沿用新建时的 key，抽屉不重新挂载（不再滑入一次）
type Open = { mode: 'new'; kind: string } | { mode: 'edit'; id: string; slot?: string }

export function ProvidersSection() {
  const q = useAgentProviders()
  const list = q.data ?? []
  const checks = useProviderChecks(list)
  const test = useTestProvider()
  const [open, setOpen] = useState<Open | null>(null)

  const editing = open?.mode === 'edit' ? list.find((p) => p.id === open.id) : undefined
  const testingId = test.isPending ? test.variables : undefined
  // 抽屉里显示的测试请求错误只认这一条的
  const testError = editing && test.isError && test.variables === editing.id ? test.error : undefined

  const card = (p: AgentProvider) => {
    const k = uiKindOf(p)
    const check = checks[p.id]
    const st = statusOf(p, check)
    return (
      <button key={p.id} type="button" className={cls('pv-card', editing?.id === p.id && 'sel')} data-provider={p.id}
        onClick={() => setOpen({ mode: 'edit', id: p.id })}>
        <ProviderLogo kind={k} />
        <span className="pv-text">
          <span className="pv-name" title={p.name}>{p.name}{p.is_default && <Tag>默认</Tag>}</span>
          <span className={cls('pv-hint', st === 'error' && 'danger-text')}>
            {st === 'error' ? '连接异常，点开看原因' : `${kindOf(k).label} · ${p.model ? `默认模型 ${p.model}` : '还没选默认模型'}`}
          </span>
        </span>
        <span className="pv-st">
          <Pill label={testingId === p.id ? '测试中' : STATUS[st].label} color={STATUS[st].color} />
          {check && <span className="pv-hint">{timeAgo(check.at)}检查</span>}
        </span>
      </button>
    )
  }

  return (
    <div className="page pv-page">
      <PageTitle parent="设置" count={q.data ? `${list.length} 个已接入` : undefined}
        desc="配好 API Key 和地址、测通之后，选一个默认模型，Agent 和会话就能用">模型服务商</PageTitle>
      <QueryState query={q}>
        {() => (
          <>
            <section aria-label="已接入">
              <div className="pv-section-label">已接入</div>
              {list.length ? <div className="pv-grid">{list.map(card)}</div>
                : <div className="pv-empty">还没接模型服务商，从下面挑一家接入</div>}
            </section>
            {PROVIDER_GROUPS.map((g) => (
              <section key={g} aria-label={`添加服务商 · ${g}`}>
                <div className="pv-section-label">添加服务商 · {g}</div>
                <div className="pv-grid">
                  {PROVIDER_KINDS.filter((k) => k.group === g).map((k) => {
                    const linked = list.some((p) => uiKindOf(p) === k.kind)
                    const hint = k.desc || (k.catalog.length ? `${k.catalog.length} 个模型` : '模型 ID 自己填')
                    return (
                      <button key={k.kind} type="button" className="pv-card pv-card-add" data-kind={k.kind} disabled={!k.api}
                        onClick={() => setOpen({ mode: 'new', kind: k.kind })}>
                        <ProviderLogo kind={k.kind} />
                        <span className="pv-text"><span className="pv-name" title={k.label}>{k.label}</span><span className="pv-hint">{hint}</span></span>
                        <span className="pv-add">{!k.api ? '暂未支持' : linked ? '再接一个' : '接入'}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
          </>
        )}
      </QueryState>

      {open?.mode === 'new' ? (
        <ProviderDrawer key={`new-${open.kind}`} def={kindOf(open.kind)} providers={list} testing={false} onTest={(id) => test.mutate(id)}
          onCreated={(p) => setOpen({ mode: 'edit', id: p.id, slot: `new-${open.kind}` })} onClose={() => setOpen(null)} />
      ) : editing && open ? (
        <ProviderDrawer key={open.slot ?? editing.id} def={kindOf(uiKindOf(editing))} provider={editing} providers={list} check={checks[editing.id]}
          testing={testingId === editing.id} testError={testError} onTest={(id) => test.mutate(id)}
          onCreated={() => undefined} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  )
}
