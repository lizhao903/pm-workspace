import { useState } from 'react'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import {
  PROXY_KIND, RESOLVE_MODE, allRoutes, conflicts, domainUrl, fqdn, renderConfig, validHost, validSuffix,
  type DomainRoute, type DomainSettings, type ProtoRef, type ProxyKind, type ResolveMode, type RouteTarget,
} from './domaindata'
import { newId } from './ids'

// 设置 > 内网域名：后缀、解析方式、反向代理、HTTPS、局域网访问，加一张「域名 -> 服务」表和生成的配置

const APP_PORT = 7778

export function DomainsPage({ settings: s, routes, protos, onSettings, onRoutes, onOpenUrl }: {
  settings: DomainSettings
  routes: DomainRoute[]
  protos: ProtoRef[]
  onSettings: (s: DomainSettings) => void
  onRoutes: (fn: (xs: DomainRoute[]) => DomainRoute[]) => void
  onOpenUrl: (url: string, title: string) => void
}) {
  const set = (x: Partial<DomainSettings>) => onSettings({ ...s, ...x })
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<{ host: string; kind: RouteTarget['kind']; proto: string; url: string; note: string }>({ host: '', kind: 'url', proto: '', url: 'http://127.0.0.1:', note: '' })
  const [showCfg, setShowCfg] = useState<'resolve' | 'proxy'>('resolve')
  const [checking, setChecking] = useState<string | null>(null)
  const all = allRoutes(routes, s, protos)
  const dup = conflicts(all)
  const protoOf = (id: string) => protos.find((p) => p.id === id)
  const upstream = (r: DomainRoute) => {
    const t = r.target
    if (t.kind === 'app') return `http://127.0.0.1:${APP_PORT}`
    if (t.kind === 'url') return t.url
    const p = protoOf(t.proto_id)
    return p ? `http://127.0.0.1:${p.port}` : null
  }
  const targetLabel = (r: DomainRoute) => {
    const t = r.target
    if (t.kind === 'app') return `一人之下（:${APP_PORT}）`
    if (t.kind === 'url') return t.url
    const p = protoOf(t.proto_id)
    return p ? `${p.project} / ${p.name}（:${p.port}）` : '已删除的原型'
  }
  const down = (r: DomainRoute) => r.target.kind === 'proto' && protoOf(r.target.proto_id)?.status !== 'running'
  const cfg = renderConfig(all, s, upstream)
  const suffixBad = !validSuffix(s.suffix)
  const hostErr = !draft.host ? '' : !validHost(draft.host) ? '只能用小写字母、数字和连字符' : all.some((r) => r.host === draft.host) ? '已经有这个域名了' : ''

  const patch = (r: DomainRoute, x: Partial<DomainRoute>) => {
    // 自动分配的域名一改就转成手动的，之后不再跟着原型名变
    if (r.auto) onRoutes((xs) => [...xs, { ...r, ...x, id: newId('dm'), auto: false }])
    else onRoutes((xs) => xs.map((y) => (y.id === r.id ? { ...y, ...x } : y)))
  }
  // 解析测试（模拟）：后缀不合法、目标没运行、冲突、证书没装都会报出来
  const check = (r: DomainRoute) => {
    setChecking(r.id)
    window.setTimeout(() => {
      const problem = suffixBad ? '域名后缀不合法' : dup.has(r.host) ? '有两条同名的域名' : !upstream(r) ? '目标原型不存在' : down(r) ? '解析正常，但目标原型没在运行' : s.https && !s.ca_installed ? '解析正常，但本地根证书没装，浏览器会提示不安全' : ''
      patch(r, { check: { ok: !problem, at: new Date().toISOString(), message: problem || `${fqdn(r, s)} 解析到 ${s.lan ? s.lan_ip : '127.0.0.1'}，转发到 ${upstream(r)}` } })
      setChecking(null)
    }, 600)
  }
  const add = () => {
    if (!draft.host || hostErr) return
    const target: RouteTarget = draft.kind === 'app' ? { kind: 'app' } : draft.kind === 'proto' ? { kind: 'proto', proto_id: draft.proto } : { kind: 'url', url: draft.url.trim() }
    onRoutes((xs) => [...xs, { id: newId('dm'), host: draft.host, target, enabled: true, note: draft.note.trim() || undefined }])
    setAdding(false); setDraft({ host: '', kind: 'url', proto: '', url: 'http://127.0.0.1:', note: '' })
  }

  return (
    <div className="page page-fill">
      <PageTitle parent="设置" desc="给本机跑的服务配好记的域名，自己和局域网里的同事不用记端口" actions={
        <label className="switch-line"><input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /><span className="switch" />{s.enabled ? '已启用' : '未启用'}</label>
      }>内网域名</PageTitle>

      <div className={cls('dm-grid', !s.enabled && 'dm-off')}>
        <section className="hook-sec">
          <div className="field-group-title">域名后缀</div>
          <div className={cls('dm-suffix', suffixBad && 'bad')}>
            <span className="run-muted">*.</span>
            <input className="mono" value={s.suffix} spellCheck={false} onChange={(e) => set({ suffix: e.target.value.trim().toLowerCase() })} />
          </div>
          <div className={cls('list-sub', suffixBad && 'danger-text')}>{suffixBad ? '后缀不合法；也别用 .local，它被系统的 mDNS 占用了' : `比如 app.${s.suffix}；推荐 .lan、.internal 或自己公司的内网域名`}</div>

          <div className="field-group-title dm-sub">解析方式</div>
          <div className="dm-opts">
            {(Object.keys(RESOLVE_MODE) as ResolveMode[]).map((k) => (
              <label key={k} className={cls('model-opt', s.resolve === k && 'on')}>
                <input type="radio" checked={s.resolve === k} onChange={() => set({ resolve: k })} />
                <span><b>{RESOLVE_MODE[k].label}</b><span className="list-sub">{RESOLVE_MODE[k].desc}</span></span>
              </label>
            ))}
          </div>
        </section>

        <section className="hook-sec">
          <div className="field-group-title">反向代理</div>
          <div className="seg seg-full">
            {(Object.keys(PROXY_KIND) as ProxyKind[]).map((k) => <button key={k} className={cls(s.proxy === k && 'on')} onClick={() => set({ proxy: k })}>{PROXY_KIND[k].label}</button>)}
          </div>
          <div className="list-sub">{PROXY_KIND[s.proxy].desc}</div>

          <label className="switch-row dm-sub">
            <span><span className="field-label">HTTPS</span><span className="switch-hint">用本地根证书给每个域名签证书；OAuth 回调、摄像头这类接口要求 HTTPS</span></span>
            <span className="switch-line"><input type="checkbox" checked={s.https} onChange={(e) => set({ https: e.target.checked })} /><span className="switch" /></span>
          </label>
          {s.https && (
            <div className={cls('dm-ca', s.ca_installed ? 'ok' : 'warn')}>
              <span>{s.ca_installed ? '本地根证书已装进系统钥匙串' : '本地根证书还没装，浏览器会提示连接不安全'}</span>
              <button className="act" onClick={() => set({ ca_installed: !s.ca_installed })}>{s.ca_installed ? '移除证书' : '安装证书'}</button>
            </div>
          )}

          <label className="switch-row dm-sub">
            <span><span className="field-label">允许局域网访问</span><span className="switch-hint">代理监听 0.0.0.0，域名解析到本机的局域网地址；同事的设备也要能解析这个后缀</span></span>
            <span className="switch-line"><input type="checkbox" checked={s.lan} onChange={(e) => set({ lan: e.target.checked })} /><span className="switch" /></span>
          </label>
          {s.lan && (
            <div className="dm-ip">
              <span className="run-muted">本机局域网地址</span>
              <input className="text-box mono" value={s.lan_ip} onChange={(e) => set({ lan_ip: e.target.value.trim() })} />
              {s.resolve === 'hosts' && <span className="dm-warn-inline">hosts 文件只对这台电脑生效，局域网访问建议改用本机 DNS 或路由器 DNS</span>}
            </div>
          )}
        </section>
      </div>

      <section className={cls('hook-sec dm-routes', !s.enabled && 'dm-off')}>
        <div className="mount-head">
          <div className="field-group-title">域名<span className="field-hint">{all.filter((r) => r.enabled).length} 个启用</span></div>
          <label className="switch-line"><input type="checkbox" checked={s.auto_proto} onChange={(e) => set({ auto_proto: e.target.checked })} /><span className="switch" />项目原型自动分配</label>
          <button className="act" onClick={() => setAdding(!adding)}>加一个</button>
        </div>

        {adding && (
          <div className="dm-add">
            <div className={cls('dm-suffix', hostErr && 'bad')}>
              <input className="mono" placeholder="子域名" value={draft.host} spellCheck={false} onChange={(e) => setDraft({ ...draft, host: e.target.value.trim().toLowerCase() })} />
              <span className="run-muted">.{s.suffix}</span>
            </div>
            <div className="seg seg-sm">
              {([['url', '地址'], ['proto', '项目原型'], ['app', '这个工作台']] as const).map(([k, l]) => <button key={k} className={cls(draft.kind === k && 'on')} onClick={() => setDraft({ ...draft, kind: k })}>{l}</button>)}
            </div>
            {draft.kind === 'url' && <input className="text-box mono" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />}
            {draft.kind === 'proto' && (
              <select className="text-box" value={draft.proto} onChange={(e) => setDraft({ ...draft, proto: e.target.value })}>
                <option value="">选原型…</option>
                {protos.map((p) => <option key={p.id} value={p.id}>{p.project} / {p.name}（:{p.port}）</option>)}
              </select>
            )}
            <input className="text-box" placeholder="备注（可选）" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            {hostErr && <span className="danger-text">{hostErr}</span>}
            <button className="act act-primary" disabled={!draft.host || !!hostErr || (draft.kind === 'proto' && !draft.proto)} onClick={add}>添加</button>
            <button className="act act-quiet" onClick={() => setAdding(false)}>取消</button>
          </div>
        )}

        <div className="dm-table">
          {all.map((r) => {
            const bad = dup.has(r.host) && r.enabled
            return (
              <div key={r.id} className={cls('dm-row', !r.enabled && 'dm-row-off', bad && 'bad')}>
                <label className="switch-line" title={r.enabled ? '停用' : '启用'}><input type="checkbox" checked={r.enabled} onChange={(e) => patch(r, { enabled: e.target.checked })} /><span className="switch" /></label>
                <span className="dm-host">
                  <button className="link-btn mono ellipsis" disabled={!s.enabled || !r.enabled} onClick={() => onOpenUrl(domainUrl(r, s), fqdn(r, s))}>{fqdn(r, s)}</button>
                  <span className="list-sub ellipsis">
                    {r.auto && <span className="tag">自动</span>}{r.note}
                    {bad && <span className="danger-text"> 和另一条同名</span>}
                    {down(r) && <span className="run-muted"> 原型没在运行</span>}
                  </span>
                </span>
                <span className="dm-target ellipsis mono">{targetLabel(r)}</span>
                <span className={cls('dm-check', r.check && (r.check.ok ? 'ok' : 'warn'))} title={r.check?.message}>
                  {checking === r.id ? '测试中…' : r.check ? `${r.check.ok ? '正常' : '有问题'} · ${timeAgo(r.check.at)}` : ''}
                </span>
                <span className="dm-acts">
                  <button className="act act-quiet" disabled={checking === r.id} onClick={() => check(r)}>测试</button>
                  <button className="act act-quiet" onClick={() => navigator.clipboard?.writeText(domainUrl(r, s))}>复制</button>
                  {!r.auto && r.target.kind !== 'app' && (
                    <button className="icon-btn icon-btn-sm" title="删除" onClick={() => onRoutes((xs) => xs.filter((y) => y.id !== r.id))}>
                      <svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    </button>
                  )}
                </span>
                {r.check && !r.check.ok && <span className="dm-check-msg">{r.check.message}</span>}
              </div>
            )
          })}
        </div>
      </section>

      <section className={cls('hook-sec', !s.enabled && 'dm-off')}>
        <div className="mount-head">
          <div className="field-group-title">生成的配置<span className="field-hint">内置代理会自动应用；用 Caddy、Nginx 或改 hosts 时复制过去</span></div>
          <div className="seg seg-sm">
            <button className={cls(showCfg === 'resolve' && 'on')} onClick={() => setShowCfg('resolve')}>{RESOLVE_MODE[s.resolve].label}</button>
            <button className={cls(showCfg === 'proxy' && 'on')} onClick={() => setShowCfg('proxy')}>{PROXY_KIND[s.proxy].label}</button>
          </div>
          <button className="act" onClick={() => navigator.clipboard?.writeText(cfg[showCfg])}>复制</button>
        </div>
        <pre className="dm-cfg">{cfg[showCfg] || '没有启用的域名'}</pre>
      </section>
    </div>
  )
}
