// 连接器配置抽屉，新建和编辑共用。即时通讯类照原型 web-next/src/connectors.tsx ConnectorDrawer（SPEC-settings-4），
// 其余照 web-next/src/apiconn.tsx ApiConnectorDrawer（SPEC-settings-5）。字段、认证方式、工具清单都按后端定义渲染。
// 和原型不同的地方（后端决定的）：
// - 测试连接、获取工具清单都按已保存的配置做：新建点「接入」先保存再自动测一次，抽屉留着看结果；有没保存的改动时先保存。
// - 凭证只显示后端给的脱敏提示，输入框空着保存不改；不是必填的凭证可以单独清掉。
// - Token 的请求头、前缀由定义决定（自定义类的定义里有 token_header、token_prefix 字段，就能改）；
// - OAuth 授权（CONN-04b）：按已保存的配置发起，有没保存的改动（含新建）先保存；新窗口打开对方的授权页，
//   轮询实例等 oauth.authorized_at 变了算完成（后端换完令牌会测一次），回调窗口报回的失败写在授权框里。
// - 字段可以只属于某种认证方式（定义的 auth），切换认证方式时跟着显示、隐藏（CONN-04）。
// - 改了地址、认证或凭证保存后不关抽屉，提示重新测试、重新获取工具清单。
import { useEffect, useState, type ChangeEvent } from 'react'
import {
  errorText, useConnectors, useCreateConnector, useDeleteConnector, usePatchConnector, useRefreshConnectorTools, useSetConnectorToolModes,
  useStartConnectorOAuth, type Connector, type ConnectorDef, type ConnectorField, type ConnectorToolMode,
} from '../../../core/data'
import { Button, cls, ConfirmDialog, Drawer, Field, Input, Select, Textarea } from '../../../core/ui'
import { AUTH_HINT, AUTH_LABEL, categoryOf, INTERVALS, MODE_LABEL } from './catalog'
import {
  ago, bulkModes, createBody, effectiveTools, fieldHint, fieldOn, initialDraft, isCustom, isIM, missingFields, modesFor, needsRetest, notReady, oauthLack,
  oauthReturnTo, oauthState, patchBody, pruneModes, refreshNote, tokenPreview, type Bulk, type ConnCheck, type Draft,
} from './model'
import { listenOAuth, OAUTH_POLL_MS, openBlank } from './oauth'
import { ConnBar, ToolLogo } from './parts'

/** 自定义图标上限：data URL 存在库里，后端最多 512KB */
const MAX_ICON = 256 * 1024

export function ConnectorDrawer({ def, connector: c, taken, check, pending, testError, onTest, onConnect, onDisconnect, onCreated, onClose }: {
  def: ConnectorDef
  /** 没有就是新建 */
  connector?: Connector
  /** 新建时同一工具已有实例的名字，默认名称按它加序号 */
  taken?: string[]
  check?: ConnCheck
  /** 正在连通测试（含连接前的启用） */
  pending: boolean
  /** 测试请求本身失败（不是 ok=false） */
  testError?: unknown
  onTest: (id: string) => void
  onConnect?: () => void
  onDisconnect?: () => void
  /** 新建成功：抽屉换成编辑这一条 */
  onCreated: (c: Connector) => void
  onClose: () => void
}) {
  const creating = !c
  const im = isIM(def)
  const available = !c || c.available
  const [draft, setDraft] = useState<Draft>(() => initialDraft(def, c, taken))
  const [baseline, setBaseline] = useState(draft)
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  const [tried, setTried] = useState(false)
  const [confirm, setConfirm] = useState<{ kind: 'delete' } | { kind: 'clear'; field: ConnectorField } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readyError, setReadyError] = useState<string | null>(null)
  const [fetchNote, setFetchNote] = useState('')
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [retest, setRetest] = useState(false)
  const [iconError, setIconError] = useState('')
  /** 这次发起的授权：before 是发起前的授权时间，变了就是完成了；url 给「授权页没打开」用，expires 之后这次作废 */
  const [authRun, setAuthRun] = useState<{ id: string; before: string | null; url: string; expires: string } | null>(null)
  const [authError, setAuthError] = useState('')
  const create = useCreateConnector()
  const patch = usePatchConnector()
  const remove = useDeleteConnector()
  const refresh = useRefreshConnectorTools()
  const setModes = useSetConnectorToolModes()
  const oauthStart = useStartConnectorOAuth()
  const authAt = c?.oauth?.authorized_at ?? null
  const authDone = !!authRun && c?.id === authRun.id && !!authAt && authAt !== authRun.before && c.status !== 'disconnected'
  const authWait = authDone ? null : authRun
  // 等授权时定时重取实例列表，c 跟着变
  const listQ = useConnectors(authWait ? OAUTH_POLL_MS : false)
  const busy = create.isPending || patch.isPending || remove.isPending || refresh.isPending || setModes.isPending || oauthStart.isPending

  const missing = missingFields(def, draft, c)
  const nameBad = tried && !draft.name.trim()
  const body = c ? patchBody(def, draft, c) : null
  const modeChanges = c ? pruneModes(c.tools, draft.modes) : {}
  const hasChanges = creating || Object.keys(body ?? {}).length > 0 || Object.keys(modeChanges).length > 0
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const lack = notReady(def, draft, c)
  const tools = c ? effectiveTools(c.tools, draft.modes) : []
  const kw = q.trim().toLowerCase()
  const shown = tools.filter((t) => !kw || `${t.name}${t.desc}`.toLowerCase().includes(kw))
  const autoWrites = tools.filter((t) => t.write && t.mode === 'auto')
  // 不分认证方式的非凭证字段放上面；属于当前认证方式的和凭证放「认证方式」里
  const plain = def.fields.filter((f) => f.kind !== 'secret' && !f.auth?.length)
  const authFields = def.fields.filter((f) => (f.kind === 'secret' || f.auth?.length) && fieldOn(f, draft.authMode))
  const preview = tokenPreview(def, draft)
  const authLack = oauthLack(def, draft, c)
  const authSaved = oauthState(c)
  // 授权完成后端会测一次，这之前的测试结论作废
  const freshCheck = check && !(authAt && check.at < Date.parse(authAt)) ? check : undefined

  // 回调窗口报回来的结果：失败写原因，成功立刻重取一次（以轮询到的实例为准）
  const refetchList = listQ.refetch
  useEffect(() => {
    if (!authWait) return
    return listenOAuth((m) => {
      if (m.connector && m.connector !== authWait.id) return
      if (m.ok) { void refetchList(); return }
      setAuthRun(null)
      setAuthError(m.message || '对方没有给出原因')
    })
  }, [authWait, refetchList])

  // 过了这次授权的有效期还没完成：停止等待
  useEffect(() => {
    if (!authWait) return
    const left = Date.parse(authWait.expires) - Date.now()
    if (!Number.isFinite(left)) return
    const t = setTimeout(() => { setAuthRun(null); setAuthError('等太久了，这次授权已作废，重新点「去授权」') }, Math.max(left, 0))
    return () => clearTimeout(t)
  }, [authWait])

  const set = (p: Partial<Draft>) => { setDraft({ ...draft, ...p }); setReadyError(null) }
  const setCfg = (k: string, v: string) => set({ config: { ...draft.config, [k]: v } })
  const setSecret = (k: string, v: string) => set({ secrets: { ...draft.secrets, [k]: v } })
  const setMode = (name: string, m: ConnectorToolMode) => set({ modes: { ...draft.modes, [name]: m } })
  const bulk = (k: Bulk) => { if (c) set({ modes: bulkModes(c.tools, k) }) }
  // 保存后草稿按后端返回的重排一次，凭证输入框清空
  const reset = (x: Connector) => {
    const d = initialDraft(def, x)
    setDraft(d)
    setBaseline(d)
  }
  // 状态条上连接、断开是直接生效的，启用开关跟着变，不算未保存
  const follow = (enabled: boolean) => {
    setDraft({ ...draft, enabled })
    setBaseline({ ...baseline, enabled })
  }

  async function fetchTools(x: Connector) {
    setFetchError(null)
    setRetest(false)
    try {
      const r = await refresh.mutateAsync(x.id)
      setFetchNote(refreshNote(x.tools.length, r))
      // 拉取前已经保存过，草稿只剩没保存的授权改动；对方删掉的工具、变成只读的去掉
      const d = initialDraft(def, r.connector)
      setDraft({ ...d, modes: pruneModes(r.connector.tools, draft.modes) })
      setBaseline(d)
    } catch (e) {
      setFetchError(`获取失败：${errorText(e)}`)
    }
  }

  /** 保存；then 是保存后接着做的事 */
  async function save(then: 'close' | 'test' | 'tools') {
    setError(null)
    setTried(true)
    if (missing.length || !draft.name.trim()) return
    if (then !== 'close' && !creating && lack) { setReadyError(lack); return }
    try {
      if (creating) {
        const x = await create.mutateAsync(createBody(def, draft))
        reset(x)
        onCreated(x)
        if (!notReady(def, initialDraft(def, x), x)) onTest(x.id)
        return
      }
      let x = c
      const changedConn = !!body && !im && available && needsRetest(body)
      if (body && Object.keys(body).length) x = await patch.mutateAsync({ id: c.id, patch: body })
      if (Object.keys(modeChanges).length) x = await setModes.mutateAsync({ id: c.id, modes: modeChanges })
      // 改了地址或认证：不关，提示重新测试和刷新工具清单
      if (then === 'close' && !changedConn) { onClose(); return }
      reset(x)
      if (then === 'test') { setRetest(false); onTest(x.id) }
      else if (then === 'tools') await fetchTools(x)
      else setRetest(true)
    } catch (e) {
      setError(`${creating ? '接入' : '保存'}失败：${errorText(e)}`)
    }
  }

  /** 去授权：先同步开空窗口（点击里开才不会被拦）；有没保存的改动（含新建）先保存，再拿授权地址跳过去 */
  async function authorize() {
    setError(null)
    setAuthError('')
    setAuthRun(null)
    setTried(true)
    if (authLack) return
    const w = openBlank()
    try {
      let x = c
      if (!x) {
        x = await create.mutateAsync(createBody(def, draft))
        reset(x)
        onCreated(x)
      } else {
        if (body && Object.keys(body).length) x = await patch.mutateAsync({ id: x.id, patch: body })
        if (Object.keys(modeChanges).length) x = await setModes.mutateAsync({ id: x.id, modes: modeChanges })
        if (x !== c) reset(x)
      }
      const r = await oauthStart.mutateAsync({ id: x.id, returnTo: oauthReturnTo() })
      setAuthRun({ id: x.id, before: x.oauth?.authorized_at ?? null, url: r.authorize_url, expires: r.expires_at })
      if (w) w.location.href = r.authorize_url
    } catch (e) {
      w?.close()
      setAuthError(`没能发起授权：${errorText(e)}`)
    }
  }

  function pickIcon(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!f.type.startsWith('image/')) { setIconError('只能用图片'); return }
    if (f.size > MAX_ICON) { setIconError('图片不能超过 256KB'); return }
    const r = new FileReader()
    r.onload = () => { setIconError(''); setDraft((d) => ({ ...d, icon: String(r.result) })) }
    r.onerror = () => setIconError('读取图片失败')
    r.readAsDataURL(f)
  }

  function clearSecret(f: ConnectorField) {
    if (!c) return
    patch.mutate({ id: c.id, patch: { secrets: { [f.key]: '' } } }, {
      onSuccess: () => { setConfirm(null); setSecret(f.key, '') },
      onError: (e) => { setConfirm(null); setError(`清除${f.label}失败：${errorText(e)}`) },
    })
  }

  function del() {
    if (!c) return
    remove.mutate(c.id, {
      onSuccess: () => { setConfirm(null); onClose() },
      onError: (e) => { setConfirm(null); setError(`删除失败：${errorText(e)}`) },
    })
  }

  const testLine = () => {
    if (creating) return <span className="cn-faint">接入后自动测一次</span>
    if (pending) return null
    if (readyError) return <span className="danger-text">{readyError}</span>
    if (testError) return <span className="danger-text">测试没发出去：{errorText(testError)}</span>
    if (hasChanges) return <span className="cn-faint">改了配置，保存后才按新配置测</span>
    if (retest) return <span className="cn-faint">已保存新配置，还没按新配置测</span>
    if (freshCheck) return freshCheck.ok ? <span className="cn-ok-text">{freshCheck.message || '连接正常'}{c.account && ` · ${c.account}`}</span>
      : <span className="danger-text">{freshCheck.message}</span>
    if (c.status === 'error') return <span className="danger-text">{c.error || '连接异常'}</span>
    if (c.last_tested_at && c.status === 'connected') return <span className="cn-faint">上次连接正常 · {ago(c.last_tested_at)}</span>
    return <span className="cn-faint">还没测过</span>
  }

  const testRow = (
    <div className="cn-test-line">
      <Button variant="outline" disabled={busy || pending || !available} onClick={() => void save('test')}>
        {pending ? '测试中…' : creating ? '接入并测试' : hasChanges ? '保存并测试' : '测试连接'}
      </Button>
      {testLine()}
    </div>
  )

  const field = (f: ConnectorField) => {
    const bad = tried && missing.includes(f.key)
    if (f.kind === 'select') {
      const opts = f.options ?? []
      const cur = draft.config[f.key] ?? ''
      return (
        <Field key={f.key} label={f.label} required={f.required} error={bad ? '必填' : undefined} hint={fieldHint(def, f, draft.config)}>
          <Select value={cur} invalid={bad} onValueChange={(v) => setCfg(f.key, v)}
            options={[...new Set([...(f.required ? [] : ['']), ...(cur ? [cur] : []), ...opts])]
              .map((v) => ({ value: v, label: v || (f.default ? `${f.default}（默认）` : '不选') }))} />
        </Field>
      )
    }
    if (f.kind === 'secret') {
      const hint = c?.secret_hints[f.key]
      return (
        <Field key={f.key} label={f.label} required={f.required && !hint} error={bad ? '必填' : undefined} hint={fieldHint(def, f, draft.config)}>
          <span className="cn-secret">
            <Input type={reveal[f.key] ? 'text' : 'password'} className="cn-mono" autoComplete="off" invalid={bad}
              value={draft.secrets[f.key] ?? ''} placeholder={hint ? '不改就留空' : f.placeholder || 'API Key 或个人访问令牌'}
              onChange={(e) => setSecret(f.key, e.target.value)} />
            <Button size="sm" onClick={(e) => { e.preventDefault(); setReveal({ ...reveal, [f.key]: !reveal[f.key] }) }}>
              {reveal[f.key] ? '隐藏' : '显示'}
            </Button>
          </span>
          {hint && (
            <span className="cn-key-line">
              <span>当前：<code className="cn-mono">{hint}</code></span>
              {!f.required && (
                <Button size="sm" variant="danger-ghost" disabled={busy}
                  onClick={(e) => { e.preventDefault(); setConfirm({ kind: 'clear', field: f }) }}>清除</Button>
              )}
            </span>
          )}
        </Field>
      )
    }
    return (
      <Field key={f.key} label={f.label} required={f.required} error={bad ? '必填' : undefined}>
        {f.long
          ? <Textarea className="cn-mono" rows={6} value={draft.config[f.key] ?? ''} placeholder={f.placeholder} invalid={bad}
            onChange={(e) => setCfg(f.key, e.target.value)} />
          : <Input value={draft.config[f.key] ?? ''} placeholder={f.placeholder} invalid={bad} onChange={(e) => setCfg(f.key, e.target.value)} />}
      </Field>
    )
  }

  const authSeg = def.auth.length > 0 && (!im || def.auth.length > 1) && (
    <>
      <div className="cn-seg cn-seg-full" role="group" aria-label="认证方式">
        {def.auth.map((m) => (
          <button key={m} type="button" className={cls(draft.authMode === m && 'on')} aria-pressed={draft.authMode === m}
            onClick={() => set({ authMode: m })}>{AUTH_LABEL[m] ?? m}</button>
        ))}
      </div>
      <div className="cn-faint">{AUTH_HINT[draft.authMode]}</div>
    </>
  )

  // 授权框，照原型 oauth-box：还没授权、已授权、已过期三种；已保存的认证方式不是 OAuth 时按还没授权算
  const authText = () => {
    if (authWait) return <><b>等待授权…</b><span className="cn-faint">在新打开的 {def.label} 页面里登录、确认授权，完成后这里自动更新</span></>
    if (authSaved === 'ok') {
      return <><b>已授权{c?.account && `：${c.account}`}</b>
        <span className="cn-faint">{c?.oauth?.expires_at ? `令牌到期：${new Date(c.oauth.expires_at).toLocaleDateString('zh-CN')}，到期前自动续期` : '令牌没有到期时间'}</span></>
    }
    if (authSaved === 'expired') {
      return <><b className="danger-text">授权已过期</b><span className="cn-faint">{c?.error || '令牌已失效，用到它的 Agent 和流程会失败'}</span></>
    }
    return <><b>还没授权</b><span className="cn-faint">{authLack || `点右边按钮会在新窗口打开 ${def.label} 的授权页`}</span></>
  }
  const oauthBox = draft.authMode === 'oauth2' && (
    <>
      <div className={cls('cn-oauth', !authWait && authSaved === 'ok' && 'ok', !authWait && authSaved === 'expired' && 'bad')} data-oauth={authWait ? 'wait' : authSaved}>
        <span className="cn-oauth-text">{authText()}</span>
        {authWait ? <>
          <a className="link cn-oauth-link" href={authWait.url} target="_blank" rel="noopener noreferrer">授权页没打开？</a>
          <Button size="sm" onClick={() => setAuthRun(null)}>不等了</Button>
        </> : (
          <Button size="sm" variant={authSaved === 'ok' ? 'outline' : 'primary'} disabled={!!authLack || busy || pending}
            title={authLack || undefined} onClick={() => void authorize()}>
            {oauthStart.isPending ? '正在打开…' : authSaved === 'none' ? `${hasChanges ? (creating ? '接入并' : '保存并') : ''}去 ${def.label} 授权` : '重新授权'}
          </Button>
        )}
      </div>
      {authError && <div className="danger-text" role="alert">授权没完成：{authError}</div>}
      {authDone && authSaved === 'ok' && <div className="cn-ok-text" role="status">授权完成{c?.status === 'connected' ? '，已连接' : ''}</div>}
    </>
  )

  const toolsSection = (
    <section className="cn-group" aria-label="工具清单">
      <div className="cn-group-title cn-tools-head">
        <span>工具清单{tools.length > 0 && (
          <span className="cn-group-hint">
            {tools.filter((t) => t.mode !== 'off').length} / {tools.length} 个可用{c?.tools_at && ` · ${ago(c.tools_at)}获取`}
          </span>
        )}</span>
        <span className="spacer" />
        <Button size="sm" variant="outline" disabled={creating || !!lack || busy || pending}
          title={creating ? '接入后才能获取' : lack || undefined} onClick={() => void save('tools')}>
          {refresh.isPending ? '获取中…' : tools.length ? '重新获取' : '获取工具清单'}
        </Button>
      </div>
      {fetchNote && <div className="cn-faint">{fetchNote}</div>}
      {fetchError && <div className="danger-text">{fetchError}</div>}
      {!tools.length ? (
        <div className="cn-empty">
          {creating ? '接入后点「获取工具清单」，看看这个连接器能提供哪些工具'
            : lack ? `${lack}，才能获取工具清单` : '点「获取工具清单」，看看这个连接器能提供哪些工具'}
        </div>
      ) : (
        <>
          <div className="cn-tools-bar">
            <Input className="cn-tools-search" placeholder="搜工具" aria-label="搜工具" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="spacer" />
            <Button size="sm" onClick={() => bulk('recommended')}>按推荐设置</Button>
            <Button size="sm" onClick={() => bulk('readonly')}>只开只读</Button>
            <Button size="sm" onClick={() => bulk('off')}>全部关闭</Button>
          </div>
          <div className="cn-ability">
            {shown.map((t) => (
              <div key={t.name} className={cls('cn-ability-row', t.mode === 'off' && 'off')} data-tool-name={t.name}>
                <span className="cn-ability-text">
                  <span><code className="cn-fn">{t.name}</code>{t.write && <span className="cn-write">写</span>}</span>
                  <span className="cn-faint">{t.desc}</span>
                </span>
                <div className="cn-seg cn-seg-sm" role="group" aria-label={`${t.name} 授权`}>
                  {modesFor(t).map((m) => (
                    <button key={m} type="button" aria-pressed={t.mode === m}
                      className={cls(t.mode === m && 'on', m === 'auto' && t.write && t.mode === m && 'risky')}
                      onClick={() => setMode(t.name, m)}>{MODE_LABEL[m]}</button>
                  ))}
                </div>
              </div>
            ))}
            {!shown.length && <div className="cn-empty">没有匹配的工具</div>}
          </div>
          {autoWrites.length > 0 && (
            <div className="cn-warn">{autoWrites.map((t) => t.name).join('、')} 是写操作，设为自动后 Agent 和流程调用时不再等你确认</div>
          )}
          <div className="cn-faint">这里是上限：Agent 里只能把这些工具设得一样严或更严，关闭的工具 Agent 和 SOP 都用不了。</div>
        </>
      )}
    </section>
  )

  const enabledRow = (
    <label className="cn-switch-row">
      <span>
        <span className="field-label">启用</span>
        <span className="cn-faint">{im ? '暂停后不再拉取新消息，已收进来的消息保留' : '停用后所有工具都不可调用，配置和授权保留'}</span>
      </span>
      <span className="cn-switch-line">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span className="cn-switch" />
      </span>
    </label>
  )

  const unfilled = [...(draft.name.trim() ? [] : [im ? '连接器名称' : '名称']), ...missing.map((k) => def.fields.find((f) => f.key === k)?.label ?? k)]

  return (
    <Drawer open onClose={onClose} dirty={dirty} className="cn-drawer"
      kicker={creating ? `接入 ${def.label}` : '配置连接器'}
      footer={(requestClose) => (
        <>
          {!creating && <Button variant="danger-ghost" disabled={busy} onClick={() => setConfirm({ kind: 'delete' })}>删除连接器</Button>}
          <div className="spacer" />
          {tried && unfilled.length > 0 && <span className="field-err">还没填：{unfilled.join('、')}</span>}
          <Button onClick={requestClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save('close')}>{creating ? '接入' : '保存'}</Button>
        </>
      )}>
      <div className="cn-form">
        {error && <div className="cn-alert" role="alert">{error}</div>}
        {c && !c.available && <div className="cn-alert" role="alert">提供它的插件已停用：只能改名、启停和删除，测试和工具清单要等插件重新启用。</div>}

        <div className="cn-profile">
          {isCustom(def) ? (
            // 自定义类可以换成自己的图标；内置的用品牌标志，不给改
            <span className="cn-icon-edit">
              <label className="cn-icon-btn" title="上传图标">
                <ToolLogo def={def} size={48} src={draft.icon || undefined} />
                <input type="file" accept="image/*" hidden aria-label="上传图标" onChange={pickIcon} />
              </label>
              {draft.icon && <Button size="sm" variant="ghost" onClick={() => set({ icon: '' })}>移除图标</Button>}
            </span>
          ) : <ToolLogo def={def} size={48} />}
          <div className="cn-profile-text">
            <h2 className="ellipsis">{draft.name.trim() || def.label}</h2>
            <div className="cn-faint">{categoryOf(def.category).label}{def.desc && ` · ${def.desc}`}</div>
            {isCustom(def) && <div className="cn-faint">{iconError ? <span className="danger-text">{iconError}</span> : '点标志上传图标，没有图片时用默认图标'}</div>}
          </div>
        </div>

        {c && onConnect && onDisconnect && (
          <ConnBar connector={c} pending={pending}
            onConnect={() => { follow(true); onConnect() }} onDisconnect={() => { follow(false); onDisconnect() }} />
        )}

        <Field label={im ? '连接器名称' : '名称'} required error={nameBad ? '必填' : undefined}>
          <Input value={draft.name} invalid={nameBad} maxLength={100} placeholder={im ? '例如 公司 Slack' : undefined}
            onChange={(e) => set({ name: e.target.value })} />
        </Field>

        {im ? (
          <>
            <section className="cn-group" aria-label="凭证与参数">
              <div className="cn-group-title">凭证与参数</div>
              {authSeg}
              {def.fields.filter((f) => fieldOn(f, draft.authMode)).map(field)}
              {oauthBox}
              {testRow}
            </section>
            <section className="cn-group" aria-label="同步">
              <div className="cn-group-title">同步</div>
              <div className="field">
                <span className="field-label">消息方向</span>
                <div className="cn-seg cn-seg-full" role="group" aria-label="消息方向">
                  <button type="button" className={cls(draft.direction === 'receive' && 'on')} aria-pressed={draft.direction === 'receive'}
                    onClick={() => set({ direction: 'receive' })}>只收消息</button>
                  <button type="button" className={cls(draft.direction === 'both' && 'on')} aria-pressed={draft.direction === 'both'}
                    disabled={!def.can_send} onClick={() => set({ direction: 'both' })}>收发（可在工作台回复）</button>
                </div>
              </div>
              <Field label="拉取间隔">
                <Select value={String(draft.interval)} onValueChange={(v) => set({ interval: Number(v) })}
                  options={[...new Set([...INTERVALS, draft.interval])].sort((a, b) => a - b)
                    .map((x) => ({ value: String(x), label: x ? `每 ${x} 分钟` : '不定时同步' }))} />
              </Field>
              {enabledRow}
            </section>
          </>
        ) : (
          <>
            {plain.map(field)}
            {available && (
              <section className="cn-group" aria-label="认证方式">
                <div className="cn-group-title">认证方式</div>
                {authSeg}
                {authFields.map(field)}
                {oauthBox}
                {preview && <div className="cn-faint">{preview}</div>}
                {testRow}
              </section>
            )}
            {retest && c && (
              <div className="cn-warn cn-retest" role="status">
                <span>改了地址或认证：重新测试连接，再重新获取工具清单，确认工具还对得上</span>
                <span className="cn-retest-acts">
                  <Button size="sm" variant="outline" disabled={busy || pending} onClick={() => { setRetest(false); onTest(c.id) }}>测试连接</Button>
                  <Button size="sm" variant="outline" disabled={busy || pending || !!lack} onClick={() => void fetchTools(c)}>重新获取工具清单</Button>
                </span>
              </div>
            )}
            {available && toolsSection}
            {enabledRow}
          </>
        )}
      </div>

      <ConfirmDialog open={confirm?.kind === 'clear'} danger title={`清除${confirm?.kind === 'clear' ? confirm.field.label : ''}？`}
        confirmLabel="清除" busy={patch.isPending} onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm?.kind === 'clear') clearSecret(confirm.field) }}>
        保险箱里这一项会被清掉。不想改的话，输入框空着保存就行。
      </ConfirmDialog>
      <ConfirmDialog open={confirm?.kind === 'delete'} danger title={`删除「${c?.name ?? ''}」？`} confirmLabel="删除" busy={remove.isPending}
        onCancel={() => setConfirm(null)} onConfirm={del} impacts={['保险箱里它的凭证一起删掉']}>
        {im ? '删除后不再同步，已收的消息保留。' : '删除后授权一并撤销，用到它的 Agent 工具会失效。'}
      </ConfirmDialog>
    </Drawer>
  )
}
