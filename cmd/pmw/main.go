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

	"github.com/lizhao903/pm-workspace/internal/api"
	"github.com/lizhao903/pm-workspace/internal/db"
	"github.com/lizhao903/pm-workspace/internal/events"
	"github.com/lizhao903/pm-workspace/internal/plugin"
	"github.com/lizhao903/pm-workspace/internal/store/sqlite"
	"github.com/lizhao903/pm-workspace/internal/vault"
	"github.com/lizhao903/pm-workspace/internal/webui"
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
	flag.Parse()

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))

	if err := run(cfg); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

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
	if err := plugins.Start(ctx); err != nil {
		return fmt.Errorf("启动插件失败: %w", err)
	}
	defer plugins.Close()
	defer bus.Wait(5 * time.Second)

	opts := api.Options{Version: version, Dev: cfg.dev, Vault: v, Plugins: plugins}
	if !cfg.dev {
		opts.UI = webui.Handler()
	}
	handler := api.New(events.WrapStore(st, bus), opts)

	// 两个监听共用同一个 handler，但各自一个 http.Server：Server 内部持有
	// 监听状态与在途连接，一个实例只能 Serve 一次，不能复用。
	newServer := func() *http.Server {
		return &http.Server{
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

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
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
