import { describe, expect, it } from 'vitest'
import type { WorkObject } from '../../core/data'
import { SOURCE_VIEW, sourceTag } from './sourceModel'

const t = (source: string, ref?: Record<string, unknown>) => ({ source, props: ref ? { source_ref: ref } : null }) as WorkObject
const names = (id: string) => (id === 'wh_a' ? 'Sentry 线上告警' : null)

describe('来源标签', () => {
  it('各来源的文字', () => {
    expect(sourceTag(t('manual'), names)?.text).toBe('人工')
    expect(sourceTag(t('import'), names)).toEqual({ text: '人工', kind: 'manual', title: '导入：导入脚本建的任务' })
    expect(sourceTag(t('webhook', { hook_id: 'wh_a', delivery_id: 'dl_1' }), names)?.text).toBe('Webhook · Sentry 线上告警')
    expect(sourceTag(t('schedule', { schedule_id: 'sch_1', name: '周会前整理议程' }), names)?.text).toBe('定时 · 周会前整理议程')
    expect(sourceTag(t('im', { message_id: 'm1', channel: '飞书' }), names)?.text).toBe('IM · 飞书')
    expect(sourceTag(t('incident', { incident_id: 'inc_1' }), names)?.text).toBe('运行异常')
    expect(sourceTag(t(''), names)).toBeNull()
  })

  it('Webhook 删了写「已删除」，列表还没取到时只写 Webhook', () => {
    expect(sourceTag(t('webhook', { hook_id: 'wh_gone' }), names)?.text).toBe('Webhook · 已删除')
    expect(sourceTag(t('webhook', { hook_id: 'wh_a' }), () => undefined)?.text).toBe('Webhook')
  })

  it('人工创建把导入的算进来，其余按原值', () => {
    expect(SOURCE_VIEW.manual.filter).toEqual(['manual', 'import'])
    expect(SOURCE_VIEW.webhook.filter).toEqual(['webhook'])
  })
})
