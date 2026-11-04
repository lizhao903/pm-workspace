package plugin

import (
	"context"
	"strings"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 插件登记产物的受限句柄（AUTO-08）：项目插件的测试报告、截图登记为任务的产出。
// 走 cmd/pmw 交进来的外层 store（同 Claude Code 运行的产物登记，runs.go recordArtifacts），
// 来源固定记 run（执行后产生的文件）、产出者记 run 类型的本插件 id，插件自己填不了来源和产出者。
// 只登记，不改、不删；同一个 run_id 下同一路径再登记一次只更新大小和时间（store 的去重口径）。

// NewArtifact 是插件要登记的一个本地文件。Path 是绝对路径，或相对 BaseDir 的路径。
type NewArtifact struct {
	// ObjectID 是挂到哪个工作对象（任务），空串不挂
	ObjectID string
	Title    string
	Path     string
	BaseDir  string
	// Kind 是字典 artifact_kind 的 key（doc、data、other……），空串不分
	Kind  string
	Note  string
	Props map[string]any
}

// ArtifactWriter 只登记产物。校验失败的错误可以用 errors.Is 对 domain.ErrValidation 判断。
type ArtifactWriter interface {
	Record(ctx context.Context, a NewArtifact) (string, error)
}

func (c *core) Artifacts() ArtifactWriter { return artifactWriter{c} }

type artifactWriter struct{ c *core }

func (w artifactWriter) Record(ctx context.Context, a NewArtifact) (string, error) {
	oc := w.c.reg.objectCreator()
	if oc == nil {
		return "", ErrNoObjectWriter
	}
	rec, ok := oc.(artifactRecorder)
	if !ok {
		return "", ErrWriteUnsupported
	}
	in := domain.ArtifactInput{
		Title: a.Title, Path: a.Path, BaseDir: a.BaseDir, Platform: "local", Kind: a.Kind, Note: a.Note,
		Source: domain.ArtifactSourceRun, ActorType: domain.ActorRun, ActorID: w.c.id, ActorLabel: w.c.id, Props: a.Props,
	}
	if id := strings.TrimSpace(a.ObjectID); id != "" {
		in.ObjectID = &id
	}
	art, err := rec.RecordArtifact(ctx, in)
	if err != nil {
		return "", err
	}
	return art.ID, nil
}
