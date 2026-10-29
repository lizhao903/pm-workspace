// 项目插件的页面（PJ-01c）：没有二级菜单，模块根是全部项目列表，/<根>/<项目 id>[/<标签>] 是详情。
// 一级菜单点「项目」回到根路径，也就是列表；打开项目时记进最近打开，列表按它排序。
import { Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { useProjectTabs } from '../../core/plugin'
import { ListPage } from './ListPage'
import { tabOf, touchRecent, type ProjectTab } from './model'
import { ProjectPage } from './ProjectPage'
import './projects.css'

export default function Page() {
  const rest = useParams()['*'] ?? ''
  const { pathname } = useLocation()
  const navigate = useNavigate()
  // 插件登记的标签（商单）也认作合法的标签段
  const pluginTabs = useProjectTabs()
  // 模块根路径：去掉子路径，模块以后挂到别的路径下也不用改
  const root = pathname.slice(0, pathname.length - rest.length).replace(/\/+$/, '')
  const [id, tabSeg, ...extra] = rest.split('/').filter(Boolean).map(decodeURIComponent)

  const open = (pid: string, tab?: ProjectTab) => {
    touchRecent(pid)
    navigate(`${root}/${encodeURIComponent(pid)}${tab && tab !== 'overview' ? `/${tab}` : ''}`)
  }
  if (!id) return <ListPage onOpen={open} />
  const tab = tabOf(tabSeg) ?? (pluginTabs.some((t) => t.key === tabSeg) ? tabSeg : null)
  if (!tab || extra.length) return <Navigate to={`${root}/${encodeURIComponent(id)}`} replace />
  return (
    <ProjectPage id={id} tab={tab} onAll={() => navigate(root)}
      onTab={(t) => navigate(`${root}/${encodeURIComponent(id)}${t === 'overview' ? '' : `/${t}`}`, { replace: true })} />
  )
}
