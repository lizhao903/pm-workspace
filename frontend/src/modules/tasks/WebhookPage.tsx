// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Webhook 配置页（SPEC-tasks-10）：左接收地址、字段映射、过滤与去重，右测试推送、推送记录；底栏删除和保存。新建也用这一页。
// 测试推送是真的往收件地址推一次：后端按已保存的配置处理，所以有改动时先保存再推；
// 签名要密钥明文，前端只在新建、轮换后的响应里拿得到（记在内存里），或者由人粘贴进来，都不落存储。
import { useMemo, useState } from 'react'
import {
  DELIVERIES_MAX, DELIVERY_HEADER, SIGNATURE_HEADER, errorText, hookPath, isApiError, useCreateWebhook, useDeleteWebhook,
  usePatchWebhook, usePushWebhook, useRotateWebhookSecret, useWebhookDeliveries,
  type Delivery, type DictItem, type Webhook, type WebhookMapping,
} from '../../core/data'
import { Button, ConfirmDialog, Field, Input, ListSegMore, PageTitle, Pill, Select, Textarea, cls } from '../../core/ui'
import { prioText, timeAgo } from './model'
import {
  FIELDS, FIELD_LABEL, LOG_PAGE, RESULT, buildCreate, buildPatch, canSign, curlExample, deliveryText, draftError, draftOf, forgetSecret,
  getPath, hmacHex, mapFields, maskSecret, newDraft, parseJson, passFilter, rememberSecret, secretOf, testDeliveryId, asText,
  type HookDraft,
} from './webhookModel'

// 打开着的时候推送记录多久重取一次（外部推送不发投递事件）
const DELIVERY_POLL_MS = 30_000

export function WebhookPage({ hook, priorities, onSaved, onDeleted, onCancel, onOpenTask }: {
  /** null 是新建 */
  hook: Webhook | null
  priorities: DictItem[]
  /** 新建成功后切到它的配置页 */
  onSaved: (id: string) => void
  onDeleted: () => void
  onCancel: () => void
  onOpenTask: (id: string) => void
}) {
  const creating = !hook
  const defaultPrio = priorities.find((p) => p.key === 'P2')?.key ?? priorities[0]?.key ?? 'P2'
  const base = useMemo(() => (hook ? draftOf(hook) : null), [hook])
  const [d, setD] = useState<HookDraft>(() => base ?? newDraft(defaultPrio))
  const [tried, setTried] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [copied, setCopied] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  // 新建、轮换后拿到的明文；人粘贴进来的另存，只用来签名
  const [secret, setSecret] = useState(() => (hook ? secretOf(hook.id) : ''))
  const [pasted, setPasted] = useState('')
  const [last, setLast] = useState<Delivery | null>(null)
  const [testErr, setTestErr] = useState('')
  const [openLog, setOpenLog] = useState<string | null>(null)
  const [allLogs, setAllLogs] = useState(false)

  const create = useCreateWebhook()
  const patch = usePatchWebhook()
  const rotate = useRotateWebhookSecret()
  const del = useDeleteWebhook()
  const push = usePushWebhook()
  const logs = useWebhookDeliveries(hook?.id ?? null, DELIVERIES_MAX, DELIVERY_POLL_MS)

  const dirty = creating || !base || JSON.stringify(buildPatch(base, d)) !== '{}'
  const err = draftError(d)
  const url = hook ? `${window.location.origin}${hookPath(hook.token)}` : ''
  const parsed = parseJson(d.sample)
  const preview = parsed.ok ? mapFields(d.mapping, parsed.value) : null
  const filterRes = parsed.ok && d.filter.trim() ? passFilter(d.filter, parsed.value) : null
  const signKey = secret || pasted.trim()
  const signable = canSign()
  const busy = create.isPending || patch.isPending || del.isPending
  const testing = push.isPending || (patch.isPending && !!push.variables)

  const set = (p: Partial<HookDraft>) => setD({ ...d, ...p })
  const setMap = (k: keyof WebhookMapping, v: string) => set({ mapping: { ...d.mapping, [k]: v } })
  const copy = (k: string, v: string) => {
    void navigator.clipboard?.writeText(v).then(() => { setCopied(k); window.setTimeout(() => setCopied(''), 1500) }, () => {})
  }

  /** 保存；成功回 true。新建成功后记下明文、切到它的配置页 */
  const save = async (): Promise<boolean> => {
    setTried(true)
    setSaveErr('')
    if (err) return false
    try {
      if (!hook) {
        const w = await create.mutateAsync(buildCreate(d))
        if (w.secret) rememberSecret(w.id, w.secret)
        onSaved(w.id)
        return true
      }
      if (!base) return false
      const p = buildPatch(base, d)
      if (JSON.stringify(p) === '{}') return true
      const w = await patch.mutateAsync({ id: hook.id, patch: p })
      setD(draftOf(w))
      return true
    } catch (e) {
      setSaveErr(`没保存：${errorText(e)}`)
      return false
    }
  }

  const test = async () => {
    if (!hook || !parsed.ok || !signKey || !signable) return
    setTestErr('')
    setLast(null)
    if (dirty && !(await save())) { setTestErr('配置没保存成功，没有推送'); return }
    const body = parsed.value
    try {
      const sig = await hmacHex(signKey, JSON.stringify(body))
      const dl = await push.mutateAsync({
        hookId: hook.id, token: hook.token, body,
        headers: { [SIGNATURE_HEADER]: sig, [DELIVERY_HEADER]: testDeliveryId() },
      })
      setLast(dl)
    } catch (e) {
      // 401 是签名对不上：后端直接拒收，不进推送记录
      setTestErr(isApiError(e) && e.status === 401
        ? '签名对不上，推送被拒收了（不进推送记录）。Secret 可能已经轮换过，轮换一次或粘贴现在的 Secret 再试'
        : `没推送成功：${errorText(e)}`)
    }
  }

  const doRotate = () => {
    if (!hook) return
    rotate.mutate(hook.id, {
      onSuccess: (w) => {
        setConfirmRotate(false)
        if (w.secret) { rememberSecret(w.id, w.secret); setSecret(w.secret); setShowSecret(true) }
      },
    })
  }

  const doDelete = () => {
    if (!hook) return
    del.mutate(hook.id, { onSuccess: () => { forgetSecret(hook.id); onDeleted() } })
  }

  const prioOptions = priorities.filter((p) => !p.archived_at || p.key === d.defaults.priority).map((p) => ({ value: p.key, label: prioText(p.key, p) }))
  if (!prioOptions.some((o) => o.value === d.defaults.priority)) prioOptions.push({ value: d.defaults.priority, label: d.defaults.priority })

  const mine = logs.data?.data ?? []
  const total = logs.data?.total ?? 0
  const shown = allLogs ? mine : mine.slice(0, LOG_PAGE)

  let testHint = ''
  if (creating) testHint = '先保存再测试'
  else if (!signable) testHint = '这个页面不是用 https 或本机地址打开的，浏览器算不了签名，用上面的 curl 示例推'
  else if (!signKey) testHint = '要用 Secret 明文签名：新建或轮换后这里会记着，也可以把现在的 Secret 粘贴到上面'
  else if (dirty) testHint = '有没保存的改动，会先保存再推送'

  return (
    <div className="tasks-page hook-page">
      <PageTitle parent="Webhook" desc="外部系统往接收地址 POST 一段 JSON，按映射规则自动建任务" actions={!creating && (
        <label className="switch-line">
          <input type="checkbox" checked={d.enabled} aria-label="启用" onChange={(e) => set({ enabled: e.target.checked })} />
          <span className="switch" />{d.enabled ? '已启用' : '已停用'}
        </label>
      )}>
        {creating ? '新建 Webhook' : hook.name || '未命名'}
      </PageTitle>
      <Field label="名称" required className="hook-name" error={tried && !d.name.trim() ? '还没有名称' : undefined}>
        <Input value={d.name} invalid={tried && !d.name.trim()} placeholder="比如：Sentry 线上告警" autoFocus={creating}
          onChange={(e) => set({ name: e.target.value })} />
      </Field>

      <div className="hook-grid">
        <div className="hook-col">
          <section className="hook-sec" aria-label="接收地址">
            <div className="field-group-title">接收地址</div>
            {hook ? (
              <>
                <div className="copy-line">
                  <code title={url}>{url}</code>
                  <Button size="sm" onClick={() => copy('url', url)}>{copied === 'url' ? '已复制' : '复制'}</Button>
                </div>
                <div className="copy-line">
                  <span className="copy-k">Secret</span>
                  {secret ? (
                    <>
                      <code>{showSecret ? secret : maskSecret(secret)}</code>
                      <Button size="sm" onClick={() => setShowSecret(!showSecret)}>{showSecret ? '隐藏' : '显示'}</Button>
                      <Button size="sm" onClick={() => copy('secret', secret)}>{copied === 'secret' ? '已复制' : '复制'}</Button>
                    </>
                  ) : (
                    <code className="run-muted">{hook.secret_version ? `${hook.secret_hint}（明文只在新建、轮换后显示一次）` : '密钥被删了，推送都会被拒收'}</code>
                  )}
                  <Button size="sm" onClick={() => { rotate.reset(); setConfirmRotate(true) }}>{hook.secret_version ? '轮换' : '生成'}</Button>
                </div>
                {secret && <div className="field-hint-line warn-text">明文只在这次打开里看得到，刷新页面后就只剩开头几位，现在复制给外部系统</div>}
                {!secret && hook.secret_version > 0 && (
                  <Field label="测试用的 Secret" hint="已经存在别处的话粘贴进来，只在这个页面里用来给测试推送签名，不保存">
                    <Input type="password" className="mono-input" value={pasted} autoComplete="off" placeholder="whsec_..."
                      onChange={(e) => setPasted(e.target.value)} />
                  </Field>
                )}
                <div className="list-sub">请求头 X-PMW-Signature 带上用 Secret 算的签名，签名不对的推送直接拒收，不进推送记录。</div>
                <details className="curl">
                  <summary>curl 示例</summary>
                  <pre className="io-json">{curlExample(url, parsed.ok ? JSON.stringify(parsed.value) : '{}')}</pre>
                </details>
              </>
            ) : <div className="list-sub">创建后生成接收地址和 Secret，Secret 明文只显示这一次</div>}
          </section>

          <section className="hook-sec" aria-label="字段映射">
            <div className="field-group-title">字段映射<span className="field-hint">写推送 JSON 里的路径，形如 event.title、items[0].name；右边是用测试推送算出来的值</span></div>
            <div className="map-table">
              {FIELDS.map((k) => {
                const v = preview?.[k] ?? ''
                const missing = k === 'title' && (!d.mapping.title.trim() || (!!preview && !v))
                return (
                  <div key={k} className="map-row">
                    <span className="map-k">{FIELD_LABEL[k]}{k === 'title' && <em>*</em>}</span>
                    <Input className="mono-input" aria-label={`${FIELD_LABEL[k]}的路径`} value={d.mapping[k]} invalid={tried && missing}
                      placeholder={k === 'title' ? '必填' : k === 'priority' ? `留空用默认 ${d.defaults.priority}`
                        : k === 'assignee' ? `留空用默认 ${d.defaults.assignee || '未分配'}` : '留空不取'}
                      onChange={(e) => setMap(k, e.target.value)} />
                    <span className={cls('map-v ellipsis', !v && 'map-v-none')} title={v}>{d.mapping[k].trim() ? (v || '取不到值') : '-'}</span>
                  </div>
                )
              })}
            </div>
            <div className="field-row">
              <Field label="默认优先级">
                <Select value={d.defaults.priority} options={prioOptions} onValueChange={(v) => set({ defaults: { ...d.defaults, priority: v } })} />
              </Field>
              <Field label="默认负责人" hint="填干系人名字，名册里对不上就不设负责人">
                <Input value={d.defaults.assignee} placeholder="未分配" onChange={(e) => set({ defaults: { ...d.defaults, assignee: e.target.value } })} />
              </Field>
            </div>
            <div className="list-sub">优先级取到 fatal / critical / 紧急 记为 P0，error / high / 高 记为 P1，warning / 中 记为 P2，info / low / 低 记为 P3。</div>
          </section>

          <section className="hook-sec" aria-label="过滤与去重">
            <div className="field-group-title">过滤与去重</div>
            <Field label={<>只在满足时建任务<span className="field-hint">路径 == 值 或 路径 != 值，留空不过滤</span></>}
              hint={filterRes ? <span className={cls(!filterRes.pass && 'warn-text')}>示例推送：{filterRes.pass ? '满足，会建任务' : filterRes.reason}</span> : undefined}>
              <Input className="mono-input" value={d.filter} placeholder="action == created" onChange={(e) => set({ filter: e.target.value })} />
            </Field>
            <Field label={<>去重字段<span className="field-hint">这个值相同的推送只建一次，防止对方重试造成重复任务</span></>}
              hint={parsed.ok && d.dedupe.trim() ? `示例推送取到：${asText(getPath(parsed.value, d.dedupe)) || '取不到值'}` : undefined}>
              <Input className="mono-input" value={d.dedupe} placeholder="event.id" onChange={(e) => set({ dedupe: e.target.value })} />
            </Field>
          </section>
        </div>

        <div className="hook-col">
          <section className="hook-sec" aria-label="测试推送">
            <div className="field-group-title">测试推送<span className="field-hint">改下面的 JSON 模拟一次推送，会真的建任务并记进推送记录</span></div>
            <Textarea className="json-area mono-area" aria-label="测试推送 JSON" spellCheck={false} rows={10} value={d.sample}
              invalid={!parsed.ok} onChange={(e) => set({ sample: e.target.value })} />
            {!parsed.ok && <div className="field-err">{parsed.error}</div>}
            <div className="act-row">
              <Button variant="primary" size="sm" disabled={creating || !parsed.ok || !signKey || !signable || testing || busy}
                title={testHint || undefined} onClick={() => void test()}>
                {testing ? '推送中' : '发送测试推送'}
              </Button>
              {last && (
                <span className="test-result">
                  <Pill {...RESULT[last.result]} />
                  {last.result === 'created' && last.task_id
                    ? <button type="button" className="link-btn" onClick={() => onOpenTask(last.task_id!)}>{deliveryText(last)}</button>
                    : <span className="list-sub">{last.reason || RESULT[last.result].label}</span>}
                </span>
              )}
            </div>
            {testHint && !last && <div className="field-hint-line">{testHint}</div>}
            {testErr && <div className="field-err" role="alert">{testErr}</div>}
          </section>

          {hook && (
            <section className="hook-sec" aria-label="推送记录">
              <div className="field-group-title">推送记录{logs.data && <span className="field-hint">{total} 次</span>}</div>
              {logs.isError ? <div className="field-err">推送记录没取到：{errorText(logs.error)}</div>
                : logs.isPending ? <div className="io-empty">加载中</div>
                  : mine.length === 0 ? <div className="io-empty">还没有收到推送</div> : (
                    <div className="log-list">
                      {shown.map((x) => (
                        <LogItem key={x.id} d={x} open={openLog === x.id} onToggle={() => setOpenLog(openLog === x.id ? null : x.id)}
                          onOpenTask={onOpenTask} onUse={() => set({ sample: JSON.stringify(x.payload, null, 2) })} />
                      ))}
                      {!allLogs && <ListSegMore n={mine.length - LOG_PAGE} text={`更早的 ${mine.length - LOG_PAGE} 条`} onMore={() => setAllLogs(true)} />}
                      {allLogs && total > mine.length && <div className="io-empty">只列最近 {mine.length} 条，一共 {total} 次</div>}
                    </div>
                  )}
            </section>
          )}
        </div>
      </div>

      <div className="hook-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">删除后这个地址不再接收推送，已建的任务保留</span>
            <span className="spacer" />
            {del.isError && <span className="field-err">没删掉：{errorText(del.error)}</span>}
            <Button onClick={() => setConfirmDel(false)}>取消</Button>
            <Button variant="danger" disabled={del.isPending} onClick={doDelete}>删除</Button>
          </>
        ) : (
          <>
            {!creating && <Button variant="danger-ghost" onClick={() => { del.reset(); setConfirmDel(true) }}>删除 Webhook</Button>}
            <span className="spacer" />
            {tried && err && <span className="field-err">{err}</span>}
            {saveErr && <span className="field-err" role="alert">{saveErr}</span>}
            {creating && <Button onClick={onCancel}>取消</Button>}
            <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
              {creating ? '创建 Webhook' : dirty ? '保存修改' : '已保存'}
            </Button>
          </>
        )}
      </div>

      {hook && (
        <ConfirmDialog open={confirmRotate} title={hook.secret_version ? '轮换 Secret？' : '生成 Secret？'} confirmLabel={hook.secret_version ? '轮换' : '生成'}
          impacts={hook.secret_version ? ['旧的 Secret 立即失效，外部系统要换成新的才推得进来', '新 Secret 明文只显示这一次'] : ['新 Secret 明文只显示这一次']}
          busy={rotate.isPending} onCancel={() => setConfirmRotate(false)} onConfirm={doRotate}>
          {rotate.isError && <div className="field-err" role="alert">没轮换成：{errorText(rotate.error)}</div>}
        </ConfirmDialog>
      )}
    </div>
  )
}

function LogItem({ d, open, onToggle, onOpenTask, onUse }: {
  d: Delivery
  open: boolean
  onToggle: () => void
  onOpenTask: (id: string) => void
  onUse: () => void
}) {
  const mapped = FIELDS.filter((k) => d.mapped[k] !== undefined)
  return (
    <div className={cls('log-item', d.result === 'failed' && 'is-failed')}>
      <button type="button" className="log-head" aria-expanded={open} onClick={onToggle}>
        <Pill {...RESULT[d.result]} />
        <span className="log-what ellipsis">{deliveryText(d)}</span>
        <span className="run-muted">{timeAgo(d.at)}</span>
      </button>
      {open && (
        <div className="log-body">
          {d.reason && <div className="list-sub">{d.reason}</div>}
          {mapped.length > 0 && (
            <div className="log-mapped">
              {mapped.map((k) => <span key={k}><b>{FIELD_LABEL[k]}</b>{d.mapped[k] || <i>空</i>}</span>)}
            </div>
          )}
          <pre className="io-json">{typeof d.payload === 'string' ? d.payload : JSON.stringify(d.payload, null, 2)}</pre>
          <div className="act-row">
            {d.task_id && !d.task_deleted && <Button size="sm" onClick={() => onOpenTask(d.task_id!)}>打开任务 {d.task_ref}</Button>}
            {d.task_id && d.task_deleted && <span className="list-sub">任务 {d.task_ref} 已删除</span>}
            {typeof d.payload !== 'string' && <Button size="sm" variant="ghost" onClick={onUse}>拿来当测试推送</Button>}
          </div>
        </div>
      )}
    </div>
  )
}
