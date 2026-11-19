// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目档案（AUTO-04，SPEC-projects-15）：给分类 Agent 和各 pipeline 用的项目信息。
// 和设置一样边改边存，没有「保存」按钮。目录存在性由正式产品的后端校验，原型不查，只说明规则。
// 末尾是原型同步（AUTO-11，protosync.tsx）。
import { useState } from 'react'
import './projectprofile.css'
import type { Contact } from './data'
import { PathInput } from './projects'
import { EMPTY_PROFILE, PLATFORM_PRESETS, PROFILE_COMMAND_GROUPS, PROFILE_COMMANDS, type Project, type ProjectProfile, type ProfileCommandKey } from './projectdata'
import { ProtoSyncSection } from './protosync'
import { SearchSelect } from './searchselect'
import { Avatar, GrowArea, cls } from './ui'

const DIRS = [
  { key: 'code_dir', label: '代码库目录', hint: '研发 pipeline 在这里改代码、跑命令；不填时沿用项目目录' },
  { key: 'proto_dir', label: '原型库目录', hint: '产品 Agent 写原型、发布后回写原型的地方' },
  { key: 'prd_dir', label: 'PRD 目录', hint: '产品 Agent 写 PRD 的地方' },
] as const

/** 逗号（全角半角）、顿号、换行拆开，去空去重 */
const splitTags = (s: string) => {
  const seen = new Set<string>()
  return s.split(/[,，、\n]/).map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
}
const isPreset = (x: string) => PLATFORM_PRESETS.some((p) => p.toLowerCase() === x.toLowerCase())

/** 执行白名单原文 → 规则数组：按行拆，去首尾空白、去空、去重（同正式产品 profileModel.runAllowOf） */
const runAllowOf = (s: string) => {
  const out: string[] = []
  for (const raw of s.split('\n')) { const x = raw.trim(); if (x && !out.includes(x)) out.push(x) }
  return out
}
/** 一眼就不行的规则：Bash、Bash(*) 这类等于放开任意命令的；有的话这一项先不存（SPEC-projects-15.8a） */
const runAllowError = (s: string) => {
  const bad = runAllowOf(s).find((r) => r === 'Bash' || /^Bash\(\s*([*:].*)?\)$/.test(r))
  return bad ? `「${bad}」等于放开任意命令，不收；按命令前缀写，如 Bash(./scripts/check.sh:*)` : ''
}

export function ProjectProfileTab({ p, contacts, onChange }: { p: Project; contacts: Contact[]; onChange: (x: Partial<Project>) => void }) {
  const pf = p.profile ?? EMPTY_PROFILE
  const set = (x: Partial<ProjectProfile>) => onChange({ profile: { ...pf, ...x } })
  // 关键词、其他平台、超时边输边拆会吃掉正在输的逗号，输入框留原文
  const [kw, setKw] = useState(pf.keywords.join('，'))
  const [other, setOther] = useState(pf.platforms.filter((x) => !isPreset(x)).join('，'))
  // 执行白名单输入框留原文，合规时才存成数组（TSK-0837）
  const [allow, setAllow] = useState((pf.run_allow ?? []).join('\n'))
  const allowErr = runAllowError(allow)
  const [timeouts, setTimeouts] = useState<Partial<Record<ProfileCommandKey, string>>>(
    Object.fromEntries(PROFILE_COMMANDS.map(({ key }) => [key, pf.commands[key]?.timeout_sec ? String(pf.commands[key]!.timeout_sec) : ''])))
  const presets = pf.platforms.filter(isPreset)
  const setCmd = (key: ProfileCommandKey, x: Partial<{ command: string; dir: string; timeout_sec: number; ready: string }>) => {
    const cur = pf.commands[key] ?? { command: '', dir: '', timeout_sec: 0 }
    const next = { ...cur, ...x }
    const commands = { ...pf.commands, [key]: next }
    if (!next.command.trim()) delete commands[key]
    set({ commands })
  }
  const options = contacts.map((c) => ({ value: c.id, label: c.name, hint: c.company, keywords: c.title, icon: <Avatar name={c.name} size={18} src={c.photo} /> }))

  return (
    <div className="form proj-settings proj-profile">
      <section className="hook-sec">
        <div className="field-group-title">分类信息<span className="field-hint">新需求、IM 消息进来时，分类 Agent 按这些判断属于哪个项目</span></div>
        <label className="field"><span className="field-label">简介</span>
          <textarea rows={3} value={pf.intro} placeholder="这个项目做什么、给谁用、边界在哪；比设置里的一句话说明写得更全" onChange={(e) => set({ intro: e.target.value })} />
        </label>
        <label className="field"><span className="field-label">关键词<span className="field-hint">用逗号或顿号隔开：产品名、模块名、客户名、常说的叫法</span></span>
          <input value={kw} placeholder="工作台，需求管理，原型" onChange={(e) => { setKw(e.target.value); set({ keywords: splitTags(e.target.value) }) }} />
        </label>
        <div className="field"><span className="field-label">平台</span>
          <div className="proj-profile-chips">
            {PLATFORM_PRESETS.map((x) => {
              const on = presets.includes(x)
              return <button key={x} type="button" className={cls('chip', on && 'chip-on')} aria-pressed={on}
                onClick={() => set({ platforms: on ? pf.platforms.filter((y) => y !== x) : [...pf.platforms, x] })}>{x}</button>
            })}
            <input className="proj-profile-other" value={other} placeholder="其他，逗号隔开" aria-label="其他平台"
              onChange={(e) => { setOther(e.target.value); set({ platforms: [...presets, ...splitTags(e.target.value).filter((x) => !isPreset(x))] }) }} />
          </div>
        </div>
      </section>

      <section className="hook-sec">
        <div className="field-group-title">目录<span className="field-hint">本机绝对路径，要已经存在；软链可以</span></div>
        {DIRS.map((d) => (
          <div key={d.key} className="field">
            <span className="field-label">{d.label}<span className="field-hint">{d.key === 'code_dir' && p.root ? `不填时沿用项目目录 ${p.root}` : d.hint}</span></span>
            <PathInput value={pf[d.key]} placeholder={d.key === 'code_dir' && p.root ? '留空沿用项目目录' : '/Users/me/projects/xxx'} onChange={(v) => set({ [d.key]: v })} />
            {/* 原型库规则（TSK-0841 复盘，SPEC-projects-15.5a）：目录没设时也能写，但提示词里只有设了目录的原型库才出现 */}
            {d.key === 'proto_dir' && (
              <label className="field proj-proto-rules-field"><span className="field-label">原型库规则<span className="field-hint">交给 Claude Code 时写进提示词、跟在原型库后面；一行一条</span></span>
                <GrowArea rows={3} value={pf.proto_rules ?? ''} aria-label="原型库规则"
                  placeholder={'新需求在这个基线上拉 cloud-v<MMDD>-<nn> 分支改，不做独立 HTML\n以 UI-chat 设计为准\n改完在原型仓提交'}
                  onChange={(e) => set({ proto_rules: e.target.value })} />
                {(pf.proto_rules ?? '').trim().length > 4000 && <span className="field-err" role="alert">没保存上：原型库规则最多 4000 字</span>}
              </label>
            )}
          </div>
        ))}
      </section>

      <section className="hook-sec">
        <div className="field-group-title">命令<span className="field-hint">目录相对代码库，超时留空用默认值</span></div>
        {PROFILE_COMMAND_GROUPS.map((g) => (
        <div key={g.key} className="proj-cmd-grid" role="group" aria-label={`${g.label}命令`}>
          <div className="proj-cmd-group">{g.label}<span className="field-hint">{g.hint}</span></div>
          <div className="proj-cmd-row proj-cmd-head" aria-hidden="true"><span>用途</span><span>命令</span><span>目录</span><span>超时（秒）</span></div>
          {PROFILE_COMMANDS.filter((x) => x.group === g.key).map(({ key, label, hint }) => {
            const c = pf.commands[key]
            const t = timeouts[key] ?? ''
            const bad = t.trim() && (!/^\d+$/.test(t.trim()) || Number(t) > 86400)
            return (
              <div key={key} className="proj-cmd-row">
                <span className="list-sub">{label}</span>
                <input className="mono-input" value={c?.command ?? ''} aria-label={`${label}命令`} placeholder={key === 'build' ? 'make build' : ''} spellCheck={false}
                  onChange={(e) => setCmd(key, { command: e.target.value })} />
                <input className="mono-input" value={c?.dir ?? ''} aria-label={`${label}目录`} placeholder="代码库根目录" spellCheck={false}
                  onChange={(e) => setCmd(key, { dir: e.target.value })} />
                <input className={cls('mono-input', bad && 'bad')} value={t} aria-label={`${label}超时`} placeholder="默认" inputMode="numeric"
                  onChange={(e) => { const v = e.target.value; setTimeouts({ ...timeouts, [key]: v }); if (/^\d*$/.test(v.trim()) && Number(v) <= 86400) setCmd(key, { timeout_sec: Number(v) || 0 }) }} />
                <span className="list-sub proj-cmd-hint">{hint}</span>
                {bad && <span className="field-err proj-cmd-err">{/^\d+$/.test(t.trim()) ? '超时最多一天（86400 秒）' : '超时填整数秒'}，改好前命令先不存</span>}
                {key === 'test_env' && (() => {
                  // 就绪检查（AUTO-08，SPEC-projects-15.7a）：空等 $PORT 能连上；/ 开头是本机端口上的路径；也可以写本机地址
                  const r = (c?.ready ?? '').trim()
                  const rbad = !r ? '' : /\s/.test(r) ? '就绪检查里不能有空格'
                    : r.startsWith('/') || /^https?:\/\/(\[::1\]|127\.0\.0\.1|localhost)(:|\/|$)/i.test(r) ? '' : '就绪检查填 / 开头的路径，或本机地址（http://127.0.0.1:{{PORT}}/…）'
                  return (
                    <div className="proj-cmd-ready">
                      <span className="list-sub">就绪检查</span>
                      <input className={cls('mono-input', rbad && 'bad')} value={c?.ready ?? ''} aria-label="起测试环境就绪检查" placeholder="留空等 $PORT 能连上；或填 /healthz" spellCheck={false}
                        onChange={(e) => setCmd(key, { ready: e.target.value })} />
                      <span className={rbad ? 'field-err' : 'list-sub'}>{rbad || '回 2xx、3xx 算就绪；超时是等就绪的时间，留空 2 分钟'}</span>
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
        ))}
      </section>

      {/* 执行白名单（TSK-0837，SPEC-projects-15.8a）：合并口径见 SPEC-tasks-6.19a */}
      <section className="hook-sec" aria-label="执行白名单">
        <div className="field-group-title">执行白名单<span className="field-hint">这个项目的任务交给 Claude Code 后台执行时额外放行的规则，一行一条；写法同「设置 / 执行权限」的自定义白名单</span></div>
        <label className="field"><span className="field-label">规则<span className="field-hint">允许改文件的档位全部放行；只读档位只放行 Read(…) 这类读规则，脚本和 MCP 工具不放行</span></span>
          <GrowArea rows={3} className={cls('mono-area', allowErr && 'bad')} value={allow} aria-label="执行白名单" spellCheck={false} aria-invalid={!!allowErr}
            placeholder={'Bash(./_shared/新建需求.sh:*)\nBash(python3 核格式.py:*)\nRead(//Volumes/project/other-repo/**)'}
            onChange={(e) => { setAllow(e.target.value); if (!runAllowError(e.target.value)) set({ run_allow: runAllowOf(e.target.value) }) }} />
          {allowErr && <span className="field-err" role="alert">{allowErr}，改好前这一项先不存</span>}
        </label>
      </section>

      <section className="hook-sec">
        <div className="field-group-title">人员<span className="field-hint">从联系人里挑；验收人员是自动流程里通知去验收的人</span></div>
        <div className="proj-profile-people">
          <label className="field"><span className="field-label">负责人</span>
            <SearchSelect variant="field" multiple value={pf.owner_ids} placeholder="选负责人" searchPlaceholder="搜姓名、公司、职位" aria-label="负责人"
              options={options} missingLabel={() => '已归档的联系人'} onChange={(owner_ids) => set({ owner_ids })} />
          </label>
          <label className="field"><span className="field-label">验收人员</span>
            <SearchSelect variant="field" multiple value={pf.acceptor_ids} placeholder="选验收人员" searchPlaceholder="搜姓名、公司、职位" aria-label="验收人员"
              options={options} missingLabel={() => '已归档的联系人'} onChange={(acceptor_ids) => set({ acceptor_ids })} />
          </label>
        </div>
      </section>

      <ProtoSyncSection info={p.proto_sync} codeDirSet={!!(pf.code_dir || p.root)} onChange={(proto_sync) => onChange({ proto_sync })} />
    </div>
  )
}
