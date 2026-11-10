// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「执行权限」（TSK-0499，SPEC-settings-26）：勾「允许写入」时默认的写入档位、自定义白名单，以及每一档实际放行的规则。
// 原型只放内存（runperms.ts）；正式产品 frontend/src/modules/settings/runperms/RunPermsSection.tsx，接口 GET / PUT /api/run-permissions。
// 执行记录被拒时的「去设置放行」带着规则过来（pending）：预填进白名单、档位切到自定义，确认后保存。
import { useState } from 'react'
import { PageTitle } from './topbar'
import { MCP_SERVER, PROFILE_LABEL, WRITE_PROFILE_OPTIONS, allowedOf, parseRules, ruleIssue, saveRunPerms, useRunPerms, type RunPermission, type RunWriteProfile } from './runperms'

export function RunPermsPage({ pending = [] }: { pending?: string[] }) {
  const saved = useRunPerms()
  const incoming = pending.filter((r) => !saved.custom.includes(r))
  const [profile, setProfile] = useState<RunWriteProfile>(incoming.length ? 'custom' : saved.write_profile)
  const [text, setText] = useState([...saved.custom, ...incoming].join('\n'))
  const [note, setNote] = useState('')
  const rules = parseRules(text)
  const issue = rules.map(ruleIssue).find((e) => e) ?? (rules.length > 100 ? '自定义白名单最多 100 条' : '')
  const changed = profile !== saved.write_profile || JSON.stringify(rules) !== JSON.stringify(saved.custom)
  const save = () => {
    if (issue || !changed) return
    saveRunPerms({ write_profile: profile, custom: rules })
    setNote(`已保存：默认写入档位「${PROFILE_LABEL[profile]}」，自定义白名单 ${rules.length} 条`)
  }
  return (
    <div className="page page-fill up-page">
      <PageTitle parent="设置" desc="任务交给 Claude Code 后台执行时放行什么：工作台 MCP、只读命令、按档位再放开改文件、测试构建或自定义白名单">执行权限</PageTitle>
      <div className="list-sub">
        后台执行没人值守，需要确认的调用会被直接拒绝。所以每一档都放行工作台 MCP（server 名 {MCP_SERVER}：读任务、记进展、登记产出、回写结论）
        和一份只读命令白名单；不勾「允许写入」就是只读档。任何档位都不用 --dangerously-skip-permissions。
        管道、&amp;&amp; 连起来的命令按每一段分别判定，每段都要在白名单里；写文件的重定向（&gt; 文件）在只读档照旧被拒。
      </div>
      {incoming.length > 0 && <div className="up-card">从执行记录带来 {incoming.length} 条待放行的规则，已加在白名单末尾，写入档位切到「自定义白名单」；确认无误后保存。</div>}
      <label className="field">
        <span className="field-label">勾「允许写入」时默认的写入档位</span>
        <select className="select" value={profile} onChange={(e) => { setProfile(e.target.value as RunWriteProfile); setNote('') }}>
          {WRITE_PROFILE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="list-sub">交给 Claude Code 的弹窗里还能逐次改</span>
      </label>
      <label className="field">
        <span className="field-label">自定义白名单</span>
        <textarea className={issue ? 'bad mono' : 'mono'} rows={6} value={text} spellCheck={false} placeholder={'Bash(git add:*)\nBash(git commit:*)'}
          onChange={(e) => { setText(e.target.value); setNote('') }} />
        {issue ? <span className="field-err">{issue}</span>
          : <span className="list-sub">一行一条 Claude Code 权限规则，只在「自定义白名单」档生效。如 Bash(git commit:*)、Bash(make deploy:*)、mcp__slack、WebFetch</span>}
      </label>
      <div className="act-row">
        <span className="spacer" />
        {changed && <button className="btn btn-ghost" onClick={() => { setProfile(saved.write_profile); setText(saved.custom.join('\n')); setNote('') }}>撤销改动</button>}
        <button className="btn" disabled={!changed || !!issue} onClick={save}>保存</button>
      </div>
      {note && <div className="list-sub" role="status">{note}</div>}
      <div className="field-label">每一档实际放行的命令</div>
      {(['read_only', 'accept_edits', 'edits_and_tests', 'custom'] as RunPermission[]).map((p) => {
        const allowed = allowedOf(p, saved.custom)
        return (
          <details key={p} className="up-card">
            <summary>{PROFILE_LABEL[p]}<span className="list-sub">{p === 'read_only' ? ' · 不改文件' : ' · 放开文件编辑'} · {allowed.length} 条</span></summary>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{[`mcp__${MCP_SERVER}`, ...allowed].join('\n')}</pre>
          </details>
        )
      })}
    </div>
  )
}
