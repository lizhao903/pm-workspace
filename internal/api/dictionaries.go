package api

import (
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// --- 字典 ---

func (s *Server) handleListDictionaries(w http.ResponseWriter, r *http.Request) {
	withItems, err := newParams(r).boolean("with_items")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.st.ListDictionaries(r.Context(), withItems)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

// --- 条目 ---

func (s *Server) handleListDictItems(w http.ResponseWriter, r *http.Request) {
	p := newParams(r)
	includeArchived, err := p.boolean("include_archived")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.st.ListDictItems(r.Context(), r.PathValue("id"), optStr(p.str("type")), includeArchived)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

// createDictItemReq 对应 web 的 DictItemInput。
type createDictItemReq struct {
	TypeID      *string        `json:"type_id"`
	Key         string         `json:"key"`
	Label       string         `json:"label"`
	Color       string         `json:"color"`
	Description string         `json:"description"`
	SortOrder   int            `json:"sort_order"`
	Meta        map[string]any `json:"meta"`
}

func (s *Server) handleCreateDictItem(w http.ResponseWriter, r *http.Request) {
	var req createDictItemReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	// key 必填、同字典内唯一、scope 与 type_id 是否匹配，全在 store 里判。
	out, err := s.st.CreateDictItem(r.Context(), &domain.DictItem{
		DictID:      r.PathValue("id"),
		TypeID:      req.TypeID,
		Key:         req.Key,
		Label:       req.Label,
		Color:       req.Color,
		Description: req.Description,
		SortOrder:   req.SortOrder,
		Meta:        req.Meta,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, out)
}

func (s *Server) handleUpdateDictItem(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	p, err := parseDictItemPatch(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.st.UpdateDictItem(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

// parseDictItemPatch 刻意不解析 key：枚举值一经创建不可改，
// 请求里带了 key 也只会被忽略，不会有任何路径把它写进库。
func parseDictItemPatch(body []byte) (domain.DictItemPatch, error) {
	var p domain.DictItemPatch
	raw, err := patchKeys(body)
	if err != nil {
		return p, err
	}
	if p.Label, err = patchField[string](raw, "label", "a string"); err != nil {
		return p, err
	}
	if p.Color, err = patchField[string](raw, "color", "a string"); err != nil {
		return p, err
	}
	if p.Description, err = patchField[string](raw, "description", "a string"); err != nil {
		return p, err
	}
	if p.SortOrder, err = patchField[int](raw, "sort_order", "an integer"); err != nil {
		return p, err
	}
	if p.Meta, err = patchField[map[string]any](raw, "meta", "a JSON object"); err != nil {
		return p, err
	}
	return p, nil
}

type archiveDictItemReq struct {
	Archived bool `json:"archived"`
}

func (s *Server) handleArchiveDictItem(w http.ResponseWriter, r *http.Request) {
	var req archiveDictItemReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.st.ArchiveDictItem(r.Context(), r.PathValue("id"), req.Archived)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

// handleDeleteDictItem 的 409 是常态而非异常：有引用就只能停用，
// store 会把引用数写进 message 供界面提示。
func (s *Server) handleDeleteDictItem(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeleteDictItem(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}

func (s *Server) handleDictItemUsage(w http.ResponseWriter, r *http.Request) {
	n, err := s.st.DictItemUsage(r.Context(), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, map[string]int{"usage": n})
}

// reorderDictItemsReq 的 type_id 缺省与 null 同义，都指 type_id 为空的那一批。
type reorderDictItemsReq struct {
	TypeID *string  `json:"type_id"`
	IDs    []string `json:"ids"`
}

func (s *Server) handleReorderDictItems(w http.ResponseWriter, r *http.Request) {
	var req reorderDictItemsReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if err := s.st.ReorderDictItems(r.Context(), r.PathValue("id"), req.TypeID, req.IDs); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}

// optStr 把「没传」和「传了空串」都折成 nil：字典的 type 过滤器缺省即不过滤。
func optStr(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}
