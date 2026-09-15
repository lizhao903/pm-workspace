// 设置页：左侧二级导航 + 右侧内容区，整页占据主内容区。
// 收口原则——工作对象本身的增删改归主界面，所有枚举值维护和需要读写数据库的配置都在这里。
import { useWorkspace, type SettingsSection } from '../hooks/workspace'
import TypesSection from './settings/TypesSection'
import CategoriesSection from './settings/CategoriesSection'
import TagsSection from './settings/TagsSection'
import StakeholdersSection from './settings/StakeholdersSection'
import DictSection from './settings/DictSection'
import DataSection from './settings/DataSection'
import ProvidersSection from './settings/ProvidersSection'
import '../settings.css'

interface NavEntry {
  id: SettingsSection
  label: string
  hint: string
}

const SECTIONS: NavEntry[] = [
  { id: 'types', label: '工作对象类型', hint: '类型与每个类型的状态集' },
  { id: 'categories', label: '分类', hint: '按类型的分类树' },
  { id: 'tags', label: '标签', hint: '重命名 / 合并 / 删除' },
  { id: 'stakeholders', label: '干系人', hint: '负责人与参与人的名册' },
  { id: 'priority', label: '优先级', hint: '字典' },
  { id: 'link-relation', label: '关联关系', hint: '字典' },
  { id: 'data', label: '数据与备份', hint: '导出 / 快照 / 迁移版本' },
  { id: 'agent', label: 'Agent 供应商', hint: '模型服务接入与密钥' },
]

export default function SettingsPage() {
  const { nav, setNav } = useWorkspace()
  const section: SettingsSection = nav.section ?? 'types'

  return (
    <div className="st-page">
      <div className="st-head">
        <span className="st-page-title">设置</span>
        <span className="faint st-page-sub">枚举值与配置都在这里维护；工作对象本身的增删改在主界面</span>
      </div>

      <div className="st-body">
        <nav className="st-nav" aria-label="设置导航">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`st-nav-item ${s.id === section ? 'st-nav-item-active' : ''}`.trim()}
              aria-current={s.id === section ? 'page' : undefined}
              onClick={() => setNav({ kind: 'page', page: 'settings', section: s.id })}
            >
              <span className="st-nav-label truncate">{s.label}</span>
              <span className="faint st-nav-hint truncate">{s.hint}</span>
            </button>
          ))}
        </nav>

        <div className="st-content">
          {renderSection(section)}
        </div>
      </div>
    </div>
  )
}

function renderSection(section: SettingsSection) {
  switch (section) {
    case 'categories':
      return <CategoriesSection />
    case 'tags':
      return <TagsSection />
    case 'stakeholders':
      return <StakeholdersSection />
    case 'priority':
      return (
        <DictSection
          dictId="priority"
          title="优先级"
          desc="工作对象的优先级取值。原本写死在前端代码里，现在是可配置字典：想加一档 P4 不用改代码。"
          usageNoun="个工作对象"
          keyExample="P4"
          labelExample="最低"
        />
      )
    case 'link-relation':
      return (
        <DictSection
          dictId="link_relation"
          title="关联关系"
          desc="工作对象之间能建立哪些关系。原本写死在后端常量里，现在是可配置字典：想加一种「阻塞于」直接在这里建。"
          usageNoun="条关联"
          keyExample="blocked_by"
          labelExample="阻塞于"
        />
      )
    case 'data':
      return <DataSection />
    case 'agent':
      return <ProvidersSection />
    case 'types':
    default:
      return <TypesSection />
  }
}
