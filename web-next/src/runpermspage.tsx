// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「执行权限」（TSK-0499，SPEC-settings-26）：勾「允许写入」时默认的写入档位（含自动审核）、自定义白名单、
// 自定义硬拦截和内置硬拦截，以及每一档实际放行的规则。
// 原型只放内存（runperms.ts）；正式产品 frontend/src/modules/settings/runperms/RunPermsSection.tsx，接口 GET / PUT /api/run-permissions。
// 执行记录被拒时的「去设置放行」带着规则过来（pending）：预填进白名单、档位切到自定义（已是自动审核的不动，它也认白名单），确认后保存；
// 「去看硬拦截清单」带 focusDeny 过来：滚到硬拦截那一块，内置硬拦截展开（正式产品是 /settings/run-permissions#deny）。
import { useEffect, useState } from 'react'
import { PageTitle } from './topbar'
import {
  BUILTIN_DENY, MCP_SERVER, PROFILE_LABEL, WRITE_PROFILE_OPTIONS, allowedOf, denyRulesIssue, parseRules, ruleIssue, saveRunPerms, useRunPerms,
  type RunPermission, type RunWriteProfile,
} from './runperms'

export function RunPermsPage({ pending = [], focusDeny = false }: { pending?: string[]; focusDeny?: boolean }) {
  const saved = useRunPerms()
  const incoming = pending.filter((r) => !saved.custom.includes(r))
  // 自动审核档也认自定义白名单：已经是自动审核时带规则过来不切档位
  const [profile, setProfile] = useState<RunWriteProfile>(incoming.length && saved.write_profile !== 'auto' ? 'custom' : saved.write_profile)
  const [text, setText] = useState([...saved.custom, ...incoming].join('\n'))
  const [denyText, setDenyText] = useState(saved.deny.join('\n'))
  const [note, setNote] = useState('')
  useEffect(() => {
    if (focusDeny) document.getElementById('deny')?.scrollIntoView({ block: 'start' })
  }, [focusDeny])
  const rules = parseRules(text)
  const deny = parseRules(denyText)
  const issue = rules.map(ruleIssue).find((e) => e) ?? (rules.length > 100 ? '自定义白名单最多 100 条' : '')
  const denyIssue = denyRulesIssue(deny)
  const changed = profile !== saved.write_profile || JSON.stringify(rules) !== JSON.stringify(saved.custom) || JSON.stringify(deny) !== JSON.stringify(saved.deny)
  const builtinCount = BUILTIN_DENY.reduce((n, g) => n + g.rules.length, 0)
  const save = () => {
    if (issue || denyIssue || !changed) return
    saveRunPerms({ write_profile: profile, custom: rules, deny })
    setNote(`已保存：默认写入档位「${PROFILE_LABEL[profile]}」，自定义白名单 ${rules.length} 条，自定义硬拦截 ${deny.length} 条`)
  }
  return (
    <div className="page page-fill up-page">
      <PageTitle parent="设置" desc="任务交给 Claude Code 后台执行时放行什么、硬拦什么：工作台 MCP、只读命令、按档位再放开改文件、测试构建、自定义白名单或交给自动审核；硬拦截每一档都生效">执行权限</PageTitle>
      <div className="list-sub">
        后台执行没人值守，需要确认的调用会被直接拒绝。所以每一档都放行工作台 MCP（server 名 {MCP_SERVER}：读任务、记进展、登记产出、回写结论）
        和一份只读命令白名单；不勾「允许写入」就是只读档。任何档位都不用 --dangerously-skip-permissions。
        管道、&amp;&amp; 连起来的命令按每一段分别判定，每段都要在白名单里；写文件的重定向（&gt; 文件）在只读档照旧被拒。
        「自动审核」档白名单外的调用不再一律被拒，由 Claude Code 按这次任务的意图决定；它对提示词里明说要做的事基本都放行，所以危险操作靠下面的硬拦截兜底。
      </div>
      {incoming.length > 0 && <div className="up-card">从执行记录带来 {incoming.length} 条待放行的规则，已加在白名单末尾{saved.write_profile === 'auto' ? '（自动审核档也认白名单，档位不动）' : '，写入档位切到「自定义白名单」'}；确认无误后保存。</div>}
      <label className="field">
        <span className="field-label">勾「允许写入」时默认的写入档位</span>
        <select className="select" value={profile} onChange={(e) => { setProfile(e.target.value as RunWriteProfile); setNote('') }}>
          {WRITE_PROFILE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="list-sub">交给 Claude Code 的弹窗里还能逐次改；SOP 的 Claude Code 节点「可写」时也用这一档</span>
      </label>
      <label className="field">
        <span className="field-label">自定义白名单</span>
        <textarea className={issue ? 'bad mono' : 'mono'} rows={6} value={text} spellCheck={false} placeholder={'Bash(git add:*)\nBash(git commit:*)'}
          onChange={(e) => { setText(e.target.value); setNote('') }} />
        {issue ? <span className="field-err">{issue}</span>
          : <span className="list-sub">一行一条 Claude Code 权限规则，在「自定义白名单」和「自动审核」档生效（自动审核档里白名单内的直接放行、不送审）。如 Bash(git commit:*)、Bash(make deploy:*)、mcp__slack、WebFetch、Read(//别处的目录/**)。只跟某个项目有关的脚本，录在项目档案的「执行白名单」里，只对那个项目的任务生效</span>}
      </label>
      <div id="deny" style={{ display: 'flex', flexDirection: 'column', gap: 12, scrollMarginTop: 16 }}>
        <label className="field">
          <span className="field-label">自定义硬拦截</span>
          <textarea className={denyIssue ? 'bad mono' : 'mono'} rows={4} value={denyText} spellCheck={false} placeholder={'Bash(git -C /别的仓库 push:*)\nBash(bash -c*)'}
            aria-label="自定义硬拦截" onChange={(e) => { setDenyText(e.target.value); setNote('') }} />
          {denyIssue ? <span className="field-err">{denyIssue}</span>
            : <span className="list-sub">一行一条，写法同白名单；每一档都生效，优先于白名单、项目执行白名单和自动审核，命中的一律被拒。可以写宽规则（如 Bash(*)，等于后台执行不许跑任何命令），但不能挡掉整个工作台 MCP。包一层的写法（bash -c、sh -c、eval）内置清单管不到，要挡就加在这里</span>}
        </label>
        <details className="up-card" open={focusDeny || undefined} data-deny="builtin">
          <summary>内置硬拦截<span className="list-sub"> · 删不掉 · {builtinCount} 条</span></summary>
          {BUILTIN_DENY.map((g) => (
            <div key={g.key} data-group={g.key} style={{ marginTop: 12 }}>
              <div className="list-sub">{g.label}</div>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{g.rules.join('\n')}</pre>
            </div>
          ))}
        </details>
      </div>
      <div className="act-row">
        <span className="spacer" />
        {changed && <button className="btn btn-ghost" onClick={() => { setProfile(saved.write_profile); setText(saved.custom.join('\n')); setDenyText(saved.deny.join('\n')); setNote('') }}>撤销改动</button>}
        <button className="btn" disabled={!changed || !!issue || !!denyIssue} onClick={save}>保存</button>
      </div>
      {note && <div className="list-sub" role="status">{note}</div>}
      <div className="field-label">每一档实际放行的命令</div>
      {(['read_only', 'accept_edits', 'edits_and_tests', 'custom', 'auto'] as RunPermission[]).map((p) => {
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
