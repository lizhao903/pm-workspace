package api

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"unicode"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/conversation"
	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/fsbrowse"
	"github.com/lizhao903/pm-workspace/internal/imident"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/localdir"
	"github.com/lizhao903/pm-workspace/internal/notify"
	"github.com/lizhao903/pm-workspace/internal/plugins/browser"
	"github.com/lizhao903/pm-workspace/internal/plugins/domains"
	"github.com/lizhao903/pm-workspace/internal/plugins/etf"
	"github.com/lizhao903/pm-workspace/internal/plugins/im"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
	"github.com/lizhao903/pm-workspace/internal/plugins/sop"
	"github.com/lizhao903/pm-workspace/internal/plugins/terminal"
	"github.com/lizhao903/pm-workspace/internal/plugins/trade"
	"github.com/lizhao903/pm-workspace/internal/plugins/video"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/store"
	"github.com/lizhao903/pm-workspace/internal/webhook"
	"github.com/lizhao903/pm-workspace/internal/workspace"
)

// 契约文档里的结构示例和 Go 结构序列化后的字段名逐个比对（QA-04）。
//
// 路由测试只管「有这个接口」，字段名写错、漏写、结构加了字段没记文档，它都看不见。
// 文档里结构有三种写法，都抽：
//   - json 代码块；
//   - 行内 `Name`：`{a, b?, c}`，同一行里的「`c` 是 `{x, y}[]`」当成 c 的嵌套结构；
//   - 首列表头为「字段」的表格，首列反引号里的名字就是字段。
//
// 示例怎么对上结构：示例前一行以 `Name`： 开头（或行内 `Name`：`{`）的，按 Name 对；
// 没有这种标签的 json 块和字段表，按「所在小节#json序号 / #table序号」对。
// 对照表维护在测试里，不往文档里加注释：标签本来就在文档里，加注释是第二份要同步的东西；
// 而且 IM 一节由别的任务维护，不该为了测试去改它。
// 对照表两头都盯：文档里有标签的示例测试没登记，或登记了的示例在文档里找不到，都报错。
//
// 口径：
//   - 结构一侧的字段是把每个字段都填上非零值再 json.Marshal 得到的，所以 omitempty 的字段也算，
//     自定义 MarshalJSON 的输出也算——比的是线上实际可能出现的字段名。
//   - 示例里带 `?` 的字段（可选）照样必须在结构里存在；可选只说明调用方可以不传。
//   - 示例里写了 `...` / `…` 的那一层，只查「示例里的字段结构里都有」，不要求列全。
//   - 结构一侧是 map 的（序列化出来是空对象），不往下比，键是数据不是字段。
//   - partial：文档只列了一部分字段（例如只列新增的列、或 SSE 联合事件里的一种），只查示例到结构这一个方向。

type contractSpec struct {
	v       any    // 对应的 Go 值，取它的类型
	partial bool   // 文档只列了一部分字段
	skip    string // 不比对的理由
}

var contractSpecs = map[string]contractSpec{
	"响应信封#json1": {v: envelope{}},
	"响应信封#json2": {v: errBody{}},

	"ProgressInput": {v: domain.ProgressInput{}},
	"Progress":      {v: domain.Progress{}},
	"ClaimInput":    {v: domain.ClaimInput{}},
	"进展与领取#table1":  {v: domain.ProgressInput{}},
	"进展与领取#table2":  {v: domain.ClaimInput{}},
	"ClaimResult":   {v: domain.ClaimResult{}},
	"TodayCard":     {v: domain.TodayCard{}},
	"TodayRun":      {v: domain.TodayRun{}},

	// 联系人字段表只列 0026 新加的列
	"干系人名册 stakeholders#table1": {v: domain.Stakeholder{}, partial: true},
	"Identity":                  {v: imident.Identity{}},
	"Conversation":              {v: conversation.Conversation{}},
	// SSE 事件是一个联合结构，示例只是其中的 question
	"Agent 对话 agent#json1": {v: agent.StreamEvent{}, partial: true},
	"Agent":                {v: domain.Agent{}},
	"AgentImpact":          {v: agentImpactResult{}},
	"Skill":                {v: skillView{}},
	// Agent 工具授权（AG-02a）：confirm 事件是 SSE 联合结构里的一种
	"Agent 对话 agent#json2": {v: agent.StreamEvent{}, partial: true},
	"AgentGrants":          {v: agentGrants{}},
	// Agent 执行记录（AG-01b4）：字段表只列要说明的几个
	"AgentRun":                     {v: store.AgentRun{}},
	"Agent 执行记录 agent-runs#table1": {v: store.AgentRun{}, partial: true},

	// 知识库（AG-01b3）
	"KnowledgeBase":                {v: kbView{}},
	"知识库 knowledge-bases:settings": {v: kbSettingsView{}},
	"知识库 knowledge-bases:counts":   {v: store.KbCounts{}},
	"KbDoc":                        {v: store.KbDoc{}},

	// 溯源字段表只列 0031 补的列
	"输出产物 artifacts / 溯源字段（AG-03b，0031）#table1": {v: domain.Artifact{}, partial: true},

	"LocalDir":   {v: localdir.Dir{}},
	"FsFile":     {v: fsbrowse.FileContent{}},
	"FsFileList": {v: fsbrowse.FileList{}},
	"FsRoot":     {v: fsbrowse.ExtraRoot{}},

	"ConnectorDef":       {v: connector.Def{}},
	"Connector":          {v: connector.Connector{}},
	"ConnectorDef.oauth": {v: connector.OAuthSpec{}},
	"连接器 connectors / OAuth 授权（CONN-01b）:oauth": {v: connector.OAuthStatus{}},

	"插件 plugins / 插件管理（CORE-04b，plugin-api.md 第 4 节）#json1": {v: pluginView{}},
	"插件 plugins / 插件管理（CORE-04b，plugin-api.md 第 4 节）#json2": {v: pluginErrBody{}},

	"Audit":        {v: audit.Entry{}},
	"Notification": {v: notify.Notification{}},
	// 运行异常（INC-01a）
	"Incident":       {v: incident.Incident{}},
	"IncidentReport": {v: incidentReport{}},
	"Schedule":       {v: schedule.Schedule{}},
	"ScheduleRun":    {v: schedule.Run{}},
	// 字段表只解释了部分字段
	"定时任务 schedules / 调度和执行记录#table1": {v: schedule.Run{}, partial: true},
	"Webhook":  {v: webhook.Webhook{}},
	"Delivery": {v: webhook.Delivery{}},
	"Webhook 配置 webhooks / 收件和投递记录#table1": {v: webhook.Delivery{}, partial: true},

	"Workspace":             {v: workspace.Workspace{}},
	"WorkspaceTemplate":     {v: workspace.Template{}},
	"工作台 workspaces:groups": {v: workspace.Group{}},
	"工作台 workspaces:mark":   {v: workspace.Mark{}},

	"ProjectStakeholder":         {v: projects.Stakeholder{}},
	"ProjectConversation":        {v: projects.ProjectConversation{}},
	"ProjectMaterial":            {v: projects.Material{}},
	"ProjectPrototype":           {v: projects.Prototype{}},
	"PrototypeLogLine":           {v: projects.LogLine{}},
	"PrototypeCrash":             {v: projects.Crash{}},
	"ProjectSummary":             {v: projects.ProjectSummary{}},
	"ProjectProfile":             {v: projects.Profile{}},
	"ProfileSummary":             {v: projects.ProfileSummary{}},
	"Worktree":                   {v: projects.Worktree{}},
	"TestRun":                    {v: projects.TestRun{}},
	"TestStep":                   {v: projects.TestStep{}},
	"Release":                    {v: projects.Release{}},
	"ReleaseStep":                {v: projects.ReleaseStep{}},
	"项目插件 projects / 发布:release": {skip: "SOP 节点输出由 map 拼出，无结构"},
	"WorktreeSettings":           {skip: "回包是 PortSettings 加 reserved、active、dir 拼出的 map"},
	"工作对象 objects / 任务阶段与提出人:props.requester":                          {v: domain.Requester{}},
	"SOP 编排插件 sop / Claude Code 执行与条件回退（AUTO-01/02，插件版本 0.9.0）:claude": {v: sop.StepClaude{}},

	// 原型同步（AUTO-11）
	"ProtoSync":         {v: projects.ProtoSync{}},
	"ProtoSyncItem":     {v: projects.ProtoSyncItem{}},
	"ProtoSyncCounts":   {v: projects.ProtoSyncCounts{}},
	"ProtoSyncSettings": {v: projects.ProtoSyncSettings{}},
	"ProtoSyncState":    {v: projects.ProtoSyncState{}},
	"SyncPoint":         {v: projects.SyncPoint{}},
	"项目插件 projects / 原型同步:sync": {skip: "SOP 节点输出由 map 拼出，无结构"},

	"Incoming": {v: im.Incoming{}},
	"Message":  {v: im.Message{}},
	// 两种错误的附加字段是 actionError.extra 这个 map 拼出来的，没有可比的结构
	"IM 消息插件 im / 处理动作#json1": {skip: "错误附加字段来自 map，无结构"},
	"IM 消息插件 im / 事件#json1":   {v: im.Received{}},
	"MaterialSource":          {v: im.MaterialSource{}},
	"OutboxItem":              {v: im.OutboxItem{}},
	"NameRefillResult":        {v: im.NameRefillResult{}},
	"IM 消息插件 im / 从 Slack 补联系人邮箱#table1": {v: im.EmailBackfillResult{}},

	"SopFlow":   {v: sop.Flow{}},
	"SopFolder": {v: sop.Folder{}},
	// IM 触发的过滤条件、执行顺序与拦截（TSK-0481）：json 示例和字段表
	"SopIMTrigger": {v: sop.IMTrigger{}},
	"SOP 编排插件 sop / IM 触发#table1": {v: sop.IMTrigger{}},
	"SopNodeType":    {v: sop.NodeType{}},
	"SopRun":         {v: sop.Run{}},
	"SopRunStep":     {v: sop.RunStep{}},
	"SopRunBrief":    {v: sop.RunBrief{}},
	"SopRunAction":   {v: sop.Action{}},
	"SopAssistReply": {v: sop.Reply{}},
	// 流水线视图与治理（AUTO-12）
	"SopStepHold":       {v: sop.StepHold{}},
	"SopStepQueue":      {v: sop.StepQueue{}},
	"SopProviderWait":   {v: sop.StepProviderWait{}}, // 等服务商恢复（TSK-0392）
	"SopPipeline":       {v: sop.Pipeline{}},
	"SopPipelineRun":    {v: sop.PipelineRun{}},
	"SopPipelineStep":   {v: sop.PipelineStep{}},
	"SopPipelineBudget": {v: sop.PipelineBudget{}},
	"SopClaudeUsage":    {v: sop.ClaudeUsage{}},
	"SopWaitingItem":    {v: sop.WaitingItem{}},

	"TerminalSession": {v: terminal.Session{}},

	"DomainSettings": {v: domains.Settings{}},
	"DomainRoute":    {v: domains.Route{}},
	"DomainStatus":   {v: domains.Status{}},
	"DomainConfig":   {v: domains.Config{}},

	"TradeInstrument": {v: trade.Instrument{}},
	"TradeWatchlist":  {v: trade.Watchlist{}},
	"TradeSource":     {v: trade.SourceInfo{}},
	"TradeSync":       {v: trade.SyncResult{}},
	// 行情缓存和推送（TRD-02a）
	"TradeSourceHealth": {v: trade.SourceHealth{}},
	"TradeQuote":        {v: trade.Quote{}},
	"TradeBook":         {v: trade.Book{}},
	"TradeFunding":      {v: trade.FundingView{}},
	"TradeKline":        {v: trade.Kline{}},
	"TradeKlineMeta":    {v: trade.KlineMeta{}},
	"TradeStreamEvent":  {v: trade.StreamEvent{}},
	// 盯盘提醒（TRD-03a）
	"TradeAlert":      {v: trade.Alert{}},
	"TradeAlertEvent": {v: trade.AlertEvent{}},
	"TradeAlertFired": {v: trade.AlertFired{}},
	"TradeAlertValue": {v: trade.AlertValue{}},
	// 策略和回测（TRD-04b）
	"TradeStrategy":       {v: trade.Strategy{}},
	"TradeRule":           {v: trade.Rule{}},
	"TradeOperand":        {skip: "联合类型：自定义 MarshalJSON 按 kind 输出指标或数值两种形状"},
	"TradeBacktestConfig": {v: trade.BacktestConfig{}},
	"TradeBacktest":       {v: trade.Backtest{}},
	"TradeBacktestBrief":  {v: trade.BacktestBrief{}},
	"TradeBacktestResult": {v: trade.BacktestResult{}},
	"TradeBacktestTrade":  {v: trade.BacktestTrade{}},
	"TradeBacktestStats":  {v: trade.BacktestStats{}},
	"TradeSweep":          {v: trade.SweepRecord{}},
	"TradeSweepPoint":     {v: trade.SweepPoint{}},

	"TradeAccount":      {v: trade.AccountView{}},
	"TradeOrder":        {v: trade.OrderView{}},
	"TradePosition":     {v: trade.PositionView{}},
	"TradeFill":         {v: trade.FillView{}},
	"TradeLedgerCheck":  {v: trade.LedgerCheck{}},
	"TradeRun":          {v: trade.RunView{}},
	"TradeRunLog":       {v: trade.RunLog{}},
	"TradeRunHolding":   {v: trade.RunHolding{}},
	"TradeRisk":         {v: trade.RiskView{}},
	"TradeRiskDay":      {v: trade.DayLoss{}},
	"TradeKillResult":   {v: trade.KillResult{}},
	"TradeHalt":         {v: trade.Halt{}},
	"TradeHaltReleased": {v: trade.HaltReleased{}},
	// 交易所账户只读接入、审计、对账（TRD-07a、TRD-08a、TRD-08b）
	"TradeLiveSnapshot": {v: trade.LiveSnapshotView{}},
	"TradeLiveBalance":  {v: trade.LiveBalance{}},
	"TradeLivePosition": {v: trade.LivePosition{}},
	"TradeLiveOrder":    {v: trade.LiveOrder{}},
	"TradeLiveFill":     {v: trade.LiveFillView{}},
	"TradeAudit":        {v: trade.AuditView{}},
	"TradeRecon":        {v: trade.ReconView{}},
	"TradeReconItem":    {v: trade.ReconItemView{}},
	"TradeReconRecord":  {v: trade.ReconRecord{}},
	// 实盘评审闸门和实盘开关（TRD-08c）
	"TradeLiveGate": {v: trade.LiveView{}},

	"EtfFund":        {v: etf.Fund{}},
	"EtfDaily":       {v: etf.Daily{}},
	"EtfShareChange": {v: etf.ShareChange{}},
	"EtfCollect":     {v: etf.CollectResult{}},
	"EtfSource":      {v: etf.SourceInfo{}},
	"EtfMetrics":     {v: etf.Metrics{}},
	"EtfAnomaly":     {v: etf.Anomaly{}},
	"EtfRule":        {v: etf.Rule{}},

	"Video":         {v: video.Video{}},
	"VideoSeries":   {v: video.Series{}},
	"VideoPublish":  {v: video.Publish{}},
	"VideoArtifact": {v: video.Artifact{}},
	"VideoTopic":    {v: video.Topic{}},
	"VideoClip":     {v: video.Clip{}},
	"VideoPlatform": {v: video.PlatformInfo{}},

	// 商单（VID-08d）
	"VideoDeal": {v: video.Deal{}},
	"视频创作插件 video / 商单（VID-08d）:reportState": {v: video.DealReportRef{}},

	// 稿件正文（VID-09a）
	"VideoArtifactContent": {v: video.ArtifactContent{}},

	// 平台账号、按天快照（VID-05a）
	"VideoAccount":        {v: video.PlatformAccount{}},
	"VideoMetricSnapshot": {v: video.MetricSnapshot{}},

	// 封面 A/B 测试（VID-05b）
	"VideoCoverTest": {v: video.CoverTest{}},

	// 内容日历（VID-06c）
	"VideoCalendarItem": {v: video.CalendarItem{}},

	// 分镜和 B-roll 素材（TSK-0456）
	"VideoShot":         {v: video.Shot{}},
	"VideoBroll":        {v: video.Broll{}},
	"VideoMediaRoot":    {v: video.MediaRoot{}},
	"VideoMediaFile":    {v: video.MediaFile{}},
	"VideoMediaListing": {v: video.MediaListing{}},

	// B 站组件（TSK-0455）
	"BiliAccount":  {v: video.BiliAccount{}},
	"BiliGuard":    {v: video.BiliGuard{}},
	"BiliSnapshot": {v: video.BiliSnapshot{}},
	"BiliOverview": {v: video.BiliOverview{}},
	"BiliSession":  {v: video.BiliSession{}},
	"BiliMessage":  {v: video.BiliMessage{}},

	"BrowserTab":         {v: browser.Tab{}},
	"BrowserAllowEntry":  {v: browser.AllowEntry{}},
	"BrowserGoogleState": {v: browser.GoogleState{}},
	"BrowserGoogleConn":  {v: browser.ConnRef{}},
}

// docShape 是从文档里抽出来的一个对象：字段名和（如果有）字段的嵌套对象。
type docShape struct {
	fields map[string]*docShape
	open   bool // 写了 ... / …，没列全
}

type docExample struct {
	key    string
	line   int
	shapes []*docShape
}

var (
	labelLineRe   = regexp.MustCompile("^`(\\w+)`(?:（[^）]*）)?：\\s*$")
	inlineLabelRe = regexp.MustCompile("`([\\w.]+)`）?(?:（[^）]*）)?：`(\\[?\\{[^`]*\\}\\]?)`")
	inlineNestRe  = regexp.MustCompile("`(\\w+)` (?:是|为)[^`]*`(\\[?\\{[^`]*\\}\\]?(?:\\[\\])?)`")
	fieldNameRe   = regexp.MustCompile("`([a-z_][a-z0-9_]*)`")
)

// docExamples 按上面说的三种写法把文档里的结构示例抽出来。
func docExamples(t *testing.T, body string) []docExample {
	t.Helper()
	lines := strings.Split(body, "\n")
	var out []docExample
	h2, h3 := "", ""
	counts := map[string]int{}
	section := func() string {
		if h3 == "" {
			return h2
		}
		return h2 + " / " + h3
	}
	// 往前找最近一个非空行，是 `Name`： 就当标签
	labelBefore := func(i int) string {
		for j := i - 1; j >= 0; j-- {
			if s := strings.TrimSpace(lines[j]); s != "" {
				if m := labelLineRe.FindStringSubmatch(s); m != nil {
					return m[1]
				}
				return ""
			}
		}
		return ""
	}
	keyFor := func(i int, kind string) string {
		if l := labelBefore(i); l != "" {
			return l
		}
		k := section() + "#" + kind
		counts[k]++
		return fmt.Sprintf("%s%d", k, counts[k])
	}
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		switch {
		case strings.HasPrefix(line, "## "):
			h2, h3 = strings.TrimSpace(line[3:]), ""
		case strings.HasPrefix(line, "### "):
			h3 = strings.TrimSpace(line[4:])
		case strings.HasPrefix(line, "```"):
			lang := strings.TrimSpace(line[3:])
			start := i
			var buf []string
			for i++; i < len(lines) && !strings.HasPrefix(lines[i], "```"); i++ {
				buf = append(buf, lines[i])
			}
			if lang != "json" {
				continue
			}
			shapes := parseShapes(strings.Join(buf, "\n"))
			if len(shapes) == 0 {
				t.Errorf("契约文档第 %d 行的 json 块里一个对象都没抽出来", start+1)
				continue
			}
			out = append(out, docExample{key: keyFor(start, "json"), line: start + 1, shapes: shapes})
		case strings.HasPrefix(line, "|") && (i == 0 || !strings.HasPrefix(lines[i-1], "|")):
			cells := strings.Split(strings.Trim(strings.TrimSpace(line), "|"), "|")
			start := i
			if strings.TrimSpace(cells[0]) != "字段" {
				for i+1 < len(lines) && strings.HasPrefix(lines[i+1], "|") {
					i++
				}
				continue
			}
			s := &docShape{fields: map[string]*docShape{}}
			for i+1 < len(lines) && strings.HasPrefix(lines[i+1], "|") {
				i++
				first := strings.Split(strings.Trim(strings.TrimSpace(lines[i]), "|"), "|")[0]
				for _, m := range fieldNameRe.FindAllStringSubmatch(first, -1) {
					s.fields[m[1]] = nil
				}
			}
			out = append(out, docExample{key: keyFor(start, "table"), line: start + 1, shapes: []*docShape{s}})
		default:
			m := inlineLabelRe.FindStringSubmatchIndex(line)
			if m == nil {
				continue
			}
			name, shapes := line[m[2]:m[3]], parseShapes(line[m[4]:m[5]])
			if len(shapes) == 0 {
				continue
			}
			// 小写开头的是某个字段的形状（`mark`：`{...}`），名字只在本节内有意义
			if unicode.IsLower(rune(name[0])) {
				name = section() + ":" + name
			}
			// 同一行后面「`c` 是 `{x, y}[]`」补成 c 的嵌套结构
			for _, n := range inlineNestRe.FindAllStringSubmatch(line[m[1]:], -1) {
				if _, ok := shapes[0].fields[n[1]]; ok {
					if sub := parseShapes(n[2]); len(sub) > 0 {
						shapes[0].fields[n[1]] = sub[0]
					}
				}
			}
			out = append(out, docExample{key: name, line: i + 1, shapes: shapes})
		}
	}
	return out
}

// parseShapes 宽松地抽出文本里的顶层对象。示例不是严格 JSON：值里有 `"cv_..." | null`、
// `<payload>`、`Progress | null`，行内写法的键不带引号还可能带 `?`，所以只认键和嵌套，值一律跳过。
func parseShapes(src string) []*docShape {
	p := &shapeParser{s: []rune(src)}
	var out []*docShape
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case '{':
			p.i++
			out = append(out, p.object())
		case '"':
			p.str()
		default:
			p.i++
		}
	}
	return out
}

type shapeParser struct {
	s []rune
	i int
}

func (p *shapeParser) ws() {
	for p.i < len(p.s) && unicode.IsSpace(p.s[p.i]) {
		p.i++
	}
}

func (p *shapeParser) str() string {
	p.i++ // 开头的引号
	var b strings.Builder
	for p.i < len(p.s) && p.s[p.i] != '"' {
		if p.s[p.i] == '\\' {
			p.i++
		}
		if p.i < len(p.s) {
			b.WriteRune(p.s[p.i])
		}
		p.i++
	}
	p.i++
	return b.String()
}

// object 从 { 之后读到配对的 }。
func (p *shapeParser) object() *docShape {
	s := &docShape{fields: map[string]*docShape{}}
	for {
		p.ws()
		if p.i >= len(p.s) {
			return s
		}
		c := p.s[p.i]
		switch {
		case c == '}':
			p.i++
			return s
		case c == ',':
			p.i++
			continue
		case c == '.' || c == '…':
			for p.i < len(p.s) && (p.s[p.i] == '.' || p.s[p.i] == '…') {
				p.i++
			}
			s.open = true
			continue
		}
		key := ""
		if c == '"' {
			key = p.str()
		} else {
			st := p.i
			for p.i < len(p.s) && (p.s[p.i] == '_' || unicode.IsLetter(p.s[p.i]) || unicode.IsDigit(p.s[p.i])) {
				p.i++
			}
			key = string(p.s[st:p.i])
			if key == "" {
				p.skipValue()
				continue
			}
		}
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == '?' {
			p.i++
			p.ws()
		}
		s.fields[key] = nil
		if p.i < len(p.s) && p.s[p.i] == ':' {
			p.i++
			p.ws()
			s.fields[key] = p.value()
		}
	}
}

// value 读一个值，返回其中的对象结构（数组取第一个对象元素），标量返回 nil；停在 , 或 } 前。
func (p *shapeParser) value() *docShape {
	var found *docShape
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ',', '}':
			return found
		case '{':
			p.i++
			o := p.object()
			if found == nil {
				found = o
			}
		case '[':
			p.i++
			if a := p.array(); found == nil {
				found = a
			}
		case '"':
			p.str()
		default:
			p.i++
		}
	}
	return found
}

func (p *shapeParser) array() *docShape {
	var found *docShape
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ']':
			p.i++
			return found
		case '{':
			p.i++
			if o := p.object(); found == nil {
				found = o
			}
		case '[':
			p.i++
			if a := p.array(); found == nil {
				found = a
			}
		case '"':
			p.str()
		default:
			p.i++
		}
	}
	return found
}

func (p *shapeParser) skipValue() {
	for p.i < len(p.s) && p.s[p.i] != ',' && p.s[p.i] != '}' {
		p.i++
	}
}

// filledJSON 把 v 的类型每个字段都填上非零值再序列化，omitempty 的字段也会出现。
func filledJSON(t *testing.T, v any) any {
	t.Helper()
	rv := reflect.New(reflect.TypeOf(v)).Elem()
	fill(rv, 0)
	b, err := json.Marshal(rv.Interface())
	if err != nil {
		t.Fatalf("序列化 %T: %v", v, err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("反序列化 %T: %v", v, err)
	}
	return out
}

var rawMessageType = reflect.TypeOf(json.RawMessage(nil))

func fill(v reflect.Value, depth int) {
	if depth > 6 || !v.CanSet() {
		return
	}
	if v.Type() == rawMessageType {
		v.SetBytes([]byte("{}"))
		return
	}
	switch v.Kind() {
	case reflect.String:
		v.SetString("x")
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v.SetInt(1)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v.SetUint(1)
	case reflect.Float32, reflect.Float64:
		v.SetFloat(1)
	case reflect.Pointer:
		v.Set(reflect.New(v.Type().Elem()))
		fill(v.Elem(), depth+1)
	case reflect.Slice:
		s := reflect.MakeSlice(v.Type(), 1, 1)
		fill(s.Index(0), depth+1)
		v.Set(s)
	case reflect.Map:
		v.Set(reflect.MakeMap(v.Type())) // 键是数据，不填
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				fill(v.Field(i), depth+1)
			}
		}
	}
}

// compareShape 比对一层，嵌套的对象往下递归。
func compareShape(doc *docShape, got any, path string, partial bool) []string {
	for {
		a, ok := got.([]any)
		if !ok || len(a) == 0 {
			break
		}
		got = a[0]
	}
	obj, ok := got.(map[string]any)
	if !ok || len(obj) == 0 {
		return nil
	}
	var diffs []string
	for _, k := range sortedKeys(doc.fields) {
		v, ok := obj[k]
		if !ok {
			diffs = append(diffs, "示例里有、结构里没有："+path+k)
			continue
		}
		if sub := doc.fields[k]; sub != nil {
			diffs = append(diffs, compareShape(sub, v, path+k+".", false)...)
		}
	}
	if !partial && !doc.open {
		for _, k := range sortedKeys(obj) {
			if _, ok := doc.fields[k]; !ok {
				diffs = append(diffs, "结构里有、示例里没有："+path+k)
			}
		}
	}
	return diffs
}

func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func loadContractExamples(t *testing.T) []docExample {
	t.Helper()
	body, err := os.ReadFile("../../docs/api-contract.md")
	if err != nil {
		t.Fatalf("读契约文档: %v", err)
	}
	ex := docExamples(t, string(body))
	if len(ex) < 20 {
		t.Fatalf("契约文档里只抽出 %d 个结构示例——多半是文档格式或抽取规则变了，本测试已经失效", len(ex))
	}
	return ex
}

// TestContractExamplesMatchStructs 守着「契约文档里的字段名和后端实际序列化出来的不一致」。
// 不一致时改示例（改契约），不改 Go 的 json 字段名：前端已经在按现在的名字读。
func TestContractExamplesMatchStructs(t *testing.T) {
	seen := map[string]bool{}
	for _, ex := range loadContractExamples(t) {
		if seen[ex.key] {
			t.Errorf("契约文档第 %d 行：示例 %s 出现了不止一次，对照表分不清该比哪个", ex.line, ex.key)
			continue
		}
		seen[ex.key] = true
		spec, ok := contractSpecs[ex.key]
		if !ok {
			t.Errorf("契约文档第 %d 行的示例 %s 在 contractSpecs 里没登记对应的 Go 结构", ex.line, ex.key)
			continue
		}
		if spec.skip != "" {
			continue
		}
		got := filledJSON(t, spec.v)
		if obj, ok := got.(map[string]any); !ok || len(obj) == 0 {
			t.Errorf("%s 对应的 %T 序列化出来不是带字段的对象，比不了", ex.key, spec.v)
			continue
		}
		for _, s := range ex.shapes {
			if diffs := compareShape(s, got, "", spec.partial); len(diffs) > 0 {
				t.Errorf("契约文档第 %d 行的示例 %s 和 %T 对不上：\n  %s",
					ex.line, ex.key, spec.v, strings.Join(diffs, "\n  "))
			}
		}
	}
	for _, k := range sortedKeys(contractSpecs) {
		if !seen[k] {
			t.Errorf("contractSpecs 登记了 %s，但契约文档里找不到这个示例（改名、挪了小节或删了）", k)
		}
	}
}

// TestParseShapes 钉住宽松解析器对文档里几种非严格写法的处理。
func TestParseShapes(t *testing.T) {
	cases := []struct {
		src  string
		want string
	}{
		{`{ "data": <payload>, "meta": { "total": 86, "limit": 50 } }`, "data meta{limit total}"},
		{`{ "a": "cv_..." | null, "b": Progress | null, "c": [{ "x": 1, "y": "..." }] }`, "a b c{x y}"},
		{`{id, name?, conversation: {id, kind}, created_at}`, "conversation{id kind} created_at id name"},
		{`{ "provides": { "modules": [], ... } }`, "provides{modules ...}"},
		{`[{name, modules}]`, "modules name"},
	}
	for _, c := range cases {
		got := parseShapes(c.src)
		if len(got) != 1 {
			t.Errorf("%s：抽出 %d 个对象", c.src, len(got))
			continue
		}
		if s := describeShape(got[0]); s != c.want {
			t.Errorf("%s：得到 %q，要 %q", c.src, s, c.want)
		}
	}
}

func describeShape(s *docShape) string {
	var parts []string
	for _, k := range sortedKeys(s.fields) {
		if sub := s.fields[k]; sub != nil {
			parts = append(parts, k+"{"+describeShape(sub)+"}")
		} else {
			parts = append(parts, k)
		}
	}
	if s.open {
		parts = append(parts, "...")
	}
	return strings.Join(parts, " ")
}
