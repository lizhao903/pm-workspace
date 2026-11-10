// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// ungroupedName 是未分组伪组的显示名，前端按 id 为空串识别它。
const ungroupedName = "未分组"

// --- 条目 ---

func (s *Server) handleListShortcuts(w http.ResponseWriter, r *http.Request) {
	grouped, err := newParams(r).boolean("grouped")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.st.ListShortcuts(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !grouped {
		respondList(w, nonNil(items), Meta{Total: len(items)})
		return
	}
	groups, err := s.st.ListShortcutGroups(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := groupShortcuts(groups, items)
	respondList(w, out, Meta{Total: len(items)})
}

// groupShortcuts 把扁平条目挂进各自的组，未分组的收进末尾的伪组。
// 组对象做了拷贝，不去改 store 返回的指针。
func groupShortcuts(groups []*domain.ShortcutGroup, items []*domain.Shortcut) []*domain.ShortcutGroup {
	byID := make(map[string]*domain.ShortcutGroup, len(groups))
	out := make([]*domain.ShortcutGroup, 0, len(groups)+1)
	for _, g := range groups {
		c := *g
		c.Items = []*domain.Shortcut{}
		out = append(out, &c)
		byID[c.ID] = &c
	}

	ungrouped := []*domain.Shortcut{}
	for _, it := range items {
		if it.GroupID != nil {
			if g, ok := byID[*it.GroupID]; ok {
				g.Items = append(g.Items, it)
				continue
			}
		}
		ungrouped = append(ungrouped, it)
	}
	// 未分组固定排在所有分组之后。没有未分组条目时不造这个伪组，免得页面多出一个空区块。
	if len(ungrouped) > 0 {
		out = append(out, &domain.ShortcutGroup{ID: "", Name: ungroupedName, Items: ungrouped})
	}
	return out
}

// createShortcutReq 对应 web 的 ShortcutInput。
type createShortcutReq struct {
	GroupID     *string `json:"group_id"`
	Label       string  `json:"label"`
	TargetKind  string  `json:"target_kind"`
	URL         string  `json:"url"`
	Nav         string  `json:"nav"`
	Command     string  `json:"command"`
	Icon        string  `json:"icon"`
	Color       string  `json:"color"`
	Description string  `json:"description"`
	OpenIn      string  `json:"open_in"`
	Pinned      bool    `json:"pinned"`
	SortOrder   int     `json:"sort_order"`
}

func (s *Server) handleCreateShortcut(w http.ResponseWriter, r *http.Request) {
	var req createShortcutReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	// 字段合法性（协议白名单、target_kind 取值、nav 是否为 JSON）全在 store 里判。
	out, err := s.st.CreateShortcut(r.Context(), &domain.Shortcut{
		GroupID:     req.GroupID,
		Label:       req.Label,
		TargetKind:  req.TargetKind,
		URL:         req.URL,
		Nav:         req.Nav,
		Command:     req.Command,
		Icon:        req.Icon,
		Color:       req.Color,
		Description: req.Description,
		OpenIn:      req.OpenIn,
		Pinned:      req.Pinned,
		SortOrder:   req.SortOrder,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, out)
}

func (s *Server) handleUpdateShortcut(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	p, err := parseShortcutPatch(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.st.UpdateShortcut(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

func (s *Server) handleDeleteShortcut(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeleteShortcut(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}

func (s *Server) handleVisitShortcut(w http.ResponseWriter, r *http.Request) {
	out, err := s.st.VisitShortcut(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

// reorderShortcutsReq 的 group_id 缺省与 null 同义，都表示未分组区。
type reorderShortcutsReq struct {
	GroupID *string  `json:"group_id"`
	IDs     []string `json:"ids"`
}

func (s *Server) handleReorderShortcuts(w http.ResponseWriter, r *http.Request) {
	var req reorderShortcutsReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.st.ReorderShortcuts(r.Context(), req.GroupID, req.IDs); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}

// parseShortcutPatch 和 parseObjectPatch 同理：group_id 是双指针，
// 必须区分「字段没传=不改」与「传了 null=移出分组」。
func parseShortcutPatch(body []byte) (domain.ShortcutPatch, error) {
	var p domain.ShortcutPatch
	raw, err := patchKeys(body)
	if err != nil {
		return p, err
	}
	if p.GroupID, err = patchNullable[string](raw, "group_id", "a string or null"); err != nil {
		return p, err
	}
	if p.Label, err = patchField[string](raw, "label", "a string"); err != nil {
		return p, err
	}
	if p.TargetKind, err = patchField[string](raw, "target_kind", "a string"); err != nil {
		return p, err
	}
	if p.URL, err = patchField[string](raw, "url", "a string"); err != nil {
		return p, err
	}
	if p.Nav, err = patchField[string](raw, "nav", "a string"); err != nil {
		return p, err
	}
	if p.Command, err = patchField[string](raw, "command", "a string"); err != nil {
		return p, err
	}
	if p.Icon, err = patchField[string](raw, "icon", "a string"); err != nil {
		return p, err
	}
	if p.Color, err = patchField[string](raw, "color", "a string"); err != nil {
		return p, err
	}
	if p.Description, err = patchField[string](raw, "description", "a string"); err != nil {
		return p, err
	}
	if p.OpenIn, err = patchField[string](raw, "open_in", "a string"); err != nil {
		return p, err
	}
	if p.Pinned, err = patchField[bool](raw, "pinned", "a boolean"); err != nil {
		return p, err
	}
	if p.SortOrder, err = patchField[int](raw, "sort_order", "an integer"); err != nil {
		return p, err
	}
	return p, nil
}

// --- 分组 ---

func (s *Server) handleListShortcutGroups(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.ListShortcutGroups(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

type createShortcutGroupReq struct {
	Name      string `json:"name"`
	Color     string `json:"color"`
	Collapsed bool   `json:"collapsed"`
	SortOrder int    `json:"sort_order"`
}

func (s *Server) handleCreateShortcutGroup(w http.ResponseWriter, r *http.Request) {
	var req createShortcutGroupReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.st.CreateShortcutGroup(r.Context(), &domain.ShortcutGroup{
		Name:      req.Name,
		Color:     req.Color,
		Collapsed: req.Collapsed,
		SortOrder: req.SortOrder,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, out)
}

func (s *Server) handleUpdateShortcutGroup(w http.ResponseWriter, r *http.Request) {
	var p domain.ShortcutGroupPatch
	if err := decodeBody(r, &p); err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.st.UpdateShortcutGroup(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

func (s *Server) handleDeleteShortcutGroup(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeleteShortcutGroup(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}

// patchKeys 把请求体拆成「字段名 -> 原始值」，两个 parse*Patch 共用这一步。
func patchKeys(body []byte) (map[string]json.RawMessage, error) {
	var raw map[string]json.RawMessage
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, validationf("request body is required")
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, validationf("malformed JSON body: %v", err)
	}
	return raw, nil
}
