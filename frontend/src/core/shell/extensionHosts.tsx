// 插件扩展点在内核页面里的宿主位置（CORE-02b）：今日页的插件卡片、设置页的插件分节，对象详情的插件区块（SOP-06）。
// 每块包一层出错边界，一个插件渲染出错只影响它自己那一块
import { Component, Suspense, type ReactNode } from 'react'
import { sortCards, useObjectSections, useTodayCards, type ObjectSectionProps, type ObjectSectionTab, type PluginSettingsSection } from '../plugin'
import { ErrorState, LoadingState, PageTitle } from '../ui'
import './extensions.css'

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

/**
 * 今日页的插件卡片，按 order 排。data 是今日聚合接口（TODAY-01）按卡片 key 给的数据：
 * 给了 data 且这张卡的值是 null 表示今天没有内容，不显示；没给 data（接口还没接上）时每张都显示
 */
export function TodayCards({ data }: { data?: Readonly<Record<string, unknown>> }) {
  const cards = sortCards(useTodayCards()).filter((c) => !(data && c.key in data && data[c.key] === null))
  if (cards.length === 0) return null
  return (
    <div className="ext-cards">
      {cards.map((c) => {
        const Render = c.render
        return (
          <section key={c.key} className="ext-card" aria-label={c.title} data-card={c.key}>
            <div className="ext-card-title">{c.title}</div>
            <Boundary what={`今日卡片「${c.title}」`}>
              <Render data={data?.[c.key]} />
            </Boundary>
          </section>
        )
      })}
    </div>
  )
}

/** 设置页里插件的一节：标题写明来自哪个插件，页面按需加载 */
export function PluginSettingsPage({ section }: { section: PluginSettingsSection }) {
  const Page = section.page
  return (
    <section className="ext-settings" data-section={`${section.plugin}/${section.key}`}>
      <PageTitle parent="设置" desc={`来自插件「${section.pluginName}」`}>{section.label}</PageTitle>
      <Boundary what={`设置分节「${section.label}」`}>
        <Suspense fallback={<LoadingState />}>
          <Page />
        </Suspense>
      </Boundary>
    </section>
  )
}

/**
 * 对象详情里插件登记的区块（SOP-06），按 order 摆；每块单独出错边界，加载时不占位。
 * tab 给了只摆这个标签里的区块，给 null 只摆没登记标签的；不给全摆
 */
export function ObjectSections({ object, returnTo, focus, tab }: ObjectSectionProps & { tab?: string | null }) {
  const all = useObjectSections(object.type_id)
  const secs = tab === undefined ? all : all.filter((s) => (s.tab?.key ?? null) === tab)
  if (!secs.length) return null
  return (
    <>
      {secs.map((s) => {
        const Section = s.section
        return (
          <Boundary key={`${s.plugin}/${s.key}`} what="插件区块">
            <Suspense fallback={null}>
              <Section object={object} returnTo={returnTo} focus={focus} />
            </Suspense>
          </Boundary>
        )
      })}
    </>
  )
}

/** 插件标签名后面的计数或状态点；出错、加载时什么都不显示，不影响标签本身 */
export function ObjectSectionBadge({ badge: Badge, object }: { badge: NonNullable<ObjectSectionTab['badge']>; object: ObjectSectionProps['object'] }) {
  return (
    <Quiet>
      <Suspense fallback={null}><Badge object={object} /></Suspense>
    </Quiet>
  )
}

class Quiet extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false }

  static getDerivedStateFromError() {
    return { error: true }
  }

  render() {
    return this.state.error ? null : this.props.children
  }
}
