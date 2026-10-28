// 内核模块，各自用 defineCoreModule 标 core。顺序就是侧边栏顺序，启用的插件模块接在后面。
// initPlugins 先把它们登记进模块注册表（所有者是内核，不能停用），再加载插件
import { initPlugins, type ModuleDef } from '../core/plugin'
import { module as today } from './today'
import { module as tasks } from './tasks'
import { module as docs } from './docs'
import { module as contacts } from './contacts'
import { module as conversations } from './conversations'
import { module as settings } from './settings'

export const kernelModules: ModuleDef[] = [today, tasks, docs, contacts, conversations, settings]

// 侧边栏和路由用的完整列表。插件入口是动态 import，要等它们注册完才建路由，所以这里顶层 await；
// 加载出错只影响出错的插件，不会卡住内核模块
export const coreModules: ModuleDef[] = await initPlugins(kernelModules)
