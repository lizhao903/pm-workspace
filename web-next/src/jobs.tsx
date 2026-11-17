// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置 > 后台任务（jobs 插件 0.1.0，SPEC-settings-31）：插件后台 Job 的状态与最近一小时运行统计，每 10 秒刷新。
// 正式产品 frontend/src/plugins/jobs/Section.tsx，接 GET /api/jobs/stats；统计只在内存里，服务重启后清零。
// 原型没有后端：演示数据是几个插件的后台 Job，每 10 秒按周期往上加次数，交易套件的行情同步带一次失败。
import { useEffect, useState } from 'react'
import { PageTitle } from './topbar'
import './setx.css'

export interface PluginJob {
  plugin_id: string; plugin_name: string; name: string; every_ms: number
  enabled: boolean; running: boolean
  total: number; success: number; failed: number; canceled: number
  last_started_at: string | null; last_finished_at: string | null
  last_duration_ms: number; last_error: string
}

const secsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString()
const seedJobs = (): PluginJob[] => [
  { plugin_id: 'trade', plugin_name: '交易套件', name: 'market-sync', every_ms: 15000, enabled: true, running: false, total: 240, success: 239, failed: 1, canceled: 0,
    last_started_at: secsAgo(9), last_finished_at: secsAgo(8), last_duration_ms: 412, last_error: '拉取 OKX 行情超时：context deadline exceeded（12 分钟前）' },
  { plugin_id: 'im', plugin_name: 'IM 消息', name: 'poll-connectors', every_ms: 30000, enabled: true, running: false, total: 120, success: 120, failed: 0, canceled: 0,
    last_started_at: secsAgo(21), last_finished_at: secsAgo(20), last_duration_ms: 860, last_error: '' },
  { plugin_id: 'sop', plugin_name: 'SOP 编排', name: 'scheduler', every_ms: 60000, enabled: true, running: true, total: 60, success: 60, failed: 0, canceled: 0,
    last_started_at: secsAgo(2), last_finished_at: secsAgo(62), last_duration_ms: 35, last_error: '' },
  { plugin_id: 'recording', plugin_name: '录音转写', name: 'transcribe-worker', every_ms: 0, enabled: true, running: true, total: 0, success: 0, failed: 0, canceled: 0,
    last_started_at: secsAgo(3600 * 3), last_finished_at: null, last_duration_ms: 0, last_error: '' },
  { plugin_id: 'projects', plugin_name: '项目', name: 'kb-sync', every_ms: 300000, enabled: false, running: false, total: 0, success: 0, failed: 0, canceled: 0,
    last_started_at: null, last_finished_at: null, last_duration_ms: 0, last_error: '' },
]
const when = (at: string | null) => (at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—')
// 有失败的任务优先显示
const ordered = (xs: PluginJob[]) => [...xs].sort((a, b) => Number(b.failed > 0) - Number(a.failed > 0))

export function JobsPage() {
  const [jobs, setJobs] = useState(seedJobs)
  const [at, setAt] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => {
      setJobs((xs) => xs.map((j) => {
        if (!j.enabled || !j.every_ms || j.every_ms > 10000 * 3) return j
        const n = Math.max(1, Math.round(10000 / j.every_ms))
        const now = new Date().toISOString()
        return { ...j, total: j.total + n, success: j.success + n, last_started_at: now, last_finished_at: now }
      }))
      setAt(Date.now())
    }, 10000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <section className="page setx-page" style={{ maxWidth: 1180 }} aria-label="后台任务运行统计">
      <PageTitle parent="设置" desc="最近 1 小时运行统计，每 10 秒自动刷新">后台任务</PageTitle>
      <p className="muted setx-sm">仅保存在内存，服务重启后清零。次数按完成时间统计，包含无新数据的成功检查；取消单列，执行中不计入总次数。有失败的任务优先显示。</p>
      {jobs.length ? (
        <div className="jobs-scroll">
          <table className="jobs-table">
            <thead><tr>{['插件 / 任务', '周期', '当前状态', '总次数', '成功', '失败', '取消', '最近开始', '最近完成 / 耗时', '最近执行错误'].map((x) => <th key={x} scope="col">{x}</th>)}</tr></thead>
            <tbody>{ordered(jobs).map((j) => (
              <tr key={`${j.plugin_id}/${j.name}`}>
                <td><strong>{j.plugin_name}</strong><br /><code>{j.name}</code></td>
                <td>{j.every_ms ? `${j.every_ms / 1000} 秒` : '启动一次 / 常驻'}</td>
                <td>{j.running ? '执行中' : j.enabled ? '空闲 / 已完成' : '已停用'}</td>
                <td>{j.total}</td><td>{j.success}</td><td className={j.failed ? 'danger-text' : undefined}>{j.failed}</td><td>{j.canceled}</td>
                <td>{when(j.last_started_at)}</td>
                <td>{when(j.last_finished_at)}{j.last_finished_at && <><br />{j.last_duration_ms} ms</>}</td>
                <td className="jobs-err">{j.last_error || '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="muted setx-sm">暂无后台任务</p>}
      <p className="muted setx-sm">数据更新于 {new Date(at).toLocaleTimeString('zh-CN', { hour12: false })}</p>
    </section>
  )
}
