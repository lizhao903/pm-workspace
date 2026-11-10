// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package agent

import (
	"fmt"
	"slices"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/store"
)

// 技能（AG-01b2）：内置技能登记在这里，内容同原型 web-next/src/agentdata.ts 的 SKILLS 里来源为「内置」的 10 条。
// 内置只读，要改就复制成自定义技能（SPEC-settings-16.9）。

var builtinSkills = []store.Skill{
	{ID: "sk_video", Name: "网页演示做视频", Desc: "web-video-presentation：文稿做成点击驱动的网页演示，可合成口播、录屏成 mp4",
		Uses:         []string{"写文档", "语音合成", "终端"},
		Instructions: "按 内容编写、规划检查、网页开发、第一章验收、其余章节、音频、录屏、分发包 推进；4 个检查点必须停下等人确认；画面比例在规划检查时定死。"},
	{ID: "sk_video_review", Name: "视频数据复盘", Desc: "对比各平台的播放、互动和封面表现，给下一集的建议",
		Uses:         []string{"B 站", "YouTube", "抖音"},
		Instructions: "按平台列核心数据，指出封面和标题的差异，给出续集选题和发布时间建议。"},
	{ID: "sk_premarket", Name: "盘前简报", Desc: "开盘前汇总自选标的的隔夜变动、要闻和今天的关键价位",
		Uses:         []string{"Binance 行情", "富途 OpenD", "网页搜索"},
		Instructions: "按市场分组，每个标的一行：隔夜涨跌、要闻一句、支撑压力位；最后列今天触发概率高的提醒。"},
	{ID: "sk_trade_review", Name: "交易复盘", Desc: "按笔复盘当日成交，归因到策略、手动和风控拦截",
		Uses:         []string{"查持仓", "查委托"},
		Instructions: "盈亏按策略和手动分开；每笔亏损写清入场理由和出场原因；风控拦截单列；结论不超过 5 条。"},
	{ID: "sk_weekly", Name: "写周报", Desc: "按项目归类本周完成、进行中、下周计划",
		Uses:         []string{"查任务", "写文档"},
		Instructions: "已完成按项目归类，进行中写清卡点，下周计划挑优先级最高的 5 条。"},
	{ID: "sk_triage", Name: "消息分诊", Desc: "判断一条消息要不要跟进、紧急程度",
		Uses:         []string{"读 IM 消息", "查联系人"},
		Instructions: "有明确诉求、问题或截止时间的需要跟进；寒暄和群通知不需要。"},
	{ID: "sk_reply", Name: "客户回复话术", Desc: "按对方语气起草回复，不承诺具体上线时间",
		Uses:         []string{"回复 IM 消息"},
		Instructions: "先确认收到，再说明下一步和时间点；涉及排期只说「评估后同步」。"},
	{ID: "sk_breakdown", Name: "需求拆解", Desc: "把一句诉求拆成用户故事和验收标准",
		Uses:         []string{"新建 / 更新任务"},
		Instructions: "每条故事写清角色、动作、价值，附 2 到 4 条可验证的验收标准。"},
	{ID: "sk_minutes", Name: "会议纪要整理", Desc: "从转写稿提炼结论、待办和遗留问题",
		Uses:         []string{"写文档"},
		Instructions: "结论单列；待办写负责人和截止时间；没有定论的放进遗留问题。"},
	{ID: "sk_competitor", Name: "竞品分析", Desc: "按功能、价格、目标用户对比几家竞品",
		Uses:         []string{"网页搜索"},
		Instructions: "每家一行，列功能差异、价格区间、目标用户和最近的更新。"},
}

// BuiltinSkills 返回内置技能的副本，按原型顺序，Source 为 builtin。
func BuiltinSkills() []store.Skill {
	out := make([]store.Skill, len(builtinSkills))
	for i, k := range builtinSkills {
		k.Source = store.SkillBuiltin
		k.Uses = slices.Clone(k.Uses)
		out[i] = k
	}
	return out
}

// BuiltinSkill 按 id 取一条内置技能。
func BuiltinSkill(id string) (store.Skill, bool) {
	for _, k := range BuiltinSkills() {
		if k.ID == id {
			return k, true
		}
	}
	return store.Skill{}, false
}

// skillSection 把 Agent 挂的技能按挂载顺序拼成「技能：<名称>」一段一段，放在 agentSection 后面。
// 取不到的技能（插件停用、已删除）调用方已经跳过，这里只管拼。
func skillSection(skills []store.Skill) string {
	if len(skills) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n## 你会的技能\n\n")
	b.WriteString("下面每段是一个做事方法。用户的请求对得上某个技能时，按那个技能的做法来；对不上就不用。\n")
	for _, k := range skills {
		fmt.Fprintf(&b, "\n### 技能：%s\n\n", k.Name)
		if d := strings.TrimSpace(k.Desc); d != "" {
			fmt.Fprintf(&b, "%s\n", d)
		}
		if w := strings.TrimSpace(k.When); w != "" {
			fmt.Fprintf(&b, "什么时候用：%s\n", w)
		}
		if len(k.Uses) > 0 {
			fmt.Fprintf(&b, "用到的工具：%s\n", strings.Join(k.Uses, "、"))
		}
		fmt.Fprintf(&b, "怎么做：\n%s\n", strings.TrimSpace(k.Instructions))
	}
	return b.String()
}
