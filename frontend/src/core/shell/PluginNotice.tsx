import type { PluginProblem } from '../plugin'

// 侧栏底部的提示：启用了但没加载的插件和原因（依赖缺失、版本不符、清单不合法、加载出错）
export function PluginNotice({ problems }: { problems: readonly PluginProblem[] }) {
  if (problems.length === 0) return null
  return (
    <details className="shell-notice" role="status">
      <summary>{problems.length} 个插件没有加载</summary>
      <ul>
        {problems.map((p, i) => (
          <li key={p.id + i}>
            <div className="shell-notice-name">{p.name ? `${p.name}（${p.id}）` : p.id}</div>
            {p.reasons.map((r) => <div key={r}>{r}</div>)}
          </li>
        ))}
      </ul>
    </details>
  )
}
