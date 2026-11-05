package projects

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lizhao903/pm-workspace/internal/idgen"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 原型回写旁路（AUTO-11，docs/auto-delivery-flow.md 第 2 节）：以上线代码为准，把原型库和规格拉齐，只提交到原型库的同步分支。
// 表 projects_proto_syncs、projects_proto_sync_settings（迁移 0010）。
//
// 分工：项目插件管同步点、触发和几个 SOP 节点；流程本身是 IM 插件写进 SOP 的内置流程「原型同步」（sop_im_proto_sync，默认停用），
// 它要用 IM 的通知节点 im_notify，而 IM 插件已经负责写受理、研发、发布三条内置流程，依赖方向一致（IM 的流程用项目插件的节点）。
//
// 三种触发（各自一个开关，默认都关）都走 Trigger：建一行 running，再经 Core.Runs().StartSOP 发起「原型同步」，输入 {project_id, sync_id, trigger}：
//   - 发布成功：发布记录变成 released 时（同一插件内直接回调，等价于订阅 projects.release_changed 的 released）；
//   - 生产分支合并：后台任务每分钟看一次生产分支 HEAD（本机代码库的本地分支，不 fetch），和同步点、上一次发起时的 HEAD 都不同就发起；
//   - 每日巡检：每天设定时间后第一次检查时巡检一次；HEAD 没变只记一行 no_change，不发起流程。
// 另有手动：接口 POST /api/projects/{id}/proto-syncs（mode sync 发起，baseline 只把当前 HEAD 记成同步点）；SOP 页直接发起时不带 sync_id，
// 「取同步范围」节点自己建行。
//
// SOP 节点（分组「项目」）：
//   - projects_proto_sync_range 取同步范围：同步点 → 生产分支 HEAD 的代码 diff，写 diff.patch，判断有没有涉及界面或接口的改动；
//   - projects_proto_sync_branch 准备原型同步分支：在原型库拉 proto-sync/<日期> 分支的 worktree，Claude Code 在里面改；
//   - projects_proto_sync_classify 登记差异：读 Claude Code 回报的 result.items，按新增 / 不一致 / 未实现 / 已下线 / 不确定分类，有拿不准的转 reviewing；
//   - projects_proto_sync_verdict 记裁决：按人工裁决（design / defect / ignore）改不确定项，判为缺陷时建修复任务；
//   - projects_proto_sync_commit 提交同步分支：把 worktree 里没提交的改动提交到同步分支，当前分支不是 proto-sync/ 开头的拒绝；
//   - projects_proto_sync_record 记同步点：这次的代码 HEAD 记成同步点，和同步分支的提交对应起来，删 worktree（分支保留）。

const (
	NodeProtoSyncRange    = "projects_proto_sync_range"
	NodeProtoSyncBranch   = "projects_proto_sync_branch"
	NodeProtoSyncClassify = "projects_proto_sync_classify"
	NodeProtoSyncVerdict  = "projects_proto_sync_verdict"
	NodeProtoSyncCommit   = "projects_proto_sync_commit"
	NodeProtoSyncRecord   = "projects_proto_sync_record"

	protoSyncChanged = "projects.proto_sync_changed"

	// ProtoSyncFlowID 是 IM 插件写进 SOP 的内置流程「原型同步」，触发时按这个 id 发起。
	ProtoSyncFlowID = "sop_im_proto_sync"
	// ProtoSyncBranchPrefix 是原型库同步分支的前缀，后面接日期 YYYYMMDD。
	ProtoSyncBranchPrefix = "proto-sync/"
	// ProtoSyncsSubdir 是数据目录下放 diff 的目录。
	ProtoSyncsSubdir = "proto-syncs"

	psRunning   = "running"
	psReviewing = "reviewing"
	psDone      = "done"
	psNoChange  = "no_change"
	psBaseline  = "baseline"
	psFailed    = "failed"
	psCancelled = "cancelled"

	trigRelease  = "release"
	trigMerge    = "merge"
	trigDaily    = "daily"
	trigManual   = "manual"
	trigBaseline = "baseline"

	// protoSyncStale：进行中（running）超过这么久没动静，当作中断，不再挡新的同步。等裁决（reviewing）不算，要人作废。
	protoSyncStale = 48 * time.Hour
	// maxSyncFiles 是记下的改动文件个数上限，maxDiffBytes 是 diff.patch 的上限。
	maxSyncFiles = 500
	maxDiffBytes = 2 << 20
	maxSyncItems = 300
)

var protoSyncStatuses = []string{psRunning, psReviewing, psDone, psNoChange, psBaseline, psFailed, psCancelled}

// syncPointStatuses 是能当同步点的状态。
var syncPointStatuses = []string{psDone, psNoChange, psBaseline}

// 差异分类。
const (
	kindAdded         = "added"
	kindChanged       = "changed"
	kindUnimplemented = "unimplemented"
	kindRemoved       = "removed"
	kindUncertain     = "uncertain"
)

var itemKinds = []string{kindAdded, kindChanged, kindUnimplemented, kindRemoved, kindUncertain}

// itemKindAlias 认中文写法，Claude Code 回报时写中文也行。
var itemKindAlias = map[string]string{"新增": kindAdded, "不一致": kindChanged, "未实现": kindUnimplemented, "已下线": kindRemoved,
	"不确定": kindUncertain, "拿不准": kindUncertain, "new": kindAdded, "mismatch": kindChanged, "offline": kindRemoved, "pending": kindUncertain}

var itemKindLabels = map[string]string{kindAdded: "新增", kindChanged: "不一致", kindUnimplemented: "未实现", kindRemoved: "已下线", kindUncertain: "不确定"}

// 规格的实现状态。
const (
	implImplemented   = "implemented"
	implUnimplemented = "unimplemented"
	implOffline       = "offline"
	implDeviation     = "deviation"
	implPending       = "pending"
)

// 人工裁决。
const (
	verdictDesign = "design"
	verdictDefect = "defect"
	verdictIgnore = "ignore"
)

var verdictLabels = map[string]string{verdictDesign: "当作新设计，按代码回写", verdictDefect: "当作缺陷，建修复任务", verdictIgnore: "暂不处理"}

// ProtoSyncItem 是差异清单的一项。
type ProtoSyncItem struct {
	Kind   string `json:"kind"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
	// Spec 是规格条目编号（SPEC-x-y），没有为空串；Page 是原型页面或路由
	Spec string `json:"spec"`
	Page string `json:"page"`
	// Status 是规格的实现状态：implemented / unimplemented / offline / deviation / pending
	Status string `json:"status"`
	// Decision 只有 uncertain 有：'' 待裁决 / design / defect / ignore
	Decision string `json:"decision"`
}

// ProtoSyncCounts 是差异清单按分类的条数。
type ProtoSyncCounts struct {
	Added         int `json:"added"`
	Changed       int `json:"changed"`
	Unimplemented int `json:"unimplemented"`
	Removed       int `json:"removed"`
	Uncertain     int `json:"uncertain"`
	// Pending 是还没裁决的不确定项
	Pending int `json:"pending"`
}

// ProtoSync 是一次原型同步。
type ProtoSync struct {
	ID          string          `json:"id"`
	ProjectID   string          `json:"project_id"`
	Trigger     string          `json:"trigger"`
	TriggerRef  string          `json:"trigger_ref"`
	Status      string          `json:"status"`
	CodeDir     string          `json:"code_dir"`
	CodeBranch  string          `json:"code_branch"`
	BaseCommit  string          `json:"base_commit"`
	HeadCommit  string          `json:"head_commit"`
	Files       []string        `json:"files"`
	DiffStat    string          `json:"diff_stat"`
	UIChanged   bool            `json:"ui_changed"`
	ProtoDir    string          `json:"proto_dir"`
	ProtoRepo   string          `json:"proto_repo"`
	ProtoBranch string          `json:"proto_branch"`
	ProtoBase   string          `json:"proto_base"`
	ProtoCommit string          `json:"proto_commit"`
	ProtoPath   string          `json:"proto_path"`
	Items       []ProtoSyncItem `json:"items"`
	Counts      ProtoSyncCounts `json:"counts"`
	Decision    string          `json:"decision"`
	DecidedAt   *time.Time      `json:"decided_at"`
	FixTaskID   string          `json:"fix_task_id"`
	Summary     string          `json:"summary"`
	RunDir      string          `json:"run_dir"`
	DiffPath    string          `json:"diff_path"`
	RunID       string          `json:"run_id"`
	SOPRunID    string          `json:"sop_run_id"`
	Error       string          `json:"error"`
	StartedAt   time.Time       `json:"started_at"`
	FinishedAt  *time.Time      `json:"finished_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
	sopKey      string
}

// ProtoSyncSettings 是一个项目的触发开关，默认都关。
type ProtoSyncSettings struct {
	OnRelease bool `json:"on_release"`
	OnMerge   bool `json:"on_merge"`
	Daily     bool `json:"daily"`
	// DailyAt 是每日巡检的时间（本机时间 HH:MM），默认 09:00
	DailyAt string `json:"daily_at"`
	// Branch 是生产分支，空串时依次认 main、master、代码库当前检出的分支
	Branch    string     `json:"branch"`
	UpdatedAt *time.Time `json:"updated_at"`
}

// SyncPoint 是同步点：最近一次同步到的代码提交，和它对应的那次同步、原型同步分支的提交。
type SyncPoint struct {
	Commit      string    `json:"commit"`
	SyncID      string    `json:"sync_id"`
	Status      string    `json:"status"`
	ProtoBranch string    `json:"proto_branch"`
	ProtoCommit string    `json:"proto_commit"`
	At          time.Time `json:"at"`
}

// ProtoSyncState 是项目的原型同步概况：开关、生效的生产分支和当前 HEAD、同步点、最近一次、进行中的那次。
type ProtoSyncState struct {
	ProjectID string            `json:"project_id"`
	Settings  ProtoSyncSettings `json:"settings"`
	Branch    string            `json:"branch"`
	Head      string            `json:"head"`
	// HeadError 是取不到 HEAD 的原因（代码库没设、不是 git 仓库、分支不存在），取到了为空串
	HeadError string     `json:"head_error"`
	Point     *SyncPoint `json:"point"`
	Last      *ProtoSync `json:"last"`
	Active    *ProtoSync `json:"active"`
}

type protoSyncService struct {
	c     plugin.Core
	mu    sync.Mutex
	now   func() time.Time
	start func(ctx context.Context, q plugin.SOPRunStart) (string, error)
}

// protoSyncEvery 是后台检查生产分支和每日巡检的间隔，测试里调小。
var protoSyncEvery = time.Minute

func newProtoSyncService(c plugin.Core) *protoSyncService {
	return &protoSyncService{c: c, now: time.Now, start: func(ctx context.Context, q plugin.SOPRunStart) (string, error) {
		return c.Runs().StartSOP(ctx, q)
	}}
}

func (s *protoSyncService) register(r plugin.Registrar, h *stakeholders) {
	r.Routes(func(m plugin.RouteRegistrar) {
		api := &protoSyncAPI{h, s}
		m.HandleFunc("GET /api/projects/{id}/proto-sync", api.state)
		m.HandleFunc("PATCH /api/projects/{id}/proto-sync", api.saveSettings)
		m.HandleFunc("GET /api/projects/{id}/proto-syncs", api.list)
		m.HandleFunc("POST /api/projects/{id}/proto-syncs", api.trigger)
		m.HandleFunc("GET /api/projects/proto-syncs/runs/{sync_id}", api.show)
		m.HandleFunc("POST /api/projects/proto-syncs/runs/{sync_id}/cancel", api.cancel)
	})
	for _, d := range []plugin.SOPNodeDef{
		{Kind: NodeProtoSyncRange, Group: "项目", Required: []plugin.SOPNodeField{}, Run: s.rangeNode},
		{Kind: NodeProtoSyncBranch, Group: "项目", Required: []plugin.SOPNodeField{}, Run: s.branchNode},
		{Kind: NodeProtoSyncClassify, Group: "项目", Required: []plugin.SOPNodeField{}, Run: s.classifyNode},
		{Kind: NodeProtoSyncVerdict, Group: "项目", Required: []plugin.SOPNodeField{{Key: "decision", Label: "裁决"}}, Run: s.verdictNode},
		{Kind: NodeProtoSyncCommit, Group: "项目", Required: []plugin.SOPNodeField{}, Run: s.commitNode},
		{Kind: NodeProtoSyncRecord, Group: "项目", Required: []plugin.SOPNodeField{}, Run: s.recordNode},
	} {
		r.SOPNode(d)
	}
	r.Subscribe(plugin.RunFinishedEvent, s.onRunFinished)
	r.Job(plugin.Job{Name: "proto_sync_watch", Every: protoSyncEvery, Run: func(ctx context.Context, _ plugin.Core) error {
		s.watch(ctx)
		return nil
	}})
}

/* ---------- 触发 ---------- */

// Trigger 发起一次原型同步：建一行 running，再发起内置流程「原型同步」。每日巡检时 HEAD 没变只记一行 no_change。
// 同一项目有进行中的同步时 409；发起不了流程（SOP 插件没在跑、流程被删了）时这行记 failed 并回 409。
func (s *protoSyncService) Trigger(ctx context.Context, projectID, trigger, ref string) (ProtoSync, error) {
	if err := plugin.Require(s.c, "process:spawn"); err != nil {
		return ProtoSync{}, apiErr(errConflict, "%s", err.Error())
	}
	o, err := s.project(ctx, projectID)
	if err != nil {
		return ProtoSync{}, err
	}
	s.mu.Lock()
	ps, err := s.begin(ctx, o, trigger, ref, "")
	s.mu.Unlock()
	if err != nil || ps.Status != psRunning {
		return ps, err
	}
	runID, err := s.start(ctx, plugin.SOPRunStart{Flow: ProtoSyncFlowID, ObjectID: o.ID,
		Input: map[string]any{"project_id": o.ID, "sync_id": ps.ID, "trigger": trigger}})
	if err != nil {
		ps.Status, ps.Error = psFailed, "原型同步流程没发起："+apiMessage(err)+"（流程「原型同步」由 IM 插件写进 SOP，要装着 SOP 编排插件）"
		s.finish(ctx, &ps)
		return ps, apiErr(errConflict, "%s", ps.Error)
	}
	ps.RunID = runID
	s.touch(ctx, &ps)
	return ps, nil
}

// begin 建一行：取代码库、生产分支和 HEAD，挡同一项目进行中的同步。sopKey 非空表示从 SOP 里直接发起（取同步范围节点建的）。
// 调用方持有 s.mu。
func (s *protoSyncService) begin(ctx context.Context, o plugin.ObjectInfo, trigger, ref, sopKey string) (ProtoSync, error) {
	if act, err := s.activeOf(ctx, o.ID); err == nil {
		if act.Status == psRunning && s.now().Sub(act.UpdatedAt) > protoSyncStale {
			act.Status, act.Error = psFailed, "超过 48 小时没有进展，当作中断"
			s.finish(ctx, &act)
		} else {
			return ProtoSync{}, apiErr(errConflict, "项目 %s 有一次原型同步还没结束（%s，%s）：等它结束，或者先作废", o.Title, act.ID, protoSyncStatusLabel(act.Status))
		}
	} else if !errors.Is(err, plugin.ErrNoRows) {
		return ProtoSync{}, err
	}
	codeDir, branch, head, err := s.codeHead(ctx, o)
	if err != nil {
		return ProtoSync{}, err
	}
	point, err := s.point(ctx, o.ID)
	if err != nil {
		return ProtoSync{}, err
	}
	now := s.now().UTC()
	ps := ProtoSync{ID: idgen.Prefixed("psy"), ProjectID: o.ID, Trigger: trigger, TriggerRef: ref, Status: psRunning, CodeDir: codeDir, CodeBranch: branch,
		HeadCommit: head, Files: []string{}, Items: []ProtoSyncItem{}, StartedAt: now, UpdatedAt: now, sopKey: sopKey}
	if point != nil {
		ps.BaseCommit = point.Commit
	}
	switch {
	case trigger == trigBaseline:
		ps.Status, ps.Summary = psBaseline, "设为基线：把当前 HEAD 记成同步点，不对比"
		ps.FinishedAt = &now
	case trigger == trigDaily && point != nil && point.Commit == head:
		ps.Status, ps.Summary = psNoChange, "每日巡检：生产分支自上次同步后没有新提交"
		ps.FinishedAt = &now
	}
	if base := s.c.WorktreeDir(); base != "" {
		ps.RunDir = filepath.Join(filepath.Dir(base), ProtoSyncsSubdir, safeSeg(o.ID), ps.ID)
	}
	if _, err := s.c.Store().Exec(ctx, `INSERT INTO projects_proto_syncs (id, project_id, trigger_kind, trigger_ref, status, code_dir, code_branch,
		base_commit, head_commit, summary, run_dir, sop_key, started_at, finished_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ps.ID, ps.ProjectID, ps.Trigger, ps.TriggerRef, ps.Status, ps.CodeDir, ps.CodeBranch, ps.BaseCommit, ps.HeadCommit, ps.Summary, ps.RunDir,
		ps.sopKey, now.Format(time.RFC3339), timeCol(ps.FinishedAt), now.Format(time.RFC3339)); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return ProtoSync{}, apiErr(errConflict, "项目 %s 有一次原型同步还没结束：等它结束，或者先作废", o.Title)
		}
		return ProtoSync{}, err
	}
	s.publish(ps)
	return ps, nil
}

// onReleased 是发布记录变成 released 时的回调（release.go 接上）：项目开了「发布成功后同步」就发起。
func (s *protoSyncService) onReleased(r Release) {
	ctx := context.Background()
	st, err := s.settings(ctx, r.ProjectID)
	if err != nil || !st.OnRelease {
		return
	}
	if _, err := s.Trigger(ctx, r.ProjectID, trigRelease, r.ID); err != nil {
		s.c.Log().Info("proto sync on release skipped", "project", r.ProjectID, "release", r.ID, "err", err)
	}
}

// watch 是后台检查：开了「生产分支合并后同步」的看 HEAD 变没变；开了「每日巡检」的到点巡检一次。
func (s *protoSyncService) watch(ctx context.Context) {
	if !s.c.Granted("process:spawn") {
		return
	}
	rows, err := s.c.Store().Query(ctx, `SELECT project_id, on_merge, daily, daily_at, branch FROM projects_proto_sync_settings WHERE on_merge = 1 OR daily = 1`)
	if err != nil {
		s.c.Log().Warn("proto sync watch failed", "err", err)
		return
	}
	type row struct {
		pid           string
		merge, daily  bool
		dailyAt, brch string
	}
	var list []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.pid, &x.merge, &x.daily, &x.dailyAt, &x.brch); err == nil {
			list = append(list, x)
		}
	}
	_ = rows.Close()
	for _, x := range list {
		if ctx.Err() != nil {
			return
		}
		o, err := s.project(ctx, x.pid)
		if err != nil {
			continue
		}
		if x.daily && s.dailyDue(ctx, x.pid, x.dailyAt) {
			if _, err := s.Trigger(ctx, x.pid, trigDaily, s.now().Format("2006-01-02")); err != nil {
				s.c.Log().Info("proto sync daily skipped", "project", x.pid, "err", err)
			}
			continue
		}
		if !x.merge {
			continue
		}
		_, _, head, err := s.codeHead(ctx, o)
		if err != nil {
			continue
		}
		if s.seenHead(ctx, x.pid, head) {
			continue
		}
		if _, err := s.Trigger(ctx, x.pid, trigMerge, head); err != nil {
			s.c.Log().Info("proto sync on merge skipped", "project", x.pid, "err", err)
		}
	}
}

// dailyDue：到了巡检时间、今天（本机日期）还没巡检过、也没有进行中的同步。
func (s *protoSyncService) dailyDue(ctx context.Context, pid, at string) bool {
	now := s.now().Local()
	hh, mm, ok := parseClock(at)
	if !ok || now.Hour()*60+now.Minute() < hh*60+mm {
		return false
	}
	if _, err := s.activeOf(ctx, pid); err == nil {
		return false
	}
	var n int
	if err := s.c.Store().QueryRow(ctx, `SELECT count(*) FROM projects_proto_syncs WHERE project_id = ? AND trigger_kind = ? AND trigger_ref = ?`,
		pid, trigDaily, now.Format("2006-01-02")).Scan(&n); err != nil {
		return false
	}
	return n == 0
}

// seenHead：这个 HEAD 已经是同步点，或者最近一次同步（不管成没成、作没作废）就是冲着它去的，或者有进行中的同步。
// 同步没成功、被作废的不按同一个 HEAD 反复发起，等下一次提交或者手动重来。
func (s *protoSyncService) seenHead(ctx context.Context, pid, head string) bool {
	if _, err := s.activeOf(ctx, pid); err == nil {
		return true
	}
	var last string
	err := s.c.Store().QueryRow(ctx, `SELECT head_commit FROM projects_proto_syncs WHERE project_id = ?
		ORDER BY started_at DESC, rowid DESC LIMIT 1`, pid).Scan(&last)
	if err == nil && last == head {
		return true
	}
	p, err := s.point(ctx, pid)
	return err == nil && p != nil && p.Commit == head
}

// onRunFinished：本插件发起的「原型同步」执行结束了，这次同步还没收尾（流程没走到记同步点）就记 failed。
func (s *protoSyncService) onRunFinished(ctx context.Context, _ plugin.Core, ev plugin.Event) error {
	var p struct {
		RunID  string `json:"run_id"`
		Kind   string `json:"kind"`
		Ref    string `json:"ref"`
		Status string `json:"status"`
		OK     bool   `json:"ok"`
	}
	if err := json.Unmarshal(ev.Payload, &p); err != nil || p.Kind != plugin.RunKindSOP {
		return nil
	}
	ps, err := s.scanOne(ctx, `WHERE (run_id = ? AND run_id <> '') OR (sop_run_id = ? AND sop_run_id <> '') ORDER BY started_at DESC LIMIT 1`, p.RunID, p.Ref)
	if err != nil || (ps.Status != psRunning && ps.Status != psReviewing) {
		return nil
	}
	ps.Status = psFailed
	ps.Error = "原型同步流程没走完（执行 " + firstNonEmpty(p.Status, "结束") + "），同步点没动；到 SOP 执行页看是哪一步，修好后重试那一步或重新发起"
	s.finish(ctx, &ps)
	return nil
}

/* ---------- SOP 节点 ---------- */

// rangeNode 取同步范围：config.sync 默认 {{sync_id}}，config.project 默认 {{project_id}}；没有 sync_id 时（SOP 页直接发起）自己建一行。
func (s *protoSyncService) rangeNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	id := strings.TrimSpace(render(firstNonEmpty(n.Config["sync"], "{{sync_id}}"), n.Input))
	var ps ProtoSync
	var err error
	if id != "" {
		ps, err = s.get(ctx, id)
		if err != nil {
			return nil, fmt.Errorf("原型同步 %s 不存在", id)
		}
		if ps.Status != psRunning && ps.Status != psReviewing {
			return nil, fmt.Errorf("这次原型同步已经%s，不能再取范围：重新发起一次", protoSyncStatusLabel(ps.Status))
		}
	} else {
		key := strings.TrimSpace(render(firstNonEmpty(n.Config["project"], "{{project_id}}"), n.Input))
		if key == "" {
			return nil, errors.New("没有指定项目：在输入里填 project_id，或者在「项目」里填 {{字段}}")
		}
		o, ferr := s.c.Objects().Find(ctx, "project", key)
		if ferr != nil {
			return nil, fmt.Errorf("项目「%s」不存在：填项目 id、编号或名字", key)
		}
		if err := plugin.Require(s.c, "process:spawn"); err != nil {
			return nil, err
		}
		wk := fmt.Sprintf("%s/%s#%d", n.RunID, n.Step, n.Attempt)
		ps, err = s.scanOne(ctx, `WHERE sop_key = ?`, wk)
		if errors.Is(err, plugin.ErrNoRows) {
			trig := strings.TrimSpace(render(firstNonEmpty(n.Config["trigger"], "{{trigger}}"), n.Input))
			if !slices.Contains([]string{trigRelease, trigMerge, trigDaily}, trig) {
				trig = trigManual
			}
			s.mu.Lock()
			ps, err = s.begin(ctx, o, trig, "", wk)
			s.mu.Unlock()
		}
		if err != nil {
			return nil, errors.New(apiMessage(err))
		}
	}
	ps.SOPRunID = n.RunID
	if err := s.computeRange(ctx, &ps); err != nil {
		ps.Error = err.Error()
		s.touch(ctx, &ps)
		return nil, err
	}
	ps.Error = ""
	s.touch(ctx, &ps)
	return with(n.Input, map[string]any{"sync": s.sopOutput(ps)}), nil
}

// computeRange 算 base → head 的改动：文件、diff --stat、diff.patch（写进 run_dir），有没有涉及界面或接口的改动。
// base 为空（首次同步）或在代码库里找不到时对比整个代码库。
func (s *protoSyncService) computeRange(ctx context.Context, ps *ProtoSync) error {
	if ps.CodeDir == "" || ps.HeadCommit == "" {
		return errors.New("这次同步没有代码库或 HEAD")
	}
	full := ps.BaseCommit == ""
	note := ""
	if !full {
		if _, err := git(ctx, ps.CodeDir, "cat-file", "-e", ps.BaseCommit+"^{commit}"); err != nil {
			full, note = true, "上次同步点 "+short(ps.BaseCommit)+" 在代码库里找不到了（可能改写过历史），这次对比整个代码库"
		}
	}
	var files []string
	switch {
	case full:
		out, err := git(ctx, ps.CodeDir, "ls-tree", "-r", "--name-only", ps.HeadCommit)
		if err != nil {
			return fmt.Errorf("列不出代码库的文件：%s", err.Error())
		}
		files = splitLines(out)
		ps.DiffStat = firstNonEmpty(note, "首次同步：没有上次同步点，对比整个代码库（"+strconv.Itoa(len(files))+" 个文件）")
		ps.UIChanged = len(files) > 0
	case ps.BaseCommit == ps.HeadCommit:
		ps.DiffStat, ps.UIChanged = "自上次同步后没有新提交", false
	default:
		out, err := git(ctx, ps.CodeDir, "diff", "--name-only", ps.BaseCommit, ps.HeadCommit)
		if err != nil {
			return fmt.Errorf("取代码 diff 没成：%s", err.Error())
		}
		files = splitLines(out)
		stat, _ := git(ctx, ps.CodeDir, "diff", "--stat=120", ps.BaseCommit, ps.HeadCommit)
		ps.DiffStat = lastLines(stat, 40)
		ps.UIChanged = slices.ContainsFunc(files, touchesUI)
	}
	if len(files) > maxSyncFiles {
		files = files[:maxSyncFiles]
	}
	ps.Files = orEmptyStrs(files)
	if ps.RunDir != "" && !full && ps.BaseCommit != ps.HeadCommit {
		if err := os.MkdirAll(ps.RunDir, 0o755); err == nil {
			if patch, err := gitRaw(ctx, ps.CodeDir, maxDiffBytes, "diff", ps.BaseCommit, ps.HeadCommit); err == nil {
				_ = os.WriteFile(filepath.Join(ps.RunDir, "diff.patch"), patch, 0o644)
			}
		}
	}
	return nil
}

// touchesUI：这个文件的改动算不算涉及界面或接口。测试、文档、锁文件、CI 配置不算，其余都算（宁可多看一次）。
func touchesUI(f string) bool {
	low := strings.ToLower(f)
	base := filepath.Base(low)
	switch {
	case strings.HasSuffix(low, ".md"), strings.HasPrefix(low, "docs/"), strings.Contains(low, "/testdata/"), strings.HasPrefix(low, "testdata/"),
		strings.HasPrefix(low, ".github/"), strings.HasSuffix(low, "_test.go"), strings.Contains(base, ".test."), strings.Contains(base, ".spec."),
		strings.Contains(low, "__tests__/"), strings.HasPrefix(low, "e2e/"), strings.HasPrefix(low, "tests/"):
		return false
	}
	switch base {
	case "go.sum", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "uv.lock", "poetry.lock", ".gitignore", "license":
		return false
	}
	return true
}

// branchNode 准备原型同步分支：config.sync 默认 {{sync.id}}。在原型库所在的 git 仓库拉 proto-sync/<日期> 分支的 worktree，
// 起点是原型库当前检出的提交，不切换、不改原型库主目录。同一次同步重跑时复用已有的 worktree。
func (s *protoSyncService) branchNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	ps, err := s.fromInput(ctx, n)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	err = s.prepareBranch(ctx, &ps)
	s.mu.Unlock()
	if err != nil {
		ps.Error = err.Error()
		s.touch(ctx, &ps)
		return nil, err
	}
	s.touch(ctx, &ps)
	return with(n.Input, map[string]any{"sync": s.sopOutput(ps)}), nil
}

func (s *protoSyncService) prepareBranch(ctx context.Context, ps *ProtoSync) error {
	if ps.ProtoBranch != "" && ps.ProtoPath != "" {
		root := strings.TrimSuffix(ps.ProtoPath, string(filepath.Separator))
		if top, err := git(ctx, root, "rev-parse", "--show-toplevel"); err == nil && isWorktreeOn(ctx, top, ps.ProtoBranch) {
			return nil
		}
	}
	base := s.c.WorktreeDir()
	if base == "" {
		return errors.New("工作台没有数据目录，建不了原型同步分支")
	}
	o, err := s.project(ctx, ps.ProjectID)
	if err != nil {
		return errors.New(apiMessage(err))
	}
	p, err := (&profiles{&stakeholders{c: s.c}}).load(ctx, o)
	if err != nil {
		return err
	}
	proto := firstDir(p.ProtoDir, p.PRDDir, firstDir(p.CodeDir, o.Workdir))
	if proto == "" {
		return errors.New("项目档案里没有原型库目录：先到项目的档案里填「原型库目录」")
	}
	if dirState(proto).State != "ok" {
		return fmt.Errorf("原型库目录 %s 不存在", proto)
	}
	top, err := git(ctx, proto, "rev-parse", "--show-toplevel")
	if err != nil {
		return fmt.Errorf("原型库目录 %s 不在 git 仓库里：同步要提交到原型库的分支，先在原型库 git init", proto)
	}
	rp, _ := filepath.EvalSymlinks(proto)
	rt, _ := filepath.EvalSymlinks(top)
	sub, err := filepath.Rel(rt, rp)
	if err != nil || strings.HasPrefix(sub, "..") {
		sub = "."
	}
	head, err := git(ctx, top, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return fmt.Errorf("原型库 %s 还没有提交，拉不了同步分支", top)
	}
	day := s.now().Local().Format("20060102")
	branch := ""
	for i := 1; i <= 50; i++ {
		b := ProtoSyncBranchPrefix + day
		if i > 1 {
			b += "-" + strconv.Itoa(i)
		}
		if _, err := git(ctx, top, "rev-parse", "--verify", "--quiet", "refs/heads/"+b); err != nil {
			branch = b
			break
		}
	}
	if branch == "" {
		return fmt.Errorf("今天的原型同步分支已经有 50 个了，先合并或删掉一些")
	}
	root := filepath.Join(base, safeSeg(ps.ProjectID), "proto-sync-"+ps.ID)
	_, _ = git(ctx, top, "worktree", "prune")
	if err := clearTarget(root); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(root), 0o755); err != nil {
		return err
	}
	if _, err := git(ctx, top, "worktree", "add", "-b", branch, root, head); err != nil {
		return fmt.Errorf("拉原型同步分支没成：%s", err.Error())
	}
	ps.ProtoDir, ps.ProtoRepo, ps.ProtoBranch, ps.ProtoBase = proto, top, branch, head
	ps.ProtoPath = filepath.Join(root, sub)
	return nil
}

// classifyNode 登记差异：读输入里 Claude Code 回报的 result（config.result 可以换字段），
// 认 result.items（[{kind, title, detail, spec, page}]），没有 items 时 synced 记成不一致、pending 记成不确定。
// 有不确定项时这次同步转 reviewing（等产品裁决），输出 sync.has_pending。
func (s *protoSyncService) classifyNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	ps, err := s.fromInput(ctx, n)
	if err != nil {
		return nil, err
	}
	res, _ := getPath(n.Input, firstNonEmpty(n.Config["result"], "result")).(map[string]any)
	ps.Items = parseItems(res)
	if sm := strings.TrimSpace(txt(n.Input["summary"])); sm != "" {
		ps.Summary = oneLine(sm, 2000)
	}
	ps.Counts = countItems(ps.Items)
	if ps.Counts.Pending > 0 {
		ps.Status = psReviewing
	} else if ps.Status == psReviewing {
		ps.Status = psRunning
	}
	s.touch(ctx, &ps)
	return with(n.Input, map[string]any{"sync": s.sopOutput(ps)}), nil
}

// parseItems 把 Claude Code 的回报整理成差异清单：分类认英文和中文，认不出的当不确定；最多 300 条。
func parseItems(res map[string]any) []ProtoSyncItem {
	out := []ProtoSyncItem{}
	add := func(m map[string]any, kind string) {
		if len(out) >= maxSyncItems {
			return
		}
		it := ProtoSyncItem{Kind: normKind(firstNonEmpty(txt(m["kind"]), kind)), Title: oneLine(txt(m["title"]), 200),
			Detail: clipRunes(strings.TrimSpace(txt(m["detail"])), 2000), Spec: oneLine(txt(m["spec"]), 60), Page: oneLine(txt(m["page"]), 200)}
		if it.Title == "" {
			it.Title = oneLine(firstNonEmpty(it.Detail, it.Spec, it.Page), 200)
		}
		if it.Title == "" {
			return
		}
		it.Status = implOf(it.Kind, "")
		out = append(out, it)
	}
	if res == nil {
		return out
	}
	if list, ok := res["items"].([]any); ok {
		for _, x := range list {
			switch v := x.(type) {
			case map[string]any:
				add(v, "")
			case string:
				add(map[string]any{"title": v}, kindUncertain)
			}
		}
		return out
	}
	for _, f := range []struct{ key, kind string }{{"synced", kindChanged}, {"pending", kindUncertain}} {
		list, _ := res[f.key].([]any)
		for _, x := range list {
			switch v := x.(type) {
			case map[string]any:
				add(v, f.kind)
			case string:
				add(map[string]any{"title": v}, f.kind)
			}
		}
	}
	return out
}

func normKind(k string) string {
	k = strings.TrimSpace(strings.ToLower(k))
	if slices.Contains(itemKinds, k) {
		return k
	}
	if v, ok := itemKindAlias[k]; ok {
		return v
	}
	return kindUncertain
}

// implOf 是一项差异落到规格上的实现状态。
func implOf(kind, decision string) string {
	switch kind {
	case kindAdded, kindChanged:
		return implImplemented
	case kindUnimplemented:
		return implUnimplemented
	case kindRemoved:
		return implOffline
	}
	switch decision {
	case verdictDesign:
		return implImplemented
	case verdictDefect:
		return implDeviation
	}
	return implPending
}

func countItems(items []ProtoSyncItem) ProtoSyncCounts {
	var c ProtoSyncCounts
	for _, it := range items {
		switch it.Kind {
		case kindAdded:
			c.Added++
		case kindChanged:
			c.Changed++
		case kindUnimplemented:
			c.Unimplemented++
		case kindRemoved:
			c.Removed++
		case kindUncertain:
			c.Uncertain++
			if it.Decision == "" {
				c.Pending++
			}
		}
	}
	return c
}

// verdictNode 记人工裁决：config.decision 是 design / defect / ignore（也认 新设计 / 缺陷 / 暂不处理），改所有还没裁决的不确定项。
// defect 时给项目建一条修复任务（正文是这些差异），同一次尝试重跑按写入键取回，不重复建。
func (s *protoSyncService) verdictNode(ctx context.Context, c plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	d := strings.TrimSpace(render(n.Config["decision"], n.Input))
	switch d {
	case "新设计", "当作新设计":
		d = verdictDesign
	case "缺陷", "当作缺陷":
		d = verdictDefect
	case "暂不处理", "忽略":
		d = verdictIgnore
	}
	if _, ok := verdictLabels[d]; !ok {
		return nil, fmt.Errorf("裁决「%s」不认，只能是 design（当作新设计）、defect（当作缺陷）、ignore（暂不处理）", d)
	}
	ps, err := s.fromInput(ctx, n)
	if err != nil {
		return nil, err
	}
	var pending []ProtoSyncItem
	for i := range ps.Items {
		if it := &ps.Items[i]; it.Kind == kindUncertain && it.Decision == "" {
			it.Decision, it.Status = d, implOf(kindUncertain, d)
			pending = append(pending, *it)
		}
	}
	now := s.now().UTC()
	ps.Decision, ps.DecidedAt = d, &now
	if d == verdictDefect && len(pending) > 0 && ps.FixTaskID == "" {
		o, err := s.project(ctx, ps.ProjectID)
		if err != nil {
			return nil, errors.New(apiMessage(err))
		}
		var b strings.Builder
		fmt.Fprintf(&b, "原型同步（%s）对比上线代码 %s 时发现下面这些和原型、规格不一致，产品裁决为实现缺陷：以原型和规格为准修代码。\n\n", ps.ID, short(ps.HeadCommit))
		for _, it := range pending {
			fmt.Fprintf(&b, "- %s", it.Title)
			if it.Spec != "" {
				fmt.Fprintf(&b, "（%s）", it.Spec)
			}
			if it.Detail != "" {
				fmt.Fprintf(&b, "：%s", oneLine(it.Detail, 300))
			}
			b.WriteString("\n")
		}
		pid := ps.ProjectID
		task, err := c.ObjectWriter().CreateAs(ctx, plugin.NewObject{TypeID: "task", Title: clipRunes("修复：原型同步发现的实现偏差（"+o.Title+"）", 200),
			Body: b.String(), ProjectID: &pid, Props: map[string]any{"proto_sync_id": ps.ID}},
			plugin.WriteMeta{Session: n.RunID, Key: fmt.Sprintf("%s/%s#%d", n.RunID, n.Step, n.Attempt), Detail: map[string]any{"run_id": n.RunID, "step": n.Step, "proto_sync_id": ps.ID}})
		if err != nil {
			return nil, fmt.Errorf("建修复任务没成：%w", err)
		}
		ps.FixTaskID = task.ID
	}
	ps.Counts = countItems(ps.Items)
	if ps.Status == psReviewing {
		ps.Status = psRunning
	}
	s.touch(ctx, &ps)
	return with(n.Input, map[string]any{"sync": s.sopOutput(ps)}), nil
}

// commitNode 提交同步分支：在同步分支的 worktree 里把没提交的改动提交掉（Claude Code 自己提交过的不动），
// 当前分支不是 proto-sync/ 开头的拒绝：只提交到同步分支，不碰原型库的主分支。不推送、不合并。
func (s *protoSyncService) commitNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	ps, err := s.fromInput(ctx, n)
	if err != nil {
		return nil, err
	}
	if err := s.commit(ctx, &ps); err != nil {
		ps.Error = err.Error()
		s.touch(ctx, &ps)
		return nil, err
	}
	s.touch(ctx, &ps)
	return with(n.Input, map[string]any{"sync": s.sopOutput(ps)}), nil
}

func (s *protoSyncService) commit(ctx context.Context, ps *ProtoSync) error {
	if ps.ProtoPath == "" || ps.ProtoBranch == "" {
		return errors.New("还没有准备原型同步分支：接在「准备原型同步分支」后面")
	}
	root, err := git(ctx, ps.ProtoPath, "rev-parse", "--show-toplevel")
	if err != nil {
		return fmt.Errorf("原型同步分支的目录 %s 不在了：重新发起一次同步", ps.ProtoPath)
	}
	cur, err := git(ctx, root, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || !strings.HasPrefix(cur, ProtoSyncBranchPrefix) || cur != ps.ProtoBranch {
		return fmt.Errorf("原型同步分支的目录现在检出的是「%s」，不是 %s：只提交到原型同步分支，这次不提交", firstNonEmpty(cur, "分离头指针"), ps.ProtoBranch)
	}
	if _, err := git(ctx, root, "add", "-A"); err != nil {
		return fmt.Errorf("暂存改动没成：%s", err.Error())
	}
	if _, err := git(ctx, root, "diff", "--cached", "--quiet"); err != nil {
		args := []string{}
		if name, _ := git(ctx, root, "config", "user.email"); name == "" {
			args = append(args, "-c", "user.name=pm-workspace", "-c", "user.email=pm-workspace@localhost")
		}
		msg := fmt.Sprintf("proto-sync: 按上线代码 %s 回写原型和规格（%s）", short(ps.HeadCommit), ps.ID)
		if _, err := git(ctx, root, append(args, "commit", "-q", "--no-verify", "-m", msg)...); err != nil {
			return fmt.Errorf("提交到原型同步分支没成：%s", err.Error())
		}
	}
	head, err := git(ctx, root, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	if head == ps.ProtoBase {
		ps.ProtoCommit = ""
	} else {
		ps.ProtoCommit = head
	}
	return nil
}

// recordNode 记同步点：config.outcome 为 no_change 时记「没有涉及界面或接口的改动」，否则记已同步。
// 这次的代码 HEAD 成为同步点，和同步分支的提交对应起来；删掉同步分支的 worktree（分支保留，原型没改时连分支一起删）。
func (s *protoSyncService) recordNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	ps, err := s.fromInput(ctx, n)
	if err != nil {
		return nil, err
	}
	if ps.Status != psRunning && ps.Status != psReviewing {
		// 重跑：已经记过了，原样回
		return with(n.Input, map[string]any{"sync": s.sopOutput(ps)}), nil
	}
	if ps.Counts.Pending > 0 {
		return nil, fmt.Errorf("还有 %d 条拿不准的差异没裁决：接在「产品裁决」后面", ps.Counts.Pending)
	}
	ps.Status = psDone
	if strings.TrimSpace(render(n.Config["outcome"], n.Input)) == psNoChange || !ps.UIChanged {
		ps.Status = psNoChange
		if ps.Summary == "" {
			ps.Summary = "没有涉及界面或接口的改动，只把同步点前移到 " + short(ps.HeadCommit)
		}
	}
	s.dropWorktree(ctx, &ps)
	ps.Error = ""
	s.finish(ctx, &ps)
	return with(n.Input, map[string]any{"sync": s.sopOutput(ps)}), nil
}

// dropWorktree 删掉同步分支的 worktree；原型没改（没有新提交）时连空分支一起删。删不掉只记日志。
func (s *protoSyncService) dropWorktree(ctx context.Context, ps *ProtoSync) {
	if ps.ProtoRepo == "" || ps.ProtoPath == "" {
		return
	}
	root, err := git(ctx, ps.ProtoPath, "rev-parse", "--show-toplevel")
	if err == nil {
		if _, err := git(ctx, ps.ProtoRepo, "worktree", "remove", "--force", root); err != nil {
			s.c.Log().Warn("remove proto sync worktree failed", "sync", ps.ID, "err", err)
		}
	}
	_, _ = git(ctx, ps.ProtoRepo, "worktree", "prune")
	if ps.ProtoCommit == "" && ps.ProtoBranch != "" && ps.ProtoBase != "" {
		// 分支上没有新提交（还在起点）才删，有提交的留着
		if tip, err := git(ctx, ps.ProtoRepo, "rev-parse", "--verify", "--quiet", "refs/heads/"+ps.ProtoBranch); err == nil && tip == ps.ProtoBase {
			if _, err := git(ctx, ps.ProtoRepo, "branch", "-D", ps.ProtoBranch); err == nil {
				ps.ProtoBranch = ""
			}
		}
	}
}

// fromInput 取输入里这次同步：config.sync 默认 {{sync.id}}，再退到 {{sync_id}}。
func (s *protoSyncService) fromInput(ctx context.Context, n plugin.SOPNodeInput) (ProtoSync, error) {
	id := strings.TrimSpace(render(firstNonEmpty(n.Config["sync"], "{{sync.id}}"), n.Input))
	if id == "" {
		id = strings.TrimSpace(txt(n.Input["sync_id"]))
	}
	if id == "" {
		return ProtoSync{}, errors.New("没有指定原型同步：接在「取同步范围」后面，或者在「同步」里填 {{sync.id}}")
	}
	ps, err := s.get(ctx, id)
	if err != nil {
		return ProtoSync{}, fmt.Errorf("原型同步 %s 不存在", id)
	}
	if ps.Status == psCancelled {
		return ProtoSync{}, errors.New("这次原型同步已经手动作废了")
	}
	if ps.SOPRunID == "" && n.RunID != "" {
		ps.SOPRunID = n.RunID
	}
	return ps, nil
}

// sopOutput 是节点输出里的 sync。text 是给通知用的一句话，items_text、pending_text 是差异清单、待裁决清单（每项一行）。
func (s *protoSyncService) sopOutput(ps ProtoSync) map[string]any {
	items := make([]any, 0, len(ps.Items))
	for _, it := range ps.Items {
		items = append(items, map[string]any{"kind": it.Kind, "title": it.Title, "detail": it.Detail, "spec": it.Spec, "page": it.Page,
			"status": it.Status, "decision": it.Decision})
	}
	files := ps.Files
	if len(files) > 200 {
		files = files[:200]
	}
	full := ps.BaseCommit == "" || strings.Contains(ps.DiffStat, "对比整个代码库")
	diffPath := ""
	if ps.RunDir != "" {
		if p := filepath.Join(ps.RunDir, "diff.patch"); fileExists(p) {
			diffPath = p
		}
	}
	return map[string]any{
		"id": ps.ID, "project_id": ps.ProjectID, "trigger": ps.Trigger, "status": ps.Status,
		"code_dir": ps.CodeDir, "branch": ps.CodeBranch, "base": ps.BaseCommit, "head": ps.HeadCommit,
		"base_short": firstNonEmpty(short(ps.BaseCommit), "（首次同步）"), "head_short": short(ps.HeadCommit),
		"files": anyStrs(files), "files_count": len(ps.Files), "diff_stat": ps.DiffStat, "diff_path": diffPath, "full": full,
		"changed":   ps.UIChanged,
		"proto_dir": ps.ProtoDir, "proto_repo": ps.ProtoRepo, "proto_branch": ps.ProtoBranch, "proto_base": ps.ProtoBase,
		"proto_commit": ps.ProtoCommit, "proto_path": ps.ProtoPath,
		"items": items, "counts": map[string]any{"added": ps.Counts.Added, "changed": ps.Counts.Changed, "unimplemented": ps.Counts.Unimplemented,
			"removed": ps.Counts.Removed, "uncertain": ps.Counts.Uncertain, "pending": ps.Counts.Pending},
		"has_pending": ps.Counts.Pending > 0, "decision": ps.Decision, "fix_task_id": ps.FixTaskID,
		"items_text": itemsText(ps.Items, false), "pending_text": itemsText(ps.Items, true), "text": protoSyncText(ps),
	}
}

func itemsText(items []ProtoSyncItem, pendingOnly bool) string {
	var b strings.Builder
	for _, it := range items {
		if pendingOnly && !(it.Kind == kindUncertain && it.Decision == "") {
			continue
		}
		fmt.Fprintf(&b, "- [%s] %s", itemKindLabels[it.Kind], it.Title)
		if it.Spec != "" {
			fmt.Fprintf(&b, "（%s）", it.Spec)
		}
		if it.Detail != "" {
			fmt.Fprintf(&b, "：%s", oneLine(it.Detail, 200))
		}
		if it.Decision != "" {
			fmt.Fprintf(&b, "（裁决：%s）", verdictLabels[it.Decision])
		}
		b.WriteString("\n")
	}
	if b.Len() == 0 {
		return "（没有）"
	}
	return strings.TrimRight(b.String(), "\n")
}

// protoSyncText 是一次同步的一句话。
func protoSyncText(ps ProtoSync) string {
	c := ps.Counts
	counts := fmt.Sprintf("新增 %d、不一致 %d、未实现 %d、已下线 %d、不确定 %d", c.Added, c.Changed, c.Unimplemented, c.Removed, c.Uncertain)
	rng := firstNonEmpty(short(ps.BaseCommit), "首次") + " → " + short(ps.HeadCommit)
	switch ps.Status {
	case psDone:
		s := "原型已按上线代码 " + rng + " 同步：" + counts
		if ps.Decision != "" {
			s += "；拿不准的裁决为「" + verdictLabels[ps.Decision] + "」"
		}
		if ps.ProtoCommit != "" {
			s += "。改动在原型库分支 " + ps.ProtoBranch + "（提交 " + short(ps.ProtoCommit) + "），看过差异清单后再合并"
		} else {
			s += "。原型和规格不用改"
		}
		return s
	case psNoChange:
		return "代码 " + rng + " 没有涉及界面或接口的改动，同步点前移到 " + short(ps.HeadCommit)
	case psBaseline:
		return "已把代码 " + short(ps.HeadCommit) + " 设为同步点"
	case psReviewing:
		return fmt.Sprintf("对比了代码 %s：%s，有 %d 条拿不准，等产品裁决", rng, counts, c.Pending)
	case psFailed:
		return "原型同步没成功：" + ps.Error
	case psCancelled:
		return "原型同步已手动作废"
	}
	return "正在对比代码 " + rng
}

/* ---------- 读写 ---------- */

const protoSyncCols = `id, project_id, trigger_kind, trigger_ref, status, code_dir, code_branch, base_commit, head_commit, files, diff_stat, ui_changed,
	proto_dir, proto_repo, proto_branch, proto_base, proto_commit, proto_path, items, decision, decided_at, fix_task_id, summary, run_dir,
	run_id, sop_run_id, sop_key, error, started_at, finished_at, updated_at`

func scanProtoSync(row plugin.Row) (ProtoSync, error) {
	var ps ProtoSync
	var files, items, started, updated string
	var decided, finished *string
	if err := row.Scan(&ps.ID, &ps.ProjectID, &ps.Trigger, &ps.TriggerRef, &ps.Status, &ps.CodeDir, &ps.CodeBranch, &ps.BaseCommit, &ps.HeadCommit,
		&files, &ps.DiffStat, &ps.UIChanged, &ps.ProtoDir, &ps.ProtoRepo, &ps.ProtoBranch, &ps.ProtoBase, &ps.ProtoCommit, &ps.ProtoPath, &items,
		&ps.Decision, &decided, &ps.FixTaskID, &ps.Summary, &ps.RunDir, &ps.RunID, &ps.SOPRunID, &ps.sopKey, &ps.Error, &started, &finished, &updated); err != nil {
		return ProtoSync{}, err
	}
	_ = json.Unmarshal([]byte(files), &ps.Files)
	_ = json.Unmarshal([]byte(items), &ps.Items)
	ps.Files = orEmptyStrs(ps.Files)
	if ps.Items == nil {
		ps.Items = []ProtoSyncItem{}
	}
	ps.Counts = countItems(ps.Items)
	ps.StartedAt, _ = time.Parse(time.RFC3339, started)
	ps.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	ps.DecidedAt, ps.FinishedAt = parseTimePtr(decided), parseTimePtr(finished)
	if ps.RunDir != "" {
		if p := filepath.Join(ps.RunDir, "diff.patch"); fileExists(p) {
			ps.DiffPath = p
		}
	}
	return ps, nil
}

func (s *protoSyncService) scanOne(ctx context.Context, where string, args ...any) (ProtoSync, error) {
	return scanProtoSync(s.c.Store().QueryRow(ctx, `SELECT `+protoSyncCols+` FROM projects_proto_syncs `+where, args...))
}

func (s *protoSyncService) get(ctx context.Context, id string) (ProtoSync, error) {
	ps, err := s.scanOne(ctx, `WHERE id = ?`, id)
	if errors.Is(err, plugin.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
		return ProtoSync{}, apiErr(errNotFound, "原型同步 %s 不存在", id)
	}
	return ps, err
}

func (s *protoSyncService) activeOf(ctx context.Context, pid string) (ProtoSync, error) {
	ps, err := s.scanOne(ctx, `WHERE project_id = ? AND status IN (?, ?) LIMIT 1`, pid, psRunning, psReviewing)
	if errors.Is(err, sql.ErrNoRows) {
		return ProtoSync{}, plugin.ErrNoRows
	}
	return ps, err
}

// point 是项目的同步点：最近一次 done / no_change / baseline，没有回 nil。
func (s *protoSyncService) point(ctx context.Context, pid string) (*SyncPoint, error) {
	ps, err := s.scanOne(ctx, `WHERE project_id = ? AND status IN (?, ?, ?) AND head_commit <> '' ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
		pid, psDone, psNoChange, psBaseline)
	if errors.Is(err, plugin.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	at := ps.UpdatedAt
	if ps.FinishedAt != nil {
		at = *ps.FinishedAt
	}
	return &SyncPoint{Commit: ps.HeadCommit, SyncID: ps.ID, Status: ps.Status, ProtoBranch: ps.ProtoBranch, ProtoCommit: ps.ProtoCommit, At: at}, nil
}

func (s *protoSyncService) list(ctx context.Context, pid string, limit int) ([]ProtoSync, error) {
	rows, err := s.c.Store().Query(ctx, `SELECT `+protoSyncCols+` FROM projects_proto_syncs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`, pid, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProtoSync{}
	for rows.Next() {
		ps, err := scanProtoSync(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ps)
	}
	return out, rows.Err()
}

// touch 写回进行中的这次（不改 finished_at），发事件。
func (s *protoSyncService) touch(ctx context.Context, ps *ProtoSync) {
	s.save(ctx, ps)
}

// finish 记结束时间再写回。
func (s *protoSyncService) finish(ctx context.Context, ps *ProtoSync) {
	now := s.now().UTC()
	ps.FinishedAt = &now
	s.save(ctx, ps)
}

func (s *protoSyncService) save(ctx context.Context, ps *ProtoSync) {
	now := s.now().UTC()
	ps.UpdatedAt = now
	ps.Counts = countItems(ps.Items)
	if _, err := s.c.Store().Exec(ctx, `UPDATE projects_proto_syncs SET status = ?, files = ?, diff_stat = ?, ui_changed = ?, proto_dir = ?, proto_repo = ?,
		proto_branch = ?, proto_base = ?, proto_commit = ?, proto_path = ?, items = ?, decision = ?, decided_at = ?, fix_task_id = ?, summary = ?,
		run_id = ?, sop_run_id = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
		ps.Status, encJSON(orEmptyStrs(ps.Files)), ps.DiffStat, boolInt(ps.UIChanged), ps.ProtoDir, ps.ProtoRepo, ps.ProtoBranch, ps.ProtoBase,
		ps.ProtoCommit, ps.ProtoPath, encJSON(orEmptyItems(ps.Items)), ps.Decision, timeCol(ps.DecidedAt), ps.FixTaskID, ps.Summary, ps.RunID,
		ps.SOPRunID, ps.Error, timeCol(ps.FinishedAt), now.Format(time.RFC3339), ps.ID); err != nil {
		s.c.Log().Warn("save proto sync failed", "sync", ps.ID, "err", err)
	}
	s.publish(*ps)
}

func (s *protoSyncService) publish(ps ProtoSync) {
	_ = s.c.Events().Publish(context.Background(), protoSyncChanged, map[string]any{"id": ps.ID, "project_id": ps.ProjectID,
		"status": ps.Status, "trigger": ps.Trigger})
}

func orEmptyItems(xs []ProtoSyncItem) []ProtoSyncItem {
	if xs == nil {
		return []ProtoSyncItem{}
	}
	return xs
}

/* ---------- 设置 ---------- */

func (s *protoSyncService) settings(ctx context.Context, pid string) (ProtoSyncSettings, error) {
	st := ProtoSyncSettings{DailyAt: "09:00"}
	var updated string
	err := s.c.Store().QueryRow(ctx, `SELECT on_release, on_merge, daily, daily_at, branch, updated_at FROM projects_proto_sync_settings WHERE project_id = ?`, pid).
		Scan(&st.OnRelease, &st.OnMerge, &st.Daily, &st.DailyAt, &st.Branch, &updated)
	if errors.Is(err, plugin.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if t, perr := time.Parse(time.RFC3339, updated); perr == nil {
		st.UpdatedAt = &t
	}
	return st, nil
}

var branchNameRe = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,100}$`)

func checkSettings(st ProtoSyncSettings) error {
	if _, _, ok := parseClock(st.DailyAt); !ok {
		return apiErr(errValidation, "daily_at: 巡检时间要写成 HH:MM（00:00 到 23:59）")
	}
	if st.Branch != "" && (!branchNameRe.MatchString(st.Branch) || strings.Contains(st.Branch, "..") || strings.HasPrefix(st.Branch, "-") ||
		strings.HasSuffix(st.Branch, "/") || strings.HasSuffix(st.Branch, ".lock")) {
		return apiErr(errValidation, "branch: 生产分支名不对：只能有字母、数字、点、下划线、斜杠、短横线，最多 100 个字符")
	}
	return nil
}

func parseClock(s string) (int, int, bool) {
	h, m, ok := strings.Cut(strings.TrimSpace(s), ":")
	if !ok || len(h) != 2 || len(m) != 2 {
		return 0, 0, false
	}
	hh, err1 := strconv.Atoi(h)
	mm, err2 := strconv.Atoi(m)
	if err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, 0, false
	}
	return hh, mm, true
}

/* ---------- 代码库 ---------- */

func (s *protoSyncService) project(ctx context.Context, id string) (plugin.ObjectInfo, error) {
	o, err := s.c.Objects().Get(ctx, strings.TrimSpace(id))
	if errors.Is(err, plugin.ErrNoRows) || (err == nil && (o.Type != "project" || o.Deleted)) {
		return plugin.ObjectInfo{}, apiErr(errNotFound, "project not found")
	}
	return o, err
}

// codeHead 取项目代码库（档案的代码库目录，没设用项目目录）、生效的生产分支和它的 HEAD。
func (s *protoSyncService) codeHead(ctx context.Context, o plugin.ObjectInfo) (string, string, string, error) {
	p, err := (&profiles{&stakeholders{c: s.c}}).load(ctx, o)
	if err != nil {
		return "", "", "", err
	}
	dir := firstDir(p.CodeDir, o.Workdir)
	if dir == "" {
		return "", "", "", apiErr(errConflict, "项目没有代码库目录：先到项目的档案里填「代码库目录」，或者给项目设目录")
	}
	if dirState(dir).State != "ok" {
		return "", "", "", apiErr(errConflict, "代码库目录 %s 不存在", dir)
	}
	if _, err := git(ctx, dir, "rev-parse", "--show-toplevel"); err != nil {
		return "", "", "", apiErr(errConflict, "代码库目录 %s 不在 git 仓库里", dir)
	}
	st, err := s.settings(ctx, o.ID)
	if err != nil {
		return "", "", "", err
	}
	branch := st.Branch
	if branch == "" {
		branch = defaultBranch(ctx, dir)
	}
	if branch == "" {
		return "", "", "", apiErr(errConflict, "认不出代码库 %s 的生产分支：在原型同步设置里填「生产分支」", dir)
	}
	head, err := git(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch+"^{commit}")
	if err != nil || head == "" {
		return "", "", "", apiErr(errConflict, "代码库 %s 里没有分支 %s", dir, branch)
	}
	return dir, branch, head, nil
}

// defaultBranch 依次认 main、master、当前检出的分支。
func defaultBranch(ctx context.Context, dir string) string {
	for _, b := range []string{"main", "master"} {
		if _, err := git(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+b); err == nil {
			return b
		}
	}
	cur, _ := git(ctx, dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	return cur
}

// gitRaw 跑一条 git 命令，回原样的标准输出，最多 limit 字节（超了截断）。
func gitRaw(ctx context.Context, dir string, limit int, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	out, err := cmd.Output()
	if len(out) > limit {
		out = append(out[:limit], []byte("\n…（diff 太长，后面截掉了）\n")...)
	}
	return out, err
}

func splitLines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = append([]string{"…"}, lines[len(lines)-n:]...)
	}
	return strings.Join(lines, "\n")
}

func short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func protoSyncStatusLabel(st string) string {
	switch st {
	case psRunning:
		return "进行中"
	case psReviewing:
		return "等产品裁决"
	case psDone:
		return "已同步"
	case psNoChange:
		return "没有改动"
	case psBaseline:
		return "设为基线"
	case psFailed:
		return "没成功"
	case psCancelled:
		return "已作废"
	}
	return st
}
