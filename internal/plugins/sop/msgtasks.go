// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package sop

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 任务关联来源消息（sop 0.23.0）：
//   - task 节点建了任务发 sop.task_created：{task_id, task_ref, run_id, flow_id, step, message_id, message_ids, backfill}。
//     IM 插件（弱依赖）订阅它，把任务记到来源消息上；新建时 IM 也按 object.created 读 source_ref 记，两边都幂等。
//     本插件不碰 IM 的表。
//   - 历史回填：TSK-0411 之前 task 节点建的任务 source_ref 里没有 message_id，IM 认不出来源。扫本插件的执行记录：
//     步骤输出里有 task.id，且那条任务的 source_ref.run_id、step 正指着这一步（确实是这一步建的，取回别的执行建的不算），
//     消息取这一步输入里的 message_id（再没有取执行输入的），再没有取上游读取消息的 message.id；输入里的 message_ids 一起带上。
//     按条发 sop.task_created（backfill 为 true）。不改任务、不改执行记录，重复跑 IM 那边不会多记。
//   - 启用后等 IM 起来（messageTasksDelay）自动跑一次，跑过记在 sop_settings 的 message_tasks_backfilled；
//     IM 插件没在跑时不跑、不记，下次启用再看。要再跑一遍调 POST /api/sop/maintenance/message-tasks。

// EventTaskCreated 是 task 节点建了任务（含历史回填），payload 见 TaskCreated。
const EventTaskCreated = "sop.task_created"

// messageTasksKey 是 sop_settings 里「历史回填做过了」的标记，值是做的时间和条数。
const messageTasksKey = "message_tasks_backfilled"

// messageIDsMax 是一条任务最多记几条来源消息（同 IM 一次关联的上限）。
const messageIDsMax = 200

// messageTasksDelay 是启用后等多久再回填：插件按依赖顺序启用，IM 订阅好之前发的事件没人收。测试里改小。
var messageTasksDelay = 30 * time.Second

// imGetMessageKind 是 IM 插件的读取消息节点，它在跑就说明 IM 插件在跑。
const imGetMessageKind = "im_get_message"

// TaskCreated 是 sop.task_created 的 payload（契约「任务关联来源消息」的示例按它比对）。message_id 是主来源消息（输入里的 message_id，或上游读取消息的 message.id），
// 没有为空串；message_ids 是输入里的一组消息，没有为空数组。
type TaskCreated struct {
	TaskID     string   `json:"task_id"`
	TaskRef    string   `json:"task_ref"`
	RunID      string   `json:"run_id"`
	FlowID     string   `json:"flow_id"`
	Step       string   `json:"step"`
	MessageID  string   `json:"message_id"`
	MessageIDs []string `json:"message_ids"`
	Backfill   bool     `json:"backfill"`
}

// publishTaskCreated 发 sop.task_created；发不出去只记日志，不影响建任务。
func publishTaskCreated(ctx context.Context, c plugin.Core, p TaskCreated) {
	if p.MessageIDs == nil {
		p.MessageIDs = []string{}
	}
	if err := c.Events().Publish(ctx, EventTaskCreated, p); err != nil {
		c.Log().Warn("sop task_created publish failed", "task", p.TaskID, "run", p.RunID, "err", err)
	}
}

// upstreamMessageID 是上游读取消息（im_get_message）输出的 message.id；只认 IM 消息的 id（msg_ 开头），别的同名字段不算。
func upstreamMessageID(input Json) string {
	id := strings.TrimSpace(txt(getPath(input, "message.id")))
	if strings.HasPrefix(id, "msg_") {
		return id
	}
	return ""
}

// inputMessageIDs 取输入里的 message_ids（数组，或逗号、空白隔开的一串），去重、保序，不含 primary；没有为 nil。
func inputMessageIDs(input Json, primary string) []string {
	return messageIDList(input["message_ids"], primary)
}

func messageIDList(v any, primary string) []string {
	var out []string
	add := func(s string) {
		if s = strings.TrimSpace(s); s != "" && s != primary && !slices.Contains(out, s) && len(out) < messageIDsMax {
			out = append(out, s)
		}
	}
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			if s, ok := e.(string); ok {
				add(s)
			}
		}
	case []string:
		for _, s := range x {
			add(s)
		}
	case string:
		for _, s := range strings.FieldsFunc(x, func(r rune) bool { return r == ',' || r == '，' || r == ' ' || r == '\n' || r == '\t' }) {
			add(s)
		}
	}
	return out
}

// refMessageIDs 是来源里记的 message_ids，没有为空数组。
func refMessageIDs(ref map[string]any) []string {
	if ids, ok := ref["message_ids"].([]string); ok {
		return ids
	}
	return []string{}
}

// messageTasksResult 是一次回填的结果：scanned 是输出里有任务的步骤数，published 是发出的条数，
// not_created_here 是任务不是这一步建的（取回的别的执行的任务、im_to_task 建的）或已删的，no_message 是找不到来源消息的。
type messageTasksResult struct {
	Scanned        int  `json:"scanned"`
	Published      int  `json:"published"`
	NotCreatedHere int  `json:"not_created_here"`
	NoMessage      int  `json:"no_message"`
	IMRunning      bool `json:"im_running"`
}

// imRunning 看 IM 插件在不在跑（它登记的读取消息节点在不在）。
func imRunning(c plugin.Core) bool {
	return slices.ContainsFunc(c.SOP().Nodes(), func(n plugin.SOPNode) bool { return n.Kind == imGetMessageKind })
}

// backfillMessageTasks 扫执行记录，按条发 sop.task_created（backfill 为 true），见文件头。
func backfillMessageTasks(ctx context.Context, c plugin.Core) (messageTasksResult, error) {
	res := messageTasksResult{IMRunning: imRunning(c)}
	type row struct{ run, step, flow, task, mid, upstream, mids string }
	rows, err := c.Store().Query(ctx, `SELECT s.run_id, s.step_key, r.flow_id,
		COALESCE(CAST(json_extract(s.output, '$.task.id') AS TEXT), ''),
		COALESCE(CAST(json_extract(s.input, '$.message_id') AS TEXT), CAST(json_extract(r.input, '$.message_id') AS TEXT), ''),
		COALESCE(CAST(json_extract(s.input, '$.message.id') AS TEXT), ''),
		COALESCE(CAST(json_extract(s.input, '$.message_ids') AS TEXT), CAST(json_extract(r.input, '$.message_ids') AS TEXT), '')
		FROM sop_run_steps s JOIN sop_runs r ON r.id = s.run_id
		WHERE s.output IS NOT NULL AND json_valid(s.output) AND json_extract(s.output, '$.task.id') IS NOT NULL
		ORDER BY r.started_at, s.run_id, s.idx`)
	if err != nil {
		return res, err
	}
	var list []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.run, &x.step, &x.flow, &x.task, &x.mid, &x.upstream, &x.mids); err != nil {
			_ = rows.Close()
			return res, err
		}
		list = append(list, x)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return res, err
	}
	for _, x := range list {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		res.Scanned++
		o, err := c.Objects().Get(ctx, x.task)
		if errors.Is(err, plugin.ErrNoRows) {
			res.NotCreatedHere++
			continue
		}
		if err != nil {
			return res, err
		}
		ref, _ := o.Props[domain.PropSourceRef].(map[string]any)
		if o.Type != "task" || o.Deleted || ref == nil || txt(ref["run_id"]) != x.run || txt(ref["step"]) != x.step {
			res.NotCreatedHere++
			continue
		}
		mid := strings.TrimSpace(x.mid)
		if mid == "" {
			mid = upstreamMessageID(Json{"message": map[string]any{"id": x.upstream}})
		}
		var ids []string
		if x.mids != "" {
			var arr []any
			if json.Unmarshal([]byte(x.mids), &arr) == nil {
				ids = messageIDList(arr, mid)
			} else {
				ids = messageIDList(x.mids, mid)
			}
		}
		if mid == "" && len(ids) == 0 {
			res.NoMessage++
			continue
		}
		publishTaskCreated(ctx, c, TaskCreated{TaskID: o.ID, TaskRef: o.Ref, RunID: x.run, FlowID: x.flow, Step: x.step,
			MessageID: mid, MessageIDs: ids, Backfill: true})
		res.Published++
	}
	return res, nil
}

// messageTasksJob 启用后自动回填一次，见文件头。
func messageTasksJob(ctx context.Context, c plugin.Core) error {
	select {
	case <-ctx.Done():
		return nil
	case <-time.After(messageTasksDelay):
	}
	var v string
	err := c.Store().QueryRow(ctx, `SELECT value FROM sop_settings WHERE key = ?`, messageTasksKey).Scan(&v)
	if err == nil {
		return nil
	}
	if !errors.Is(err, plugin.ErrNoRows) {
		return err
	}
	if !imRunning(c) {
		return nil
	}
	res, err := backfillMessageTasks(ctx, c)
	if err != nil {
		return err
	}
	at := time.Now().UTC().Format(time.RFC3339)
	val, _ := json.Marshal(map[string]any{"at": at, "scanned": res.Scanned, "published": res.Published})
	if _, err := c.Store().Exec(ctx, `INSERT INTO sop_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING`,
		messageTasksKey, string(val), at); err != nil {
		return err
	}
	c.Log().Info("sop message tasks backfilled", "scanned", res.Scanned, "published", res.Published,
		"not_created_here", res.NotCreatedHere, "no_message", res.NoMessage)
	return nil
}

// backfillMessageTasksHandler 是 POST /api/sop/maintenance/message-tasks：手动再回填一遍，回 messageTasksResult。
// IM 插件没在跑时 409（发了也没人记）。
func backfillMessageTasksHandler(c plugin.Core) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !imRunning(c) {
			fail(w, r, c, apiErr(errConflict, "IM 消息插件没在跑，任务记不到消息上：先启用 IM 消息插件"))
			return
		}
		res, err := backfillMessageTasks(r.Context(), c)
		if err != nil {
			fail(w, r, c, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": res})
	}
}
