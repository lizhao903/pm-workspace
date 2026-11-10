// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// UninstallOptions：DeleteData 为 false 时只把状态表置未安装，表、迁移记录都留着（4.4）。
// 删数据时必须给 Backup：先打快照，返回快照路径；快照失败就不删。
type UninstallOptions struct {
	DeleteData bool
	Backup     func(ctx context.Context) (string, error)
}

// UninstallResult 是卸载的结果：删数据时带快照路径和删掉的表。
type UninstallResult struct {
	DataDeleted   bool     `json:"data_deleted"`
	Backup        string   `json:"backup,omitempty"`
	DroppedTables []string `json:"dropped_tables"`
}

// Uninstall 卸载已停用的插件。还有已安装的插件强依赖它时拒绝（DependentsError）。
// 删数据：快照、OnUninstall、删本插件前缀的表和迁移记录、状态表置未安装，按这个顺序，
// 删表之后写状态表失败时数据已删，快照就是恢复手段。
func (r *Registry) Uninstall(ctx context.Context, id string, opt UninstallOptions) (UninstallResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	res := UninstallResult{DroppedTables: []string{}}
	e, err := r.get(id)
	if err != nil {
		return res, err
	}
	if !e.state.Installed {
		return res, fmt.Errorf("%w: 插件 %s 未安装", ErrState, id)
	}
	if e.state.Enabled || e.active.Load() != nil {
		return res, fmt.Errorf("%w: 插件 %s 还在启用，要先停用", ErrState, id)
	}
	var deps []string
	for _, oid := range r.order {
		o := r.entries[oid]
		if _, dep := o.m.Depends[id]; dep && o.state.Installed {
			deps = append(deps, oid)
		}
	}
	if len(deps) > 0 {
		return res, &DependentsError{ID: id, Dependents: deps, Uninstall: true}
	}
	if opt.DeleteData {
		if opt.Backup == nil {
			return res, errors.New("plugin uninstall: delete data without backup")
		}
		path, err := opt.Backup(ctx)
		if err != nil {
			return res, fmt.Errorf("删数据前备份失败，没有删：%w", err)
		}
		res.Backup = path
		e.core.log.Info("plugin data backed up before uninstall", "backup", path)
	}
	if u, ok := e.p.(Uninstaller); ok {
		if err := u.OnUninstall(ctx, e.core, opt.DeleteData); err != nil {
			return res, fmt.Errorf("插件 %s 卸载失败：%w", id, err)
		}
	}
	if opt.DeleteData {
		tables, err := r.Migrations.DropData(ctx, id, e.m.TablePrefix)
		if err != nil {
			return res, err
		}
		if tables != nil {
			res.DroppedTables = tables
		}
		res.DataDeleted = true
		e.core.log.Info("plugin data deleted", "tables", tables)
	}
	st := e.state
	st.Installed, st.Enabled, st.UpdatedAt = false, false, time.Now().UTC()
	if err := r.store.Save(ctx, st); err != nil {
		return res, err
	}
	r.setState(e, st)
	e.core.log.Info("plugin uninstalled", "delete_data", opt.DeleteData)
	return res, nil
}
