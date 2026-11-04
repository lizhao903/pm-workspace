// Command pmw 是产品工作台的单二进制入口：一个进程同时提供 API 与前端静态资源。
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/lizhao903/pm-workspace/internal/agent"
	"github.com/lizhao903/pm-workspace/internal/api"
	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/connector"
	"github.com/lizhao903/pm-workspace/internal/conversation"
	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/imident"
	"github.com/lizhao903/pm-workspace/internal/incident"
	"github.com/lizhao903/pm-workspace/internal/localdir"
	"github.com/lizhao903/pm-workspace/internal/notify"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/plugins/browser"
	"github.com/lizhao903/pm-workspace/internal/plugins/domains"
	"github.com/lizhao903/pm-workspace/internal/plugins/etf"
	"github.com/lizhao903/pm-workspace/internal/plugins/im"
	"github.com/lizhao903/pm-workspace/internal/plugins/projects"
	"github.com/lizhao903/pm-workspace/internal/plugins/sop"
	"github.com/lizhao903/pm-workspace/internal/plugins/terminal"
	"github.com/lizhao903/pm-workspace/internal/plugins/trade"
	"github.com/lizhao903/pm-workspace/internal/plugins/video"
	"github.com/lizhao903/pm-workspace/internal/runner"
	"github.com/lizhao903/pm-workspace/internal/schedule"
	"github.com/lizhao903/pm-workspace/internal/selfupdate"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
	"github.com/lizhao903/pm-workspace/internal/webhook"
	"github.com/lizhao903/pm-workspace/internal/webui"
	"github.com/lizhao903/pm-workspace/internal/workspace"
)

// version 可通过 -ldflags "-X main.version=..." 覆盖。
var version = "0.1.0"

// config 汇总命令行参数。参数超过五个后逐个传形参既难读也容易传错位置。
type config struct {
	addr     string
	tlsAddr  string
	tlsCert  string
	tlsKey   string
	dbPath   string
	seedDemo bool
	dev      bool
	open     bool
	// vaultKeychain：保险箱主密钥是否优先放 macOS 钥匙串；测试实例关掉，只用数据目录下的密钥文件
	vaultKeychain bool
	// fakeConnector：登记内置的假连接器（不联网），只给测试实例演练连接器框架用
	fakeConnector bool
	// fakeIM：IM 插件带上假适配器 fake（slack 渠道，不联网），只给测试实例演练收消息用
	fakeIM bool
	// publicURL：浏览器访问工作台的地址，OAuth 回调地址 = 它 + /api/connectors/oauth/callback
	publicURL string
	// mcpBin：「切换到终端」执行时写进 MCP 配置的 MCP 程序；空串时按本程序的位置推（mcpBinFor）
	mcpBin string
	// dshBin：deepseek-harness 的 dsh 可执行文件；空串时走 PATH，再看 DSH_BIN
	dshBin string
}

func main() {
	var cfg config
	flag.StringVar(&cfg.addr, "addr", "127.0.0.1:7777", "明文 HTTP 监听地址")
	flag.StringVar(&cfg.tlsAddr, "tls-addr", "", "额外的 HTTPS 监听地址；留空则不单独监听（此时若给了证书就把 --addr 本身升级成 HTTPS）")
	flag.StringVar(&cfg.tlsCert, "tls-cert", "", "TLS 证书路径（需与 --tls-key 同时给出）")
	flag.StringVar(&cfg.tlsKey, "tls-key", "", "TLS 私钥路径（需与 --tls-cert 同时给出）")
	flag.StringVar(&cfg.dbPath, "db", "./data/pm.db", "SQLite 数据库路径")
	flag.BoolVar(&cfg.seedDemo, "seed-demo", false, "写入演示数据后退出前继续运行")
	flag.BoolVar(&cfg.dev, "dev", false, "开发模式：放开 CORS，不服务内嵌前端（前端交给 vite dev）")
	flag.BoolVar(&cfg.open, "open", false, "启动后用默认浏览器打开（仅 macOS）")
	flag.BoolVar(&cfg.vaultKeychain, "vault-keychain", true, "凭证保险箱主密钥优先放 macOS 钥匙串；关掉则只用数据目录下权限 0600 的 vault.key")
	flag.BoolVar(&cfg.fakeConnector, "fake-connector", false, "登记内置的假连接器 fake 和 fake_oauth（只用于演练连接器框架）")
	flag.BoolVar(&cfg.fakeIM, "fake-im", false, "IM 插件带上假适配器 fake，可用 POST /api/im/callbacks/fake 灌消息（只用于演练）")
	flag.StringVar(&cfg.publicURL, "public-url", connector.DefaultPublicURL, "浏览器访问工作台的地址，OAuth 回调地址由它拼出（见 docs/local-domain.md）")
	flag.StringVar(&cfg.mcpBin, "mcp-bin", "", "交给 Claude Code「切换到终端」时接回工作台的 MCP 程序；留空按本程序位置推：bin/pmw 配 bin/pmw-mcp，bin/pmw-dev 配 bin/pmw-mcp-dev")
	flag.StringVar(&cfg.dshBin, "dsh-bin", os.Getenv("DSH_BIN"), "deepseek-harness 的 dsh 可执行文件；留空走 PATH（也可用环境变量 DSH_BIN）")
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))

	err := run(cfg)
	// 版本更新（SYS-UPD）换好二进制后要求重启：run 已经收完尾（关监听、关库、停插件），在这里原地换成新程序，
	// 参数、环境、进程号都不变（pid 文件、数据目录、vault.key 跟着不变）
	var re *restartRequest
	if errors.As(err, &re) {
		slog.Info("版本更新：原地重启", "exe", re.exe)
		if xerr := syscall.Exec(re.exe, os.Args, os.Environ()); xerr != nil {
			slog.Error("重启失败，新程序没起来；旧程序留在 .prev，手动换回再启动", "exe", re.exe, "err", xerr)
			os.Exit(1)
		}
	}
	if err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

// restartRequest 是 run 收尾后要求原地换成 exe 重启
type restartRequest struct{ exe string }

func (r *restartRequest) Error() string { return "restart into " + r.exe }

func run(cfg config) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// 证书与私钥必须成对出现，只给一个是明显的配置笔误，早报错好过静默降级成明文。
	tlsEnabled := cfg.tlsCert != "" && cfg.tlsKey != ""
	if !tlsEnabled && (cfg.tlsCert != "" || cfg.tlsKey != "") {
		return errors.New("--tls-cert 与 --tls-key 必须同时给出")
	}
	if !tlsEnabled && cfg.tlsAddr != "" {
		return errors.New("--tls-addr 需要配合 --tls-cert / --tls-key 使用")
	}

	// 提前把证书读进来，而不是等 ServeTLS 自己去读：证书路径写错的话，
	// 那边要到监听起来、启动横幅都打完了才报错，看着像「起来了又挂了」。
	// 这里先读一次既能早失败，也省得两个监听各解析一遍同一份证书。
	var tlsConf *tls.Config
	if tlsEnabled {
		cert, err := tls.LoadX509KeyPair(cfg.tlsCert, cfg.tlsKey)
		if err != nil {
			return fmt.Errorf("加载证书失败（cert=%s key=%s）: %w", cfg.tlsCert, cfg.tlsKey, err)
		}
		tlsConf = &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		}
	}

	if dir := filepath.Dir(cfg.dbPath); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("创建数据目录失败: %w", err)
		}
	}

	st, err := sqlite.Open(ctx, cfg.dbPath)
	if err != nil {
		// 迁移失败已整体回滚，库停在迁移前的版本；把快照路径单独打出来，恢复时照着拷回去
		var me *db.MigrationError
		if errors.As(err, &me) && me.Snapshot != "" {
			slog.Error("迁移失败，已回滚，库版本未变", "migration", me.Version, "snapshot", me.Snapshot)
		}
		return fmt.Errorf("打开数据库失败: %w", err)
	}
	defer st.Close()

	if cfg.seedDemo {
		if err := st.SeedDemo(ctx); err != nil {
			return fmt.Errorf("写入演示数据失败: %w", err)
		}
		slog.Info("demo 数据已写入", "db", cfg.dbPath)
	}

	// 凭证保险箱：主密钥和库一起决定能不能解密，备份时要连同 vault.key（或钥匙串条目）一起带走
	v, keySrc, err := vault.Open(ctx, cfg.dbPath, vault.KeyOptions{UseKeychain: cfg.vaultKeychain && runtime.GOOS == "darwin"})
	if err != nil {
		return fmt.Errorf("打开凭证保险箱失败: %w", err)
	}
	defer v.Close()
	slog.Info("凭证保险箱已就绪", "key", keySrc)
	// 模型服务商的 api_key 存进保险箱；0015 之前留下的明文在这里加密搬过去，旧列清空
	if n, err := st.AttachVault(ctx, v); err != nil {
		return fmt.Errorf("迁移模型服务商密钥失败: %w", err)
	} else if n > 0 {
		slog.Info("模型服务商密钥已搬进凭证保险箱", "count", n)
	}

	// 插件注册表：第一方插件编译进二进制，在这里 Add（PJ-01a 起）；启停状态存在 plugins 表。
	// Start 必须在 api.New 之前：插件路由在 New 时挂上。defer 先于关库执行，后台任务先停。
	// 状态表和迁移记录复用 store 的连接，不另开一组（写池单连接，插件迁移和内核写入排同一个队）。
	pdb := st.DB()
	plugins := plugin.NewRegistry(plugin.NewSQLStateStore(pdb), slog.Default())
	// 插件迁移记在 plugins_migrations（0017）；已应用的被改过时 Start 报错，拒绝启动
	plugins.Migrations = plugin.NewSQLMigrationStore(pdb)
	// 事件总线：订阅者从注册表现取；内核事件在 store 写成功后发（events.WrapStore）。
	// defer 晚于 plugins.Close 登记，所以先等在途的订阅者处理完再停插件。
	bus := events.New(plugins, slog.Default())
	plugins.Events = bus
	// 插件的附件目录在数据目录下（IM-04a）：attachments/ 和库文件同级
	plugins.DataDir = filepath.Dir(cfg.dbPath)
	if err := plugins.Add(projects.New().WithPublicURL(cfg.publicURL)); err != nil {
		return fmt.Errorf("登记插件失败: %w", err)
	}
	// IM 消息插件（IM-01a）：真实渠道 Slack（IM-01b）、Telegram（IM-01c），另有演练用的假适配器
	var imAdapters []im.Adapter
	if cfg.fakeIM {
		imAdapters = append(imAdapters, im.NewFake("fake", "slack", 5*time.Second, "我"))
	}
	// Slack（IM-01b）：Bot Token、Signing Secret 在连接器实例里，出网走 network:im；联调时用 --dev-upstream slack.com=<假服务>
	imAdapters = append(imAdapters, im.NewSlack(im.SlackOptions{}))
	// Telegram Bot（IM-01c）：Token 在连接器实例里，出网走 network:im；--dev-upstream 可改投到本机假服务
	imAdapters = append(imAdapters, im.NewTelegram())
	applyDevUpstreams(plugins)
	if err := plugins.Add(im.New(imAdapters...).WithPublicURL(cfg.publicURL)); err != nil {
		return fmt.Errorf("登记插件失败: %w", err)
	}
	// SOP 编排插件（SOP-01a）：先只有流程定义，执行引擎从 SOP-01b 起
	if err := plugins.Add(sop.New()); err != nil {
		return fmt.Errorf("登记插件失败: %w", err)
	}
	// 终端插件（TERM-01a）：WebSocket 握手认本机和 --public-url 的 Origin
	if err := plugins.Add(terminal.New(cfg.publicURL)); err != nil {
		return fmt.Errorf("登记插件失败: %w", err)
	}
	// 内网域名插件（DOM-01a）：只读检测 hosts、pf、证书，生成配置和命令，不写系统文件
	if err := plugins.Add(domains.New(domains.Options{Addr: cfg.addr, TLSAddr: cfg.tlsAddr, TLSCert: cfg.tlsCert})); err != nil {
		return fmt.Errorf("登记插件失败: %w", err)
	}
	// 交易套件插件（TRD-01a）：只做行情、回测、模拟盘；真实行情源在 TRD-01b 接上
	if err := plugins.Add(trade.New()); err != nil {
		return fmt.Errorf("登记插件失败: %w", err)
	}
	// 宽基监控插件（ETF-01a）：只读东方财富公开数据，采每日份额与交易快照
	if err := plugins.Add(etf.New(etf.NewEastMoney())); err != nil {
		return fmt.Errorf("登记插件失败: %w", err)
	}
	// 视频创作插件（VID-01a）：系列、视频、检查点、发布记录；不接内容平台
	if err := plugins.Add(video.New()); err != nil {
		return fmt.Errorf("登记插件失败: %w", err)
	}
	// 内置浏览器插件（BR-01a）：标签页、地址白名单；Google 账号用 Google Drive 连接器实例
	if err := plugins.Add(browser.New()); err != nil {
		return fmt.Errorf("登记插件失败: %w", err)
	}
	if err := plugins.Start(ctx); err != nil {
		return fmt.Errorf("启动插件失败: %w", err)
	}
	defer plugins.Close()
	defer bus.Wait(5 * time.Second)

	opts := api.Options{Version: version, Dev: cfg.dev, Vault: v, Plugins: plugins, DSHBin: cfg.dshBin}
	// 版本更新（SYS-UPD）：按正在跑的二进制找源码目录；换好二进制后经 restartCh 让下面的 select 收尾、main 原地重启
	restartCh := make(chan string, 1)
	if exe, err := os.Executable(); err == nil {
		opts.Updater = selfupdate.New(exe, version, func(ctx context.Context) (string, error) {
			info, err := st.Snapshot(ctx, "")
			if err != nil {
				return "", err
			}
			return info.Path, nil
		}, func(exe string) {
			select {
			case restartCh <- exe:
			default:
			}
		})
	}
	// 审计日志（CORE-08，0018）：删除和 Agent 写操作在 store 外层记，配置类在 handler 里记
	opts.Audit = audit.New(pdb, slog.Default())
	// 事件流和通知（CORE-07b，0019）：内核内部订阅总线，不经插件注册表；退出时先关流，SSE 连接不拖住 Shutdown
	opts.Stream = events.NewStream(events.DefaultStreamSize)
	bus.Tap(opts.Stream.Append)
	opts.Notify = notify.New(pdb, st, opts.Stream, slog.Default())
	bus.Tap(opts.Notify.Handle)
	// 插件发通知（VID-06b）：kind 带插件前缀、data.source 记插件 id，同样推 notification.created
	plugins.SetNotifier(opts.Notify)
	defer opts.Notify.Wait(5 * time.Second)
	// 运行异常（INC-01a，0043）：写成功发 incident 事件，转任务、改状态、巡检建任务记审计；建任务的 store 在下面接上
	opts.Incidents = incident.New(pdb, slog.Default())
	opts.Incidents.Events = bus
	opts.Incidents.Audit = opts.Audit
	// 插件记运行异常（原型崩溃、附件取不到、SOP 步骤失败）
	plugins.SetIncidents(opts.Incidents)
	// 定时任务的定义（TASK-03a，0020）：规则按本机时区算
	opts.Schedules = schedule.New(pdb, time.Local)
	// 提醒（动作 remind）保存时查关联的对象在不在
	opts.Schedules.SetObjects(st)
	// 插件登记的定时任务动作（VID-06a）：保存时交给插件校验，到点交给插件执行
	opts.Schedules.SetPluginActions(plugins)
	// Webhook 配置（TASK-02a，0022）：接收密钥存保险箱，表里只有条目 id
	opts.Webhooks = webhook.New(pdb, v)
	// 工作台配置（CORE-10a，0023）
	opts.Workspaces = workspace.New(pdb)
	// 文档挂载的本机目录（DOC-01a，0025）
	opts.LocalDirs = localdir.New(pdb)
	// 联系人的 IM 身份（CT-01b，0027）
	opts.Identities = imident.New(pdb)
	// IM 会话（CT-02，0028）
	opts.Conversations = conversation.New(pdb)
	// 连接器（CONN-01a，0029）：定义在代码里登记，实例存表，凭证存保险箱
	connDefs := connector.NewRegistry()
	// 真实连接器：Google Drive（CONN-01e1），client_id、secret 由用户在设置页填
	if err := connDefs.Register(connector.GoogleDrive(connector.GoogleEndpoints{})); err != nil {
		return err
	}
	// Google 日历（CONN-01e2），同一套 OAuth
	if err := connDefs.Register(connector.GoogleCalendar(connector.GoogleCalendarEndpoints{})); err != nil {
		return err
	}
	// 自定义 MCP 服务、OpenAPI 接口（CONN-04）：地址和认证由用户填
	for _, d := range []connector.Def{connector.CustomMCP(), connector.CustomOpenAPI()} {
		if err := connDefs.Register(d); err != nil {
			return err
		}
	}
	if cfg.fakeConnector {
		for _, d := range []connector.Def{connector.Fake(), connector.FakeOAuth()} {
			if err := connDefs.Register(d); err != nil {
				return err
			}
		}
	}
	// 插件登记的连接器定义（CONN-02）：插件停用后它的定义不出现，实例保留、available 为 false
	connDefs.SetPluginDefs(plugins.ConnectorDefs)
	opts.Connectors = connector.New(pdb, v, connDefs)
	// 连接失败、同步失败记运行异常（INC-01a）
	opts.Connectors.SetIncidents(opts.Incidents)
	// 插件发起连接器授权、断开（BR-01a，浏览器插件的 Google 登录和退出）
	plugins.SetConnectors(opts.Connectors)
	if err := opts.Connectors.SetPublicURL(cfg.publicURL); err != nil {
		return err
	}
	// OAuth 令牌到期前后台刷新（CONN-01b）；退出时先停刷新再关库
	opts.Connectors.StartRefresher(ctx)
	defer opts.Connectors.StopRefresher()
	opts.DataDir = filepath.Dir(cfg.dbPath)
	// 切换到终端执行（0048）：MCP 配置接回本实例
	opts.PublicURL = cfg.publicURL
	opts.MCPBin = cfg.mcpBin
	if opts.MCPBin == "" {
		if exe, err := os.Executable(); err == nil {
			opts.MCPBin = mcpBinFor(exe, fileExists)
		}
	}
	if !cfg.dev {
		opts.UI = webui.Handler()
	}
	objects := events.WrapStore(audit.WrapStore(st, opts.Audit), bus)
	// 运行异常转任务、巡检建任务走外层包装，修订、事件、审计照常
	opts.Incidents.Tasks = objects
	// 插件建内核对象（IM-02a 转任务）走同一个外层包装，修订、审计、事件照常；来源记为插件 id
	plugins.SetObjectCreator(objects)
	// 插件用模型和 Agent（SOP-01c）：口径同对话接口，Agent 的写操作走外层包装，审计、事件照常
	plugins.SetAgent(&agent.Service{Store: objects, Connectors: opts.Connectors, PluginSkills: plugins.Skills})
	// 插件交给 Claude Code（VID-03a）：插件发起的运行只在内存里，退出时最多等 5 秒在途的
	plugins.SetClaudeRunner(&runner.Runner{Logger: slog.Default()})
	defer plugins.WaitRuns(5 * time.Second)
	// Agent 的触发和执行记录（AG-01b4，0036）：任务、IM 事件和定时任务的 agent 动作交给它，跑模型的 Runner 由 api.New 接上。
	// 退出时最多等 5 秒在途的执行，没跑完的下次启动记为失败
	opts.AgentRuns = agent.NewDispatcher(objects, slog.Default())
	if err := opts.AgentRuns.Recover(ctx); err != nil {
		return fmt.Errorf("整理 Agent 执行记录失败: %w", err)
	}
	bus.Tap(func(e plugin.Event) { opts.AgentRuns.HandleEvent(e.Type, e.Payload) })
	defer opts.AgentRuns.Wait(5 * time.Second)
	// 调度器（TASK-03b，0021）：到点执行定时任务，建任务走外层包装，事件和审计照常；退出时先停调度再关库
	opts.ScheduleRunner = schedule.NewRunner(opts.Schedules, objects, slog.Default())
	opts.ScheduleRunner.Agents = opts.AgentRuns
	// 运行异常巡检（INC-01a）：定时任务动作 incident_sweep，不自动建这个定时任务，由用户在定时任务页决定
	opts.ScheduleRunner.Incidents = opts.Incidents
	// 提醒：定时任务动作 remind 到点在工作台里发一条通知，只进通知列表和事件流，不外发 IM
	opts.ScheduleRunner.Reminders = opts.Notify
	// 发起 SOP（SOP-01d）：定时任务的 sop 动作和 Agent 的 run_sop 经插件注册表的钩子交给 SOP 插件；删流程前查指向它的定时任务
	opts.ScheduleRunner.SOPs = plugins
	agent.SetSOPStarter(plugins)
	plugins.SetSOPRefs(opts.Schedules.SOPRefs)
	// 按 Host 分发（DOM-02a）：内网域名插件接原型等子域名，--public-url 的主机和 IP、localhost 永远进工作台
	handler := plugins.HostDispatch(api.New(objects, opts), cfg.publicURL)
	// 在 api.New 之后启动：agent 动作要用 New 接上的 Runner
	if err := opts.ScheduleRunner.Start(ctx); err != nil {
		return fmt.Errorf("启动定时任务调度失败: %w", err)
	}
	defer opts.ScheduleRunner.Stop()

	// 两个监听共用同一个 handler，但各自一个 http.Server：Server 内部持有
	// 监听状态与在途连接，一个实例只能 Serve 一次，不能复用。
	newServer := func() *http.Server {
		srv := &http.Server{
			Handler:           handler,
			TLSConfig:         tlsConf,
			ReadHeaderTimeout: 10 * time.Second,
			// WriteTimeout 必须留空。它不是「写一次卡住多久算超时」，而是从开始写响应
			// 那一刻起的**绝对**截止时间——对 SSE 就等于给整条流设了硬上限。
			// 原来这里写 60s，注释写的是「给将来的 SSE 留余量」，实际效果相反：
			// 超过一分钟的流会被服务端掐断在半路，而且因为响应头早就发出去了，
			// 访问日志照样记一条 200，只有浏览器那头看到 network error。
			// 真机上 /api/agent/chat 跑到 70s、81s 的那两次就是这么断的，
			// /api/objects/{id}/run 跑 Claude Code 超一分钟更是常态。
			// 这和 internal/agent/chat.go 里 streamClient.Timeout 要留空是同一个道理，
			// 只是方向相反：那个是出去的，这个是回来的。
			// 单机、只听 127.0.0.1，没有写超时不构成风险；连接空闲照样由 IdleTimeout 收。
			WriteTimeout: 0,
			IdleTimeout:  120 * time.Second,
		}
		srv.RegisterOnShutdown(opts.Stream.Close)
		return srv
	}

	var (
		servers []*http.Server
		urls    []string
	)
	// errCh 容量按最多两个监听算，保证 goroutine 写入后一定能退出，不会泄漏。
	errCh := make(chan error, 2)

	// 起一个监听并把 Serve 放进后台 goroutine。serveTLS 为 true 时走 TLS 握手。
	listen := func(bindAddr string, serveTLS bool) error {
		ln, err := net.Listen("tcp", bindAddr)
		if err != nil {
			return fmt.Errorf("监听 %s 失败: %w", bindAddr, err)
		}
		srv := newServer()
		servers = append(servers, srv)

		scheme := "http"
		if serveTLS {
			scheme = "https"
		}
		urls = append(urls, scheme+"://"+displayAddr(ln.Addr()))

		go func() {
			var err error
			if serveTLS {
				// 传空路径：证书已经在 srv.TLSConfig.Certificates 里了。
				err = srv.ServeTLS(ln, "", "")
			} else {
				err = srv.Serve(ln)
			}
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- err
			}
		}()
		return nil
	}

	switch {
	case tlsEnabled && cfg.tlsAddr != "":
		// 双监听：明文口留给 MCP 与本地脚本，TLS 口给浏览器。
		if err := listen(cfg.addr, false); err != nil {
			return err
		}
		if err := listen(cfg.tlsAddr, true); err != nil {
			return err
		}
	case tlsEnabled:
		// 只给了证书没给 --tls-addr：把 --addr 本身升级成 HTTPS。
		if err := listen(cfg.addr, true); err != nil {
			return err
		}
	default:
		if err := listen(cfg.addr, false); err != nil {
			return err
		}
	}

	for _, u := range urls {
		fmt.Printf("产品工作台已启动: %s  (db=%s, version=%s)\n", u, cfg.dbPath, version)
	}
	if cfg.dev {
		fmt.Println("dev 模式：前端请另开终端跑 cd web && npm run dev（http://127.0.0.1:5173）")
	}
	if cfg.open && len(urls) > 0 {
		// 有 HTTPS 就优先开 HTTPS，浏览器本来就会把这些域名升级到 443。
		openBrowser(urls[len(urls)-1])
	}

	var restartExe string
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	case restartExe = <-restartCh:
		fmt.Println("\n版本更新：收尾后重启…")
	}

	// 优雅退出：先停止收新请求，给在途请求 5 秒收尾，再关库。
	fmt.Println("\n正在退出…")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, srv := range servers {
		if err := srv.Shutdown(shutCtx); err != nil {
			slog.Warn("shutdown 超时，强制关闭", "err", err)
			_ = srv.Close()
		}
	}
	if restartExe != "" {
		return &restartRequest{exe: restartExe}
	}
	return nil
}

// displayAddr 把 0.0.0.0/:: 换成可点击的回环地址。
func displayAddr(a net.Addr) string {
	tcp, ok := a.(*net.TCPAddr)
	if !ok {
		return a.String()
	}
	if tcp.IP == nil || tcp.IP.IsUnspecified() {
		return fmt.Sprintf("127.0.0.1:%d", tcp.Port)
	}
	return tcp.String()
}

func openBrowser(url string) {
	if runtime.GOOS != "darwin" {
		slog.Warn("--open 仅支持 macOS，已忽略")
		return
	}
	if err := exec.Command("open", url).Start(); err != nil {
		slog.Warn("打开浏览器失败", "err", err)
	}
}
