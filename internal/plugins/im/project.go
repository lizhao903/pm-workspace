package im

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// 消息归到项目（0006）：im_messages.project_id 记这条消息归到哪个项目。
// 手动：POST /api/im/messages/{id}/project，body {"project_id": "<项目 id、ref 或名字>"}，null 或空串是清除；回改后的整条消息。
// SOP：节点 im_set_project（消息归到项目），config.message 同读取消息（留空取输入的 message.id、message_id），
// config.project 是项目 id、ref 或名字（支持 {{字段}}）；输出加 project: {id, ref, name, message_id}。
// 项目页「沟通」按 GET /api/im/messages?project_id= 把归到项目的消息并进绑定会话的消息里。

const (
	NodeSetProject = "im_set_project"
	projectType    = "project"
)

// findProject 按 id、ref、名字认项目（只认没删的 type project）。
func (in *inbox) findProject(ctx context.Context, key string) (plugin.ObjectInfo, error) {
	o, err := in.c.Objects().Find(ctx, projectType, key)
	if errors.Is(err, plugin.ErrNoRows) {
		return o, apiErr(errValidation, "project %s not found", key)
	}
	return o, err
}

// setProject 是手动改归属。
func (in *inbox) setProject(w http.ResponseWriter, r *http.Request) {
	var body map[string]*string
	if err := decode(r, &body, 4<<10); err != nil {
		fail(w, r, in.c, err)
		return
	}
	raw, ok := body["project_id"]
	if !ok {
		fail(w, r, in.c, apiErr(errValidation, "project_id is required (null to clear)"))
		return
	}
	var pid any
	if key := strings.TrimSpace(deref(raw)); key != "" {
		o, err := in.findProject(r.Context(), key)
		if err != nil {
			fail(w, r, in.c, err)
			return
		}
		pid = o.ID
	}
	in.update(w, r, `project_id = ?`, pid)
}

// messageTemplate 定节点要处理的消息：配置留空时先取输入的 message.id（读取消息的输出），没有再按 messageOf 取 message_id（IM 触发的输入）。
func messageTemplate(cfg map[string]string, input map[string]any) map[string]string {
	if strings.TrimSpace(cfg["message"]) != "" {
		return cfg
	}
	if id := strings.TrimSpace(txt(getPath(input, "message.id"))); id != "" {
		return map[string]string{"message": id}
	}
	return cfg
}

func (in *inbox) setProjectNode(ctx context.Context, _ plugin.Core, n plugin.SOPNodeInput) (map[string]any, error) {
	key := strings.TrimSpace(render(n.Config["project"], n.Input))
	if key == "" {
		return nil, errors.New("没有指定项目：在「项目」里选一个，或者填 {{字段}}，确认输入里有值")
	}
	m, err := in.messageOf(ctx, messageTemplate(n.Config, n.Input), n.Input)
	if err != nil {
		return nil, err
	}
	o, err := in.c.Objects().Find(ctx, projectType, key)
	if errors.Is(err, plugin.ErrNoRows) {
		return nil, fmt.Errorf("项目「%s」不存在：填项目 id、编号或名字，已删除的项目不算", key)
	}
	if err != nil {
		return nil, err
	}
	if _, err := in.c.Store().Exec(ctx, `UPDATE im_messages SET project_id = ? WHERE id = ?`, o.ID, m.ID); err != nil {
		return nil, err
	}
	return with(n.Input, "project", map[string]any{"id": o.ID, "ref": o.Ref, "name": o.Title, "message_id": m.ID}), nil
}
