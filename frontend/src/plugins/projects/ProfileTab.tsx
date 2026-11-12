// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 档案（AUTO-04，SPEC-projects-15）：给分类 Agent 和各 pipeline 用的项目信息——简介、关键词、平台，
// 代码库、原型库、PRD 三个目录，构建到回滚十条命令，负责人和验收人员；末尾是原型同步（AUTO-11，ProtoSyncBlock）。
// 和设置一样边改边存、没有「保存」按钮：输入停手片刻存一次，点选的立即存，离开标签时没存的也存掉。
// 目录一个一个单独存，后端校验目录在不在，存不上的只在那一项下面说，不连累别的；请求按顺序一个个发。
import { useEffect, useRef, useState } from 'react'
import { PROFILE_COMMANDS, PROFILE_COMMAND_GROUPS, errorText, useContacts, useProjectProfile, useSaveProjectProfile, type ProjectProfile, type ProjectProfilePatch } from '../../core/data'
import { Avatar, ErrorState, LoadingState, SearchSelect, Textarea, cls } from '../../core/ui'
import { nameInitial } from '../../core/ui/pinyin'
import { PathInput } from './PathInput'
import { ProtoSyncBlock } from './ProtoSyncBlock'
import { DIR_FIELDS, PLATFORM_PRESETS, formOfProfile, profileDiff, readyError, timeoutError, type DirField, type ProfileForm } from './profileModel'

const SAVE_DELAY = 500
const PICK_LIMIT = 80

export function ProfileTab({ projectId }: { projectId: string }) {
  const q = useProjectProfile(projectId)
  if (q.isError) return <ErrorState title="档案没加载出来" error={errorText(q.error)} onRetry={() => void q.refetch()} />
  if (!q.data) return <LoadingState />
  return <ProfileEditor key={projectId} profile={q.data} />
}

function ProfileEditor({ profile }: { profile: ProjectProfile }) {
  const id = profile.project_id
  const save = useSaveProjectProfile(id)
  const contacts = useContacts()
  const [form, setForm] = useState(() => formOfProfile(profile))
  const saved = useRef(formOfProfile(profile))
  const pending = useRef<ProfileForm | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 请求排队：一次只发一个，按改的先后
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const [busy, setBusy] = useState(0)
  const [err, setErr] = useState('')
  const [dirErr, setDirErr] = useState<Partial<Record<DirField, string>>>({})
  const [done, setDone] = useState(false)

  const send = (patch: ProjectProfilePatch, onOk: () => void, onFail: (e: unknown) => void) => {
    setBusy((n) => n + 1)
    queue.current = queue.current.then(() => save.mutateAsync(patch).then(onOk, onFail)).finally(() => setBusy((n) => n - 1))
  }

  const flush = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const f = pending.current
    pending.current = null
    if (!f) return
    const { patch, dirs } = profileDiff(f, saved.current)
    const prev = saved.current
    if (Object.keys(patch).length) {
      // 先记成已存（目录除外，目录各自记），失败时退回，重试再发
      saved.current = { ...f, code_dir: saved.current.code_dir, proto_dir: saved.current.proto_dir, prd_dir: saved.current.prd_dir }
      send(patch, () => { setErr(''); setDone(true) }, (e) => {
        saved.current = { ...prev, code_dir: saved.current.code_dir, proto_dir: saved.current.proto_dir, prd_dir: saved.current.prd_dir }
        setErr(errorText(e))
      })
    }
    for (const [k, v] of Object.entries(dirs) as [DirField, string][]) {
      send({ [k]: v }, () => {
        saved.current = { ...saved.current, [k]: v }
        setDirErr((m) => ({ ...m, [k]: '' }))
        setDone(true)
      }, (e) => setDirErr((m) => ({ ...m, [k]: errorText(e) })))
    }
  }
  const flushRef = useRef(flush)
  useEffect(() => { flushRef.current = flush })
  useEffect(() => () => flushRef.current(), [])

  const update = (x: Partial<ProfileForm>, delay = SAVE_DELAY) => {
    const next = { ...form, ...x }
    setForm(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => flushRef.current(), delay)
  }
  const retry = () => { pending.current = form; flush() }
  const setCmd = (key: (typeof PROFILE_COMMANDS)[number]['key'], x: Partial<ProfileForm['commands'][typeof key]>) =>
    update({ commands: { ...form.commands, [key]: { ...form.commands[key], ...x } } })

  // 名册接口只回在岗的人，归档的不出现在候选里
  const options = (contacts.data ?? []).map((c) => ({
    value: c.id, label: c.name, hint: c.company || undefined, group: nameInitial(c.name),
    keywords: [c.title, c.group, ...(c.tags ?? [])].filter(Boolean).join(' '),
    icon: <Avatar name={c.name} size={18} src={c.photo || undefined} />,
  }))
  const missingName = () => '已归档的联系人'

  return (
    <div className="pj-settings pj-profile">
      <div className="pj-save-state" aria-live="polite">
        {err ? (
          <span className="field-err" role="alert">没保存上：{err} <button type="button" className="pj-link" onClick={retry}>重试</button></span>
        ) : busy > 0 ? <span className="pj-muted">保存中</span> : done ? <span className="pj-muted">已保存</span> : null}
      </div>

      <section className="pj-block" aria-label="分类信息">
        <h2 className="pj-sec-title">分类信息<span className="pj-hint">新需求、IM 消息进来时，分类 Agent 按这些判断属于哪个项目</span></h2>
        <label className="field">
          <span className="field-label">简介</span>
          <Textarea rows={3} autoGrow value={form.intro} placeholder="这个项目做什么、给谁用、边界在哪；比设置里的一句话说明写得更全"
            onChange={(e) => update({ intro: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">关键词<span className="pj-hint">用逗号或顿号隔开：产品名、模块名、客户名、常说的叫法</span></span>
          <input className="input" value={form.keywords} placeholder="工作台，需求管理，原型" onChange={(e) => update({ keywords: e.target.value })} />
        </label>
        <div className="field">
          <span className="field-label">平台</span>
          <div className="pj-chips" role="group" aria-label="平台">
            {PLATFORM_PRESETS.map((x) => {
              const on = form.platforms.includes(x)
              return (
                <button key={x} type="button" className={cls('chip', on && 'chip-on')} aria-pressed={on}
                  onClick={() => update({ platforms: on ? form.platforms.filter((y) => y !== x) : [...form.platforms, x] }, 0)}>{x}</button>
              )
            })}
            <input className="input pj-profile-other" value={form.otherPlatforms} placeholder="其他，逗号隔开" aria-label="其他平台"
              onChange={(e) => update({ otherPlatforms: e.target.value })} />
          </div>
        </div>
      </section>

      <section className="pj-block" aria-label="目录">
        <h2 className="pj-sec-title">目录<span className="pj-hint">本机绝对路径，要已经存在；软链可以</span></h2>
        {DIR_FIELDS.map((d) => (
          <div key={d.key} className="field">
            <span className="field-label">{d.label}<span className="pj-hint">{d.key === 'code_dir' && profile.root ? `不填时沿用项目目录 ${profile.root}` : d.hint}</span></span>
            <PathInput label={d.label} value={form[d.key]} placeholder={d.key === 'code_dir' && profile.root ? '留空沿用项目目录' : '/Users/me/projects/xxx'}
              start={form[d.key].trim() || profile.root} onChange={(v) => update({ [d.key]: v })} />
            {dirErr[d.key] && <span className="field-err" role="alert">没保存上：{dirErr[d.key]}</span>}
          </div>
        ))}
      </section>

      <section className="pj-block" aria-label="命令">
        <h2 className="pj-sec-title">命令<span className="pj-hint">目录相对代码库，超时留空用默认值</span></h2>
        {PROFILE_COMMAND_GROUPS.map((g) => (
          <div key={g.key} className="pj-cmd-grid" role="group" aria-label={`${g.label}命令`}>
            <div className="pj-cmd-group">{g.label}<span className="pj-hint">{g.hint}</span></div>
            <div className="pj-cmd-head" aria-hidden="true">
              <span>用途</span><span>命令</span><span>目录</span><span>超时（秒）</span>
            </div>
            {PROFILE_COMMANDS.filter((x) => x.group === g.key).map(({ key, label, hint }) => {
              const c = form.commands[key]
              const te = timeoutError(c.timeout)
              return (
                <div key={key} className="pj-cmd-row">
                  <span className="pj-cmd-label">{label}</span>
                  <input className="input pj-mono" value={c.command} spellCheck={false} aria-label={`${label}命令`}
                    placeholder={key === 'build' ? 'make build' : ''} onChange={(e) => setCmd(key, { command: e.target.value })} />
                  <input className="input pj-mono" value={c.dir} spellCheck={false} aria-label={`${label}目录`} placeholder="代码库根目录"
                    onChange={(e) => setCmd(key, { dir: e.target.value })} />
                  <input className={cls('input', te && 'bad')} value={c.timeout} inputMode="numeric" aria-label={`${label}超时`} aria-invalid={!!te || undefined}
                    placeholder="默认" onChange={(e) => setCmd(key, { timeout: e.target.value })} />
                  <span className="pj-muted pj-cmd-hint">{hint}</span>
                  {te && <span className="field-err pj-cmd-err">{te}，改好前命令先不存</span>}
                  {key === 'test_env' && <ReadyRow value={c.ready} onChange={(v) => setCmd('test_env', { ready: v })} />}
                </div>
              )
            })}
          </div>
        ))}
      </section>

      <section className="pj-block" aria-label="人员">
        <h2 className="pj-sec-title">人员<span className="pj-hint">从联系人里挑；验收人员是自动流程里通知去验收的人</span></h2>
        <div className="pj-profile-people">
          <label className="field">
            <span className="field-label">负责人</span>
            <SearchSelect variant="field" multiple value={form.owner_ids} placeholder="选负责人" searchPlaceholder="搜姓名、公司、职位" aria-label="负责人"
              options={options} limit={PICK_LIMIT} missingLabel={missingName} onChange={(v) => update({ owner_ids: v }, 0)} />
          </label>
          <label className="field">
            <span className="field-label">验收人员</span>
            <SearchSelect variant="field" multiple value={form.acceptor_ids} placeholder="选验收人员" searchPlaceholder="搜姓名、公司、职位" aria-label="验收人员"
              options={options} limit={PICK_LIMIT} missingLabel={missingName} onChange={(v) => update({ acceptor_ids: v }, 0)} />
          </label>
        </div>
      </section>

      <ProtoSyncBlock projectId={id} />
    </div>
  )
}

/** 起测试环境的就绪检查（AUTO-08）：空等端口能连上；/ 开头 GET 本机端口上的路径；也可以写本机地址 */
function ReadyRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const re = readyError(value)
  return (
    <div className="pj-cmd-ready">
      <span className="pj-cmd-sub">就绪检查</span>
      <input className={cls('input pj-mono', re && 'bad')} value={value} spellCheck={false} aria-label="起测试环境就绪检查" aria-invalid={!!re || undefined}
        placeholder="留空等 $PORT 能连上；或填 /healthz" onChange={(e) => onChange(e.target.value)} />
      <span className={re ? 'field-err' : 'pj-muted'}>{re ? `${re}，改好前命令先不存` : '回 2xx、3xx 算就绪；超时是等就绪的时间，留空 2 分钟'}</span>
    </div>
  )
}
