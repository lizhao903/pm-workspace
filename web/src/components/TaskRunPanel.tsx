// 详情抽屉「执行」Tab：把当前工作对象交给本机 Claude Code 去做，并实时看它在动哪些文件。
// 另外导出详情 Tab 用的「工作区」字段（WorkdirField），两处共用同一套「自己设的 / 继承自项目」判断。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskRun, TaskRunStatus, WorkObject } from '../lib/types'
import { Button, TextArea, formatDateTime } from './ui'
import FolderPicker from './FolderPicker'
import { PROJECT_TYPE_ID, useEffectiveWorkdir } from './taskrun/workdir'
import { useTaskRun, type RunItem } from './taskrun/useTaskRun'
import '../taskrun.css'

/* ------------------------------------------------------------ 小工具 */

const STATUS_LABELS: Record<TaskRunStatus, string> = {
  pending: '排队中', running: '执行中', done: '成功', failed: '失败', canceled: '已取消',
}

// claude 的工具名映射成人读动作，让「它到底改了什么」一眼能看出来
const TOOL_VERBS: Record<string, string> = {
  Read: '读取', Write: '写入', Edit: '编辑', MultiEdit: '批量编辑', NotebookEdit: '编辑 Notebook',
  Bash: '执行命令', BashOutput: '读取命令输出', Glob: '查找文件', Grep: '搜索',
  WebFetch: '抓取网页', WebSearch: '联网搜索', Task: '子任务', TodoWrite: '更新待办',
}

function toolLabel(name: string): string {
  return TOOL_VERBS[name] ?? name
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  return `${m} 分 ${s % 60} 秒`
}

function runDuration(r: TaskRun): string {
  if (!r.finished_at) return '—'
  return fmtDuration(new Date(r.finished_at).getTime() - new Date(r.started_at).getTime())
}

/* -------------------------------------------------- 详情 Tab：工作区字段 */

export interface WorkdirFieldProps {
  object: WorkObject
  /** 交回给详情 Tab 保存，沿用它那套「保存中 / 已保存」提示 */
  onChange: (workdir: string) => void
}

export function WorkdirField({ object, onChange }: WorkdirFieldProps) {
  const eff = useEffectiveWorkdir(object)
  const isProject = object.type_id === PROJECT_TYPE_ID

  return (
    <div className="tr-field">
      <FolderPicker
        value={eff.own}
        allowEmpty
        placeholder={eff.inherited ? `未设置则用 ${eff.inherited}` : '绝对路径，如 /Users/me/work/demo'}
        onChange={onChange}
      />
      <div className="tr-field-hint">
        {isProject ? (
          <span className="faint">该项目的产物默认落到这里，项目下的任务没单独设置时也用它。</span>
        ) : eff.source === 'own' ? (
          <span className="tr-src-own">本对象专属{eff.inherited ? `（覆盖了项目的 ${eff.inherited}）` : ''}，清空后改为继承项目设置。</span>
        ) : eff.source === 'inherited' ? (
          <span className="tr-src-inherit">
            继承自项目{eff.fromProject ? `「${eff.fromProject}」` : ''}：<span className="mono">{eff.inherited}</span>
            ；不必逐条设置，填上才是本对象专属。
          </span>
        ) : (
          <span className="faint">
            {eff.loading ? '读取项目工作区…' : '未设置。留空则继承所属项目的工作区；项目也没设时无法执行任务。'}
          </span>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------- 输出流里的工具行 */

/** 错误文本先截这么长，剩下的点「展开」再看：一条 bash 报错动辄几十行，
 *  摊开会把用户真正关心的「它动了哪些文件」冲掉。 */
const ERR_CLIP = 120

function ToolLine({ item, expanded, onToggle }: {
  item: RunItem
  expanded: boolean
  onToggle: () => void
}) {
  const failed = item.toolState === 'fail'
  const err = item.toolError ?? ''
  const clipped = err.length > ERR_CLIP
  const cls = ['tr-tool', failed ? 'tr-tool-fail' : '', item.kind === 'tool_result' ? 'tr-tool-orphan' : '']
    .filter(Boolean).join(' ')

  return (
    <div className={cls}>
      <div className="tr-tool-row">
        <span className="tr-tool-verb">{toolLabel(item.toolName ?? '')}</span>
        {item.kind === 'tool'
          ? <span className="mono truncate" title={item.text}>{item.text || '—'}</span>
          : <span className="faint">（没有配对的调用记录）</span>}
        {/* 一直没等到 tool_result 就停在「进行中」，不在流结束时统一改写：
            执行被取消时它正好告诉用户 claude 卡在哪一步。 */}
        {item.toolState === 'running' ? <span className="tr-tool-state">进行中</span> : null}
        {failed ? <span className="tr-tool-state tr-tool-state-fail">失败</span> : null}
      </div>
      {failed && err ? (
        <div className="tr-tool-err">
          {expanded || !clipped ? err : `${err.slice(0, ERR_CLIP)}…`}
          {clipped ? (
            <button type="button" className="tr-link tr-tool-more" onClick={onToggle}>
              {expanded ? '收起' : '展开'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ 执行 Tab */

export interface TaskRunPanelProps {
  object: WorkObject
  /** 没有工作区时，点提示直接跳回详情 Tab 去设 */
  onGoDetail: () => void
}

export default function TaskRunPanel({ object, onGoDetail }: TaskRunPanelProps) {
  const eff = useEffectiveWorkdir(object)
  const run = useTaskRun(object.id)
  const [extra, setExtra] = useState('')
  // 默认不勾：先只读跑一遍看它打算做什么，比先改了再说安全
  const [allowWrites, setAllowWrites] = useState(false)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [openErrors, setOpenErrors] = useState<Set<string>>(new Set())
  // 执行器：claude 是本机 Claude Code，deepseek 是 deepseek-harness 的 headless 模式
  const [harness, setHarness] = useState<'claude' | 'deepseek'>('claude')
  const engineName = harness === 'deepseek' ? 'DeepSeek Harness' : 'Claude Code'
  // 续跑只对 DeepSeek 有意义：上一次 dsh 执行留下了会话才能接着跑
  const [resume, setResume] = useState(false)
  const lastSession = useMemo(() => {
    for (const r of run.history) {
      if (r.harness === 'deepseek' && r.harness_session) return r.harness_session
    }
    return ''
  }, [run.history])
  const streamRef = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)

  // 只有用户没往回翻时才自动跟随到底，否则会把他正在看的内容顶走
  useEffect(() => {
    const el = streamRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [run.items])

  const toggleError = (id: string) => setOpenErrors((prev) => {
    const next = new Set(prev)
    if (!next.delete(id)) next.add(id)
    return next
  })

  const onStreamScroll = () => {
    const el = streamRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  }

  const canRun = eff.value !== '' && !run.running
  const failed = run.exitCode !== null && run.exitCode !== 0
  const finished = !run.running && run.exitCode !== null

  const toolCount = useMemo(() => run.items.filter((i) => i.kind === 'tool').length, [run.items])

  return (
    <div className="drawer-body tr-panel">
      {/* ── 工作区与发起 ── */}
      <div className="card tr-head">
        {eff.value ? (
          <div className="tr-wd">
            <b>工作区</b>
            <span className="mono truncate" title={eff.value}>{eff.value}</span>
            <span className="badge">{eff.source === 'own' ? '本对象' : `继承自项目${eff.fromProject ? `「${eff.fromProject}」` : ''}`}</span>
          </div>
        ) : (
          <div className="tr-warn">
            <b>请先设置工作区目录</b>
            <span>执行器需要一个落地目录才能干活；可以设在本对象上，也可以设在所属项目上由它继承。</span>
            <button type="button" className="tr-link" onClick={onGoDetail}>去详情 Tab 设置</button>
          </div>
        )}

        <TextArea
          className="tr-extra"
          rows={2}
          value={extra}
          disabled={run.running}
          placeholder="额外告诉 Claude 的话，比如「只改前端，不要动数据库」"
          onValueChange={setExtra}
        />

        {/* 同一个任务可以交给两个执行器：改代码给 Claude Code，读需求写方案给 DeepSeek */}
        <div className="tr-engine">
          <span className="tr-engine-label">执行器</span>
          <div className="tr-engine-opts" role="group" aria-label="执行器">
            <button
              type="button"
              className={harness === 'claude' ? 'tr-engine-opt is-on' : 'tr-engine-opt'}
              disabled={run.running}
              onClick={() => setHarness('claude')}
            >
              Claude Code
            </button>
            <button
              type="button"
              className={harness === 'deepseek' ? 'tr-engine-opt is-on' : 'tr-engine-opt'}
              disabled={run.running}
              onClick={() => setHarness('deepseek')}
            >
              DeepSeek Harness
            </button>
          </div>
          {harness === 'deepseek' ? (
            <span className="tr-engine-hint">
              按设置里的默认服务商跑；模型和密钥由工作台转成 dsh 的临时配置，每次执行现生成。
            </span>
          ) : null}
          {harness === 'deepseek' && lastSession ? (
            <label className="tr-resume">
              <input
                type="checkbox"
                checked={resume}
                disabled={run.running}
                onChange={(e) => setResume(e.target.checked)}
              />
              <span>
                接着上次会话
                <span className="tr-resume-id mono">{lastSession.slice(-8)}</span>
              </span>
            </label>
          ) : null}
        </div>

        {/* 勾这个框等于放手让执行器改文件，所以把「会写到哪」摆在同一行里 */}
        <label className={`tr-writes ${allowWrites ? 'tr-writes-on' : ''}`.trim()}>
          <input
            type="checkbox"
            checked={allowWrites}
            disabled={run.running}
            onChange={(e) => setAllowWrites(e.target.checked)}
          />
          <span>
            <b>允许修改文件</b>
            {eff.value ? (
              <span className="tr-writes-hint">
                {allowWrites
                  ? <>{engineName} 可以直接改 <span className="mono">{eff.value}</span> 下的文件。</>
                  : <>不勾则只读跑一遍：{engineName} 会说它打算做什么，但改不了 <span className="mono">{eff.value}</span> 里的任何东西。</>}
              </span>
            ) : null}
          </span>
        </label>

        <div className="tr-actions">
          {run.running ? (
            <Button variant="danger" small disabled={run.stopping} onClick={run.stop}>
              {run.stopping ? '停止中…' : '停止'}
            </Button>
          ) : (
            <Button
              variant="primary"
              small
              disabled={!canRun}
              title={eff.value ? '' : '未设置工作区目录，无法执行'}
              onClick={() => void run.start({
                workdir: eff.value, extraPrompt: extra, allowWrites, harness,
                resumeSession: resume,
              })}
            >
              用 {engineName} 执行
            </Button>
          )}
          {run.running ? <span className="tr-timer mono">{fmtDuration(run.elapsedMs)}</span> : null}
          {run.running ? <span className="faint">执行中{toolCount ? ` · 已用工具 ${toolCount} 次` : ''}</span> : null}
          {finished ? (
            <span className={failed ? 'tr-badge-fail' : 'tr-badge-ok'}>
              {failed ? `失败（退出码 ${run.exitCode}）` : '完成'} · {fmtDuration(run.elapsedMs)}
            </span>
          ) : null}
        </div>
      </div>

      {/* ── 输出流 ── */}
      {run.items.length > 0 ? (
        <div className="card tr-stream-card">
          <div className="card-title">
            执行输出
            {run.runId ? <span className="mono faint tr-runid">{run.runId.slice(0, 8)}</span> : null}
          </div>
          {/* 后端回的才是真正生效的目录：对象设的和面板上临时填的可能不是一个 */}
          {run.runWorkdir ? (
            <div className="tr-runwd faint">
              正在 <span className="mono" title={run.runWorkdir}>{run.runWorkdir}</span> 下执行
            </div>
          ) : null}
          <div className="tr-stream" ref={streamRef} onScroll={onStreamScroll}>
            {run.items.map((it) =>
              it.kind === 'tool' || it.kind === 'tool_result' ? (
                <ToolLine
                  key={it.id}
                  item={it}
                  expanded={openErrors.has(it.id)}
                  onToggle={() => toggleError(it.id)}
                />
              ) : it.kind === 'artifact' ? (
                // 收尾时登记下来的产出。和工具行区分开：工具行说的是「它做了什么」，
                // 这一行说的是「留下了什么」——后者是用户跑完之后真正要找的东西。
                <div className="tr-artifact" key={it.id}>
                  <span className={it.artifactNew ? 'tr-art-tag tr-art-new' : 'tr-art-tag'}>
                    {it.artifactNew ? '新建' : '改动'}
                  </span>
                  <span className="mono truncate" title={it.text}>{it.text}</span>
                </div>
              ) : it.kind === 'notice' ? (
                <div className={it.tone === 'error' ? 'tr-notice tr-notice-err' : 'tr-notice'} key={it.id}>
                  {it.text}
                </div>
              ) : (
                <div className="tr-text" key={it.id}>{it.text}</div>
              ),
            )}
            {run.running ? <div className="tr-cursor" aria-hidden="true" /> : null}
          </div>
        </div>
      ) : null}

      {/* ── 历史记录 ── */}
      <div className="card">
        <div className="card-title">
          历史执行
          {run.history.length ? <span className="badge">{run.history.length}</span> : null}
        </div>
        {run.historyLoading ? <div className="skeleton v-sk v-sk-title" /> : null}
        {!run.historyLoading && run.history.length === 0 ? <div className="faint">还没有执行记录。</div> : null}
        {run.history.map((r) => (
          <div className="tr-hist" key={r.id}>
            <button
              type="button"
              className="tr-hist-row"
              onClick={() => setOpenRun((cur) => (cur === r.id ? null : r.id))}
            >
              <span className={`tr-dot tr-dot-${r.status}`} aria-hidden="true" />
              <span className="faint">{formatDateTime(r.started_at)}</span>
              <span className="tr-hist-engine" title={r.harness_session || undefined}>
                {r.harness === 'deepseek'
                  ? `DeepSeek${r.harness_session ? ` · ${r.harness_session.slice(-6)}` : ''}`
                  : 'Claude'}
              </span>
              <span className={r.status === 'failed' ? 'tr-badge-fail' : ''}>{STATUS_LABELS[r.status] ?? r.status}</span>
              <span className="faint">{runDuration(r)}</span>
              {r.status !== 'done' && r.exit_code !== 0 ? <span className="faint mono">退出码 {r.exit_code}</span> : null}
              <span className="tr-hist-caret">{openRun === r.id ? '收起' : '查看'}</span>
            </button>
            {openRun === r.id ? (
              <div className="tr-hist-body">
                <div className="faint tr-hist-meta">
                  工作区 <span className="mono">{r.workdir || '—'}</span>
                </div>
                {r.error ? <div className="tr-notice tr-notice-err">{r.error}</div> : null}
                <pre className="tr-hist-out">{r.output || '（无输出）'}</pre>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}
