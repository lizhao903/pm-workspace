// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package recording

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/lizhao903/pm-workspace/internal/plugin"
)

// modelSpec 是一个能用的 whisper.cpp 模型：文件名 + 官方发布字节数（下载完按它校验）。
type modelSpec struct {
	name  string
	file  string
	bytes int64
}

// catalog 是支持的模型，顺序即设置页顺序。默认用 small（用户确认先跑通），turbo 质量最好。
var catalog = []modelSpec{
	{name: "base", file: "ggml-base.bin", bytes: 147951465},
	{name: "small", file: "ggml-small.bin", bytes: 487601967},
	{name: "medium", file: "ggml-medium.bin", bytes: 1533763059},
	{name: "large-v3-turbo", file: "ggml-large-v3-turbo.bin", bytes: 1624555275},
}

var catalogByName = func() map[string]modelSpec {
	m := make(map[string]modelSpec, len(catalog))
	for _, s := range catalog {
		m[s.name] = s
	}
	return m
}()

func modelNameList() string {
	names := make([]string, len(catalog))
	for i, s := range catalog {
		names[i] = s.name
	}
	return strings.Join(names, "、")
}

// modelURL 是 HuggingFace 上的官方模型地址；走 network:model 白名单。
func modelURL(name string) string {
	return "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-" + name + ".bin"
}

// ToolInfo 是设置页显示的一个工具：路径、版本、能不能用。
type ToolInfo struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
}

// Tools 是本机转写依赖的两个工具。
type Tools struct {
	Whisper ToolInfo `json:"whisper"`
	FFmpeg  ToolInfo `json:"ffmpeg"`
}

// ModelInfo 是一个模型在界面上的样子。status: missing / downloading / ready / error。
type ModelInfo struct {
	Name         string `json:"name"`
	Size         int64  `json:"size"`
	Status       string `json:"status"`
	Progress     int    `json:"progress"`
	DownloadedAt string `json:"downloaded_at"`
	Error        string `json:"error"`
	Path         string `json:"path"`
}

// toolDirs 是自动探测工具的目录：GUI 启动的进程 PATH 可能不含 Homebrew。
var toolDirs = []string{"/opt/homebrew/bin", "/usr/local/bin"}

func isExecutable(path string) bool {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return false
	}
	return fi.Mode().Perm()&0o111 != 0
}

// findTool 按「设置里写死的路径 → PATH → Homebrew 常见目录」找工具。
func findTool(explicit, name string) string {
	if explicit != "" {
		return explicit
	}
	if p, err := exec.LookPath(name); err == nil && isExecutable(p) {
		return p
	}
	for _, dir := range toolDirs {
		p := filepath.Join(dir, name)
		if isExecutable(p) {
			return p
		}
	}
	return ""
}

var toolVersionRe = regexp.MustCompile(`version[:\s]+v?([0-9][0-9A-Za-z.+-]*)`)

// toolVersion 跑 --version / -version 解析版本号；跑不起来把错误带回去。
func toolVersion(ctx context.Context, path, flag string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, flag).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(clip(msg, 300))
	}
	if m := toolVersionRe.FindStringSubmatch(string(out)); len(m) > 1 {
		return m[1], nil
	}
	return "", nil
}

// detectTools 探测 whisper-cli 和 ffmpeg，失败原因直接给界面（不阻断其他功能）。
func detectTools(ctx context.Context, s Settings) Tools {
	var t Tools
	if p := findTool(s.WhisperPath, "whisper-cli"); p == "" {
		t.Whisper = ToolInfo{Error: "没找到 whisper-cli，先 brew install whisper.cpp"}
	} else if v, err := toolVersion(ctx, p, "--version"); err != nil {
		t.Whisper = ToolInfo{Path: p, Error: "whisper-cli 跑不起来：" + err.Error()}
	} else {
		t.Whisper = ToolInfo{Path: p, Version: v, OK: true}
	}
	if p := findTool(s.FFmpegPath, "ffmpeg"); p == "" {
		t.FFmpeg = ToolInfo{Error: "没找到 ffmpeg，先 brew install ffmpeg"}
	} else if v, err := toolVersion(ctx, p, "-version"); err != nil {
		t.FFmpeg = ToolInfo{Path: p, Error: "ffmpeg 跑不起来：" + err.Error()}
	} else {
		t.FFmpeg = ToolInfo{Path: p, Version: v, OK: true}
	}
	return t
}

// downloadState 是一次进行中的模型下载；err 非空表示上次下载失败了。
type downloadState struct {
	progress int
	err      string
}

func (p *Plugin) setDownloadProgress(name string, pct int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if st := p.downloads[name]; st != nil && st.err == "" {
		st.progress = pct
	}
}

func (p *Plugin) downloadStatus(name string) (progress int, busy bool, errMsg string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := p.downloads[name]
	if st == nil {
		return 0, false, ""
	}
	if st.err == "" {
		return st.progress, true, ""
	}
	return st.progress, false, st.err
}

func (p *Plugin) workerContext() context.Context {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.workerCtx != nil {
		return p.workerCtx
	}
	return context.Background()
}

// modelInfos 扫描模型目录，合并进行中的下载状态。
func (p *Plugin) modelInfos(c plugin.Core, s Settings) ([]ModelInfo, string, error) {
	dir, err := effectiveModelDir(c, s)
	if err != nil {
		return nil, "", err
	}
	out := make([]ModelInfo, 0, len(catalog))
	for _, spec := range catalog {
		info := ModelInfo{Name: spec.name, Path: filepath.Join(dir, spec.file)}
		fi, statErr := os.Stat(info.Path)
		ready := statErr == nil && !fi.IsDir()
		if ready {
			info.Size = fi.Size()
			info.DownloadedAt = fi.ModTime().UTC().Format(time.RFC3339)
			if fi.Size() == spec.bytes {
				info.Status = "ready"
				out = append(out, info)
				continue
			}
		}
		prog, busy, derr := p.downloadStatus(info.Name)
		switch {
		case ready:
			info.Status = "error"
			info.Error = fmt.Sprintf("文件大小不对：期望 %d 字节，实际 %d", spec.bytes, fi.Size())
		case busy:
			info.Status = "downloading"
			info.Progress = prog
		case derr != "":
			info.Status = "error"
			info.Error = derr
		default:
			info.Status = "missing"
		}
		out = append(out, info)
	}
	return out, dir, nil
}

// startModelDownload 起后台下载；同一模型只能下一个，已有文件则 409。
func (p *Plugin) startModelDownload(c plugin.Core, s Settings, name string) (ModelInfo, error) {
	spec, ok := catalogByName[name]
	if !ok {
		return ModelInfo{}, apiErr(errValidation, "不认识的模型 %s，可选 %s", name, modelNameList())
	}
	if err := plugin.Require(c, "network:model"); err != nil {
		return ModelInfo{}, err
	}
	dir, err := effectiveModelDir(c, s)
	if err != nil {
		return ModelInfo{}, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ModelInfo{}, fmt.Errorf("建模型目录失败：%w", err)
	}
	final := filepath.Join(dir, spec.file)
	if fi, err := os.Stat(final); err == nil && fi.Size() == spec.bytes {
		return ModelInfo{}, apiErr(errConflict, "模型 %s 已经下载好了", name)
	}
	if _, busy, _ := p.downloadStatus(name); busy {
		return ModelInfo{}, apiErr(errConflict, "模型 %s 正在下载", name)
	}
	p.mu.Lock()
	p.downloads[name] = &downloadState{}
	p.mu.Unlock()
	base := p.workerContext()
	go p.downloadModel(base, c, spec, dir)
	return ModelInfo{Name: name, Status: "downloading", Path: final}, nil
}

// downloadModel 下载并校验大小，先写 .tmp- 再改名；失败原因留在下载状态里给界面。
func (p *Plugin) downloadModel(base context.Context, c plugin.Core, spec modelSpec, dir string) {
	ctx, cancel := context.WithTimeout(base, 90*time.Minute)
	defer cancel()
	err := fetchModel(ctx, c, p, spec, dir)
	p.mu.Lock()
	st := p.downloads[spec.name]
	if err != nil && st != nil {
		st.err = clip(err.Error(), 300)
	}
	p.mu.Unlock()
	if err == nil {
		p.mu.Lock()
		delete(p.downloads, spec.name)
		p.mu.Unlock()
		c.Log().Info("模型下载完成", "model", spec.name, "dir", dir)
	}
}

func fetchModel(ctx context.Context, c plugin.Core, p *Plugin, spec modelSpec, dir string) error {
	client, err := c.HTTP("model")
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, modelURL(spec.name), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "pm-workspace-recording/0.1")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("下载 %s 失败：%w", spec.name, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("下载 %s 失败：HTTP %d %s", spec.name, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	tmp := filepath.Join(dir, ".tmp-"+spec.file)
	f, err := os.Create(tmp)
	if err != nil {
		return fmt.Errorf("写模型文件失败：%w", err)
	}
	written, copyErr := io.Copy(io.MultiWriter(f, &progressWriter{p: p, name: spec.name, total: spec.bytes}), resp.Body)
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("下载 %s 中断：%w", spec.name, copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("写模型文件失败：%w", closeErr)
	}
	if written != spec.bytes {
		_ = os.Remove(tmp)
		return fmt.Errorf("下载 %s 大小不对：期望 %d 字节，实际 %d（可能网络中断，重试即可）", spec.name, spec.bytes, written)
	}
	if err := os.Rename(tmp, filepath.Join(dir, spec.file)); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("模型文件改名失败：%w", err)
	}
	return nil
}

type progressWriter struct {
	p     *Plugin
	name  string
	total int64
	n     int64
	last  int
}

func (w *progressWriter) Write(b []byte) (int, error) {
	w.n += int64(len(b))
	if w.total > 0 {
		pct := int(w.n * 100 / w.total)
		if pct != w.last {
			w.last = pct
			w.p.setDownloadProgress(w.name, pct)
		}
	}
	return len(b), nil
}

// deleteModel 删掉已经下好的模型文件；下载中的不让删。
func (p *Plugin) deleteModel(c plugin.Core, s Settings, name string) (ModelInfo, error) {
	spec, ok := catalogByName[name]
	if !ok {
		return ModelInfo{}, apiErr(errValidation, "不认识的模型 %s，可选 %s", name, modelNameList())
	}
	if _, busy, _ := p.downloadStatus(name); busy {
		return ModelInfo{}, apiErr(errConflict, "模型 %s 正在下载，下完再删", name)
	}
	dir, err := effectiveModelDir(c, s)
	if err != nil {
		return ModelInfo{}, err
	}
	path := filepath.Join(dir, spec.file)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return ModelInfo{}, fmt.Errorf("删模型文件失败：%w", err)
	}
	p.mu.Lock()
	delete(p.downloads, name)
	p.mu.Unlock()
	return ModelInfo{Name: name, Status: "missing", Path: path}, nil
}
