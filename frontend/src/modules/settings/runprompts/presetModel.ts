// 角色（SPEC-settings-24，AUTO-03 由预置提示词升级）的纯函数：前端先挡的校验，口径同后端 PUT /api/run-prompts。
import type { RoleDirKind, RolePermission, RunPreset } from '../../../core/data'

export const PRESET_MAX = 30
export const PRESET_SCENE_MAX = 40
export const PRESET_CONTENT_MAX = 4000
export const PRESET_OUTPUT_MAX = 2000

export const PERMISSION_OPTIONS: { value: RolePermission; label: string }[] = [
  { value: 'accept_edits', label: '允许改文件（acceptEdits）' },
  { value: 'read_only', label: '只读' },
]

export const DIR_KIND_OPTIONS: { value: RoleDirKind; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'code', label: '代码目录' },
  { value: 'prototype', label: '原型目录' },
  { value: 'prd', label: 'PRD 目录' },
]

/** 一条的问题：场景、内容、输出要求各一个，没有为 undefined */
export function presetIssues(list: readonly RunPreset[], i: number): { scene?: string; content?: string; output?: string } {
  const p = list[i]
  const scene = p.scene.trim()
  const out: { scene?: string; content?: string; output?: string } = {}
  if (!scene) out.scene = '写一个角色场景'
  else if ([...scene].length > PRESET_SCENE_MAX) out.scene = `最多 ${PRESET_SCENE_MAX} 字`
  else if (list.findIndex((x) => x.scene.trim() === scene) !== i) out.scene = '和上面的重复了'
  const content = p.content.trim()
  if (!content) out.content = '写上执行要求'
  else if ([...content].length > PRESET_CONTENT_MAX) out.content = `最多 ${PRESET_CONTENT_MAX} 字`
  if ([...(p.output ?? '').trim()].length > PRESET_OUTPUT_MAX) out.output = `最多 ${PRESET_OUTPUT_MAX} 字`
  return out
}

/** 发给后端的样子：去首尾空白、新字段补默认（同后端）；新条目 id 留空由后端补 */
export function cleanPresets(list: readonly RunPreset[]): RunPreset[] {
  return list.map((p) => ({
    id: p.id, scene: p.scene.trim(), content: p.content.trim(), default: p.default,
    permission: p.permission ?? 'accept_edits', output: (p.output ?? '').trim(), dir_kind: p.dir_kind ?? 'any',
  }))
}

/** 加一条时的空白角色 */
export function blankRole(): RunPreset {
  return { id: '', scene: '', content: '', default: false, permission: 'accept_edits', output: '', dir_kind: 'any' }
}

/** 设为默认是单选：点了的那条为真，其余为假；再点已默认的那条取消默认 */
export function toggleDefault(list: readonly RunPreset[], i: number): RunPreset[] {
  const on = !list[i].default
  return list.map((p, j) => ({ ...p, default: j === i ? on : false }))
}
