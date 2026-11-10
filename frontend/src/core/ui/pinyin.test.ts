// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { charInitial, compareNames, initialRank, nameInitial } from './pinyin'
import { PY_TABLE } from './pinyinData'

describe('拼音首字母', () => {
  it('常见姓氏归到正确的字母', () => {
    const cases: Record<string, string> = {
      王: 'W', 李: 'L', 张: 'Z', 刘: 'L', 陈: 'C', 杨: 'Y', 赵: 'Z', 黄: 'H', 周: 'Z', 吴: 'W',
      徐: 'X', 孙: 'S', 胡: 'H', 朱: 'Z', 高: 'G', 林: 'L', 何: 'H', 郭: 'G', 马: 'M', 罗: 'L',
      梁: 'L', 宋: 'S', 郑: 'Z', 谢: 'X', 韩: 'H', 唐: 'T', 冯: 'F', 于: 'Y', 董: 'D', 萧: 'X',
      程: 'C', 曹: 'C', 袁: 'Y', 邓: 'D', 许: 'X', 傅: 'F', 沈: 'S', 彭: 'P', 吕: 'L', 苏: 'S',
      卢: 'L', 蒋: 'J', 蔡: 'C', 贾: 'J', 丁: 'D', 魏: 'W', 薛: 'X', 叶: 'Y', 阎: 'Y', 余: 'Y',
      潘: 'P', 杜: 'D', 戴: 'D', 夏: 'X', 钟: 'Z', 汪: 'W', 田: 'T', 任: 'R', 姜: 'J', 范: 'F',
      方: 'F', 石: 'S', 姚: 'Y', 谭: 'T', 廖: 'L', 邹: 'Z', 熊: 'X', 金: 'J', 陆: 'L', 郝: 'H',
      孔: 'K', 白: 'B', 崔: 'C', 康: 'K', 毛: 'M', 邱: 'Q', 秦: 'Q', 江: 'J', 史: 'S', 顾: 'G',
      侯: 'H', 邵: 'S', 孟: 'M', 龙: 'L', 万: 'W', 段: 'D', 雷: 'L', 钱: 'Q', 汤: 'T', 尹: 'Y',
      黎: 'L', 易: 'Y', 常: 'C', 武: 'W', 乔: 'Q', 贺: 'H', 赖: 'L', 龚: 'G', 文: 'W', 欧: 'O',
      艾: 'A', 安: 'A', 鄂: 'E', 饶: 'R',
    }
    for (const [ch, letter] of Object.entries(cases)) expect(nameInitial(`${ch}明`), ch).toBe(letter)
  })

  it('多音字作姓氏按姓氏读音，不按常用读音', () => {
    expect(nameInitial('单雄')).toBe('S') // 常用读 dan
    expect(nameInitial('解缙')).toBe('X') // 常用读 jie
    expect(nameInitial('曾国强')).toBe('Z') // 常用读 ceng
    expect(nameInitial('仇英')).toBe('Q') // 常用读 chou
    expect(nameInitial('区家明')).toBe('O') // 常用读 qu
    expect(nameInitial('查良镛')).toBe('Z') // 常用读 cha
    expect(nameInitial('覃斌')).toBe('Q')
    expect(nameInitial('翟志刚')).toBe('Z')
    expect(nameInitial('朴树')).toBe('P')
    expect(nameInitial('盖聂')).toBe('G')
    // 字表本身取的是常用读音
    expect(charInitial('单')).toBe('D')
    expect(charInitial('长')).toBe('C')
  })

  it('复姓先认两个字', () => {
    expect(nameInitial('万俟卨')).toBe('M')
    expect(nameInitial('尉迟恭')).toBe('Y')
    expect(nameInitial('澹台明月')).toBe('T')
    expect(nameInitial('长孙无忌')).toBe('Z')
    // 只有第一个字时按单姓
    expect(nameInitial('万')).toBe('W')
    expect(nameInitial('长江')).toBe('C')
  })

  it('名字里的多音字不影响归类：只看姓', () => {
    expect(nameInitial('李长乐')).toBe('L')
    expect(nameInitial('王重阳')).toBe('W')
  })

  it('英文名取首字母，大小写不论', () => {
    expect(nameInitial('Alice Wang')).toBe('A')
    expect(nameInitial('bob')).toBe('B')
    expect(nameInitial('  zoe')).toBe('Z')
  })

  it('常见繁体姓和 GB2312 没收的姓也认', () => {
    expect(nameInitial('陳大文')).toBe('C')
    expect(nameInitial('張學友')).toBe('Z')
    expect(nameInitial('黃家駒')).toBe('H')
    expect(nameInitial('禤靜')).toBe('X')
  })

  it('对不上的归到 #', () => {
    expect(nameInitial('')).toBe('#')
    expect(nameInitial('   ')).toBe('#')
    expect(nameInitial('123')).toBe('#')
    expect(nameInitial('@老王')).toBe('#')
    expect(nameInitial('\u{1F600}小明')).toBe('#')
    expect(nameInitial('〇号')).toBe('#')
    expect(nameInitial('堃哥')).toBe('#') // 表外的生僻字
  })

  it('二级字也有字母（按排序规则离线算出）', () => {
    expect(charInitial('亍')).toBe('C')
    expect(charInitial('冼')).toBe('X')
    expect(charInitial('阚')).toBe('K')
    expect(charInitial('隗')).toBe('W')
  })

  it('# 排在 Z 后面', () => {
    expect(initialRank('A')).toBeLessThan(initialRank('Z'))
    expect(initialRank('Z')).toBeLessThan(initialRank('#'))
  })

  it('字表 6763 字，没有重复，不超过 30KB', () => {
    const all = Object.values(PY_TABLE).join('')
    expect(Array.from(all)).toHaveLength(6763)
    expect(new Set(all).size).toBe(6763)
    expect(Object.keys(PY_TABLE).join('')).toBe('ABCDEFGHJKLMNOPQRSTWXYZ')
    expect(new TextEncoder().encode(all).length).toBeLessThan(30 * 1024)
  })
})

describe('按姓名排序', () => {
  it('拉丁名和中文名混排时按索引字母排，# 在最后', () => {
    const names = ['Zoe', '赵六', '王五', '孙七', '史强', 'alice', '123', '吴九']
    expect([...names].sort(compareNames)).toEqual(['alice', '史强', '孙七', '王五', '吴九', '赵六', 'Zoe', '123'])
  })
})
