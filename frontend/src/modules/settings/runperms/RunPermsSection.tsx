// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「执行权限」（TSK-0499，SPEC-settings-26）：任务交给 Claude Code 后台执行（claude -p，没人值守）时放行什么。
// 上面选「允许写入」时默认的写入档位，下面是自定义白名单（一行一条 Claude Code 权限规则，只在「自定义白名单」档生效）；
// 再往下列出每一档实际放行的规则（GET /api/run-permissions 给的，不在前端另抄）。保存整体替换（PUT）。
// 执行记录被拒时的「去设置放行」带 ?add=<规则> 过来：预填进白名单、写入档位切到自定义，用户确认后保存。
import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { errorText, useRunPermissions, useSaveRunPermissions, type RunPermissions, type RunWriteProfile } from '../../../core/data'
import { Button, ErrorState, Field, LoadingState, PageTitle, Select, Textarea } from '../../../core/ui'
import { WRITE_PROFILE_OPTIONS } from '../../tasks/handoffModel'
import { parseRules, pendingRules, rulesIssue } from './permsModel'
import './runperms.css'

type Note = { ok: boolean; text: string }

export function RunPermsSection() {
  const q = useRunPermissions()
  const title = <PageTitle parent="设置" desc="任务交给 Claude Code 后台执行时放行什么：工作台 MCP、只读命令、按档位再放开改文件、测试构建或自定义白名单">执行权限</PageTitle>
  if (q.isPending) return <div className="rperm-page">{title}<LoadingState /></div>
  if (q.isError) return <div className="rperm-page">{title}<ErrorState title="执行权限没加载出来" error={errorText(q.error)} onRetry={() => void q.refetch()} /></div>
  // 不按数据换 key：保存后缓存更新时表单留着（草稿已和保存的一致），「已保存」的提示不被冲掉
  return <PermsForm saved={q.data} title={title} />
}

function PermsForm({ saved, title }: { saved: RunPermissions; title: ReactNode }) {
  const save = useSaveRunPermissions()
  const [params, setParams] = useSearchParams()
  // 地址带来的待加规则：预填一次，用户可以删
  const [incoming] = useState(() => pendingRules(params.get('add'), saved.custom))
  const [profile, setProfile] = useState<RunWriteProfile>(incoming.length ? 'custom' : saved.write_profile)
  const [text, setText] = useState(() => [...saved.custom, ...incoming].join('\n'))
  const [note, setNote] = useState<Note | null>(null)
  const rules = parseRules(text)
  const issue = rulesIssue(rules)
  const changed = profile !== saved.write_profile || JSON.stringify(rules) !== JSON.stringify(saved.custom)

  const submit = () => {
    setNote(null)
    if (issue || !changed || save.isPending) return
    save.mutate({ write_profile: profile, custom: rules }, {
      onSuccess: (v) => {
        setNote({ ok: true, text: `已保存：默认写入档位「${WRITE_PROFILE_OPTIONS.find((o) => o.value === v.write_profile)?.label ?? v.write_profile}」，自定义白名单 ${v.custom.length} 条` })
        if (params.has('add')) { params.delete('add'); setParams(params, { replace: true }) }
      },
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }

  return (
    <form className="rperm-page" aria-label="执行权限" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
      {title}
      <div className="rperm-muted">
        后台执行没人值守，需要确认的调用会被直接拒绝。所以每一档都放行工作台 MCP（server 名 {saved.mcp_server}：读任务、记进展、登记产出、回写结论）
        和一份只读命令白名单；不勾「允许写入」就是只读档。任何档位都不用 --dangerously-skip-permissions。
        管道、&& 连起来的命令按每一段分别判定，每段都要在白名单里；写文件的重定向（&gt; 文件）在只读档照旧被拒。
      </div>
      {incoming.length > 0 && (
        <div className="rperm-incoming" role="status">
          从执行记录带来 {incoming.length} 条待放行的规则，已加在白名单末尾，写入档位切到「自定义白名单」；确认无误后保存。
        </div>
      )}
      <Field label="勾「允许写入」时默认的写入档位" hint="交给 Claude Code 的弹窗里还能逐次改">
        <Select value={profile} aria-label="默认写入档位" options={WRITE_PROFILE_OPTIONS}
          onValueChange={(v) => { setProfile(v as RunWriteProfile); setNote(null) }} />
      </Field>
      <Field label="自定义白名单" error={issue || undefined}
        hint="一行一条 Claude Code 权限规则，只在「自定义白名单」档生效。如 Bash(git commit:*)、Bash(make deploy:*)、mcp__slack、WebFetch">
        <Textarea rows={6} value={text} aria-label="自定义白名单" spellCheck={false} invalid={!!issue}
          placeholder={'Bash(git add:*)\nBash(git commit:*)'} onChange={(e) => { setText(e.target.value); setNote(null) }} />
      </Field>
      <div className="rperm-actions">
        <span className="spacer" />
        {changed && <Button size="sm" variant="ghost" onClick={() => { setProfile(saved.write_profile); setText(saved.custom.join('\n')); setNote(null) }}>撤销改动</Button>}
        <button type="submit" className="btn btn-outline btn-sm" disabled={!changed || !!issue || save.isPending}>{save.isPending ? '保存中…' : '保存'}</button>
      </div>
      {note && <div className={note.ok ? 'rperm-ok' : 'rperm-err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
      <div className="rperm-sub">每一档实际放行的命令</div>
      <div className="rperm-profiles">
        {saved.profiles.map((p) => (
          <details key={p.key} className="rperm-profile" data-profile={p.key}>
            <summary>{p.label}<span className="rperm-muted">{p.writes ? ' · 放开文件编辑' : ' · 不改文件'} · {p.allowed.length} 条</span></summary>
            <code className="rperm-rules">{[`mcp__${saved.mcp_server}`, ...p.allowed].join('\n')}</code>
          </details>
        ))}
      </div>
    </form>
  )
}
