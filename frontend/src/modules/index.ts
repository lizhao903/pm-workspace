// 内核模块。顺序就是侧边栏顺序。
import type { ModuleDef } from '../core/plugin'
import { module as today } from './today'
import { module as tasks } from './tasks'
import { module as docs } from './docs'
import { module as contacts } from './contacts'
import { module as conversations } from './conversations'
import { module as settings } from './settings'

export const coreModules: ModuleDef[] = [today, tasks, docs, contacts, conversations, settings]
