// 后端返回的类型。只写到脚手架用到的字段，FE-02 按 docs/api-contract.md 补全。

export type Health = { ok: boolean; version: string }

export type ObjectStatus = { key: string; label: string; color: string; terminal: boolean }

export type ObjectType = {
  id: string
  name: string
  plural: string
  ref_prefix: string
  icon: string
  color: string
  builtin: boolean
  sort_order: number
  statuses: ObjectStatus[]
}

export type Dictionary = {
  id: string
  name: string
  description: string
  scope: string
  builtin: boolean
  sort_order: number
}
