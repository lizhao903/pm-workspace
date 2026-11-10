// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { Navigate } from 'react-router'
import { useWorkspaces } from '../data'
import { useActiveModules, type ModuleDef } from '../plugin'
import { homeModule, resolveCurrent, useCurrentWorkspaceId } from './workspace'

// 打开 / 时进当前工作台的默认模块；工作台还在取时先不跳，取不到就进第一个模块
export function HomeRedirect({ modules }: { modules: ModuleDef[] }) {
  const live = useActiveModules(modules)
  const workspaces = useWorkspaces()
  const current = resolveCurrent(workspaces.data, useCurrentWorkspaceId())
  if (workspaces.isPending) return null
  const home = (current && homeModule(current, live)) ?? live[0]
  return <Navigate to={'/' + (home?.path ?? '')} replace />
}
