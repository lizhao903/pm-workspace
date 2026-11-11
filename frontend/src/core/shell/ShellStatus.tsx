// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 插件登记的外壳状态条（shellStatus 前端扩展点）：常驻在顶栏下面，切页面不卸载。
// 每块单独出错边界，一个插件渲染出错不影响外壳和其他插件。
import { Component, Suspense, type ReactNode } from 'react'
import { sortShellStatus, useShellStatus } from '../plugin'

class Quiet extends Component<{ what: string; children: ReactNode }, { error: boolean }> {
  state = { error: false }

  static getDerivedStateFromError() {
    return { error: true }
  }

  componentDidCatch(error: Error) {
    console.error(`${this.props.what}渲染出错`, error)
  }

  render() {
    return this.state.error ? null : this.props.children
  }
}

export function ShellStatus() {
  const items = sortShellStatus(useShellStatus())
  if (items.length === 0) return null
  return (
    <div className="shell-status" role="region" aria-label="后台状态">
      {items.map(({ plugin, key, render: Render }) => (
        <Quiet key={`${plugin}/${key}`} what={`外壳状态「${plugin}/${key}」`}>
          <Suspense fallback={null}><Render /></Suspense>
        </Quiet>
      ))}
    </div>
  )
}
