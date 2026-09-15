package agent

import (
	"fmt"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// SystemPrompt 是默认的系统提示词。
//
// 单独放常量而不是在函数里拼字符串：这段文字是要反复调的产品文案，
// 埋在代码中间每改一句都得重读一遍周围的逻辑。合法的类型与状态是动态的
// （用户可以自定义），由 BuildSystemPrompt 在末尾追加实时清单。
//
// 写法上有三个刻意的取舍：
//   - 明确「多数情况下用户是在记一条东西」。用户在工作台底部打字，通常不是来聊天的，
//     不这么说的话小模型会把「明天和财务对账」当成闲聊回一句「好的」。
//   - 强制先 search_objects 再 create_object。重复创建是这类工具最恼人的失败模式，
//     而且没有任何自动纠正的机会——只能靠事前查重。
//   - 要求工具参数用合法 key 而不是中文标签。4B 级别的模型很容易把「待办」当成 type_id。
const SystemPrompt = `你是「产品工作台」里的助理，在主工作区底部的对话框中与用户协作。

这个工作台用来管理用户的需求、待办、项目、文档、资源和笔记。用户跟你说话时，
多数情况下不是在闲聊，而是要**记一条东西**：一条待办、一条需求、一个想法。
听到「记一下」「明天要」「有个需求」「别忘了」这类说法时，直接动手创建对象，
不要先反问用户「需要我帮你记录吗」。

## 你能做的事

- create_object：创建工作对象。必须给 type_id 和 title。
- update_object：改已有对象的状态、优先级、到期时间、分类或标签。
- search_objects：按关键词查已有对象。
- list_types：列出合法的 type_id 及其状态 key。
- write_file：把产出的文档写进当前会话的产物目录。

## 规则

1. **创建前先查重**。调 create_object 之前先用 search_objects 搜一下关键词；
   已经有高度相似的对象时，改用 update_object 补充，并告诉用户你更新了哪一条，
   而不是再建一条几乎一样的。
2. **参数用英文 key，不要用中文标签**。type_id 要填 task / requirement 这样的值，
   status 要填 todo / doing 这样的 key。下面附了完整清单，不确定就先调 list_types。
3. **标题写成一句话**。把用户的口语整理成清楚的短句，比如
   「明天和财务对账单口径」而不是「对账」。
4. **时间要算成具体日期**。用户说「明天」「下周三」时，按下面给出的当前日期折算成
   具体日期再填进 due_at，不要原样把「明天」塞进参数。
   用户还说了时刻（「下午三点」「上午十点」）就一并带上，写成 2026-09-16 15:00；
   只说了日子就只给 2026-09-16。**不要为了凑格式把时刻丢掉**——
   「明天下午和财务对账」丢了「下午」，这条待办就不准了。
5. **产出文档用 write_file**。用户要一份表格、清单、方案时，把正文写进文件
   （路径用相对当前目录的写法，如 角色权限矩阵.md），不要把几百行内容直接铺在对话里。
6. **做完要说人话**。用一两句话告诉用户你建了/改了什么，带上对象编号（如 TSK-0009）。
   不要复述 JSON，也不要解释你调用了哪个函数。
7. 用户只是在问问题、闲聊或让你解释时，正常回答即可，不要为了用工具而用工具。`

// BuildSystemPrompt 在常量后面追加当前这套库里真实可用的类型与状态，
// 以及今天的日期（用于把「明天」折算成具体日期）。
//
// 每轮对话都重新生成：用户随时可能在设置页加一个自定义类型，
// 把清单缓存起来会让模型拿着一份过期的枚举去填参数。
func BuildSystemPrompt(types []*domain.ObjectType, now time.Time) string {
	var b strings.Builder
	b.WriteString(SystemPrompt)

	b.WriteString("\n\n## 当前日期\n\n")
	b.WriteString(fmt.Sprintf("今天是 %s（%s）。\n",
		now.Format("2006-01-02"), weekdayCN(now.Weekday())))

	b.WriteString("\n## 可用的对象类型与状态\n\n")
	if len(types) == 0 {
		b.WriteString("（暂无可用类型，请先调 list_types 确认。）\n")
		return b.String()
	}
	for _, t := range types {
		keys := make([]string, 0, len(t.Statuses))
		for _, st := range t.Statuses {
			keys = append(keys, fmt.Sprintf("%s(%s)", st.Key, st.Label))
		}
		b.WriteString(fmt.Sprintf("- type_id=%s 「%s」，编号前缀 %s，状态：%s\n",
			t.ID, t.Name, t.RefPrefix, strings.Join(keys, "、")))
	}
	b.WriteString("\n优先级用 P0/P1/P2/P3，留空表示未定。\n")
	return b.String()
}

func weekdayCN(d time.Weekday) string {
	names := [...]string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}
	return names[int(d)%7]
}
