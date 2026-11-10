// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// Meta 只在列表接口出现，给前端做分页。
type Meta struct {
	Total  int `json:"total"`
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}

// envelope 是成功响应的统一信封，契约见 docs/api-contract.md。
type envelope struct {
	Data any   `json:"data"`
	Meta *Meta `json:"meta,omitempty"`
}

type errPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errBody struct {
	Error errPayload `json:"error"`
}

// apiError 让上层能自带一条面向前端的 message，同时保留哨兵错误供 errors.Is 判断。
type apiError struct {
	msg string
	err error
}

func (e *apiError) Error() string { return e.msg }
func (e *apiError) Unwrap() error { return e.err }

// validationf 构造 400 validation 错误，message 直接展示给用户，所以要讲清是哪个参数/字段。
func validationf(format string, a ...any) error {
	return &apiError{msg: fmt.Sprintf(format, a...), err: domain.ErrValidation}
}

func notFoundf(format string, a ...any) error {
	return &apiError{msg: fmt.Sprintf(format, a...), err: domain.ErrNotFound}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	// 到这一步 header 已发出，编码失败只能记日志，不能再改状态码。
	_ = json.NewEncoder(w).Encode(v)
}

func respondData(w http.ResponseWriter, status int, data any) {
	writeJSON(w, status, envelope{Data: data})
}

func respondList(w http.ResponseWriter, data any, m Meta) {
	writeJSON(w, http.StatusOK, envelope{Data: data, Meta: &m})
}

// fail 把领域错误映射成契约里的五个错误码。500 只回通用 message，细节进日志。
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	status, code, msg := http.StatusInternalServerError, "internal", err.Error()
	switch {
	case errors.Is(err, domain.ErrNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, domain.ErrConflict):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, domain.ErrValidation):
		status, code = http.StatusBadRequest, "validation"
	case errors.Is(err, domain.ErrReadOnly):
		status, code = http.StatusForbidden, "readonly"
	default:
		s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		msg = "internal server error"
	}
	writeJSON(w, status, errBody{Error: errPayload{Code: code, Message: msg}})
}
