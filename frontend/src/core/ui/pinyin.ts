// 姓名的拼音首字母（CT-03a）：联系人按姓名排序、分段用；放在 core 里，插件（项目干系人）也能用。
// 不引拼音库：常用字表在 pinyinData.ts（GB2312 6763 字，约 20KB），名字的第一个字是姓，
// 所以多音字一律按姓氏读音处理（单 Shan、解 Xie、曾 Zeng），复姓先认两个字。
// 表外的字（生僻字、符号、数字、emoji）归到 #。
import { PY_TABLE } from './pinyinData'

/** 复姓：读音和第一个字单独念时不同的 */
const COMPOUND: Record<string, string> = { 万俟: 'M', 尉迟: 'Y', 澹台: 'T', 长孙: 'Z' }

/** 多音字作姓氏时的读音，覆盖字表里的默认读音 */
const SURNAME: Record<string, string> = {
  单: 'S', 解: 'X', 仇: 'Q', 区: 'O', 查: 'Z', 覃: 'Q', 翟: 'Z', 秘: 'B', 种: 'C', 召: 'S', 繁: 'P',
  句: 'G', 藏: 'Z', 祭: 'Z', 便: 'P', 重: 'C', 折: 'S', 番: 'P', 乜: 'N', 曾: 'Z', 盖: 'G', 缪: 'M',
}

/** 字表之外的常见姓氏：GB2312 没收的简体字和常见繁体姓 */
const EXTRA: Record<string, string> = {
  禤: 'X', 陳: 'C', 張: 'Z', 黃: 'H', 劉: 'L', 楊: 'Y', 吳: 'W', 趙: 'Z', 鄭: 'Z', 謝: 'X', 許: 'X', 鄧: 'D',
  馮: 'F', 蕭: 'X', 葉: 'Y', 蘇: 'S', 盧: 'L', 蔣: 'J', 韓: 'H', 鍾: 'Z', 鐘: 'Z', 羅: 'L', 譚: 'T', 錢: 'Q',
  孫: 'S', 馬: 'M', 賴: 'L', 龔: 'G', 歐: 'O', 陸: 'L', 衛: 'W', 閻: 'Y', 嚴: 'Y', 賈: 'J', 鄒: 'Z', 呂: 'L',
  範: 'F', 溫: 'W', 華: 'H', 鄺: 'K', 關: 'G', 練: 'L', 鄔: 'W', 魯: 'L', 蘭: 'L', 喬: 'Q', 齊: 'Q', 龍: 'L',
  萬: 'W', 顧: 'G', 莊: 'Z', 湯: 'T', 談: 'T', 聶: 'N', 項: 'X', 單: 'S', 曾: 'Z',
}

let charMap: Map<string, string> | null = null

/** 字到首字母；第一次用时才展开字表 */
function table() {
  if (!charMap) {
    charMap = new Map()
    for (const [letter, chars] of Object.entries(PY_TABLE)) for (const ch of chars) charMap.set(ch, letter)
  }
  return charMap
}

/** 一个汉字的拼音首字母（按常用读音）；不认识的字返回 null */
export function charInitial(ch: string): string | null {
  return table().get(ch) ?? EXTRA[ch] ?? null
}

/**
 * 姓名的索引字母：A 到 Z，或 #。
 * 英文名取首字母；中文名按姓氏读音取首字母；空名字、数字、符号和表外的字归到 #。
 */
export function nameInitial(name: string): string {
  const s = name.trim()
  const first = Array.from(s)[0]
  if (!first) return '#'
  if (/[a-z]/i.test(first)) return first.toUpperCase()
  const compound = COMPOUND[s.slice(0, 2)]
  if (compound) return compound
  return SURNAME[first] ?? charInitial(first) ?? '#'
}

/** 索引字母的排位：A 到 Z 依次，# 最后 */
export const initialRank = (x: string) => (x === '#' ? 99 : x.charCodeAt(0))

const zh = new Intl.Collator('zh-CN')

/** 按姓名排：先按索引字母（A 到 Z，# 最后），同字母再按 zh-CN 排，口径同联系人页「按姓名」 */
export const compareNames = (a: string, b: string) => initialRank(nameInitial(a)) - initialRank(nameInitial(b)) || zh.compare(a, b)
