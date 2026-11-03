import { useState } from 'react'
import { CLAUDE_COMMAND_DEFAULT, handoffFiles, renderClaudeCommand } from './handoff'

/* ---------- 设置 > 终端（SPEC-settings-22）：Claude Code 启动命令 ---------- */

/**
 * 任务「交给 Claude Code」选「切换到终端」时，在新开的终端标签里执行的命令。
 * 正式产品是终端插件登记的设置分节（/settings/plugins/terminal/terminal），存在插件设置里（GET / PATCH /api/terminal/settings）
 */
export function TerminalSettingsPage({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [txt, setTxt] = useState(value)
  const [note, setNote] = useState('')
  const effective = txt.trim() || CLAUDE_COMMAND_DEFAULT
  const sample = renderClaudeCommand(effective, { ...handoffFiles('run_示例'), workdir: '/Volumes/project/0xBroleez/pm-workspace' })
  const save = (v: string) => {
    const next = v.trim() || CLAUDE_COMMAND_DEFAULT
    setTxt(next)
    onSave(next)
    setNote(v.trim() ? '已保存，下次「在终端中打开」生效' : '留空等于默认值，已恢复成 gogogo')
  }
  return (
    <div className="sop-settings">
      <div className="sop-settings-title">Claude Code 启动命令</div>
      <div className="field">
        <span className="field-label">命令</span>
        <div className="sop-settings-row">
          <input className="mono-input" aria-label="Claude Code 启动命令" value={txt} placeholder={CLAUDE_COMMAND_DEFAULT} style={{ flex: 1, minWidth: 0 }}
            onChange={(e) => { setTxt(e.target.value); setNote('') }} onKeyDown={(e) => e.key === 'Enter' && save(txt)} />
          <button className="btn btn-outline" disabled={txt.trim() === value} onClick={() => save(txt)}>保存</button>
          <button className="btn btn-ghost" disabled={value === CLAUDE_COMMAND_DEFAULT && txt.trim() === CLAUDE_COMMAND_DEFAULT} onClick={() => save('')}>恢复默认</button>
        </div>
        {note ? <span className="ok-text">{note}</span>
          : <span className="field-hint-line">任务里「交给 Claude Code」选「切换到终端」时，在新开的终端标签里执行这行命令。终端是登录 shell，会加载 ~/.zshrc，所以 shell 别名可以直接用。默认 gogogo；留空保存等于恢复默认</span>}
      </div>
      <div className="field">
        <span className="field-label">占位符</span>
        <ul className="field-hint-line" style={{ margin: 0, paddingLeft: 18 }}>
          <li><code>{'{{prompt_file}}'}</code> 工作台写好的提示词文件路径（任务内容、所属项目的文档和原型位置、回写要求）</li>
          <li><code>{'{{mcp_config}}'}</code> 工作台生成的 MCP 配置文件路径：server 名 pm-workspace，接回当前这个工作台，claude 用它回写进展和结论</li>
          <li><code>{'{{workdir}}'}</code> 这次执行的工作目录（终端标签也开在这里）</li>
          <li>占位符会换成已经加好引号的路径，不用再自己加引号</li>
          <li>没写 <code>{'{{prompt_file}}'}</code> 就在末尾补 <code>{'"$(cat {{prompt_file}})"'}</code>，没写 <code>{'{{mcp_config}}'}</code> 再补 <code>{'--mcp-config {{mcp_config}}'}</code>。提示词放在 --mcp-config 前面：--mcp-config 能接多个值，写在它后面的参数会被它吞掉</li>
        </ul>
      </div>
      <div className="field">
        <span className="field-label">示例</span>
        <ul className="field-hint-line" style={{ margin: 0, paddingLeft: 18 }}>
          <li><code>gogogo</code>（默认）：别名展开是 <code>{'cd /Volumes/docs/Know\\ Me && claude --dangerously-skip-permissions'}</code>，再自动补上提示词和 MCP 配置</li>
          <li><code>{'cd {{workdir}} && claude --mcp-config {{mcp_config}} -- "$(cat {{prompt_file}})"'}</code></li>
          <li><code>{'claude "$(cat {{prompt_file}})" --mcp-config {{mcp_config}}'}</code>（和上一条等价，不切目录）</li>
        </ul>
      </div>
      <div className="field">
        <span className="field-label">实际执行的命令（预览）</span>
        <code className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>{sample}</code>
      </div>
    </div>
  )
}
