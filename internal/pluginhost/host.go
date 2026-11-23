// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package pluginhost

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Host 是外部插件宿主。所有公开方法并发安全；启停/安装串行执行。
type Host struct {
	opts       Options
	log        *slog.Logger
	httpClient *http.Client

	baseDir     string // <DataDir>/external-plugins
	packagesDir string // <base>/packages/<id>/<version>/
	dataRoot    string // <base>/data/<id>/
	cacheRoot   string // <base>/cache/<id>/
	logsDir     string // <base>/logs/<id>.log
	runDir      string // <base>/run/

	lifecycle sync.Mutex // 串行化 Resolve 后的落盘/启停/卸载
	mu        sync.Mutex // 保护 procs/closed/restarts/restartTimers
	procs     map[string]*pluginProcess
	closed    bool
	// restarts 记崩溃自动重启的连续尝试次数；restartTimers 是等待中的退避定时器。
	restarts      map[string]int
	restartTimers map[string]*time.Timer
	// httpStreams/wsStreams 是插件 HTTP/WebSocket 代理的在途流。
	httpStreams map[string]*httpStream
	wsStreams   map[string]*wsStream

	// testLaunch 是测试注入点：非 nil 时不 exec 子进程，由测试里的 fake 客户端
	// 连上 host 的 Unix socket 走完整 hello → welcome → activate → health 握手。
	testLaunch func(p *pluginProcess) error

	// busCancel 取消 Start 时挂上的事件订阅。
	busCancel func()
}

// New 建一个宿主。此时不碰磁盘、不拉起任何进程；Start 才读状态并恢复 enabled 插件。
func New(opts Options) *Host {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	if opts.DevDir != "" {
		logger.Debug("外部插件开发者目录（P1 只记录，不参与安装）", "dev_dir", opts.DevDir)
	}
	base := filepath.Join(opts.DataDir, "external-plugins")
	return &Host{
		opts:          opts,
		log:           logger.With("component", "pluginhost"),
		httpClient:    client,
		baseDir:       base,
		packagesDir:   filepath.Join(base, "packages"),
		dataRoot:      filepath.Join(base, "data"),
		cacheRoot:     filepath.Join(base, "cache"),
		logsDir:       filepath.Join(base, "logs"),
		runDir:        filepath.Join(base, "run"),
		procs:         map[string]*pluginProcess{},
		restarts:      map[string]int{},
		restartTimers: map[string]*time.Timer{},
		httpStreams:   map[string]*httpStream{},
		wsStreams:     map[string]*wsStream{},
	}
}

// Start 读状态表，把 enabled 的插件 best-effort 拉起；单个失败只记日志，不影响其它插件。
func (h *Host) Start(ctx context.Context) error {
	rows, err := h.listState(ctx)
	if err != nil {
		return err
	}
	if h.opts.Events != nil && h.busCancel == nil {
		h.busCancel = h.opts.Events.Tap(h.onKernelEvent)
	}
	if h.opts.DevDir != "" {
		if _, err := h.reloadDevLocked(ctx); err != nil {
			h.log.Warn("加载开发目录插件失败", "dev_dir", h.opts.DevDir, "err", err)
		}
		rows, _ = h.listState(ctx)
	}
	for _, r := range rows {
		if !r.Enabled {
			continue
		}
		if err := h.startPlugin(ctx, r); err != nil {
			h.log.Warn("外部插件启动失败（继续启动其它插件）", "plugin", r.ID, "err", err)
			_ = h.setLastError(ctx, r.ID, err.Error())
		}
	}
	return nil
}

// Close 停所有子进程、关 socket、关插件私有库；可重复调用。
func (h *Host) Close() {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	procs := make([]*pluginProcess, 0, len(h.procs))
	for _, p := range h.procs {
		procs = append(procs, p)
	}
	for id, timer := range h.restartTimers {
		if timer != nil {
			timer.Stop()
		}
		delete(h.restartTimers, id)
	}
	cancelBus := h.busCancel
	h.busCancel = nil
	h.mu.Unlock()
	if cancelBus != nil {
		cancelBus()
	}

	// 停用要发 deactivate 并等进程退出，不能拿着 h.mu 做。
	for _, p := range procs {
		p.stop(context.Background(), true)
	}
	h.mu.Lock()
	h.procs = map[string]*pluginProcess{}
	h.mu.Unlock()
}

// List 返回全部已安装插件（按安装时间）。
func (h *Host) List() []Info {
	rows, err := h.listState(context.Background())
	if err != nil {
		h.log.Error("列出外部插件失败", "err", err)
		return nil
	}
	out := make([]Info, 0, len(rows))
	for _, r := range rows {
		out = append(out, h.infoFromRow(r))
	}
	return out
}

// Get 返回一个已安装插件；没有时 ErrNotFound。
func (h *Host) Get(id string) (Info, error) {
	r, err := h.loadState(context.Background(), id)
	if err != nil {
		return Info{}, err
	}
	return h.infoFromRow(r), nil
}

// Resolve 解析来源并返回安全预览，不落盘安装（下载的包在临时目录里，函数返回前清理）。
func (h *Host) Resolve(ctx context.Context, src Source) (*Preview, error) {
	pkg, err := h.resolvePackage(ctx, src)
	if err != nil {
		return nil, err
	}
	defer pkg.cleanup()
	return h.preview(ctx, pkg)
}

// Install 安装一个外部插件，装完默认不启用（brief §2）。confirm 是用户在安全预览里
// 确认的非高风险权限；高风险/单独授权项不会随安装授予。
func (h *Host) Install(ctx context.Context, src Source, confirm []string) (Info, error) {
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()

	pkg, err := h.resolvePackage(ctx, src)
	if err != nil {
		return Info{}, err
	}
	defer pkg.cleanup()

	preview, err := h.preview(ctx, pkg)
	if err != nil {
		return Info{}, err
	}
	if !preview.Compatible {
		return Info{}, wrap(ErrIncompatible, "插件 %s %s 与当前宿主/平台不兼容", pkg.manifest.ID, pkg.manifest.Version)
	}

	granted, err := confirmPermissions(pkg.manifest, confirm)
	if err != nil {
		return Info{}, err
	}
	tier, err := h.trustPublisher(ctx, pkg.manifest, pkg.publisherVerified)
	if err != nil {
		return Info{}, err
	}

	// 开发目录是链接安装：不复制、不写包目录，直接记源目录。
	if pkg.source.Type == "dev" {
		return h.installDevLocked(ctx, pkg, granted, false)
	}

	// 同版本重复安装是幂等的：直接返回已装记录，不重复拷目录。
	if existing, err := h.loadState(ctx, pkg.manifest.ID); err == nil {
		if existing.Version == pkg.manifest.Version {
			h.log.Info("插件已安装同版本，按幂等处理", "plugin", existing.ID, "version", existing.Version)
			return h.infoFromRow(existing), nil
		}
		return Info{}, wrap(ErrConflict, "插件 %s 已安装版本 %s，P1 不支持同 id 多版本/升级",
			existing.ID, existing.Version)
	}

	installDir := h.packageDir(pkg.manifest.ID, pkg.manifest.Version)
	if err := copyPackageDir(pkg.root, installDir); err != nil {
		_ = os.RemoveAll(installDir)
		return Info{}, err
	}

	manifestJSON, err := json.Marshal(pkg.manifest)
	if err != nil {
		_ = os.RemoveAll(installDir)
		return Info{}, fmt.Errorf("序列化清单失败：%w", err)
	}
	now := time.Now().UTC()
	row := &stateRow{
		ID:                pkg.manifest.ID,
		PublisherID:       publisherIDOf(pkg.manifest),
		PublisherVerified: tier == "verified",
		Name:              pkg.manifest.Name,
		Version:           pkg.manifest.Version,
		Description:       pkg.manifest.Description,
		SourceType:        pkg.source.Type,
		SourceRef:         sourceRef(pkg.source),
		PackageSHA256:     pkg.sha256,
		InstallDir:        installDir,
		ManifestJSON:      string(manifestJSON),
		Permissions:       pkg.manifest.Permissions,
		Granted:           granted,
		Enabled:           false,
		InstalledAt:       now,
		UpdatedAt:         now,
	}
	if err := h.saveState(ctx, row); err != nil {
		_ = os.RemoveAll(installDir)
		return Info{}, err
	}
	h.log.Info("外部插件安装完成", "plugin", row.ID, "version", row.Version,
		"install_dir", installDir, "granted", granted)
	return h.infoFromRow(row), nil
}

// Enable 启用一个插件：应用私有库迁移、拉起子进程并完成握手/激活/健康检查。
func (h *Host) Enable(ctx context.Context, id string) (Info, error) {
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()

	r, err := h.loadState(ctx, id)
	if err != nil {
		return Info{}, err
	}
	if err := h.startPlugin(ctx, r); err != nil {
		_ = h.setLastError(ctx, id, err.Error())
		return Info{}, err
	}
	if err := h.setEnabled(ctx, id, true); err != nil {
		return Info{}, err
	}
	return h.Get(id)
}

// Disable 停用一个插件：plugin.deactivate → 10s → SIGTERM → 5s → SIGKILL；幂等。
func (h *Host) Disable(ctx context.Context, id string) (Info, error) {
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()

	if _, err := h.loadState(ctx, id); err != nil {
		return Info{}, err
	}
	h.cancelRestart(id)
	if p := h.lookupProc(id); p != nil {
		p.stop(ctx, true)
	}
	if err := h.setEnabled(ctx, id, false); err != nil {
		return Info{}, err
	}
	return h.Get(id)
}

// Uninstall 卸载插件：删安装目录、状态记录；deleteData 为真时连插件数据/缓存一起删。
func (h *Host) Uninstall(ctx context.Context, id string, deleteData bool) (Info, error) {
	h.lifecycle.Lock()
	defer h.lifecycle.Unlock()

	r, err := h.loadState(ctx, id)
	if err != nil {
		return Info{}, err
	}
	info := h.infoFromRow(r)
	h.cancelRestart(id)
	if p := h.lookupProc(id); p != nil {
		p.stop(ctx, true)
	}
	// 开发目录插件是链接：卸载只删状态/数据，绝不能删开发者的源码目录。
	if r.InstallDir != "" && r.SourceType != "dev" {
		if err := safeRemoveAll(h.packagesDir, r.InstallDir); err != nil {
			return Info{}, err
		}
	}
	if deleteData {
		if err := safeRemoveAll(h.dataRoot, h.dataDir(id)); err != nil {
			return Info{}, err
		}
		if err := safeRemoveAll(h.cacheRoot, h.cacheDir(id)); err != nil {
			return Info{}, err
		}
	}
	if err := h.deleteState(ctx, id); err != nil {
		return Info{}, err
	}
	info.Enabled = false
	info.Running = false
	h.log.Info("外部插件已卸载", "plugin", id, "delete_data", deleteData)
	return info, nil
}

// Call 把宿主 → 插件的请求透传给运行中的插件，result 原样返回。
func (h *Host) Call(ctx context.Context, id, method string, params json.RawMessage) (json.RawMessage, error) {
	p := h.lookupProc(id)
	if p == nil || !p.isRunning() {
		if _, err := h.loadState(ctx, id); err != nil {
			return nil, err
		}
		return nil, wrap(ErrNotRunning, "插件 %s 未运行", id)
	}
	return p.call(ctx, method, params)
}

// WebFile 读插件前端静态文件；rel 是包内相对路径（例 web/entry.js），越界返回 ErrNotFound。
func (h *Host) WebFile(id, rel string) (data []byte, contentType string, err error) {
	r, err := h.loadState(context.Background(), id)
	if err != nil {
		return nil, "", err
	}
	m, err := decodeManifest(r.ManifestJSON)
	if err != nil {
		return nil, "", wrap(ErrNotFound, "插件 %s 的清单已损坏", id)
	}
	if m.Runtime.Web == nil {
		return nil, "", wrap(ErrNotFound, "插件 %s 没有前端资源", id)
	}
	root := filepath.Dir(m.Runtime.Web.Entry)
	rel = strings.TrimPrefix(filepath.ToSlash(rel), "/")
	if !relPath(rel) {
		return nil, "", wrap(ErrNotFound, "非法文件路径")
	}
	full, err := safeJoin(r.InstallDir, rel)
	if err != nil {
		return nil, "", wrap(ErrNotFound, "非法文件路径")
	}
	// 只允许读 web 入口所在目录内的文件（例如 web/ 下的 chunk 和样式）。
	// 必须解析符号链接后再判断：安装期虽然拒绝 symlink，但插件运行期仍可能在本机造链接，
	// 不解析会把 /etc/passwd 这类包外文件读出去。
	resolvedInstall, err := filepath.EvalSymlinks(r.InstallDir)
	if err != nil {
		return nil, "", wrap(ErrNotFound, "插件安装目录不可读")
	}
	resolvedRoot, err := filepath.EvalSymlinks(filepath.Join(r.InstallDir, root))
	if err != nil || !withinDir(resolvedInstall, resolvedRoot) {
		return nil, "", wrap(ErrNotFound, "文件不在插件前端目录内")
	}
	resolvedFull, err := filepath.EvalSymlinks(full)
	if err != nil || !withinDir(resolvedRoot, resolvedFull) {
		return nil, "", wrap(ErrNotFound, "文件不在插件前端目录内")
	}
	return readStaticFile(resolvedFull)
}

// IconFile 读插件图标（清单 icon 字段，包内相对路径）；没有图标时 ErrNotFound。
func (h *Host) IconFile(id string) ([]byte, string, error) {
	r, err := h.loadState(context.Background(), id)
	if err != nil {
		return nil, "", err
	}
	m, err := decodeManifest(r.ManifestJSON)
	if err != nil || m.Icon == "" {
		return nil, "", wrap(ErrNotFound, "插件 %s 没有图标", id)
	}
	full, err := safeJoin(r.InstallDir, m.Icon)
	if err != nil {
		return nil, "", wrap(ErrNotFound, "非法图标路径")
	}
	resolvedInstall, err := filepath.EvalSymlinks(r.InstallDir)
	if err != nil {
		return nil, "", wrap(ErrNotFound, "插件安装目录不可读")
	}
	resolvedFull, err := filepath.EvalSymlinks(full)
	if err != nil || !withinDir(resolvedInstall, resolvedFull) {
		return nil, "", wrap(ErrNotFound, "非法图标路径")
	}
	return readStaticFile(resolvedFull)
}

// ---------------------------------------------------------------------------
// 目录与进程小工具
// ---------------------------------------------------------------------------

// platformKey 返回当前平台键，例 darwin-arm64。
func platformKey() string { return runtime.GOOS + "-" + runtime.GOARCH }

func (h *Host) packageDir(id, version string) string {
	return filepath.Join(h.packagesDir, id, version)
}

func (h *Host) dataDir(id string) string { return filepath.Join(h.dataRoot, id) }

func (h *Host) cacheDir(id string) string { return filepath.Join(h.cacheRoot, id) }

func (h *Host) logPath(id string) string { return filepath.Join(h.logsDir, id+".log") }

// isRunning 判断插件当前是否在运行（加锁，可被任意 goroutine 调用）。
func (h *Host) isRunning(id string) bool {
	p := h.lookupProc(id)
	return p != nil && p.isRunning()
}

func (h *Host) lookupProc(id string) *pluginProcess {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.procs[id]
}

// sourceRef 把来源压成一个字符串存库：github 存 URL，本地来源存路径。
func sourceRef(src Source) string {
	if src.Type == "github" {
		return src.URL
	}
	return src.Path
}

// confirmPermissions 校验用户确认的权限列表：必须覆盖全部非高风险声明权限，
// 不能确认未声明的权限；高风险/单独授权项不随安装授予（brief §5 / spec 5.3）。
func confirmPermissions(m *Manifest, confirm []string) ([]string, error) {
	declared := map[string]bool{}
	for _, p := range m.Permissions {
		declared[p] = true
	}
	confirmed := map[string]bool{}
	for _, p := range confirm {
		if !declared[p] {
			return nil, wrap(ErrValidation, "确认了未声明的权限：%s", p)
		}
		confirmed[p] = true
	}
	granted := make([]string, 0, len(m.Permissions))
	for _, p := range m.Permissions {
		if !grantableOnInstall(p) {
			if confirmed[p] {
				return nil, wrap(ErrValidation, "高风险权限 %s 安装时不授予，需装后单独申请", p)
			}
			continue
		}
		if !confirmed[p] {
			return nil, wrap(ErrValidation, "安装前必须确认权限：%s", p)
		}
		granted = append(granted, p)
	}
	return granted, nil
}
