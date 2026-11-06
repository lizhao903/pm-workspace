// 设置 > 插件 > 终端（终端插件 0.2.0）：交给 Claude Code「切换到终端」时，在新开的终端标签里执行的启动命令。
// 命令在登录 shell（zsh -l，带 pty，是交互式的）里执行，会读 ~/.zshrc，所以别名能用。留空保存等于恢复默认
import { useState } from 'react'
import { QueryState, errorText, usePatchTerminalSettings, useTerminalSettings, type TerminalSettings } from '../../core/data'
import { Button, Field, Input } from '../../core/ui'
import { commandError, renderClaudeCommand } from './launchModel'
import './settings.css'

type Note = { ok: boolean; text: string }

const SAMPLE = {
  prompt_file: '<数据目录>/tmp/handoff/run_…/prompt.md',
  mcp_config: '<数据目录>/tmp/handoff/run_…/mcp.json',
  workdir: '/Volumes/project/示例项目',
}

export default function TerminalSettingsSection() {
  const settings = useTerminalSettings()
  return (
    <QueryState query={settings} errorTitle="读不到终端的设置">
      {(s) => <Body s={s} />}
    </QueryState>
  )
}

function Body({ s }: { s: TerminalSettings }) {
  const save = usePatchTerminalSettings()
  const [draft, setDraft] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const value = draft ?? s.claude_command
  const bad = commandError(value)
  const changed = !bad && value.trim() !== s.claude_command
  const isDefault = s.claude_command === s.default_claude_command

  const put = (v: string, done: string) => {
    setNote(null)
    save.mutate({ claude_command: v }, {
      onSuccess: () => { setDraft(null); setNote({ ok: true, text: done }) },
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }
  const submit = () => {
    if (bad || !changed || save.isPending) return
    put(value.trim(), value.trim() ? '已保存，下次「切换到终端」就用它' : '已恢复默认')
  }

  return (
    <form className="tset" aria-label="终端设置" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
      <div className="tset-title">Claude Code 启动命令</div>
      <p className="tset-muted">
        任务「交给 Claude Code」选「切换到终端」时，工作台在终端里新开一个标签（目录是这次的工作目录），执行这条命令开一个交互式 Claude Code 会话。
        终端起的是登录 shell，会读 ~/.zshrc，别名可以直接用。
      </p>
      <Field label="命令" wrap={false} error={draft !== null ? bad : undefined} hint={`默认 ${s.default_claude_command}。留空保存等于恢复默认`}>
        <div className="tset-row">
          <Input className="tset-input" aria-label="Claude Code 启动命令" spellCheck={false} value={value} invalid={draft !== null && !!bad}
            onChange={(e) => { setDraft(e.target.value); setNote(null) }} />
          <Button type="submit" variant="outline" size="sm" disabled={!changed || save.isPending}>{save.isPending ? '保存中…' : '保存'}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={isDefault || save.isPending}
            onClick={() => put('', '已恢复默认')}>恢复默认</Button>
        </div>
      </Field>
      {note && <div className={note.ok ? 'tset-ok' : 'tset-err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}

      <div className="tset-sub">实际会执行</div>
      <code className="tset-code" aria-label="实际会执行的命令">{renderClaudeCommand(bad ? s.claude_command : value, SAMPLE)}</code>

      <div className="tset-sub">占位符</div>
      <dl className="tset-dl">
        <dt><code>{'{{prompt_file}}'}</code></dt><dd>工作台写好的提示词文件（任务内容、所属项目的文档和原型目录、回写要求）</dd>
        <dt><code>{'{{mcp_config}}'}</code></dt><dd>工作台生成的 MCP 配置文件：server 名 pmw-run（不和工作目录 .mcp.json 里的 pm-workspace 撞名），接回当前这个工作台，Claude Code 靠它回写进展、产出和结论</dd>
        <dt><code>{'{{workdir}}'}</code></dt><dd>这次执行的工作目录</dd>
      </dl>
      <ul className="tset-list">
        <li>占位符会换成已经加好引号的路径，不用再自己加引号。</li>
        <li>没写 <code>{'{{prompt_file}}'}</code> 就在命令末尾补 <code>{'"$(cat {{prompt_file}})"'}</code>；没写 <code>{'{{mcp_config}}'}</code> 就再补 <code>{'--mcp-config {{mcp_config}}'}</code>。提示词放在前面，因为 --mcp-config 能接多个值，放在它后面的参数会被吞掉。</li>
        <li>临时文件放在工作台数据目录的 tmp/handoff 下，这次执行收尾时删掉。</li>
      </ul>

      <div className="tset-sub">示例</div>
      <ul className="tset-list">
        <li><code>gogogo</code>：默认。本机别名，展开后是 <code>{'cd /Volumes/docs/Know\\ Me && claude --dangerously-skip-permissions'}</code>，再补上提示词和 MCP 配置。</li>
        <li><code>{'cd {{workdir}} && claude "$(cat {{prompt_file}})" --mcp-config {{mcp_config}}'}</code>：在工作目录里开，用 Claude Code 自己的权限确认。</li>
        <li><code>{'claude --permission-mode acceptEdits'}</code>：允许直接改文件，提示词和 MCP 配置自动补在后面。</li>
      </ul>
    </form>
  )
}
