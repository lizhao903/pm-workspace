// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useMemo, useState } from 'react'
import { ConnBar, ToolLogo } from './connectors'
import { MarkEditor } from './imagepick'
import { AUTH_LABEL, defaultMode, discoverTools, type AuthMode, type ConnAuth, type ConnTool, type Connector, type Tool, type ToolMode } from './data'
import { cls, timeAgo } from './ui'

// 应用与 API 类连接器的配置抽屉：认证方式（无授权 / OAuth 2.0 / Token）→ 测试连接 → 获取工具清单 → 每个工具的权限
// 工具权限是这个连接器的上限：Agent、SOP 用到它的工具时，只能和这里一样严或更严

const MODE_LABEL: Record<ToolMode, string> = { off: '关闭', confirm: '需确认', auto: '自动' }
const AUTH_HINT: Record<AuthMode, string> = {
  none: '公开接口，不需要凭证。只适合不涉及账号数据的服务',
  oauth2: '跳转到对方页面登录授权，拿到的令牌到期前会自动续期',
  token: '填 API Key 或个人访问令牌，请求时放在请求头里',
}

type Phase = 'idle' | 'running' | 'ok' | 'error'

export function ApiConnectorDrawer({ tool, connector, onClose, onSave, onDelete, onConnect, onDisconnect, delImpact }: {
  onConnect?: () => void
  onDisconnect?: () => void
  tool: Tool
  connector: Connector | null
  onClose: () => void
  onSave: (d: Omit<Connector, 'id' | 'created_at'>) => void
  onDelete: () => void
  /** 删除的连带影响，列在确认里 */
  delImpact?: string[]
}) {
  const creating = !connector
  const modes = tool.auth ?? ['token']
  const [name, setName] = useState(connector?.name ?? tool.label)
  const [icon, setIcon] = useState(connector?.icon)
  const [config, setConfig] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(tool.fields.filter((f) => f.kind === 'select').map((f) => [f.key, f.options![0]])), ...connector?.config,
  }))
  const [auth, setAuth] = useState<ConnAuth>(() => connector?.auth ?? {
    mode: modes[0],
    oauth: { client_id: '', client_secret: '', auth_url: tool.oauth?.auth_url ?? '', token_url: tool.oauth?.token_url ?? '', scopes: tool.oauth?.scopes ?? '' },
    token: { header: 'Authorization', prefix: 'Bearer', value: '' },
  })
  const [enabled, setEnabled] = useState(connector ? connector.status !== 'paused' : true)
  const [tools, setTools] = useState<ConnTool[]>(connector?.tools ?? [])
  const [toolsAt, setToolsAt] = useState(connector?.tools_at)
  const [authPhase, setAuthPhase] = useState<Phase>(() => (connector?.auth?.mode === 'oauth2' && connector.auth.oauth?.account
    ? (connector.auth.oauth.expires_at && new Date(connector.auth.oauth.expires_at) < new Date() ? 'error' : 'ok') : 'idle'))
  const [test, setTest] = useState<{ phase: Phase; text?: string }>(() => (connector?.status === 'error' ? { phase: 'error', text: connector.error } : connector ? { phase: 'ok', text: '上次连接正常' } : { phase: 'idle' }))
  const [fetching, setFetching] = useState(false)
  const [fetchNote, setFetchNote] = useState('')
  const [q, setQ] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)

  const oauth = auth.oauth!
  const token = auth.token ?? { header: 'Authorization', prefix: 'Bearer', value: '' }
  const builtinOAuth = !!tool.oauth?.builtin
  const missingFields = tool.fields.filter((f) => f.required && !config[f.key]?.trim())
  const authProblem = auth.mode === 'token' && !token.value.trim() ? '还没填 Token'
    : auth.mode === 'oauth2' && !builtinOAuth && (!oauth.client_id.trim() || !oauth.auth_url.trim() || !oauth.token_url.trim()) ? '还没填 OAuth 应用信息'
      : auth.mode === 'oauth2' && authPhase !== 'ok' ? '还没完成授权' : ''
  const ready = !missingFields.length && !authProblem

  const setMode = (m: AuthMode) => { setAuth({ ...auth, mode: m }); setTest({ phase: 'idle' }) }
  const authorize = () => {
    setAuthPhase('running')
    // 原型里不真的跳转：模拟对方授权页登录、同意，拿回账号和到期时间
    window.setTimeout(() => {
      setAuth((a) => ({ ...a, oauth: { ...a.oauth!, account: tool.key === 'github' ? 'broleez（acme-inc）' : `${tool.label} 账号`, expires_at: new Date(Date.now() + 86400000 * 60).toISOString() } }))
      setAuthPhase('ok')
      setTest({ phase: 'idle' })
    }, 900)
  }
  const revoke = () => { setAuth({ ...auth, oauth: { ...oauth, account: undefined, expires_at: undefined } }); setAuthPhase('idle'); setTest({ phase: 'idle' }) }

  const runTest = () => {
    if (!ready) { setTest({ phase: 'error', text: missingFields.length ? `还没填：${missingFields.map((f) => f.label).join('、')}` : authProblem }); return }
    setTest({ phase: 'running' })
    window.setTimeout(() => {
      const bad = /expired|invalid|bad/i.test(`${token.value} ${Object.values(config).join(' ')}`)
      setTest(bad ? { phase: 'error', text: '401 Unauthorized：凭证无效或已过期' } : { phase: 'ok', text: auth.mode === 'none' ? '服务可以访问' : '凭证有效，可以访问' })
    }, 700)
  }

  // 重新获取时保留已经配过的权限；新出现的工具按默认（写操作需确认），对方删掉的工具去掉
  const fetchTools = () => {
    setFetching(true)
    window.setTimeout(() => {
      const found = discoverTools(tool, config)
      const kept = found.map((t) => ({ ...t, mode: tools.find((x) => x.name === t.name)?.mode ?? defaultMode(t) }))
      const added = found.filter((t) => !tools.some((x) => x.name === t.name)).length
      const removed = tools.filter((t) => !found.some((x) => x.name === t.name)).length
      setTools(kept)
      setToolsAt(new Date().toISOString())
      setFetchNote(tools.length ? `新增 ${added} 个，移除 ${removed} 个，其余保留原来的权限` : `发现 ${found.length} 个工具：只读的默认自动，写操作默认需确认`)
      setFetching(false)
    }, 800)
  }
  const setToolMode = (n: string, m: ToolMode) => setTools(tools.map((t) => (t.name === n ? { ...t, mode: m } : t)))
  const bulk = (f: (t: ConnTool) => ToolMode) => setTools(tools.map((t) => ({ ...t, mode: f(t) })))
  const kw = q.trim().toLowerCase()
  const shown = useMemo(() => tools.filter((t) => !kw || `${t.name}${t.desc}`.toLowerCase().includes(kw)), [tools, kw])
  const autoWrites = tools.filter((t) => t.write && t.mode === 'auto')

  const save = () => {
    setTried(true)
    if (!name.trim() || missingFields.length) return
    const account = auth.mode === 'oauth2' ? oauth.account ?? '未授权' : auth.mode === 'token' ? 'Token 认证' : '公开接口'
    const status = !enabled ? 'paused' : authProblem || test.phase === 'error' ? 'error' : 'connected'
    onSave({
      tool: tool.key, name: name.trim(), account, status, error: status === 'error' ? (test.text ?? authProblem) : undefined,
      config, direction: 'receive', interval: 0, last_sync_at: test.phase === 'ok' ? new Date().toISOString() : connector?.last_sync_at ?? null,
      auth, tools, tools_at: toolsAt, icon,
    })
  }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? `接入 ${tool.label}` : '配置连接器'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        <div className="profile">
          {/* 内置应用用品牌标志，不给改；自定义的 MCP / OpenAPI 可以换成自己的图标 */}
          {tool.category === 'custom'
            ? <MarkEditor image={icon} onImage={setIcon} hint="没有图片时用默认图标"><ToolLogo tool={tool} size={48} src={icon} /></MarkEditor>
            : <ToolLogo tool={tool} size={48} />}
          <div className="profile-text"><h2>{name || tool.label}</h2><div className="list-sub">{tool.desc}</div></div>
        </div>
        {connector && onConnect && onDisconnect && <ConnBar connector={connector} onConnect={onConnect} onDisconnect={onDisconnect} />}
        <label className="field">
          <span className="field-label">名称<em>*</em></span>
          <input value={name} className={cls(tried && !name.trim() && 'bad')} onChange={(e) => setName(e.target.value)} />
        </label>
        {tool.fields.map((f) => (
          <label key={f.key} className="field">
            <span className="field-label">{f.label}{f.required && <em>*</em>}</span>
            {f.kind === 'select'
              ? <select value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>
              : <input value={config[f.key] ?? ''} placeholder={f.placeholder} className={cls(tried && f.required && !config[f.key]?.trim() && 'bad')} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />}
          </label>
        ))}

        <section className="field-group">
          <div className="field-group-title">认证方式</div>
          <div className="seg seg-full">
            {modes.map((m) => <button key={m} className={cls(auth.mode === m && 'on')} onClick={() => setMode(m)}>{AUTH_LABEL[m]}</button>)}
          </div>
          <div className="list-sub">{AUTH_HINT[auth.mode]}</div>

          {auth.mode === 'oauth2' && (
            <>
              {!builtinOAuth && (
                <>
                  <div className="field-row">
                    <label className="field"><span className="field-label">Client ID<em>*</em></span><input value={oauth.client_id} onChange={(e) => setAuth({ ...auth, oauth: { ...oauth, client_id: e.target.value } })} /></label>
                    <label className="field"><span className="field-label">Client Secret</span><input type="password" value={oauth.client_secret} onChange={(e) => setAuth({ ...auth, oauth: { ...oauth, client_secret: e.target.value } })} /></label>
                  </div>
                  <label className="field"><span className="field-label">授权地址<em>*</em></span><input value={oauth.auth_url} placeholder="https://…/oauth/authorize" onChange={(e) => setAuth({ ...auth, oauth: { ...oauth, auth_url: e.target.value } })} /></label>
                  <label className="field"><span className="field-label">令牌地址<em>*</em></span><input value={oauth.token_url} placeholder="https://…/oauth/token" onChange={(e) => setAuth({ ...auth, oauth: { ...oauth, token_url: e.target.value } })} /></label>
                  <div className="list-sub">回调地址填：<code className="model-id">https://pmw.local/oauth/callback</code></div>
                </>
              )}
              <label className="field">
                <span className="field-label">授权范围<span className="field-hint">{builtinOAuth ? '用内置的应用，不用自己申请' : '空格或逗号隔开'}</span></span>
                <input value={oauth.scopes} onChange={(e) => setAuth({ ...auth, oauth: { ...oauth, scopes: e.target.value } })} />
              </label>
              <div className={cls('oauth-box', authPhase === 'ok' && 'ok', authPhase === 'error' && 'bad')}>
                {authPhase === 'ok' ? (
                  <>
                    <span className="oauth-text"><b>已授权：{oauth.account}</b><span className="list-sub">令牌到期：{oauth.expires_at ? new Date(oauth.expires_at).toLocaleDateString('zh-CN') : '-'}，到期前自动续期</span></span>
                    <button className="act act-quiet" onClick={authorize}>重新授权</button>
                    <button className="act act-quiet btn-danger-ghost" onClick={revoke}>撤销</button>
                  </>
                ) : authPhase === 'error' ? (
                  <>
                    <span className="oauth-text"><b className="danger-text">授权已过期</b><span className="list-sub">{oauth.account} 的令牌已失效，用到它的 Agent 和流程会失败</span></span>
                    <button className="act act-primary" onClick={authorize}>重新授权</button>
                  </>
                ) : (
                  <>
                    <span className="oauth-text"><b>还没授权</b><span className="list-sub">点右边按钮会打开 {tool.label} 的授权页</span></span>
                    <button className="act act-primary" disabled={authPhase === 'running' || (!builtinOAuth && (!oauth.client_id || !oauth.auth_url))} onClick={authorize}>
                      {authPhase === 'running' ? '等待授权…' : `去 ${tool.label} 授权`}
                    </button>
                  </>
                )}
              </div>
            </>
          )}

          {auth.mode === 'token' && (
            <>
              <label className="field">
                <span className="field-label">Token<em>*</em></span>
                <span className="secret-line">
                  <input className={cls(!showSecret && 'mono', tried && !token.value.trim() && 'bad')} type={showSecret ? 'text' : 'password'} value={token.value} placeholder={tool.key === 'github' ? 'ghp_…' : 'API Key 或个人访问令牌'}
                    onChange={(e) => { setAuth({ ...auth, token: { ...token, value: e.target.value } }); setTest({ phase: 'idle' }) }} />
                  <button type="button" className="act act-quiet" onClick={() => setShowSecret(!showSecret)}>{showSecret ? '隐藏' : '显示'}</button>
                </span>
              </label>
              <div className="field-row">
                <label className="field"><span className="field-label">请求头</span><input className="mono" value={token.header} onChange={(e) => setAuth({ ...auth, token: { ...token, header: e.target.value } })} /></label>
                <label className="field"><span className="field-label">前缀</span><input className="mono" value={token.prefix} placeholder="留空就只发 Token" onChange={(e) => setAuth({ ...auth, token: { ...token, prefix: e.target.value } })} /></label>
              </div>
              <div className="list-sub">请求时带上：<code className="model-id">{token.header}: {token.prefix ? `${token.prefix} ` : ''}{token.value ? '••••••' : '<token>'}</code></div>
            </>
          )}

          <div className="test-line">
            <button className="act" onClick={runTest} disabled={test.phase === 'running'}>{test.phase === 'running' ? '测试中…' : '测试连接'}</button>
            {test.phase === 'ok' && <span className="ok-text">{test.text}</span>}
            {test.phase === 'error' && <span className="danger-text">{test.text}</span>}
          </div>
        </section>

        <section className="field-group">
          <div className="field-group-title tools-head">
            <span>工具清单{tools.length > 0 && <span className="field-hint">{tools.filter((t) => t.mode !== 'off').length} / {tools.length} 个可用{toolsAt && ` · ${timeAgo(toolsAt)}获取`}</span>}</span>
            <span className="spacer" />
            <button className="act" disabled={!ready || fetching} title={!ready ? authProblem || '先填完必填项' : undefined} onClick={fetchTools}>
              {fetching ? '获取中…' : tools.length ? '重新获取' : '获取工具清单'}
            </button>
          </div>
          {fetchNote && <div className="list-sub">{fetchNote}</div>}
          {!tools.length ? (
            <div className="io-empty">{ready ? '点「获取工具清单」，看看这个连接器能提供哪些工具' : `${authProblem || '先填完必填项'}，才能获取工具清单`}</div>
          ) : (
            <>
              <div className="tools-bar">
                <div className="search search-sm">
                  <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                  <input placeholder="搜工具" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <span className="spacer" />
                <button className="act act-quiet" onClick={() => bulk((t) => (t.write ? 'confirm' : 'auto'))}>按推荐设置</button>
                <button className="act act-quiet" onClick={() => bulk((t) => (t.write ? 'off' : 'auto'))}>只开只读</button>
                <button className="act act-quiet" onClick={() => bulk(() => 'off')}>全部关闭</button>
              </div>
              <div className="ability-table">
                {shown.map((t) => (
                  <div key={t.name} className={cls('ability-row', t.mode === 'off' && 'tool-off')}>
                    <span className="ability-text">
                      <span><code className="tool-fn">{t.name}</code>{t.write && <span className="write-tag">写</span>}</span>
                      <span className="list-sub">{t.desc}</span>
                    </span>
                    <div className="seg seg-sm">
                      {((t.write ? ['off', 'confirm', 'auto'] : ['off', 'auto']) as ToolMode[]).map((m) => (
                        <button key={m} className={cls(t.mode === m && 'on', m === 'auto' && t.write && t.mode === m && 'risky')} onClick={() => setToolMode(t.name, m)}>{MODE_LABEL[m]}</button>
                      ))}
                    </div>
                  </div>
                ))}
                {!shown.length && <div className="io-empty">没有匹配的工具</div>}
              </div>
              {autoWrites.length > 0 && <div className="banner banner-warn">{autoWrites.map((t) => t.name).join('、')} 是写操作，设为自动后 Agent 和流程调用时不再等你确认</div>}
              <div className="list-sub">这里是上限：Agent 里只能把这些工具设得一样严或更严，关闭的工具 Agent 和 SOP 都用不了。</div>
            </>
          )}
        </section>

        <label className="switch-row">
          <span><span className="field-label">启用</span><span className="switch-hint">停用后所有工具都不可调用，配置和授权保留</span></span>
          <span className="switch-line"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span className="switch" /></span>
        </label>
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">{delImpact?.length ? `删除后授权一并撤销：${delImpact.join('；')}` : '删除后授权一并撤销，用到它的 Agent 工具会失效'}</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            {!creating && <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除连接器</button>}
            <div className="spacer" />
            {tried && missingFields.length > 0 && <span className="field-err">还没填：{missingFields.map((f) => f.label).join('、')}</span>}
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={save}>{creating ? '接入' : '保存'}</button>
          </>
        )}
      </div>
    </aside>
  )
}
