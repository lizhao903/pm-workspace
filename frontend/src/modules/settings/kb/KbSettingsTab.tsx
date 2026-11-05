// 知识库详情的「设置」标签（SPEC-settings-13）：来源分类、本地目录、切分方式、向量化模型、挂了这个库的 Agent。
// 和原型不同的地方（后端决定的）：
// - 本地目录存不存在、有没有读权限由后端判，挂上时报「找不到这个目录」「没有读权限」，不加进来。
// - 后端只做关键词检索，向量化模型只存不用，换模型不会让文档变待索引。
// - 改切分不自动重新索引，段数会变的文档给「重新索引这 N 篇」。
// - 大目录同步分批跑，同步（含挂上新目录时的同步）没回来前每秒查一次进度，显示在那个目录下。
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  errorText, useAgentProviders, useKbAgents, useKbSyncProgress, usePatchKb, useProviderChecks, useSyncKb, type KbDoc, type KbSettingsInput,
  type KbSyncProgress, type KnowledgeBase,
} from '../../../core/data'
import { Avatar, Button, cls, Input, SearchSelect, Select, Switch } from '../../../core/ui'
import { statusOf } from '../providers/model'
import { ago, checkDir, CHUNK_SIZES, embedOptions, embedValue, fitOverlap, OVERLAPS, parseEmbed, splitChunks } from './model'
import { SourceTags } from './parts'

export function KbSettingsTab({ kb, docs, editing, onEdit, onReindex }: {
  kb: KnowledgeBase
  docs: KbDoc[]
  editing: boolean
  onEdit: () => void
  onReindex: (ids: string[]) => void
}) {
  const navigate = useNavigate()
  const s = kb.settings
  const patch = usePatchKb()
  const sync = useSyncKb()
  const progressQ = useKbSyncProgress(kb.id, sync.isPending || patch.isPending)
  const progress = sync.isPending || patch.isPending ? progressQ.data ?? null : null
  const providersQ = useAgentProviders()
  const providers = useMemo(() => providersQ.data ?? [], [providersQ.data])
  const checks = useProviderChecks(providers)
  const agentsQ = useKbAgents()
  const [dir, setDir] = useState('')
  const [dirErr, setDirErr] = useState('')
  const [confirmDir, setConfirmDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const set = (p: KbSettingsInput, opts: { onError?: (e: unknown) => void; onSuccess?: () => void } = {}) => {
    setError(null)
    patch.mutate({ id: kb.id, patch: { settings: p } }, { onError: opts.onError ?? ((e) => setError(errorText(e))), onSuccess: opts.onSuccess })
  }
  const dirsBody = (dirs: { path: string; auto_sync: boolean }[]) => dirs.map((d) => ({ path: d.path, auto_sync: d.auto_sync }))

  const addDir = () => {
    const c = checkDir(dir, s.dirs)
    if (c.error) { setDirErr(c.error); return }
    setDirErr('')
    // 失败时输入框留着改
    set({ dirs: [...dirsBody(s.dirs), { path: c.path, auto_sync: true }] }, { onError: (e) => setDirErr(errorText(e)), onSuccess: () => setDir('') })
  }
  const syncDir = (path: string) => {
    setError(null)
    setNote(null)
    sync.mutate({ id: kb.id, path }, {
      onSuccess: ({ result: r }) => {
        const errs = Object.values(r.errors ?? {})
        setNote(errs.length ? `同步出错：${errs.join('；')}` : `同步完了：新收 ${r.added} 篇，更新 ${r.updated} 篇，移出 ${r.removed} 篇${r.failed ? `，${r.failed} 篇失败` : ''}`)
      },
      onError: (e) => setError(`同步失败：${errorText(e)}`),
    })
  }
  const removeDir = (path: string) => {
    set({ dirs: dirsBody(s.dirs.filter((d) => d.path !== path)) })
    setConfirmDir(null)
  }

  // 按当前切分，现有文档共多少段；上次索引后段数会变的文档
  const sized = useMemo(() => docs.map((d) => ({ d, n: splitChunks(d.text, s.chunk_size, s.overlap).length })), [docs, s.chunk_size, s.overlap])
  const total = sized.filter((x) => x.d.status !== 'failed').reduce((n, x) => n + x.n, 0)
  const resized = sized.filter((x) => x.d.status === 'indexed' && x.d.chunks !== x.n).map((x) => x.d)
  const pending = docs.filter((d) => d.status === 'pending')

  const embeds = embedOptions(providers)
  const pv = providers.find((p) => p.id === s.embed.provider_id)
  const pvStatus = pv ? statusOf(pv, checks[pv.id]) : undefined
  const hasEmbed = !!s.embed.provider_id

  const agentInfo = new Map((agentsQ.data ?? []).map((a) => [a.id, a]))

  return (
    <div className="kbx-settings">
      {(error || note) && <div className={cls('kbx-alert', error ? 'kbx-alert-bad' : 'kbx-alert-info', 'kbx-wide')} role={error ? 'alert' : 'status'}>{error ?? note}</div>}
      <section className="kbx-sec" aria-label="来源">
        <div className="kbx-sec-title">来源</div>
        <div className="kbx-set-line">
          <span className="kbx-set-label">文档分类</span>
          <SourceTags ids={kb.sources} empty="没选分类" />
          <span className="spacer" />
          <Button size="sm" variant={editing ? 'primary' : 'outline'} aria-pressed={editing} onClick={onEdit}>修改</Button>
        </div>
        <div className="kbx-switch-row">
          <span>分类里新加的文档自动收进来<span className="kbx-hint">关掉后只收手动加的；「文档」页顶上会提示还没收进来的篇目</span></span>
          <Switch checked={s.auto_sync} aria-label="分类里新加的文档自动收进来" onCheckedChange={(v) => set({ auto_sync: v })} />
        </div>
        <div className="kbx-set-label">本地目录<span className="kbx-hint">只收 .md、.txt 文件</span></div>
        {s.dirs.length ? (
          <div className="kbx-dirs">
            {s.dirs.map((d) => (
              <div key={d.path} className="kbx-dir" data-dir={d.path}>
                <span className="kbx-dir-main">
                  <code className="ellipsis" title={d.path}>{d.path}</code>
                  <span className="kb-muted">{d.files} 个文件{d.synced_at && ` · ${ago(d.synced_at)}同步`}</span>
                  {progress?.dir === d.path && <span className="kb-muted kbx-dir-progress" role="status">{progressText(progress)}</span>}
                </span>
                {confirmDir === d.path ? (
                  <span className="kbx-dir-ops">
                    <span className="danger-text">{d.files ? `目录里的 ${d.files} 篇会一起移出` : '移除这个目录'}</span>
                    <Button size="sm" variant="danger" onClick={() => removeDir(d.path)}>移除</Button>
                    <Button size="sm" onClick={() => setConfirmDir(null)}>取消</Button>
                  </span>
                ) : (
                  <span className="kbx-dir-ops">
                    <Switch checked={d.auto_sync} title="目录里的文件有变动时自动重新索引"
                      onCheckedChange={(v) => set({ dirs: dirsBody(s.dirs.map((x) => (x.path === d.path ? { ...x, auto_sync: v } : x))) })}>自动同步</Switch>
                    <Button size="sm" disabled={sync.isPending} onClick={() => syncDir(d.path)}>{sync.isPending && sync.variables?.path === d.path ? '同步中…' : '立即同步'}</Button>
                    <Button size="sm" onClick={() => setConfirmDir(d.path)}>移除</Button>
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : <div className="kbx-empty">还没挂本地目录</div>}
        {progress && !s.dirs.some((d) => d.path === progress.dir) && (
          <div className="kb-muted kbx-dir-progress" role="status">{progress.dir ? `${progress.dir} · ` : '文档分类 · '}{progressText(progress)}</div>
        )}
        <div className="kbx-search-line">
          <Input className="kb-mono" value={dir} invalid={!!dirErr} aria-label="本地目录" placeholder="/Volumes/docs/example-client"
            onChange={(e) => { setDir(e.target.value); setDirErr('') }} onKeyDown={(e) => { if (e.key === 'Enter' && dir.trim()) addDir() }} />
          <Button disabled={!dir.trim() || patch.isPending} onClick={addDir}>挂上目录</Button>
        </div>
        {dirErr && <span className="field-err">{dirErr}</span>}
      </section>

      <section className="kbx-sec" aria-label="切分方式">
        <div className="kbx-sec-title">切分方式<span className="kbx-hint">检索按段来找；段太长答案不准，段太短上下文不够</span></div>
        <div className="kbx-fields">
          <label className="field"><span className="field-label">每段多少字</span>
            <Select value={String(s.chunk_size)} options={CHUNK_SIZES.map((x) => ({ value: String(x), label: `${x} 字` }))}
              onValueChange={(v) => { const n = Number(v); set({ chunk_size: n, overlap: fitOverlap(n, s.overlap) }) }} />
          </label>
          <label className="field"><span className="field-label">段间重叠</span>
            <Select value={String(s.overlap)} options={OVERLAPS.filter((x) => x <= s.chunk_size / 2).map((x) => ({ value: String(x), label: x ? `${x} 字` : '不重叠' }))}
              onValueChange={(v) => set({ overlap: Number(v) })} />
          </label>
        </div>
        <span className="kb-muted">按这个设置，现有文档共切成 {total} 段；尽量在换行和句号处断开</span>
        {resized.length > 0 && (
          <div className="kbx-alert kbx-alert-warn">
            <span><b>有 {resized.length} 篇段数变了</b>重新索引后检索才按新的切分</span>
            <Button size="sm" onClick={() => onReindex(resized.map((d) => d.id))}>重新索引这 {resized.length} 篇</Button>
          </div>
        )}
      </section>

      <section className="kbx-sec" aria-label="向量化模型">
        <div className="kbx-sec-title">向量化模型<span className="kbx-hint">现在检索按关键词打分，这里先记下以后算向量用的模型</span></div>
        <SearchSelect variant="field" value={hasEmbed ? embedValue(s.embed.provider_id, s.embed.model) : ''} placeholder="选一个向量化模型" searchPlaceholder="搜服务商或模型"
          options={embeds.map((x) => {
            const st = statusOf(x.provider, checks[x.provider.id])
            return {
              value: embedValue(x.provider.id, x.model), label: `${x.provider.name} · ${x.model}`, group: x.provider.name, keywords: x.kindLabel,
              hint: st === 'error' ? '连接异常' : st === 'untested' ? '未测试' : undefined,
            }
          })}
          emptyText="还没有能做向量化的服务商，到「设置 / 模型服务商」接一个"
          missingLabel={() => `${s.embed.model}（服务商已删除）`}
          onChange={(v) => { if (v) set({ embed: parseEmbed(v) }) }} />
        {pv && pvStatus === 'error' && (
          <div className="kbx-alert kbx-alert-bad"><span><b>{pv.name} 连接异常</b>{checks[pv.id]?.result.message ?? ''}；重新索引会失败，换一个模型或先修好服务商</span></div>
        )}
        {hasEmbed && providersQ.data && (!pv || !pv.enabled) && (
          <div className="kbx-alert kbx-alert-bad"><span>当前用的服务商已停用或删除，换一个模型</span></div>
        )}
        {pending.length > 0 && (
          <div className="kbx-alert kbx-alert-warn">
            <span><b>{pending.length} 篇待索引</b>{hasEmbed ? `用 ${s.embed.model} 重新算向量` : '按当前切分重新切段'}</span>
            <Button size="sm" onClick={() => onReindex(pending.map((d) => d.id))}>开始索引</Button>
          </div>
        )}
      </section>

      <section className="kbx-sec" aria-label="挂了这个知识库的 Agent">
        <div className="kbx-sec-title">挂了这个知识库的 Agent<span className="kbx-hint">在 Agent 配置里挂、卸</span></div>
        {kb.agents.length ? (
          <div className="kbx-agents">
            {kb.agents.map((a) => {
              const info = agentInfo.get(a.id)
              return (
                <button key={a.id} type="button" className="kbx-agent" title="打开 Agent 配置"
                  onClick={() => { void navigate(`/settings/agents?agent=${encodeURIComponent(a.id)}`) }}>
                  <Avatar name={a.name} size={28} />
                  <span className="kbx-agent-text">
                    <b className="ellipsis">{a.name}</b>
                    {info?.desc && <span className="kb-muted ellipsis">{info.desc}</span>}
                  </span>
                  {info && !info.enabled && <span className="tag">已停用</span>}
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )
            })}
          </div>
        ) : <div className="kbx-empty">还没有 Agent 挂这个知识库，到「设置 / Agent」里挂</div>}
      </section>
    </div>
  )
}

/** 同步进度的一句话：还在列时总数还会涨 */
function progressText(p: KbSyncProgress): string {
  if (!p.listed && p.listing) return '正在列目录…'
  return `正在同步：已处理 ${p.done} / ${p.listed}${p.listing ? '+' : ''} 个文件`
}
