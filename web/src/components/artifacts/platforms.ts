// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 平台名单来自字典 artifact_platform，不在前端硬编码。
//
// 硬编码的话，用户在「设置 → 字典」里加一个平台之后，登记表单里仍然没有它——
// 而字典页会显示它已经加好了。两个地方对同一份名单各有一份副本，必然有一份是旧的。
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { DictItem } from '../../lib/types'

export const ARTIFACT_PLATFORM_DICT = 'artifact_platform'

/** 字典拉不到时的兜底：至少让「本地文件 / 其他」两个能选，表单不至于没法提交。
 *  兜底不写全名单——写全了就是第二份硬编码副本，而它一定会和字典分叉。 */
const FALLBACK: DictItem[] = [
  { id: 'dit_plt_local', dict_id: ARTIFACT_PLATFORM_DICT, key: 'local', label: '本地文件', color: '#868e96', description: '', sort_order: 10, meta: {}, type_id: null, usage: 0, archived_at: null, created_at: '', updated_at: '' },
  { id: 'dit_plt_other', dict_id: ARTIFACT_PLATFORM_DICT, key: 'other', label: '其他', color: '#495057', description: '', sort_order: 100, meta: {}, type_id: null, usage: 0, archived_at: null, created_at: '', updated_at: '' },
]

let cache: DictItem[] | null = null
let inflight: Promise<DictItem[]> | null = null
const subs = new Set<() => void>()

async function load(): Promise<DictItem[]> {
  if (cache) return cache
  if (!inflight) {
    inflight = api.dictItems(ARTIFACT_PLATFORM_DICT)
      .then((items) => {
        cache = items.filter((i) => !i.archived_at)
        return cache
      })
      .catch(() => {
        // 不缓存失败结果：缓存了的话，一次网络抖动会让这一整个会话都只剩兜底两项。
        return FALLBACK
      })
      .finally(() => { inflight = null })
  }
  const got = await inflight
  subs.forEach((f) => f())
  return got
}

/** 字典改过之后调一次，让所有用到平台名单的地方重新拉。 */
export function invalidatePlatforms(): void {
  cache = null
  subs.forEach((f) => f())
}

export function usePlatforms(): DictItem[] {
  const [items, setItems] = useState<DictItem[]>(cache ?? [])
  useEffect(() => {
    let alive = true
    const sync = () => { if (alive) setItems(cache ?? []) }
    subs.add(sync)
    void load().then((got) => { if (alive) setItems(got) })
    return () => { alive = false; subs.delete(sync) }
  }, [])
  return items
}

/**
 * detectPlatform 从链接猜平台，依据是字典项 meta.hosts 里的域名特征。
 *
 * **这只是表单上的即时预览，后端才是权威。**同一套识别在
 * internal/store/sqlite 的 detectPlatform 里也有一份，四条登记渠道
 * （手工、Agent 写盘、执行扫目录、MCP 回写）里只有手工那条经过前端，
 * 所以真正决定平台的必须是后端。两边读的是同一份字典 meta.hosts，
 * 结论一致；不一致时以保存后返回的值为准。
 *
 * 猜错的代价只是分组归错，用户改一下就行，所以这里宁可猜也不留空——
 * 留空会让每条登记都多一步手动选平台，而那一步最常被跳过。
 *
 * 认不出来返回 'other' 而不是 ''：空平台在统计页上是一个没有名字的分组，
 * 用户看不出那是什么。
 */
export function detectPlatform(url: string, platforms: DictItem[]): string {
  const u = url.trim().toLowerCase()
  if (!u) return ''
  for (const p of platforms) {
    const hosts = p.meta?.hosts
    if (!Array.isArray(hosts)) continue
    for (const h of hosts) {
      // 空串会匹配任何链接，把第一个带空 hosts 的平台变成万能匹配。
      // 迁移里的种子不会有空串（有测试守着），但用户可以在字典页手填。
      if (typeof h === 'string' && h.trim() && u.includes(h.toLowerCase())) return p.key
    }
  }
  return 'other'
}

export function platformLabel(key: string, platforms: DictItem[]): string {
  return platforms.find((p) => p.key === key)?.label ?? key ?? '—'
}

export function platformColor(key: string, platforms: DictItem[]): string {
  return platforms.find((p) => p.key === key)?.color || '#868e96'
}
