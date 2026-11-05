// 页面分包的懒加载带重试（TSK-0390 等 6 条）。
// 分包没取到时先看服务是不是换了新版本：换了就刷新一次（同一版本只刷一次，见 staleBuild）；
// 没换（服务正在重启、网络抖了一下）就退避后再取，重试成功就当没发生过，不上报。
// 重试用完还失败才把错误抛给路由，由「出错了」页上报并给「重新加载」按钮。
// Chrome 不缓存失败的动态 import，同一个地址再 import 一次会重新请求（临时实例上实测过）。
import { isChunkError } from './errorReport'
import { checkBuild, type BuildCheck } from './staleBuild'

/** 每次重试前等多久（毫秒）；次数就是数组长度。合计 5 秒左右，盖过一次本机服务重启 */
export const CHUNK_RETRY_DELAYS: readonly number[] = [500, 1500, 3000]

export type LoadChunkOptions = {
  delays?: readonly number[]
  /** 测试替换用 */
  sleep?: (ms: number) => Promise<void>
  check?: () => Promise<BuildCheck>
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function loadChunk<T>(load: () => Promise<T>, opts: LoadChunkOptions = {}): Promise<T> {
  const delays = opts.delays ?? CHUNK_RETRY_DELAYS
  const sleep = opts.sleep ?? wait
  const check = opts.check ?? checkBuild
  for (let i = 0; ; i++) {
    try {
      return await load()
    } catch (err) {
      if (!isChunkError(err) || i >= delays.length) throw err
      const st = await check()
      // 已经发起刷新：挂住不往下走，免得刷新前闪一下「出错了」
      if (st === 'reloading') return new Promise<T>(() => {})
      // 新版本刷过一次还是旧页面，再取旧文件名也取不到
      if (st === 'looped') throw err
      await sleep(delays[i])
    }
  }
}
