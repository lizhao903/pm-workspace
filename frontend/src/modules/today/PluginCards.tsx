// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 今日页的插件卡片（SPEC-today-1.22、1.23）：前端注册的卡片和聚合接口里的插件卡片按 order 合并。
// 每张包一层出错边界，一个插件渲染出错只影响它自己那一张
import { Component, type ReactNode } from 'react'
import { sortCards, useTodayCards } from '../../core/plugin'
import { pluginTodayCards, usePlugins, useToday } from '../../core/data'
import { Button, ErrorState } from '../../core/ui'
import { LINE_SHOW, itemText, mergePluginCards, type PluginCardView } from './model'

class Boundary extends Component<{ what: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`${this.props.what}渲染出错`, error)
  }

  render() {
    if (this.state.error) return <ErrorState compact title={`${this.props.what}出错了`} error={this.state.error} />
    return this.props.children
  }
}

/** 前端没有注册渲染的插件卡片：显示总数和前几条 */
function GenericCard({ card }: { card: PluginCardView }) {
  const items = (card.data?.items ?? []).map(itemText).filter(Boolean).slice(0, LINE_SHOW)
  return (
    <>
      <div className="today-card-total">共 {card.data?.total ?? 0} 条</div>
      {items.map((t, i) => <div key={i} className="today-line"><span className="ellipsis">{t}</span></div>)}
    </>
  )
}

export function PluginCards() {
  const registered = sortCards(useTodayCards())
  // 插件卡片只在不传 type 的聚合里有
  const all = useToday()
  const plugins = usePlugins()
  // 插件列表没回来时当作都没有后端：前端注册的卡片先显示（data 为 undefined），回来后再按规则收起
  const known = new Set((plugins.data ?? []).map((p) => p.id))
  const cards = mergePluginCards(registered, pluginTodayCards(all.data), known)
  const miss = all.isError || plugins.isError

  if (!cards.length && !miss) return null
  return (
    <section className="today-plugin" aria-label="插件卡片">
      {miss && (
        <div className="today-miss" role="alert">
          插件卡片这部分没取到
          <Button size="sm" onClick={() => { void all.refetch(); void plugins.refetch() }}>重试</Button>
        </div>
      )}
      {cards.length > 0 && (
        <div className="today-cards">
          {cards.map((c) => {
            const Render = c.render
            return (
              <section key={c.key} className="today-sec" aria-label={c.title} data-card={c.key}>
                <div className="today-title">{c.title}</div>
                {/* 数据从无到有时重新挂载，前面渲染出的错不留着 */}
                <Boundary key={c.data ? 'data' : 'none'} what={`今日卡片「${c.title}」`}>
                  {Render ? <Render data={c.data} /> : <GenericCard card={c} />}
                </Boundary>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}
