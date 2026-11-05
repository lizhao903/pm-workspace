package plugin

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// 权限在运行时生效（SEC-01，docs/plugin-api.md 3.3、4.5）：插件编译在二进制里，换了二进制跑的就是新代码，
// 「不确认就停在旧版本」做不到。所以要高风险权限的代码路径执行前调 Core.Granted 或 Require，
// 只认状态表里用户确认过的；升级时新增的权限在 Upgrade 确认之前一直是 false。

// ErrNotGranted：要用的权限用户还没确认。
var ErrNotGranted = errors.New("plugin permission not granted")

// NotGrantedError 是 Require 返回的错误，Error() 直接给用户看。
type NotGrantedError struct {
	ID   string
	Perm string
}

func (e *NotGrantedError) Error() string {
	return fmt.Sprintf("插件 %s 的 %s 权限还没确认，到插件管理里升级并确认", e.ID, e.Perm)
}

func (e *NotGrantedError) Unwrap() error { return ErrNotGranted }

// Require 在 c 没确认 perm 时返回 *NotGrantedError。
func Require(c Core, perm string) error {
	if c.Granted(perm) {
		return nil
	}
	return &NotGrantedError{ID: c.PluginID(), Perm: perm}
}

// Granted 只认已安装插件在状态表里确认过的权限。不拿 r.mu：后台任务里也会调，停用时等任务退出会卡在锁上。
func (c *core) Granted(perm string) bool {
	p := c.perms.Load()
	return p != nil && slices.Contains(*p, perm)
}

// setState 改内存里的状态行，同时换掉 Granted 看的权限集合。调用方持有 r.mu。
func (r *Registry) setState(e *entry, st State) {
	e.state = st
	perms := []string{}
	if st.Installed {
		perms = slices.Clone(st.Permissions)
	}
	e.core.perms.Store(&perms)
}

// UpgradePermissionsError：升级时清单新增的权限没有全部确认。Missing 是还没确认的那几条。
type UpgradePermissionsError struct {
	ID      string
	Missing []string
}

func (e *UpgradePermissionsError) Error() string {
	return fmt.Sprintf("插件 %s 升级新增了这些权限，要先确认：%s", e.ID, strings.Join(e.Missing, "、"))
}

// NewPermissions 是清单里有、状态表里还没确认过的权限，按清单顺序。没安装时为空。
// 单独申请的权限（SeparatePermissions，如 trade:live）不算：升级时不授予，也不要求确认。
func (in Info) NewPermissions() []string {
	if !in.State.Installed {
		return []string{}
	}
	out := []string{}
	for _, p := range installable(in.Manifest) {
		if !slices.Contains(in.State.Permissions, p) {
			out = append(out, p)
		}
	}
	return out
}

// CheckUpgrade 只做升级前的检查，不改任何东西。接口层先用它挡掉升不了的，再去打快照。
func (r *Registry) CheckUpgrade(id string, confirmed []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.get(id)
	if err != nil {
		return err
	}
	return r.checkUpgrade(e, confirmed)
}

// checkUpgrade：已安装、版本变了、新版本的 core 范围和依赖仍满足、依赖本插件的已装插件对新版本的范围仍满足、
// 新增的权限都确认了。
func (r *Registry) checkUpgrade(e *entry, confirmed []string) error {
	id := e.m.ID
	if !e.state.Installed {
		return fmt.Errorf("%w: 插件 %s 未安装", ErrState, id)
	}
	if e.state.Version == e.m.Version {
		return fmt.Errorf("%w: 插件 %s 已经是 %s，不用升级", ErrState, id, e.m.Version)
	}
	var installed []*Manifest
	var bad []string
	for _, oid := range r.order {
		o := r.entries[oid]
		if !o.state.Installed || oid == id {
			continue
		}
		installed = append(installed, &o.m)
		if rng, ok := o.m.Depends[id]; ok && !Satisfies(e.m.Version, rng) {
			bad = append(bad, fmt.Sprintf("%s 要求 %s", oid, rng))
		}
	}
	if err := Check(&e.m, Env{APIVersion: r.apiVersion(), Plugins: installed}); err != nil {
		return err
	}
	if len(bad) > 0 {
		return &ValidationError{Issues: []Issue{{Field: "dependents", Message: "依赖它的插件不认新版本 " + e.m.Version + "：" + strings.Join(bad, "；")}}}
	}
	var missing []string
	for _, p := range r.info(e).NewPermissions() {
		if !slices.Contains(confirmed, p) {
			missing = append(missing, p)
		}
	}
	if len(missing) > 0 {
		return &UpgradePermissionsError{ID: id, Missing: missing}
	}
	return nil
}

// Upgrade 把状态表里的版本升到二进制里的版本（4.5）：跑新迁移、记下确认过的权限（清单里去掉的直接收回），
// 在跑的插件撤掉旧注册再按新版本注册；已启用但因迁移没跑而没起来的，迁移跑完后起来。
// 迁移中途失败时状态表不动（仍是旧版本），已提交的迁移靠升级前的快照恢复。
// 状态表写完后重新注册失败时返回错误，这时已经是新版本，插件没在跑。
func (r *Registry) Upgrade(ctx context.Context, id string, confirmed []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, err := r.get(id)
	if err != nil {
		return err
	}
	if err := r.checkUpgrade(e, confirmed); err != nil {
		return err
	}
	if err := r.migrate(ctx, e); err != nil {
		return err
	}
	now := time.Now().UTC()
	st := e.state
	from := st.Version
	st.Version, st.UpdatedAt = e.m.Version, now
	// 单独申请的权限不随升级授予：已经单独授予过、新清单里仍声明的保留，其余收回
	perms := installable(e.m)
	for _, p := range st.Permissions {
		if IsSeparate(p) && slices.Contains(e.m.Permissions, p) {
			perms = append(perms, p)
		}
	}
	if !slices.Equal(perms, st.Permissions) {
		st.Permissions, st.PermissionsAt = perms, &now
	}
	if err := r.store.Save(ctx, st); err != nil {
		return err
	}
	r.setState(e, st)
	e.core.log.Info("plugin upgraded", "from", from, "to", e.m.Version)
	if !st.Enabled {
		return nil
	}
	r.stop(e)
	if err := r.checkEnable(e); err != nil {
		return fmt.Errorf("插件 %s 已升级到 %s，但没能重新启用：%w", id, e.m.Version, err)
	}
	a, err := r.collect(e)
	if err != nil {
		return fmt.Errorf("插件 %s 已升级到 %s，但没能重新启用：%w", id, e.m.Version, err)
	}
	r.start(e, a)
	return nil
}

// LocalDir 把 file:// 地址转成本机路径（主机部分只认空和 localhost，路径按 URL 解码）；
// 不是 file:// 开头的原样返回。项目根目录有时存成了 file:// 地址（TERM-01c 记），起进程前用它转。
func LocalDir(s string) string {
	t := strings.TrimSpace(s)
	if len(t) < 7 || !strings.EqualFold(t[:7], "file://") {
		return s
	}
	u, err := url.Parse(t)
	if err != nil || (u.Host != "" && u.Host != "localhost") || u.Path == "" {
		return s
	}
	return filepath.FromSlash(u.Path)
}
