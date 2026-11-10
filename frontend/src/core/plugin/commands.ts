// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 命令面板的命令注册（docs/plugin-api.md 2.9）。插件经 api.commands 注册，外壳打开命令面板时读一次。
import type { Disposable } from './api'
import { CORE_OWNER } from './extensions'

// 外壳能力。CORE-02a 先只给跳转，抽屉、提示、确认框在 CORE-02b
export interface ShellApi {
  // 站内路径，带前导斜杠，例 /tasks
  navigate(to: string): void
}

export interface CommandDef {
  // 插件命令 = 清单 provides.commands 里的一项，形如 <插件 id>.<动作>
  id: string
  group: string
  title: string
  sub?: string
  // 额外参与搜索的词，不显示
  keywords?: string
  run(ctx: { shell: ShellApi }): void | Promise<void>
}

export interface CommandRegistry {
  register(cmd: CommandDef): Disposable
  // 动态条目，命令面板打开且有输入时才调用
  provide(source: string, fn: (q: string) => Promise<CommandDef[]>): Disposable
}

export type CommandProvider = { owner: string; source: string; fn: (q: string) => Promise<CommandDef[]> }

type Owned = { owner: string; cmd: CommandDef }

const commands: Owned[] = []
const providers: CommandProvider[] = []

function remove<T>(list: T[], x: T) {
  const i = list.indexOf(x)
  if (i >= 0) list.splice(i, 1)
}

// 给一个插件的 api.commands。不在清单里的 id：开发环境抛错，生产环境拒绝并把原因记进 reasons
export function commandRegistry(
  owner: string,
  allowed: { commands?: readonly string[]; search?: readonly string[] },
  reasons: string[],
  strict: boolean,
): CommandRegistry {
  const reject = (msg: string): Disposable => {
    if (strict) throw new Error(msg)
    reasons.push(msg)
    return { dispose() {} }
  }
  return {
    register(cmd) {
      if (!(allowed.commands ?? []).includes(cmd.id)) return reject(`注册的命令 ${cmd.id} 不在清单 provides.commands 里`)
      const x = { owner, cmd }
      commands.push(x)
      return { dispose: () => remove(commands, x) }
    },
    provide(source, fn) {
      if (!(allowed.search ?? []).includes(source)) return reject(`注册的搜索数据源 ${source} 不在清单 provides.search 里`)
      const x = { owner, source, fn }
      providers.push(x)
      return { dispose: () => remove(providers, x) }
    },
  }
}

// 内核模块（任务、联系人）登记的搜索数据源：不经清单，模块入口加载时登记一次，同名的只收第一个
export function registerCoreSearch(source: string, fn: (q: string) => Promise<CommandDef[]>): Disposable {
  if (providers.some((p) => p.owner === CORE_OWNER && p.source === source)) return { dispose() {} }
  const x = { owner: CORE_OWNER, source, fn }
  providers.push(x)
  return { dispose: () => remove(providers, x) }
}

// 撤掉某个插件注册的全部命令和数据源（加载失败、停用时）
export function disposeCommandsOf(owner: string) {
  for (const x of commands.filter((c) => c.owner === owner)) remove(commands, x)
  for (const x of providers.filter((p) => p.owner === owner)) remove(providers, x)
}

// 当前注册的命令，按注册顺序
export function registeredCommands(): CommandDef[] {
  return commands.map((x) => x.cmd)
}

export function commandProviders(): readonly CommandProvider[] {
  return [...providers]
}
