// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sqlite

import (
	"context"
	"fmt"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/store"
)

// seedActor 让演示数据在修订历史里可辨认，和真人操作区分开。
var seedActor = store.Actor{Name: "me", Source: "import"}

// SeedDemo 灌一批贴合产品经理日常的演示数据。库里已有对象时直接返回，保证可重复调用。
// 只灌工作对象：快捷访问要的是空态引导，预置假链接会盖掉首次进入的引导页。
func (s *Store) SeedDemo(ctx context.Context) error {
	var n int
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM objects`).Scan(&n); err != nil {
		return fmt.Errorf("check seed state: %w", err)
	}
	if n > 0 {
		return nil
	}

	now := time.Now()
	// 演示数据刻意留两种到期形态，因为界面对它们的显示不同：
	// 落在 23:59:59 的当成「整天任务」显示纯日期，带具体时刻的显示到分钟。
	// 大多数事项是「这天之前做完」，本来就没有时刻，用 endOfDay；
	// 只有会议、约人这类真有钟点的用 at。全统一成一种的话，
	// 「能从『明天下午三点』解析出真实时刻」这个能力在演示数据上就看不出来了。
	endOfDay := func(offset int) *time.Time {
		t := time.Date(now.Year(), now.Month(), now.Day(), 23, 59, 59, 0, now.Location()).AddDate(0, 0, offset)
		return &t
	}
	at := func(offset, hour, min int) *time.Time {
		t := time.Date(now.Year(), now.Month(), now.Day(), hour, min, 0, 0, now.Location()).AddDate(0, 0, offset)
		return &t
	}
	ago := func(d time.Duration) time.Time { return now.Add(-d) }

	// 记下 key 到 id 的映射，后面建关联时用得上。
	ids := map[string]string{}
	create := func(key string, o *domain.Object) error {
		out, err := s.CreateObject(ctx, o, seedActor)
		if err != nil {
			return fmt.Errorf("seed %s: %w", key, err)
		}
		ids[key] = out.ID
		return nil
	}
	catOf := func(id string) *string { return &id }

	// 项目先建，需求和待办要挂到它下面。
	projects := []struct {
		key string
		obj *domain.Object
	}{
		{"prj_cloud", &domain.Object{
			TypeID: "project", Title: "云端平台 2026 Q4 迭代", Status: "active", Priority: "P0",
			Owner: "me", CategoryID: catOf("cat_prj_inner"), Source: "manual",
			Body:      "围绕多租户与计费打通，目标 12 月底灰度 3 家种子客户。",
			StartedAt: ptrTime(ago(30 * 24 * time.Hour)), CreatedAt: ago(32 * 24 * time.Hour),
			Tags: []string{"云端平台"},
		}},
		{"prj_local", &domain.Object{
			TypeID: "project", Title: "本地客户端 v2 重构", Status: "planning", Priority: "P1",
			Owner: "me", CategoryID: catOf("cat_prj_inner"), Source: "manual",
			Body:      "把渲染层从 WebView 换成原生，先出技术方案再评估排期。",
			CreatedAt: ago(12 * 24 * time.Hour),
			Tags:      []string{"本地客户端"},
		}},
	}
	for _, p := range projects {
		if err := create(p.key, p.obj); err != nil {
			return err
		}
	}

	reqs := []struct {
		key string
		obj *domain.Object
	}{
		{"req_tenant", &domain.Object{
			TypeID: "requirement", Title: "多租户组织架构与成员权限", Status: "doing", Priority: "P0",
			Owner: "me", CategoryID: catOf("cat_req_prod_cloud"), ProjectID: refOf(ids, "prj_cloud"),
			Source: "manual",
			Body:   "支持一个账号下多组织切换，组织内区分管理员/成员/只读三种角色，权限点按功能模块配置。",
			DueAt:  endOfDay(9), StartedAt: ptrTime(ago(6 * 24 * time.Hour)), CreatedAt: ago(20 * 24 * time.Hour),
			Tags: []string{"云端平台", "P0 冲刺"},
		}},
		{"req_billing", &domain.Object{
			TypeID: "requirement", Title: "用量计费与账单导出", Status: "planned", Priority: "P0",
			Owner: "me", CategoryID: catOf("cat_req_prod_cloud"), ProjectID: refOf(ids, "prj_cloud"),
			Source: "manual",
			Body:   "按调用次数与存储量计费，月末生成账单并支持导出 CSV 给财务对账。",
			DueAt:  endOfDay(21), CreatedAt: ago(18 * 24 * time.Hour),
			Tags: []string{"云端平台", "P0 冲刺"},
		}},
		{"req_tenant_dup", &domain.Object{
			TypeID: "requirement", Title: "组织与成员管理（客户会议重复提出）", Status: "inbox", Priority: "P2",
			Owner: "me", Source: "inbox",
			Body:      "客户在 10 月例会再次提到希望一个账号管多个团队，与已有需求重复，留档备查。",
			CreatedAt: ago(4 * 24 * time.Hour),
		}},
		{"req_offline", &domain.Object{
			TypeID: "requirement", Title: "本地客户端离线草稿与冲突合并", Status: "backlog", Priority: "P1",
			Owner: "me", CategoryID: catOf("cat_req_prod_local"), ProjectID: refOf(ids, "prj_local"),
			Source: "manual",
			Body:   "断网时本地留存草稿，恢复联网后按最后写入时间提示冲突，由用户选择保留哪一版。",
			DueAt:  endOfDay(30),
			// 躺在需求池里半个月没动，用来演示「停滞」徽标。
			CreatedAt: ago(15 * 24 * time.Hour), UpdatedAt: ago(15 * 24 * time.Hour),
			Tags: []string{"本地客户端"},
		}},
		{"req_perf", &domain.Object{
			TypeID: "requirement", Title: "列表页首屏加载压到 1 秒内", Status: "doing", Priority: "P1",
			Owner: "me", CategoryID: catOf("cat_req_tech_perf"), ProjectID: refOf(ids, "prj_cloud"),
			Source: "manual",
			Body:   "当前万级数据列表首屏 3.2 秒，目标 P95 降到 1 秒，方案是游标分页加索引重建。",
			DueAt:  endOfDay(5), StartedAt: ptrTime(ago(3 * 24 * time.Hour)), CreatedAt: ago(11 * 24 * time.Hour),
			Tags: []string{"云端平台"},
		}},
	}
	for _, r := range reqs {
		if err := create(r.key, r.obj); err != nil {
			return err
		}
	}

	tasks := []struct {
		key string
		obj *domain.Object
	}{
		{"tsk_prd_review", &domain.Object{
			TypeID: "task", Title: "多租户 PRD 评审会纪要回收", Status: "doing", Priority: "P0",
			Owner: "me", CategoryID: catOf("cat_task_pm"), ProjectID: refOf(ids, "prj_cloud"),
			Source: "manual", Body: "把评审会上研发提的 7 个疑问逐条回复并更新 PRD。",
			DueAt: at(0, 10, 0), StartedAt: ptrTime(ago(2 * 24 * time.Hour)), CreatedAt: ago(5 * 24 * time.Hour),
			Tags: []string{"云端平台", "P0 冲刺"},
		}},
		{"tsk_role_matrix", &domain.Object{
			TypeID: "task", Title: "输出角色权限矩阵表", Status: "todo", Priority: "P0",
			Owner: "me", CategoryID: catOf("cat_task_pm"), ProjectID: refOf(ids, "prj_cloud"),
			Source: "manual", Body: "三种角色 × 18 个功能点，逐格标注可见/可编辑/不可见。",
			DueAt: endOfDay(0), CreatedAt: ago(3 * 24 * time.Hour),
			Tags: []string{"云端平台", "P0 冲刺"},
		}},
		{"tsk_billing_rule", &domain.Object{
			TypeID: "task", Title: "和财务确认计费口径", Status: "todo", Priority: "P1",
			Owner: "me", CategoryID: catOf("cat_task_meet"), ProjectID: refOf(ids, "prj_cloud"),
			Source: "manual", Body: "确认按自然月还是按订阅周期结算，以及超额部分如何计价。",
			DueAt: endOfDay(-3), CreatedAt: ago(9 * 24 * time.Hour),
			Tags: []string{"云端平台"},
		}},
		{"tsk_compliance", &domain.Object{
			TypeID: "task", Title: "补齐数据出境合规材料", Status: "todo", Priority: "P0",
			Owner: "me", CategoryID: catOf("cat_task_pm"), Source: "manual",
			Body:  "法务要的数据流向说明和留存策略还差两份，本周必须交。",
			DueAt: endOfDay(-1), CreatedAt: ago(14 * 24 * time.Hour),
			Tags: []string{"合规", "P0 冲刺"},
		}},
		{"tsk_index", &domain.Object{
			TypeID: "task", Title: "列表页索引重建方案落地", Status: "blocked", Priority: "P1",
			Owner: "me", CategoryID: catOf("cat_task_dev"), ProjectID: refOf(ids, "prj_cloud"),
			Source: "manual", Body: "等 DBA 给出停机窗口，窗口没定之前动不了。",
			DueAt: endOfDay(6), CreatedAt: ago(8 * 24 * time.Hour),
			Tags: []string{"云端平台"},
		}},
		{"tsk_dba", &domain.Object{
			TypeID: "task", Title: "约 DBA 敲定停机窗口", Status: "doing", Priority: "P1",
			Owner: "me", CategoryID: catOf("cat_task_meet"), ProjectID: refOf(ids, "prj_cloud"),
			Source: "manual", Body: "候选窗口是本周六凌晨 2 点到 4 点，待运维确认。",
			DueAt: at(2, 15, 30), StartedAt: ptrTime(ago(24 * time.Hour)), CreatedAt: ago(7 * 24 * time.Hour),
			Tags: []string{"云端平台"},
		}},
		{"tsk_native_poc", &domain.Object{
			TypeID: "task", Title: "原生渲染层 POC 验证", Status: "todo", Priority: "P2",
			Owner: "me", CategoryID: catOf("cat_task_dev"), ProjectID: refOf(ids, "prj_local"),
			Source: "manual", Body: "先验证长列表滚动与富文本编辑两个最难的场景。",
			DueAt: endOfDay(12), CreatedAt: ago(10 * 24 * time.Hour),
			Tags: []string{"本地客户端"},
		}},
		{"tsk_weekly", &domain.Object{
			TypeID: "task", Title: "整理上周迭代周报", Status: "done", Priority: "P2",
			Owner: "me", CategoryID: catOf("cat_task_pm"), Source: "manual",
			Body:        "已发出，重点是多租户进度与性能优化的风险提示。",
			DueAt:       endOfDay(-4),
			StartedAt:   ptrTime(ago(5 * 24 * time.Hour)),
			CompletedAt: ptrTime(ago(4 * 24 * time.Hour)),
			CreatedAt:   ago(6 * 24 * time.Hour),
		}},
	}
	for _, t := range tasks {
		if err := create(t.key, t.obj); err != nil {
			return err
		}
	}

	docs := []struct {
		key string
		obj *domain.Object
	}{
		{"doc_tenant_prd", &domain.Object{
			TypeID: "doc", Title: "多租户组织架构 PRD v1.2", Status: "review", Priority: "P0",
			Owner: "me", CategoryID: catOf("cat_doc_prd"), ProjectID: refOf(ids, "prj_cloud"),
			Source: "manual", Body: "含组织切换流程图、角色权限矩阵、边界场景与灰度方案。",
			CreatedAt: ago(16 * 24 * time.Hour),
			Tags:      []string{"云端平台", "P0 冲刺"},
		}},
		{"doc_perf_plan", &domain.Object{
			TypeID: "doc", Title: "列表页性能优化技术方案", Status: "published", Priority: "P1",
			Owner: "me", CategoryID: catOf("cat_doc_tech"), ProjectID: refOf(ids, "prj_cloud"),
			Source: "manual", Body: "游标分页 + 覆盖索引 + 结果缓存三段式，附压测基线数据。",
			CreatedAt: ago(9 * 24 * time.Hour),
			Tags:      []string{"云端平台"},
		}},
		{"doc_compliance", &domain.Object{
			TypeID: "doc", Title: "数据出境合规自查清单", Status: "draft", Priority: "P0",
			Owner: "me", CategoryID: catOf("cat_doc_prd"), Source: "manual",
			Body:      "按监管口径逐项自查，当前 12 项里有 3 项待补材料。",
			CreatedAt: ago(13 * 24 * time.Hour),
			Tags:      []string{"合规"},
		}},
	}
	for _, d := range docs {
		if err := create(d.key, d.obj); err != nil {
			return err
		}
	}

	resources := []struct {
		key string
		obj *domain.Object
	}{
		{"res_metrics", &domain.Object{
			TypeID: "resource", Title: "线上核心指标看板", Status: "active", Priority: "P2",
			Owner: "me", CategoryID: catOf("cat_res_link"), Source: "manual",
			Body:      "日活、留存、接口 P95 都在这里，每天早会前先看一眼。",
			CreatedAt: ago(40 * 24 * time.Hour),
			Tags:      []string{"云端平台"},
		}},
		{"res_competitor", &domain.Object{
			TypeID: "resource", Title: "竞品定价与功能对比表", Status: "stale", Priority: "P3",
			Owner: "me", CategoryID: catOf("cat_res_file"), Source: "manual",
			Body:      "上次更新是半年前，做计费需求前需要重新核一遍。",
			CreatedAt: ago(180 * 24 * time.Hour), UpdatedAt: ago(150 * 24 * time.Hour),
		}},
	}
	for _, r := range resources {
		if err := create(r.key, r.obj); err != nil {
			return err
		}
	}

	links := []struct {
		from, to, rel, note string
	}{
		{"req_tenant", "tsk_prd_review", domain.RelRelates, "评审遗留问题跟进"},
		{"req_tenant", "tsk_role_matrix", domain.RelRelates, "权限矩阵是该需求的交付物之一"},
		{"tsk_index", "tsk_dba", domain.RelBlocks, "停机窗口没定，索引重建开不了工"},
		{"req_tenant", "doc_tenant_prd", domain.RelReferences, "需求正文以该 PRD 为准"},
		{"req_tenant_dup", "req_tenant", domain.RelDuplicates, "同一诉求，合并到主需求跟进"},
		{"req_perf", "doc_perf_plan", domain.RelReferences, "技术方案已评审通过"},
	}
	for _, l := range links {
		if _, err := s.CreateLink(ctx, ids[l.from], ids[l.to], l.rel, l.note); err != nil {
			return fmt.Errorf("seed link %s->%s: %w", l.from, l.to, err)
		}
	}
	return nil
}

func ptrTime(t time.Time) *time.Time { return &t }

// refOf 取前面已建对象的 id，seed 里项目先于需求创建，所以这里必然取得到。
func refOf(ids map[string]string, key string) *string {
	if id, ok := ids[key]; ok {
		return &id
	}
	return nil
}
