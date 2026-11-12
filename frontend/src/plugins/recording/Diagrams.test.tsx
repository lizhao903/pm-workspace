// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RecordingDiagrams } from '../../core/data'
import { Diagrams } from './Diagrams'

const diagrams = (): RecordingDiagrams => ({
  flow: {
    title: '讨论脉络',
    nodes: [
      { id: 'n1', label: '现状', kind: 'start' },
      { id: 'n2', label: '要不要做', kind: 'decision' },
      { id: 'n3', label: '先做小样', kind: 'end' },
    ],
    edges: [{ from: 'n1', to: 'n2', label: '提问' }, { from: 'n2', to: 'n3', label: '' }],
  },
  tree: {
    title: '项目/任务树',
    root: { label: '会议主题', children: [{ label: '项目 A', children: [{ label: '任务 A1', children: [] }] }, { label: '项目 B', children: [] }] },
  },
})

describe('纪要图表', () => {
  it('流程图自绘 SVG：标题、节点、边标注都在，带无障碍标签', () => {
    render(<Diagrams diagrams={diagrams()} />)
    expect(screen.getByText('讨论脉络')).toBeInTheDocument()
    const svg = screen.getByRole('img', { name: '流程图：讨论脉络' })
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(screen.getByText('现状')).toBeInTheDocument()
    expect(screen.getByText('要不要做')).toBeInTheDocument()
    expect(screen.getByText('先做小样')).toBeInTheDocument()
    expect(screen.getByText('提问')).toBeInTheDocument()
    // 三个节点 + 两个边的连线
    expect(svg.querySelectorAll('rect, polygon')).toHaveLength(3)
    expect(svg.querySelectorAll('.rec-flow-edge')).toHaveLength(2)
  })

  it('树形图按层级渲染（role=tree/treeitem，带层级）', () => {
    render(<Diagrams diagrams={diagrams()} />)
    expect(screen.getByText('项目/任务树')).toBeInTheDocument()
    const tree = screen.getByRole('tree', { name: '树形图：项目/任务树' })
    expect(tree).toBeInTheDocument()
    expect(screen.getAllByRole('treeitem')).toHaveLength(4)
    expect(screen.getByText('会议主题').closest('li')).toHaveAttribute('aria-level', '1')
    expect(screen.getByText('任务 A1').closest('li')).toHaveAttribute('aria-level', '3')
  })

  it('空/坏数据显示提示，不崩', () => {
    render(<Diagrams diagrams={null} />)
    expect(screen.getByText('这次纪要没有生成流程图。')).toBeInTheDocument()
    expect(screen.getByText('这次纪要没有生成树形图。')).toBeInTheDocument()
  })

  it('半坏数据：坏节点/边被丢掉，剩下的照常画', () => {
    const broken = {
      flow: { title: '', nodes: [{ id: 'a', label: 'A', kind: 'start' }, { id: '', label: '缺 id' }, null], edges: [{ from: 'a', to: 'nope' }] },
      tree: { title: '', root: { label: '根', children: [{ label: '' }] } },
    } as unknown as RecordingDiagrams
    render(<Diagrams diagrams={broken} />)
    const svg = screen.getByRole('img', { name: '流程图：讨论脉络' })
    expect(svg.querySelectorAll('rect, polygon')).toHaveLength(1)
    expect(svg.querySelectorAll('.rec-flow-edge')).toHaveLength(0)
    expect(screen.getByText('根')).toBeInTheDocument()
  })
})
