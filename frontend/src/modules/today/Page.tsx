import { Placeholder } from '../../core/shell/Placeholder'
import { TodayCards } from '../../core/shell/extensionHosts'

// 今日的内核部分还没做（TODAY-01 之后），先放占位，下面接插件注册的今日卡片
export default function Page() {
  return (
    <>
      <Placeholder title="今日" />
      <TodayCards />
    </>
  )
}
