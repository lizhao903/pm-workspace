package plugin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/http"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lizhao903/pm-workspace/internal/db"
)

// Registry 管编译进二进制的插件（docs/plugin-api.md 第 4 节）：登记、按状态表启停、
// 挂路由、起停后台任务、登记事件订阅。管理接口（CORE-04b）和插件迁移（CORE-05）在它上面做。
//
// 路由在启动时按清单展开挂进接口层（Routes），之后不再变；启停只切换「这组路由现在交给谁」，
// 停用时同一组路径回 404，和不存在的接口一样。
type Registry struct {
	store StateStore
	log   *slog.Logger

	// Migrations 存插件迁移记录，默认是内存的；cmd/pmw 在 Add 之前换成 SQLMigrationStore。
	Migrations MigrationStore
	// Events 是插件发布事件用的总线（internal/events），为 nil 时插件发布什么都不做。
	Events Publisher
	// DB 是插件 Store、Objects、Contacts 用的库；为 nil 时取 Migrations 是 SQLMigrationStore 时的那个。
	DB *db.DB
	// DataDir 是库文件所在目录，插件的附件目录在它下面（IM-04a，datadir.go）；空串表示没有。
	DataDir string

	// APIVersion 为空时用 APIVersion 常量；测试用它模拟内核升级。
	APIVersion string
	// StopTimeout 是停用时等后台任务退出的上限，默认 10 秒。超时只记日志，状态照样置停用。
	StopTimeout time.Duration

	// objects 是插件建内核对象用的 store（IM-02a，objects_write.go），SetObjectCreator 接上
	objects atomic.Pointer[objectCreatorBox]
	// agent 是插件用模型和 Agent 的实现（SOP-01c，agent.go），SetAgent 接上
	agent atomic.Pointer[agentBox]
	// sopRefs 查指向 SOP 流程的定时任务（SOP-01d，soplaunch.go），SetSOPRefs 接上
	sopRefs atomic.Pointer[sopRefsBox]
	// notifier 是插件发通知用的通知中心（VID-06b，notify.go），SetNotifier 接上
	notifier atomic.Pointer[notifierBox]

	mu      sync.Mutex // 串行化生命周期操作，也守着 entry.state
	order   []string
	entries map[string]*entry
	started bool
}

type entry struct {
	p      Plugin
	m      Manifest
	core   *core
	routes []string // 启动时登记的路由模式，挂进接口层的就是这些
	migs   []migrationFile
	state  State

	active atomic.Pointer[activation] // nil 表示没在跑
	jobs   atomic.Int64               // 还没退出的后台任务协程数
}

// activation 是一次启用的产物：路由处理函数、订阅、后台任务的取消函数。
type activation struct {
	handlers map[string]http.HandlerFunc
	jobs     []Job
	subs     map[string][]EventHandler
	cards    []TodayCardDef
	conns    []ConnectorDef
	impacts  []ConnectorImpactDef
	skills   []SkillDef
	sopNodes []SOPNodeDef
	// sopEngine 只有 SOP 编排插件登记（SOP-03a，sopnode.go）
	sopEngine SOPEngine
	cancel    context.CancelFunc
	done      sync.WaitGroup

	// sopStarter 是「发起 SOP」的入口（SOP-01d，soplaunch.go）
	sopStarter SOPStarter

	// host 是按 Host 分发的处理器（DOM-02a，host.go）
	host *HostHandlerDef
}

var (
	ErrNotFound = errors.New("plugin not found")
	ErrState    = errors.New("plugin state conflict")
	// ErrUnconfirmed：安装时没确认清单里的全部权限。同时也是 ErrState，旧调用方照常认。
	ErrUnconfirmed = errors.New("plugin permissions not confirmed")
)

// DependentsError：还有插件强依赖它。停用时看已启用的（4.3），卸载时看已安装的（4.4）。
type DependentsError struct {
	ID         string
	Dependents []string
	Uninstall  bool
}

func (e *DependentsError) Error() string {
	if e.Uninstall {
		return fmt.Sprintf("插件 %s 被这些已安装的插件依赖，要先卸载它们：%s", e.ID, strings.Join(e.Dependents, "、"))
	}
	return fmt.Sprintf("插件 %s 被这些已启用的插件依赖，要先停用它们：%s", e.ID, strings.Join(e.Dependents, "、"))
}

// GuardError：插件自己的 DisableGuard 拒绝停用。
type GuardError struct {
	ID     string
	Reason string
}

func (e *GuardError) Error() string {
	return fmt.Sprintf("插件 %s 现在不能停用：%s", e.ID, e.Reason)
}

func NewRegistry(store StateStore, log *slog.Logger) *Registry {
	if log == nil {
		log = slog.Default()
	}
	return &Registry{store: store, log: log, Migrations: NewMemMigrationStore(), entries: map[string]*entry{}}
}

func (r *Registry) apiVersion() string {
	if r.APIVersion != "" {
		return r.APIVersion
	}
	return APIVersion
}

func (r *Registry) stopTimeout() time.Duration {
	if r.StopTimeout > 0 {
		return r.StopTimeout
	}
	return 10 * time.Second
}

// Add 登记一个编译进来的插件，必须在 Start 之前调。会试调一次 Register 收下路由清单，
// 登记得不对（路径越界、订阅没声明的事件）直接报错：这是第一方代码的问题，应该在启动时就暴露。
func (r *Registry) Add(p Plugin) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started {
		return errors.New("plugin registry: Add after Start")
	}
	m := p.Manifest()
	if m.ID == "" {
		return errors.New("plugin registry: manifest without id")
	}
	if _, dup := r.entries[m.ID]; dup {
		return fmt.Errorf("plugin registry: duplicate plugin id %s", m.ID)
	}
	e := &entry{p: p, m: m, core: &core{id: m.ID, log: r.log.With("plugin", m.ID), emits: m.Emits, prefix: m.TablePrefix, reg: r}, state: State{ID: m.ID}}
	migs, err := loadMigrations(&m, p.Migrations())
	if err != nil {
		return err
	}
	e.migs = migs
	a, err := r.collect(e)
	if err != nil {
		return err
	}
	e.routes = slices.Sorted(maps.Keys(a.handlers))
	r.entries[m.ID] = e
	r.order = append(r.order, m.ID)
	return nil
}

// Start 读状态表，把已启用的插件按依赖顺序跑起来。单个插件起不来只记日志，不拦启动；
// 但已应用的插件迁移被改过时整个启动失败，和内核迁移一样（2.4）。
func (r *Registry) Start(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	states, err := r.store.Load(ctx)
	if err != nil {
		return err
	}
	applied, err := r.appliedByPlugin(ctx)
	if err != nil {
		return err
	}
	for _, id := range r.order {
		if err := verifyMigrations(id, r.entries[id].migs, applied[id]); err != nil {
			return err
		}
	}
	r.started = true
	for _, id := range r.depOrder() {
		e := r.entries[id]
		if st, ok := states[id]; ok {
			r.setState(e, st)
		}
		if !e.state.Installed || !e.state.Enabled {
			continue
		}
		if e.state.Version != e.m.Version {
			// 换了二进制、版本变了：先照常启用，「可升级」由管理接口按 State.Version 判断（4.5）
			e.core.log.Info("plugin version changed", "installed", e.state.Version, "binary", e.m.Version)
		}
		if n := len(pending(e.migs, applied[id])); n > 0 {
			// 新代码要的表还没建，起来也是坏的；迁移等升级流程（先备份再跑，4.5）
			e.core.log.Error("plugin not started: migrations pending, upgrade required", "pending", n)
			continue
		}
		if err := r.checkEnable(e); err != nil {
			e.core.log.Error("plugin not started", "err", err)
			continue
		}
		a, err := r.collect(e)
		if err != nil {
			e.core.log.Error("plugin not started", "err", err)
			continue
		}
		r.start(e, a)
	}
	return nil
}

// Close 停掉所有在跑的插件（进程退出时用），不改状态表。
func (r *Registry) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	order := r.depOrder()
	for i := len(order) - 1; i >= 0; i-- {
		r.stop(r.entries[order[i]])
	}
}

// Install 跑本插件的迁移、记下安装和确认过的权限，不启用（安装后接着启用由管理接口串起来）。
// confirmed 必须覆盖清单里的全部权限（3.2）。卸载保留数据后重装时跳过已应用的迁移。
// 迁移中途失败时前面已提交的文件不回滚，靠安装前的快照恢复（4.1、REL-02）。
// 迁移跑完、写状态表之前调 Installer.OnInstall，出错整次安装失败（迁移同样不回滚）。
func (r *Registry) Install(ctx context.Context, id string, confirmed []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.get(id)
	if err != nil {
		return err
	}
	if err := r.checkInstall(e, confirmed); err != nil {
		return err
	}
	if err := r.migrate(ctx, e); err != nil {
		return err
	}
	if in, ok := e.p.(Installer); ok {
		if err := in.OnInstall(ctx, e.core); err != nil {
			return fmt.Errorf("插件 %s 安装失败：%w", id, err)
		}
	}
	now := time.Now().UTC()
	st := State{
		ID: id, Installed: true, Version: e.m.Version, InstalledAt: &now,
		Permissions: slices.Clone(e.m.Permissions), PermissionsAt: &now, UpdatedAt: now,
	}
	if err := r.store.Save(ctx, st); err != nil {
		return err
	}
	r.setState(e, st)
	return nil
}

// CheckInstall 只做安装前的检查，不改任何东西。接口层先用它挡掉装不了的，再去打快照。
func (r *Registry) CheckInstall(id string, confirmed []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.get(id)
	if err != nil {
		return err
	}
	return r.checkInstall(e, confirmed)
}

// checkInstall：未安装、依赖已启用、清单和环境相容、权限都确认了。
func (r *Registry) checkInstall(e *entry, confirmed []string) error {
	id := e.m.ID
	if e.state.Installed {
		return fmt.Errorf("%w: 插件 %s 已安装", ErrState, id)
	}
	var installed []*Manifest
	for _, o := range r.entries {
		if o.state.Installed {
			installed = append(installed, &o.m)
		}
	}
	// 先查依赖是否启用：没启用时 Check 只会说「依赖的插件不存在」，不如这句准
	if err := r.checkDepsEnabled(e); err != nil {
		return err
	}
	if err := Check(&e.m, Env{APIVersion: r.apiVersion(), Plugins: installed}); err != nil {
		return err
	}
	var missing []string
	for _, p := range e.m.Permissions {
		if !slices.Contains(confirmed, p) {
			missing = append(missing, p)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("%w: %w: 这些权限没有确认：%s", ErrState, ErrUnconfirmed, strings.Join(missing, "、"))
	}
	return nil
}

// Enable 启用已安装的插件：调 Register、写状态表、起后台任务。已启用时什么都不做。
func (r *Registry) Enable(ctx context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.get(id)
	if err != nil {
		return err
	}
	if !e.state.Installed {
		return fmt.Errorf("%w: 插件 %s 未安装", ErrState, id)
	}
	if e.state.Enabled && e.active.Load() != nil {
		return nil
	}
	if err := r.checkEnable(e); err != nil {
		return err
	}
	a, err := r.collect(e)
	if err != nil {
		return err
	}
	st := e.state
	st.Enabled, st.UpdatedAt = true, time.Now().UTC()
	if err := r.store.Save(ctx, st); err != nil {
		return err
	}
	r.setState(e, st)
	r.start(e, a)
	return nil
}

// Disable 停用：被已启用的插件强依赖时拒绝；写状态表后撤掉路由、取消后台任务并等它们退出。数据不动。
func (r *Registry) Disable(ctx context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.get(id)
	if err != nil {
		return err
	}
	if !e.state.Enabled {
		r.stop(e)
		return nil
	}
	if deps := r.enabledDependents(id); len(deps) > 0 {
		return &DependentsError{ID: id, Dependents: deps}
	}
	if g, ok := e.p.(DisableGuard); ok {
		if ok, reason := g.CanDisable(ctx, e.core); !ok {
			return &GuardError{ID: id, Reason: reason}
		}
	}
	st := e.state
	st.Enabled, st.UpdatedAt = false, time.Now().UTC()
	if err := r.store.Save(ctx, st); err != nil {
		return err
	}
	r.setState(e, st)
	r.stop(e)
	return nil
}

// Info 是一个插件对外的样子：清单、状态表里的行、是否在跑、还没退出的后台任务数，
// 以及二进制里强依赖它的插件（不论装没装，停用、卸载前提示用）。
type Info struct {
	Manifest   Manifest `json:"manifest"`
	State      State    `json:"state"`
	Running    bool     `json:"running"`
	Jobs       int      `json:"jobs"`
	Dependents []string `json:"dependents"`
}

func (r *Registry) List() []Info {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Info, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.info(r.entries[id]))
	}
	return out
}

func (r *Registry) Get(id string) (Info, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.get(id)
	if err != nil {
		return Info{}, err
	}
	return r.info(e), nil
}

func (r *Registry) info(e *entry) Info {
	deps := []string{}
	for _, oid := range r.order {
		if _, ok := r.entries[oid].m.Depends[e.m.ID]; ok {
			deps = append(deps, oid)
		}
	}
	return Info{Manifest: e.m, State: e.state, Running: e.active.Load() != nil, Jobs: int(e.jobs.Load()), Dependents: deps}
}

// Route 是挂进接口层的一条插件路由。
type Route struct {
	Plugin  string
	Pattern string
	Handler http.HandlerFunc
}

// Routes 返回所有插件在启动时登记的路由。处理函数每次请求时查插件当前的启用结果：
// 没在跑就交给 notFound，所以停用后同一路径回 404，重新启用后恢复。
func (r *Registry) Routes(notFound http.HandlerFunc) []Route {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Route
	for _, id := range r.order {
		e := r.entries[id]
		for _, pat := range e.routes {
			out = append(out, Route{Plugin: id, Pattern: pat, Handler: func(w http.ResponseWriter, req *http.Request) {
				if a := e.active.Load(); a != nil {
					if h := a.handlers[pat]; h != nil {
						h(w, req)
						return
					}
				}
				notFound(w, req)
			}})
		}
	}
	return out
}

// Subscriber 是一个在跑的插件对某类事件的订阅，事件总线（internal/events）按它分发。
type Subscriber struct {
	Plugin string
	Handle func(ctx context.Context, e Event) error
}

// Subscribers 返回当前在跑的插件里订阅了 eventType 的处理函数；停用的插件不在里面。
// 处理函数调用时再查一次：拿到之后插件被停用（或停了又启用）就不送，停用后一条都收不到。
// 不拿 r.mu：order、entries 只在 Start 之前改，启停走 atomic；否则停用时等后台任务退出，
// 任务里发事件会卡在这把锁上，一直等到 StopTimeout。
func (r *Registry) Subscribers(eventType string) []Subscriber {
	var out []Subscriber
	for _, id := range r.order {
		e := r.entries[id]
		a := e.active.Load()
		if a == nil {
			continue
		}
		for _, h := range a.subs[eventType] {
			out = append(out, Subscriber{Plugin: id, Handle: func(ctx context.Context, ev Event) error {
				if e.active.Load() != a {
					return nil
				}
				return h(ctx, e.core, ev)
			}})
		}
	}
	return out
}

// MigrationSteps 返回插件迁移。id 为空时只给已应用的记录（含已不在二进制里的插件）；
// 给了 id 时是这个插件已应用和待应用的全部文件，按文件名排序。
func (r *Registry) MigrationSteps(ctx context.Context, id string) ([]MigrationStep, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	all, err := r.Migrations.Applied(ctx)
	if err != nil {
		return nil, err
	}
	var out []MigrationStep
	if id == "" {
		for i := range all {
			a := all[i]
			out = append(out, MigrationStep{Plugin: a.Plugin, File: a.File, Checksum: a.Checksum, Applied: &a})
		}
		slices.SortFunc(out, func(x, y MigrationStep) int {
			return strings.Compare(x.Plugin+"/"+x.File, y.Plugin+"/"+y.File)
		})
		return out, nil
	}
	e, ok := r.entries[id]
	applied := map[string]AppliedMigration{}
	for _, a := range all {
		if a.Plugin == id {
			applied[a.File] = a
		}
	}
	if !ok && len(applied) == 0 {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	files := map[string]string{}
	if ok {
		for _, f := range e.migs {
			files[f.name] = f.checksum
		}
	}
	for name := range applied {
		if _, has := files[name]; !has {
			files[name] = applied[name].Checksum
		}
	}
	for _, name := range slices.Sorted(maps.Keys(files)) {
		st := MigrationStep{Plugin: id, File: name, Checksum: files[name]}
		if a, has := applied[name]; has {
			st.Applied = &a
		}
		out = append(out, st)
	}
	return out, nil
}

// --- 内部 ---

func (r *Registry) appliedByPlugin(ctx context.Context) (map[string]map[string]AppliedMigration, error) {
	all, err := r.Migrations.Applied(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]map[string]AppliedMigration{}
	for _, a := range all {
		if out[a.Plugin] == nil {
			out[a.Plugin] = map[string]AppliedMigration{}
		}
		out[a.Plugin][a.File] = a
	}
	return out, nil
}

func pending(files []migrationFile, applied map[string]AppliedMigration) []migrationFile {
	var out []migrationFile
	for _, f := range files {
		if _, ok := applied[f.name]; !ok {
			out = append(out, f)
		}
	}
	return out
}

// migrate 先校验已应用的，再按文件名顺序应用待应用的，每个文件一个事务。
func (r *Registry) migrate(ctx context.Context, e *entry) error {
	if len(e.migs) == 0 {
		return nil
	}
	applied, err := r.appliedByPlugin(ctx)
	if err != nil {
		return err
	}
	if err := verifyMigrations(e.m.ID, e.migs, applied[e.m.ID]); err != nil {
		return err
	}
	for _, f := range pending(e.migs, applied[e.m.ID]) {
		a := AppliedMigration{Plugin: e.m.ID, File: f.name, Checksum: f.checksum,
			PluginVersion: e.m.Version, AppliedAt: time.Now().UTC()}
		if err := r.Migrations.Apply(ctx, a, f.body); err != nil {
			return err
		}
		e.core.log.Info("plugin migration applied", "file", f.name)
	}
	return nil
}

func (r *Registry) get(id string) (*entry, error) {
	e, ok := r.entries[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	return e, nil
}

// checkEnable 查插件 API 版本、强依赖已启用且版本匹配。
func (r *Registry) checkEnable(e *entry) error {
	if err := r.checkDepsEnabled(e); err != nil {
		return err
	}
	var enabled []*Manifest
	for _, o := range r.entries {
		if o.state.Enabled && o.active.Load() != nil {
			enabled = append(enabled, &o.m)
		}
	}
	return Check(&e.m, Env{APIVersion: r.apiVersion(), Plugins: enabled})
}

func (r *Registry) checkDepsEnabled(e *entry) error {
	var off []string
	for _, dep := range sortedKeys(e.m.Depends) {
		if o, ok := r.entries[dep]; !ok || !o.state.Enabled || o.active.Load() == nil {
			off = append(off, dep)
		}
	}
	if len(off) > 0 {
		return fmt.Errorf("%w: 插件 %s 依赖的插件没有启用：%s", ErrState, e.m.ID, strings.Join(off, "、"))
	}
	return nil
}

func (r *Registry) enabledDependents(id string) []string {
	var out []string
	for _, oid := range r.order {
		o := r.entries[oid]
		if _, dep := o.m.Depends[id]; dep && o.state.Enabled {
			out = append(out, oid)
		}
	}
	return out
}

// depOrder 按强依赖排序：被依赖的在前。成环由清单校验挡住，这里只防死循环。
func (r *Registry) depOrder() []string {
	seen := map[string]bool{}
	var out []string
	var visit func(id string)
	visit = func(id string) {
		e, ok := r.entries[id]
		if !ok || seen[id] {
			return
		}
		seen[id] = true
		for _, dep := range sortedKeys(e.m.Depends) {
			visit(dep)
		}
		out = append(out, id)
	}
	for _, id := range r.order {
		visit(id)
	}
	return out
}

// collect 调一次 Register，把登记的东西收进一个新的 activation，同时逐项比对清单。
// 启用时的路由必须和启动时挂进接口层的一致，否则新路由根本没挂上。
func (r *Registry) collect(e *entry) (*activation, error) {
	c := &collector{e: e, a: &activation{handlers: map[string]http.HandlerFunc{}, subs: map[string][]EventHandler{}}}
	if err := e.p.Register(c); err != nil {
		return nil, fmt.Errorf("插件 %s 登记失败：%w", e.m.ID, err)
	}
	if e.routes != nil {
		got := slices.Sorted(maps.Keys(c.a.handlers))
		if !slices.Equal(got, e.routes) {
			c.add("路由和启动时登记的不一致")
		}
	}
	if len(c.issues) > 0 {
		return nil, fmt.Errorf("插件 %s 登记失败：%s", e.m.ID, strings.Join(c.issues, "；"))
	}
	return c.a, nil
}

func (r *Registry) start(e *entry, a *activation) {
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	// 先标在跑再起任务：任务一启动就可能发通知（Notify 只认在跑的插件）
	e.active.Store(a)
	for _, j := range a.jobs {
		a.done.Add(1)
		e.jobs.Add(1)
		go r.runJob(ctx, e, a, j)
	}
	e.core.log.Info("plugin started", "routes", len(a.handlers), "jobs", len(a.jobs))
}

// stop 先撤路由（立刻 404），再取消后台任务并等它们退出，最多等 StopTimeout。
func (r *Registry) stop(e *entry) {
	a := e.active.Swap(nil)
	if a == nil {
		return
	}
	a.cancel()
	done := make(chan struct{})
	go func() {
		a.done.Wait()
		close(done)
	}()
	select {
	case <-done:
		e.core.log.Info("plugin stopped")
	case <-time.After(r.stopTimeout()):
		e.core.log.Warn("plugin jobs did not exit in time", "timeout", r.stopTimeout(), "jobs", e.jobs.Load())
	}
}

func (r *Registry) runJob(ctx context.Context, e *entry, a *activation, j Job) {
	defer a.done.Done()
	defer e.jobs.Add(-1)
	if j.Every <= 0 {
		r.runOnce(ctx, e, j)
		return
	}
	t := time.NewTicker(j.Every)
	defer t.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		r.runOnce(ctx, e, j)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// runOnce 跑一次任务；出错、panic 只记日志，不影响别的插件和下一轮。
func (r *Registry) runOnce(ctx context.Context, e *entry, j Job) {
	defer func() {
		if v := recover(); v != nil {
			e.core.log.Error("plugin job panic", "job", j.Name, "panic", v, "stack", string(debug.Stack()))
		}
	}()
	if err := j.Run(ctx, e.core); err != nil && ctx.Err() == nil {
		e.core.log.Warn("plugin job failed", "job", j.Name, "err", err)
	}
}

// collector 是 Register 拿到的 Registrar，登记的同时逐项检查。
type collector struct {
	e      *entry
	a      *activation
	issues []string
}

func (c *collector) add(format string, args ...any) {
	c.issues = append(c.issues, fmt.Sprintf(format, args...))
}

func (c *collector) Core() Core { return c.e.core }

func (c *collector) Routes(fn func(m RouteRegistrar)) { fn(routeCollector{c}) }

var routeMethods = []string{"GET", "POST", "PUT", "PATCH", "DELETE"}

type routeCollector struct{ c *collector }

func (rc routeCollector) HandleFunc(pattern string, h func(http.ResponseWriter, *http.Request)) {
	c := rc.c
	method, path, ok := strings.Cut(pattern, " ")
	prefix := "/api/" + c.e.m.ID + "/"
	switch {
	case !ok || !slices.Contains(routeMethods, method):
		c.add("路由要写成「方法 路径」：%s", pattern)
	case !strings.HasPrefix(path, prefix) || len(path) == len(prefix):
		c.add("路由必须在 %s 下：%s", prefix, pattern)
	case h == nil:
		c.add("路由没有处理函数：%s", pattern)
	case c.a.handlers[pattern] != nil:
		c.add("路由重复：%s", pattern)
	default:
		c.a.handlers[pattern] = h
	}
}

func (c *collector) Job(j Job) {
	switch {
	case !keyRe.MatchString(j.Name):
		c.add("后台任务名不合法：%q", j.Name)
	case j.Run == nil:
		c.add("后台任务 %s 没有 Run", j.Name)
	case j.Every < 0:
		c.add("后台任务 %s 的 Every 不能为负", j.Name)
	case slices.ContainsFunc(c.a.jobs, func(o Job) bool { return o.Name == j.Name }):
		c.add("后台任务重复：%s", j.Name)
	default:
		c.a.jobs = append(c.a.jobs, j)
	}
}

func (c *collector) Subscribe(eventType string, h EventHandler) {
	switch {
	case !slices.Contains(c.e.m.Subscribes, eventType):
		c.add("订阅的事件不在清单 subscribes 里：%s", eventType)
	case h == nil:
		c.add("订阅 %s 没有处理函数", eventType)
	default:
		c.a.subs[eventType] = append(c.a.subs[eventType], h)
	}
}
