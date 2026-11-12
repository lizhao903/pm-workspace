import { errorText, usePluginJobs } from '../../core/data'
import { PageTitle } from '../../core/ui'
import './jobs.css'

const when = (at: string | null) => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—'
export default function JobsSection() {
  const q = usePluginJobs()
  return <section className="jobs-page" aria-label="后台任务运行统计">
    <PageTitle parent="设置" desc="最近 1 小时运行统计，每 10 秒自动刷新">后台任务</PageTitle>
    <p className="plg-muted">仅保存在内存，服务重启后清零。次数按完成时间统计，包含无新数据的成功检查；取消单列，执行中不计入总次数。有失败的任务优先显示。</p>
    {q.isError && <p role="alert" className="danger-text">统计读取失败：{errorText(q.error)}</p>}
    {q.isPending ? <p className="plg-muted">正在读取…</p> : q.data?.length ? <div className="plg-jobs-scroll">
      <table className="plg-jobs-table">
        <thead><tr>{['插件 / 任务', '周期', '当前状态', '总次数', '成功', '失败', '取消', '最近开始', '最近完成 / 耗时', '最近执行错误'].map((x) => <th key={x} scope="col">{x}</th>)}</tr></thead>
        <tbody>{q.data.map((j) => <tr key={`${j.plugin_id}/${j.name}`}>
          <td><strong>{j.plugin_name}</strong><br /><code>{j.name}</code></td>
          <td>{j.every_ms ? `${j.every_ms / 1000} 秒` : '启动一次 / 常驻'}</td>
          <td>{j.running ? '执行中' : j.enabled ? '空闲 / 已完成' : '已停用'}</td>
          <td>{j.total}</td><td>{j.success}</td><td className={j.failed ? 'danger-text' : undefined}>{j.failed}</td><td>{j.canceled}</td>
          <td>{when(j.last_started_at)}</td><td>{when(j.last_finished_at)}{j.last_finished_at && <><br />{j.last_duration_ms} ms</>}</td>
          <td className="plg-job-error">{j.last_error || '—'}</td>
        </tr>)}</tbody>
      </table>
    </div> : !q.isError && <p className="plg-muted">暂无后台任务</p>}
    {q.dataUpdatedAt > 0 && <p className="plg-muted">数据更新于 {new Date(q.dataUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</p>}
  </section>
}
