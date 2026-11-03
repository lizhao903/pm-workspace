package api

import (
	"net/http"
	"time"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 干系人名册。负责人与参与人都指向这里，契约见 docs/api-contract.md 的「干系人名册」一节。

// handleListStakeholders 默认只回在岗的（选人时用），archived=true 才带上已归档的
// （名册管理页用）。两个场景的口径不同，不合并成一个默认值。
func (s *Server) handleListStakeholders(w http.ResponseWriter, r *http.Request) {
	includeArchived, err := newParams(r).boolean("archived")
	if err != nil {
		s.fail(w, r, err)
		return
	}
	items, err := s.st.ListStakeholders(r.Context(), includeArchived)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

// createStakeholderReq 对应 web 的 Partial<Stakeholder>。
// archived_at 不收：新建的人不可能一出生就已离岗，要归档走 PATCH。
type createStakeholderReq struct {
	Name      string `json:"name"`
	Role      string `json:"role"`
	Email     string `json:"email"`
	Note      string `json:"note"`
	Color     string `json:"color"`
	SortOrder int    `json:"sort_order"`

	// 联系人字段（0026）
	Group         string     `json:"group"`
	Company       string     `json:"company"`
	Title         string     `json:"title"`
	Phone         string     `json:"phone"`
	Tags          []string   `json:"tags"`
	Photo         string     `json:"photo"`
	Starred       bool       `json:"starred"`
	LastContactAt *time.Time `json:"last_contact_at"`
}

func (s *Server) handleCreateStakeholder(w http.ResponseWriter, r *http.Request) {
	var req createStakeholderReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	// name 必填与全局唯一都在 store 里判：唯一性只有数据库说了算，
	// 在这里先查一遍再插入，两个请求撞在一起时照样会漏过去。
	out, err := s.st.CreateStakeholder(r.Context(), &domain.Stakeholder{
		Name:      req.Name,
		Role:      req.Role,
		Email:     req.Email,
		Note:      req.Note,
		Color:     req.Color,
		SortOrder: req.SortOrder,

		Group:         req.Group,
		Company:       req.Company,
		Title:         req.Title,
		Phone:         req.Phone,
		Tags:          req.Tags,
		Photo:         req.Photo,
		Starred:       req.Starred,
		LastContactAt: req.LastContactAt,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusCreated, out)
}

func (s *Server) handleUpdateStakeholder(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	p, err := parseStakeholderPatch(body)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.st.UpdateStakeholder(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, out)
}

// parseStakeholderPatch 走 patchField 而不是直接 unmarshal：
// 「没传 sort_order」和「传了 sort_order: 0」必须是两件事，
// 直接 unmarshal 到值类型的话前者会被当成后者，把所有人的排序清成 0。
func parseStakeholderPatch(body []byte) (domain.StakeholderPatch, error) {
	var p domain.StakeholderPatch
	raw, err := patchKeys(body)
	if err != nil {
		return p, err
	}
	if p.Name, err = patchField[string](raw, "name", "a string"); err != nil {
		return p, err
	}
	if p.Role, err = patchField[string](raw, "role", "a string"); err != nil {
		return p, err
	}
	if p.Email, err = patchField[string](raw, "email", "a string"); err != nil {
		return p, err
	}
	if p.Note, err = patchField[string](raw, "note", "a string"); err != nil {
		return p, err
	}
	if p.Color, err = patchField[string](raw, "color", "a string"); err != nil {
		return p, err
	}
	if p.SortOrder, err = patchField[int](raw, "sort_order", "an integer"); err != nil {
		return p, err
	}
	if p.Archived, err = patchField[bool](raw, "archived", "a boolean"); err != nil {
		return p, err
	}
	if p.Group, err = patchField[string](raw, "group", "a string"); err != nil {
		return p, err
	}
	if p.Company, err = patchField[string](raw, "company", "a string"); err != nil {
		return p, err
	}
	if p.Title, err = patchField[string](raw, "title", "a string"); err != nil {
		return p, err
	}
	if p.Phone, err = patchField[string](raw, "phone", "a string"); err != nil {
		return p, err
	}
	if p.Tags, err = patchField[[]string](raw, "tags", "an array of strings"); err != nil {
		return p, err
	}
	if p.Photo, err = patchField[string](raw, "photo", "a string"); err != nil {
		return p, err
	}
	if p.Starred, err = patchField[bool](raw, "starred", "a boolean"); err != nil {
		return p, err
	}
	// last_contact_at 传 null 清空，回到「没联系过」
	if p.LastContactAt, err = patchNullable[time.Time](raw, "last_contact_at", "an RFC3339 string"); err != nil {
		return p, err
	}
	return p, nil
}

// handleDeleteStakeholder 的 409 是常态而非异常：人一旦被对象引用过就只能归档，
// store 会把引用数写进 message 供界面提示。
func (s *Server) handleDeleteStakeholder(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeleteStakeholder(r.Context(), r.PathValue("id")); err != nil {
		s.fail(w, r, err)
		return
	}
	respondData(w, http.StatusOK, nil)
}
