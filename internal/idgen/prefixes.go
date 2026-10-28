package idgen

import "fmt"

// Entry 是一条前缀登记：一类实体一个前缀，不许两类共用。
type Entry struct {
	Prefix string // id 前缀，Prefixed(Prefix) 生成 <Prefix>_xxxx
	Entity string // 实体名
	Table  string // 落在哪张表；空表示原型里有、后端还没建表，前缀先占着
	Proto  string // 原型 web-next/src/ids.ts 里 ID_PREFIX 的 key，没有对应就留空
}

// Alias 记原型前缀和后端不一致的地方：后端已上线的前缀不改，原型的前缀保留不给别的实体用。
type Alias struct {
	Proto  string // 原型 ID_PREFIX 的 key
	From   string // 原型用的前缀
	Prefix string // 后端实际用的前缀，必须已登记
	Why    string
}

// Registry 是全部 id 前缀。新表要用新前缀先在这里登记，重复登记 TestRegistryUnique 会失败。
var Registry = []Entry{
	// 内核：对象和它的附属
	{"obj", "object", "objects", ""},
	{"cat", "category", "categories", ""},
	{"tag", "tag", "tags", ""},
	{"lnk", "link", "links", ""},
	{"rev", "revision", "revisions", ""},
	{"stk", "stakeholder", "stakeholders", ""},
	{"dit", "dictItem", "dict_items", ""},
	{"sgr", "shortcutGroup", "shortcut_groups", ""},
	{"sct", "shortcut", "shortcuts", ""},
	// Agent 与执行
	{"apv", "provider", "agent_providers", ""},
	{"ags", "agentSession", "agent_sessions", ""},
	{"agm", "agentMessage", "agent_messages", ""},
	{"q", "agentQuestion", "", ""}, // ask_user 的问题，存在消息里不单独建表
	{"art", "artifact", "artifacts", ""},
	{"run", "taskRun", "task_runs", "sopRun"}, // 原型的开发执行和 SOP 运行都用 run；SOP 运行以后单独建表时另登记前缀，原型跟着改
	// 0014 以后的新表
	{"sec", "secret", "vault_secrets", ""},
	{"aud", "audit", "audits", ""},
	{"ntf", "notification", "notifications", ""},
	{"sch", "schedule", "schedules", ""},
	{"srn", "schedule_run", "schedule_runs", ""},
	{"wh", "webhook", "webhooks", "webhook"},
	{"dl", "delivery", "webhook_deliveries", "delivery"},
	{"ws", "workspace", "workspaces", "workspace"},
	{"dir", "localDir", "local_dirs", "localDir"},
	{"idn", "contactIdentity", "contact_identities", ""}, // 原型的身份挂在 Contact.im 上，没有单独的 id
	{"cv", "conversation", "conversations", ""},          // 原型按渠道加群名认会话，没有 id；ch 是项目绑定，不是会话
	{"cn", "connector", "connectors", "connector"},

	// 以下是原型里有、后端还没建表的实体，前缀和原型一致
	// 沟通
	{"ct", "contact", "", "contact"},
	{"msg", "message", "im_messages", "message"}, // IM 插件的表（IM-01a）
	{"att", "attachment", "", "attachment"},
	{"rp", "reply", "", "reply"},
	// 项目
	{"mt", "material", "", "material"},
	{"pd", "projectDoc", "", "projectDoc"},
	{"pt", "prototype", "", "prototype"},
	{"ch", "projectChat", "", "projectChat"},
	// 任务与自动化
	{"sop", "sop", "", "sop"},
	{"inc", "incident", "", "incident"},
	// Agent 与模型
	{"ag", "agent", "", "agent"},
	{"ar", "agentRun", "", "agentRun"},
	{"op", "output", "", "output"},
	{"kb", "kb", "", "kb"},
	{"kd", "kbDoc", "", "kbDoc"},
	{"sk", "skill", "", "skill"},
	// 工作台、域名
	{"dm", "domainRoute", "", "domainRoute"},
	// 视频
	{"vd", "video", "", "video"},
	{"sr", "series", "", "series"},
	{"pb", "publish", "", "publish"},
	{"tp", "topic", "", "topic"},
	{"cl", "clip", "", "clip"},
	// 交易
	{"wl", "watchlist", "", "watchlist"},
	{"al", "alert", "", "alert"},
	{"ae", "alertEvent", "", "alertEvent"},
	{"st", "strategy", "", "strategy"},
	{"rl", "strategyRule", "", "strategyRule"},
	{"bk", "backtest", "", "backtest"},
	{"ac", "account", "", "account"},
	{"ps", "position", "", "position"},
	{"od", "order", "", "order"},
	{"rn", "strategyRun", "", "strategyRun"},
	// 浏览器与终端
	{"bt", "browserTab", "", "browserTab"},
	{"tb", "termTab", "", "termTab"},
	{"pn", "termPane", "", "termPane"},
}

// Aliases 是原型前缀到后端前缀的对照，原型前缀算作已占用。
var Aliases = []Alias{
	{"task", "tk", "obj", "任务是 objects 里的一种类型"},
	{"project", "pj", "obj", "项目是 objects 里的一种类型"},
	{"doc", "dc", "obj", "文档是 objects 里的一种类型"},
	{"session", "ss", "ags", "agent_sessions 已上线用 ags"},
	{"provider", "pv", "apv", "agent_providers 已上线用 apv"},
	{"artifact", "af", "art", "artifacts 已上线用 art"},
	{"schedule", "sc", "sch", "schedules（0020）已上线用 sch"},
}

// Lookup 按前缀查登记。
func Lookup(prefix string) (Entry, bool) {
	for _, e := range Registry {
		if e.Prefix == prefix {
			return e, true
		}
	}
	return Entry{}, false
}

// Check 校验登记表：前缀格式、前缀和实体都不重复、原型前缀不被占用、别名指向已登记前缀。
func Check(reg []Entry, aliases []Alias) error {
	prefixes := map[string]string{}
	entities := map[string]bool{}
	for _, e := range reg {
		if !validPrefix(e.Prefix) {
			return fmt.Errorf("前缀 %q 只能是 1 到 4 个小写字母", e.Prefix)
		}
		if o, ok := prefixes[e.Prefix]; ok {
			return fmt.Errorf("id 前缀 %s 同时登记给了 %s 和 %s", e.Prefix, o, e.Entity)
		}
		if entities[e.Entity] {
			return fmt.Errorf("实体 %s 登记了两次", e.Entity)
		}
		prefixes[e.Prefix] = e.Entity
		entities[e.Entity] = true
	}
	for _, a := range aliases {
		if o, ok := prefixes[a.From]; ok {
			return fmt.Errorf("原型前缀 %s（%s）已保留，不能再登记给 %s", a.From, a.Proto, o)
		}
		if _, ok := prefixes[a.Prefix]; !ok {
			return fmt.Errorf("别名 %s 指向未登记的前缀 %s", a.From, a.Prefix)
		}
		prefixes[a.From] = a.Proto
	}
	return nil
}

func validPrefix(p string) bool {
	if len(p) == 0 || len(p) > 4 {
		return false
	}
	for _, r := range p {
		if r < 'a' || r > 'z' {
			return false
		}
	}
	return true
}
