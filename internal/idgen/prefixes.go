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
	{"msg", "message", "im_messages", "message"},          // IM 插件的表（IM-01a）
	{"att", "attachment", "im_attachments", "attachment"}, // IM 插件补的附件 id（IM-04a），附件本身在消息里，表里是获取状态
	{"rp", "reply", "im_replies", "reply"},                // IM 插件的表（IM-02a）
	{"ob", "outbox", "im_outbox", ""},                     // IM 插件主动发出的消息（0.17.0）
	{"imu", "imMute", "im_mutes", "imMute"},               // IM 插件的自动忽略发信人（TSK-0495）
	// 项目
	{"mt", "material", "projects_materials", "material"},    // 项目插件的表（PJ-03a）
	{"pd", "projectDoc", "", "projectDoc"},                  // PJ-03a 起项目文档并进资料用 mt，前缀保留
	{"pt", "prototype", "projects_prototypes", "prototype"}, // 项目插件的表（PJ-04a）
	{"wt", "worktree", "projects_worktrees", ""},            // 项目插件的需求工作区（AUTO-07）
	{"tr", "testRun", "projects_test_runs", ""},             // 项目插件的测试环境与测试报告（AUTO-08）
	{"rel", "release", "projects_releases", ""},             // 项目插件的发布记录（AUTO-10）
	{"psy", "protoSync", "projects_proto_syncs", ""},        // 项目插件的原型同步记录（AUTO-11）
	{"ch", "projectChat", "", "projectChat"},
	// 任务与自动化
	{"sop", "sop", "sop_flows", "sop"},               // SOP 插件的表（SOP-01a）
	{"spr", "sopRun", "sop_runs", ""},                // SOP 插件的执行（SOP-01b）；run 已给开发执行，原型的 sopRun 还用 run
	{"sfd", "sopFolder", "sop_folders", "sopFolder"}, // SOP 插件的流程库文件夹（TSK-0482）
	{"spb", "sopBatch", "", ""},                      // SOP 插件的批量发起批次（TSK-0717），记在 sop_runs.source_ref，不单独建表
	{"spk", "sopSkip", "sop_skips", ""},              // SOP 插件的自动触发没发起的记录（TSK-0491）
	{"sdb", "sopDebug", "", ""},                      // SOP 插件的一次调试（TSK-0491），不落库，只在回包和日志里
	{"inc", "incident", "incidents", "incident"},     // 内核的表（INC-01a，0043），运行异常
	// Agent 与模型
	{"ag", "agent", "agents", "agent"},               // 内核的表（AG-01b1，0032）
	{"atc", "agentToolCall", "agent_tool_calls", ""}, // 内核的表（AG-02a，0035），要人确认的工具调用
	{"dbg", "agentDebugCall", "", ""},                // 调试对话里要人确认的调用，只在进程内存里（AG-02c）
	{"smk", "runnerSmoke", "", ""},                   // 执行器集成检查（TSK-0722），最近一次存在 agent_settings 的 runner_smoke_deepseek 下，不单独建表
	{"ar", "agentRun", "agent_runs", "agentRun"},     // 内核的表（AG-01b4，0036）
	{"op", "output", "", "output"},
	{"kb", "kb", "knowledge_bases", "kb"}, // 内核的表（AG-01b3，0034）
	{"kd", "kbDoc", "kb_docs", "kbDoc"},   // 内核的表（AG-01b3，0034），切块 kb_chunks 用整数 id
	{"sk", "skill", "skills", "skill"},    // 内核的表（AG-01b2，0033），只放自定义技能
	// 工作台、域名
	{"dm", "domainRoute", "domains_routes", "domainRoute"}, // 内网域名插件的表（DOM-01a）
	// 视频
	{"vd", "video", "video_videos", "video"},        // 视频插件的表（VID-01a）
	{"sr", "series", "video_series", "series"},      // 视频插件的表（VID-01a）
	{"pb", "publish", "video_publishes", "publish"}, // 视频插件的表（VID-01a），检查点按视频加阶段认，没有 id
	{"vaf", "videoArtifact", "video_artifacts", ""}, // 视频插件的表（VID-01b），原型的 af 已给内核产物；验收记录用整数 id
	{"pa", "platformAccount", "video_accounts", ""}, // 视频插件的表（VID-05a），平台账号；数据快照没有 id
	{"vct", "coverTest", "video_cover_tests", ""},   // 视频插件的表（VID-05b），封面 A/B 测试；分组没有 id
	{"tp", "topic", "", "topic"},
	{"cl", "clip", "", "clip"},
	{"deal", "deal", "video_deals", "deal"},            // 视频插件的表（VID-08d），商单
	{"bpm", "biliMessage", "video_bili_messages", ""},  // 视频插件的表（TSK-0455），B 站私信
	{"vsh", "videoShot", "video_shots", ""},            // 视频插件的表（TSK-0456），分镜
	{"vbr", "videoBroll", "video_shot_brolls", ""},     // 视频插件的表（TSK-0456），分镜里的 B-roll
	{"vmr", "videoMediaRoot", "video_media_roots", ""}, // 视频插件的表（TSK-0456），登记的素材目录
	// 交易
	{"wl", "watchlist", "", "watchlist"},
	{"al", "alert", "trade_alerts", "alert"},                 // 交易插件的表（TRD-03a），盯盘提醒
	{"ae", "alertEvent", "trade_alert_events", "alertEvent"}, // 交易插件的表（TRD-03a），提醒触发记录
	{"st", "strategy", "", "strategy"},
	{"rl", "strategyRule", "", "strategyRule"},
	{"bk", "backtest", "", "backtest"},
	{"ac", "account", "trade_accounts", "account"},       // 交易插件的表（TRD-05a），模拟盘账户
	{"ps", "position", "trade_fills", "position"},        // 交易插件（TRD-05a），持仓编号记在成交流水的 pos_id 上，没有单独的表
	{"od", "order", "trade_orders", "order"},             // 交易插件的表（TRD-05a），委托
	{"fl", "fill", "trade_fills", ""},                    // 交易插件的表（TRD-05a），成交流水
	{"rn", "strategyRun", "trade_runs", "strategyRun"},   // 交易插件的表（TRD-05b），策略部署；日志 trade_run_logs 用整数 id
	{"hl", "haltRecord", "trade_halts", ""},              // 交易插件的表（TRD-06a），熔断记录
	{"rcn", "reconRun", "trade_recons", ""},              // 交易插件的表（TRD-08b），实盘账户的一次对账
	{"rc", "reconItem", "trade_recon_items", ""},         // 交易插件的表（TRD-08b），对账差异（原型 ReconItem 的 id 也是 rc 开头，原型没有登记前缀）
	{"ear", "etfAnomalyRule", "etf_anomaly_rules", ""},   // 宽基监控插件的表（ETF-01b），异动规则；内置 7 条用固定 id
	{"eae", "etfAnomalyEvent", "etf_anomaly_events", ""}, // 宽基监控插件的表（ETF-01b），异动命中记录
	// 浏览器与终端
	{"bt", "browserTab", "browser_tabs", "browserTab"}, // 浏览器插件的表（BR-01a）
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
