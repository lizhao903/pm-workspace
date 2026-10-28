package api

import (
	"context"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/audit"
	"github.com/lizhao903/pm-workspace/internal/vault"
)

// SecretVault 是 HTTP 层能碰到的保险箱操作。刻意不含 Resolve：
// 明文只给后端内部用，接口层连调用它的入口都没有。*vault.Vault 天然满足它。
type SecretVault interface {
	Create(ctx context.Context, name, kind, value string) (*vault.Secret, error)
	List(ctx context.Context) ([]vault.Secret, error)
	Rotate(ctx context.Context, id, value string) (*vault.Secret, error)
	Delete(ctx context.Context, id string) error
}

// vaultReady 在没配保险箱时回 500 并说明原因；fail 会把 internal 的 message 吞掉，这里直接写。
func (s *Server) vaultReady(w http.ResponseWriter) bool {
	if s.opt.Vault != nil {
		return true
	}
	writeJSON(w, http.StatusInternalServerError,
		errBody{Error: errPayload{Code: "internal", Message: "vault is not configured on this server"}})
	return false
}

func (s *Server) handleListSecrets(w http.ResponseWriter, r *http.Request) {
	if !s.vaultReady(w) {
		return
	}
	items, err := s.opt.Vault.List(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	respondList(w, nonNil(items), Meta{Total: len(items)})
}

// value 是只写字段：只往保险箱里去，响应只有脱敏提示。
type createSecretReq struct {
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

func (s *Server) handleCreateSecret(w http.ResponseWriter, r *http.Request) {
	if !s.vaultReady(w) {
		return
	}
	var req createSecretReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.opt.Vault.Create(r.Context(), req.Name, req.Kind, req.Value)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "create", "secret", out.ID, "凭证 "+out.Name+" "+audit.SecretSet, secretDetail(out, audit.SecretSet))
	respondData(w, http.StatusCreated, out)
}

type rotateSecretReq struct {
	Value string `json:"value"`
}

func (s *Server) handleRotateSecret(w http.ResponseWriter, r *http.Request) {
	if !s.vaultReady(w) {
		return
	}
	var req rotateSecretReq
	if err := decodeBody(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	out, err := s.opt.Vault.Rotate(r.Context(), r.PathValue("id"), req.Value)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "rotate", "secret", out.ID, "凭证 "+out.Name+" "+audit.SecretUpdated, secretDetail(out, audit.SecretUpdated))
	respondData(w, http.StatusOK, out)
}

// secretDetail 只有名字、种类、版本和提示：不带明文、密文和 hint（hint 含明文尾号）。
func secretDetail(sec *vault.Secret, value string) map[string]any {
	return map[string]any{"name": sec.Name, "kind": sec.Kind, "version": sec.Version, "value": value}
}

func (s *Server) handleDeleteSecret(w http.ResponseWriter, r *http.Request) {
	if !s.vaultReady(w) {
		return
	}
	id := r.PathValue("id")
	label, d := id, map[string]any{}
	if items, err := s.opt.Vault.List(r.Context()); err == nil {
		for i := range items {
			if items[i].ID == id {
				label, d = items[i].Name, map[string]any{"name": items[i].Name, "kind": items[i].Kind}
			}
		}
	}
	if err := s.opt.Vault.Delete(r.Context(), id); err != nil {
		s.fail(w, r, err)
		return
	}
	s.auditConfig(r, "delete", "secret", id, "删除凭证 "+label, d)
	respondData(w, http.StatusOK, nil)
}
