// 详情页标题里的项目名（SPEC-projects-2.9）：点开是可搜索的项目菜单，选了切到那个项目、停在同一个标签。
// 用 core/ui 的 SearchSelect（plain 外观，同屏 Agent、SOP 标签的挑选也是它），键盘：上下选、回车切、Esc 关。
// 列全部没删的项目，最近打开的在前（和项目列表「最近打开」同一份本机记录），其余按名称；当前项目打勾。
// 项目标志跟着选项走（按钮上显示当前项目的标志），所以标题行不再单独放标志。
import { useMemo } from 'react'
import { useProjects } from '../../core/data'
import { SearchSelect } from '../../core/ui'
import { ProjectMarkView } from './Mark'
import { loadRecent, switchOrder } from './model'

export function ProjectSwitcher({ current, name, onSwitch }: {
  current: string
  /** 项目列表还没取到时按钮上显示的名字 */
  name: string
  onSwitch: (id: string) => void
}) {
  const q = useProjects()
  const list = q.data?.data
  // 切项目时记进了最近打开；loadRecent 回的是同一份缓存，变了才是新数组
  const recent = loadRecent()
  const options = useMemo(() => switchOrder(list ?? [], recent).map((p) => ({
    value: p.id, label: p.name, keywords: `${p.desc} ${p.root}`, icon: <ProjectMarkView p={p} size={18} />,
  })), [list, recent])
  return (
    <SearchSelect variant="plain" className="pj-switch" value={current} aria-label="切换项目" title="切换项目"
      options={options} searchPlaceholder="搜项目" emptyText={q.isPending ? '加载中' : '没有项目'} noMatchText="没有匹配的项目"
      missingLabel={() => name} menuWidth={300}
      onChange={(id) => { if (id && id !== current) onSwitch(id) }} />
  )
}
