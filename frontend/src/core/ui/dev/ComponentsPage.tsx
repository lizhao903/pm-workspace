// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useState } from 'react'
import {
  Avatar, Button, Checkbox, ConfirmDialog, Drawer, EmptyState, ErrorState, Field, IconButton, IconClose, Input,
  ListSegHead, ListSegMore, LoadingState, PageTitle, Pill, SearchSelect, Select, Subnav, Tag, Tags, Textarea,
  ThemeSwitch, useTheme, type SearchOption, type SubnavItem,
} from '..'
import './components-page.css'

// 基础组件演示页，只在 dev 构建里挂路由 /_dev/components。数据都是写死的演示数据，不连后端。

const PROJECTS: SearchOption[] = [
  { value: 'p1', label: '官网改版', keywords: 'guanwang', group: '进行中' },
  { value: 'p2', label: '支付接入', hint: '本周截止', group: '进行中' },
  { value: 'p3', label: '会员体系', group: '进行中' },
  { value: 'p4', label: '数据看板', hint: '已归档', group: '已结束', disabled: true },
  { value: 'p5', label: '移动端适配', group: '已结束' },
]
const PEOPLE: SearchOption[] = ['张三', '李四', '王五', 'Alice Chen', 'Bob'].map((n) => ({
  value: n, label: n, icon: <Avatar name={n} size={18} />,
}))
const STATUS = [
  { value: 'todo', label: '待办' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
]
const SUBNAV: SubnavItem<string>[] = [
  ...['外观', '字典', '对象类型', '干系人', '凭证保险箱', '模型服务商'].map((l, i) => ({ key: 'g' + i, label: l, group: '通用' })),
  ...['连接器', 'Webhook', '定时任务', '运行异常', '域名', '插件', '日志'].map((l, i) => ({
    key: 'a' + i, label: l, group: '集成', desc: i === 0 ? '3 个已连接' : undefined, alert: i === 3 ? 2 : undefined,
  })),
]
const SEGMENTS = [
  { key: 'overdue', label: '已逾期', tone: 'danger' as const, rows: ['补上周的验收记录', '回复合作方邮件'] },
  { key: 'today', label: '今天', rows: ['评审支付接入方案', '整理会员体系需求', '更新路线图', '约设计走查', '写周报'] },
]

export default function ComponentsPage() {
  const { resolved } = useTheme()
  const [proj, setProj] = useState('p2')
  const [filter, setFilter] = useState('')
  const [people, setPeople] = useState<string[]>(['张三'])
  const [status, setStatus] = useState('doing')
  const [title, setTitle] = useState('')
  const [tried, setTried] = useState(false)
  const [notify, setNotify] = useState(true)
  const [tags, setTags] = useState(['产品', '设计', '一个比较长的标签名字'])
  const [nav, setNav] = useState('g0')
  const [segOpen, setSegOpen] = useState<Record<string, boolean>>({ overdue: true, today: true })
  const [segShown, setSegShown] = useState(3)

  const [drawer, setDrawer] = useState(false)
  const [draft, setDraft] = useState({ title: '整理会员体系需求', desc: '' })
  const [saved, setSaved] = useState(draft)
  const dirty = draft.title !== saved.title || draft.desc !== saved.desc
  const [confirmDel, setConfirmDel] = useState(false)
  const [deleted, setDeleted] = useState(false)

  return (
    <div className="cp-page">
      <header className="cp-head">
        <div>
          <h1>基础组件</h1>
          <p className="muted">FE-01b 的组件一览，写法照原型 web-next/src。当前主题：{resolved}</p>
        </div>
        <ThemeSwitch />
      </header>

      <section className="cp-section">
        <h2>按钮</h2>
        <div className="cp-card">
          <div className="cp-row">
            <Button variant="primary">保存</Button>
            <Button variant="ghost">取消</Button>
            <Button variant="outline">导出</Button>
            <Button variant="danger">删除</Button>
            <Button variant="danger-ghost">删除任务</Button>
            <Button variant="primary" disabled>已保存</Button>
          </div>
          <div className="cp-row">
            <span className="cp-label">小号</span>
            <Button variant="primary" size="sm">新建</Button>
            <Button variant="outline" size="sm">筛选</Button>
            <IconButton label="关闭"><IconClose /></IconButton>
            <IconButton label="关闭" size="sm"><IconClose size={12} /></IconButton>
          </div>
        </div>
      </section>

      <section className="cp-section">
        <h2>表单</h2>
        <div className="cp-card form">
          <div className="field-row">
            <Field label="标题" required error={tried && !title.trim() ? '必填' : undefined}>
              <Input value={title} invalid={tried && !title.trim()} placeholder="要做的事" onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="状态" hint="选项少用原生下拉">
              <Select value={status} options={STATUS} onValueChange={setStatus} />
            </Field>
          </div>
          <Field label="描述">
            <Textarea rows={3} placeholder="补充说明" />
          </Field>
          <div className="field-row">
            <Field label="所属项目" wrap={false} hint="可搜索、上下键选择、回车确认、Esc 关闭">
              <SearchSelect variant="field" aria-label="所属项目" value={proj} noneLabel="不属于项目" searchPlaceholder="搜项目"
                options={PROJECTS} missingLabel={() => '已删除的项目'} onChange={setProj} />
            </Field>
            <Field label="参与人" wrap={false} hint="多选，勾选不关弹层">
              <SearchSelect variant="field" multiple aria-label="参与人" value={people} placeholder="加参与人"
                options={PEOPLE} onChange={setPeople} />
            </Field>
          </div>
          <div className="cp-row">
            <Checkbox checked={notify} onCheckedChange={setNotify}>完成后通知我</Checkbox>
            <Checkbox disabled>不可用的选项</Checkbox>
            <div className="spacer" />
            <Button variant="primary" onClick={() => setTried(true)}>校验</Button>
          </div>
          <div className="cp-row">
            <span className="cp-label">工具条</span>
            <SearchSelect aria-label="项目筛选" value={filter} noneLabel="全部项目" options={PROJECTS} onChange={setFilter} />
            <SearchSelect aria-label="已删除的值" value="gone" options={PROJECTS} missingLabel={() => '已删除的项目'} onChange={() => {}} />
          </div>
        </div>
      </section>

      <section className="cp-section">
        <h2>标记</h2>
        <div className="cp-card">
          <div className="cp-row">
            <span className="cp-label">Pill</span>
            <Pill label="进行中" color="var(--accent)" />
            <Pill label="已完成" color="var(--ok)" />
            <Pill label="待验收" color="var(--warn)" />
            <Pill label="已逾期" color="var(--danger)" />
            <Pill label="未设颜色" />
          </div>
          <div className="cp-row">
            <span className="cp-label">Tag</span>
            <Tags>
              {tags.map((t) => <Tag key={t} onRemove={() => setTags(tags.filter((x) => x !== t))}>{t}</Tag>)}
              <Tag>只读标签</Tag>
            </Tags>
          </div>
          <div className="cp-row">
            <span className="cp-label">Avatar</span>
            {['张三', '李四', '王五', 'Alice Chen', 'Bob'].map((n) => <Avatar key={n} name={n} />)}
            <Avatar name="大头像" size={40} />
          </div>
        </div>
      </section>

      <section className="cp-section">
        <h2>页面标题</h2>
        <p className="muted">外壳给了顶栏位置就送进顶栏，这里没有顶栏，原地渲染。</p>
        <div className="cp-card">
          <PageTitle parent="任务" count={28} desc="本周到期和逾期的任务" actions={<Button variant="primary" size="sm">新建任务</Button>}>
            本周
          </PageTitle>
        </div>
      </section>

      <section className="cp-section">
        <h2>二级菜单</h2>
        <p className="muted">条目超过 12 个出搜索框；回车打开第一条，Esc 清空。760px 以下变成顶部横排。</p>
        <div className="cp-subnav">
          <Subnav title="设置" items={SUBNAV} active={nav} onSelect={setNav} search={{ placeholder: '搜设置项' }}>
            <Button variant="outline" size="sm" className="spacer">新建</Button>
          </Subnav>
          <div className="cp-subnav-main">当前：{SUBNAV.find((s) => s.key === nav)?.label}</div>
        </div>
      </section>

      <section className="cp-section">
        <h2>列表分段</h2>
        <div className="cp-card cp-card-flush">
          {SEGMENTS.map((s) => {
            const open = segOpen[s.key] ?? true
            const limit = s.key === 'today' ? segShown : s.rows.length
            return (
              <div key={s.key}>
                <ListSegHead label={s.label} n={s.rows.length} open={open} tone={s.tone}
                  onToggle={() => setSegOpen({ ...segOpen, [s.key]: !open })} />
                {open && s.rows.slice(0, limit).map((r) => <div key={r} className="cp-list-row"><span className="ellipsis">{r}</span></div>)}
                {open && <ListSegMore n={s.rows.length - limit} onMore={() => setSegShown(segShown + 100)} />}
              </div>
            )
          })}
        </div>
      </section>

      <section className="cp-section">
        <h2>空状态、加载中、出错</h2>
        <div className="cp-grid">
          <EmptyState compact title="还没有任务" desc="新建一条，或者从 IM 消息转过来" action={<Button variant="primary" size="sm">新建任务</Button>} />
          <div className="cp-card"><LoadingState /></div>
          <ErrorState compact error={new Error('后端未连接：请求没到后端')} onRetry={() => {}} />
        </div>
      </section>

      <section className="cp-section">
        <h2>抽屉与确认</h2>
        <p className="muted">抽屉里改了内容再按 Esc 或点关闭，会先确认；删除确认列出连带影响。</p>
        <div className="cp-card">
          <div className="cp-row">
            <Button variant="outline" onClick={() => setDrawer(true)}>打开抽屉</Button>
            <Button variant="danger-ghost" onClick={() => setConfirmDel(true)}>删除需求</Button>
            {deleted && <span className="muted">已删除（演示）</span>}
          </div>
        </div>
      </section>

      <Drawer open={drawer} kicker="TSK-0042" dirty={dirty}
        onClose={() => { setDrawer(false); setDraft(saved) }}
        footer={(close) => (
          <>
            {dirty && <span className="muted">有未保存的修改</span>}
            <div className="spacer" />
            <Button variant="ghost" onClick={close}>取消</Button>
            <Button variant="primary" disabled={!dirty} onClick={() => setSaved(draft)}>{dirty ? '保存' : '已保存'}</Button>
          </>
        )}>
        <div className="form">
          <Field label="标题" required>
            <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </Field>
          <Field label="描述">
            <Textarea value={draft.desc} onChange={(e) => setDraft({ ...draft, desc: e.target.value })} />
          </Field>
          <Field label="所属项目" wrap={false}>
            <SearchSelect variant="field" aria-label="抽屉里的所属项目" value={proj} noneLabel="不属于项目" options={PROJECTS} onChange={setProj} />
          </Field>
        </div>
      </Drawer>

      <ConfirmDialog open={confirmDel} danger title="删除需求 REQ-0012？" confirmLabel="删除"
        impacts={['3 条子任务一起删除', '2 个文档解除关联，文档本身保留', '1 条进行中的执行记录停止']}
        onCancel={() => setConfirmDel(false)}
        onConfirm={() => { setConfirmDel(false); setDeleted(true) }}>
        删除后不能恢复。
      </ConfirmDialog>
    </div>
  )
}
