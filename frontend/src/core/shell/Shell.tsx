import { NavLink, Outlet } from 'react-router'
import { useHealth } from '../api'
import type { ModuleDef } from '../plugin'
import './shell.css'

// 空壳：侧边栏列出模块，右边是当前模块的页面。样式等 FE-01a 的设计变量出来后替换。
export function Shell({ modules }: { modules: ModuleDef[] }) {
  return (
    <div className="shell">
      <aside className="shell-side">
        <div className="shell-brand">一人之下</div>
        <nav className="shell-nav">
          {modules.map((m) => (
            <NavLink key={m.id} to={'/' + m.path} className="shell-nav-item">
              {m.label}
            </NavLink>
          ))}
        </nav>
        <BackendStatus />
      </aside>
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  )
}

function BackendStatus() {
  const health = useHealth()
  let text = '后端：连接中'
  if (health.isError) text = '后端：未连接'
  else if (health.data?.ok) text = '后端：已连接 ' + health.data.version
  return (
    <div className="shell-status" data-state={health.isError ? 'error' : health.data?.ok ? 'ok' : 'pending'}>
      {text}
    </div>
  )
}
