// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package domain

import "errors"

var (
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("conflict")
	ErrValidation = errors.New("validation failed")
	ErrReadOnly   = errors.New("builtin object type is read-only")
)
