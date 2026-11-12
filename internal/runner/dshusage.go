// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package runner

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/klauspost/compress/zstd"
)

// dsh 会话日志里的用量（TSK-0722 之后的缓存实验基础，见 docs/agent-module-session-cache-design.md）。
//
// dsh headless 的 --json 只投射 session/status/text/thinking/tool_call/tool_result/final，
// **不带 token 用量**；用量在 dsh 自己持久化的会话日志里：每个 assistant/message 事件带
// data.usage = {inputTokens, outputTokens, totalTokens, cacheReadTokens}。
//
// 其中 inputTokens 是**未命中缓存**的输入（DeepSeek / pi-ai 的 uncached input），
// cacheReadTokens 是命中前缀缓存的输入；两者相加再加 outputTokens 才是 totalTokens。
// 例：input 2722 + cacheRead 8192 + output 204 = total 11118。
//
// 这个文件只读日志，不启动 dsh、不访问网络：跑完一次执行之后按会话 id 找到文件解析就行。
// 日志默认是 zstd 帧（可能不带 content size，按流式解），也兼容禁用压缩后的纯文本行。

// DSHStepUsage 是一次模型请求（一个 step）的用量。
type DSHStepUsage struct {
	Turn int `json:"turn"`
	Step int `json:"step"`
	// CacheReadTokens 是命中前缀缓存的输入 token。
	CacheReadTokens int `json:"cache_read_tokens"`
	// UncachedInputTokens 是没命中缓存的输入 token。
	UncachedInputTokens int `json:"uncached_input_tokens"`
	OutputTokens        int `json:"output_tokens"`
}

// DSHSessionUsage 是一个 dsh 会话的用量汇总。
type DSHSessionUsage struct {
	SessionID string `json:"session_id"`
	Cwd       string `json:"cwd"`
	// SystemPrompt 是第一条 system/message 的文本：验「跨进程前缀是否逐字节一致」用。
	SystemPrompt string `json:"-"`
	// Steps 按日志顺序（turn/step 升序）给出每次模型请求的用量。
	Steps []DSHStepUsage `json:"steps"`

	CacheReadTokens     int `json:"cache_read_tokens"`
	UncachedInputTokens int `json:"uncached_input_tokens"`
	OutputTokens        int `json:"output_tokens"`

	// PromptTokens 是总输入 = 命中 + 未命中。
	PromptTokens int `json:"prompt_tokens"`
}

// CacheHitRatio 是按输入 token 加权的缓存命中率（0~1）；没有输入时为 0。
func (u *DSHSessionUsage) CacheHitRatio() float64 {
	if u == nil || u.PromptTokens <= 0 {
		return 0
	}
	return float64(u.CacheReadTokens) / float64(u.PromptTokens)
}

// FirstStep 返回第一次模型请求的用量，没有时返回零值。
func (u *DSHSessionUsage) FirstStep() DSHStepUsage {
	if u == nil || len(u.Steps) == 0 {
		return DSHStepUsage{}
	}
	return u.Steps[0]
}

// DefaultDSHHome 找 dsh 的 home：环境变量 DSH_HOME 优先，否则 ~/.dsh。
func DefaultDSHHome() string {
	if h := strings.TrimSpace(os.Getenv("DSH_HOME")); h != "" {
		return h
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".dsh")
}

// sessionLogRe 匹配 dsh 会话日志文件名：session.v4.jsonl.zstd / session.v3.jsonl / session.jsonl。
var sessionLogRe = regexp.MustCompile(`^session(?:\.v(\d+))?\.jsonl(\.zstd)?$`)

// FindDSHSessionLog 按会话 id 找日志文件。
//
// dsh 的磁盘布局是 <home>/sessions/<normalized-cwd>/<session-id>/session.vN.jsonl[.zstd]；
// normalized-cwd 目录名是 cwd 的可读编码，调用方不用关心，这里在 sessions/ 下按会话 id 找。
// 同一个会话理论上只有一份文件，保险起见取版本号最高、再取修改时间最新的。
func FindDSHSessionLog(dshHome, sessionID string) (string, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "", fmt.Errorf("会话 id 为空")
	}
	home := strings.TrimSpace(dshHome)
	if home == "" {
		home = DefaultDSHHome()
	}
	if home == "" {
		return "", fmt.Errorf("找不到 dsh home")
	}
	root := filepath.Join(home, "sessions")
	dirs, err := os.ReadDir(root)
	if err != nil {
		return "", fmt.Errorf("读 dsh sessions 目录: %w", err)
	}

	type candidate struct {
		path string
		ver  int
		mod  int64
	}
	var best *candidate
	for _, cwdDir := range dirs {
		if !cwdDir.IsDir() {
			continue
		}
		sessDir := filepath.Join(root, cwdDir.Name(), sessionID)
		entries, err := os.ReadDir(sessDir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			m := sessionLogRe.FindStringSubmatch(e.Name())
			if m == nil {
				continue
			}
			ver := 0
			if m[1] != "" {
				ver, _ = strconv.Atoi(m[1])
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			cur := &candidate{path: filepath.Join(sessDir, e.Name()), ver: ver, mod: info.ModTime().UnixNano()}
			if best == nil || cur.ver > best.ver || (cur.ver == best.ver && cur.mod > best.mod) {
				best = cur
			}
		}
	}
	if best == nil {
		return "", fmt.Errorf("找不到会话 %s 的日志（dsh home: %s）", sessionID, home)
	}
	return best.path, nil
}

// dshUsageEvent 是日志里解析用量与系统提示需要的那几个字段；其余键忽略。
type dshUsageEvent struct {
	Type string `json:"type"`
	Data struct {
		// session 事件
		ID  string `json:"id"`
		Cwd string `json:"cwd"`

		Turn int `json:"turn"`
		Step int `json:"step"`

		// system/message 事件
		Message struct {
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`

		// assistant/message 事件
		Usage *struct {
			InputTokens     int `json:"inputTokens"`
			OutputTokens    int `json:"outputTokens"`
			TotalTokens     int `json:"totalTokens"`
			CacheReadTokens int `json:"cacheReadTokens"`
		} `json:"usage"`
	} `json:"data"`
}

// ReadDSHSessionUsage 读一个 dsh 会话日志并汇总用量。
//
// 文件可以是 zstd 帧（dsh 默认）或纯 JSONL（persistence compression: 'none'）；
// 尾行不完整（进程刚退出/正在写）时忽略尾行，不因此报错。
func ReadDSHSessionUsage(path string) (*DSHSessionUsage, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("打开 dsh 会话日志: %w", err)
	}
	defer func() { _ = f.Close() }()

	var r io.Reader = f
	if strings.HasSuffix(path, ".zstd") {
		dec, err := zstd.NewReader(f)
		if err != nil {
			return nil, fmt.Errorf("解压 dsh 会话日志: %w", err)
		}
		defer dec.Close()
		r = dec
	}

	out := &DSHSessionUsage{}
	br := bufio.NewReaderSize(r, 64<<10)
	lineNo := 0
	for {
		line, readErr := br.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			lineNo++
			var ev dshUsageEvent
			if err := json.Unmarshal(bytes.TrimSpace(line), &ev); err != nil {
				// 尾行可能只写了一半；不是尾行就说明文件不是我们以为的格式。
				if readErr == io.EOF {
					break
				}
				return nil, fmt.Errorf("解析 dsh 会话日志第 %d 行: %w", lineNo, err)
			}
			switch ev.Type {
			case "session":
				if out.SessionID == "" {
					out.SessionID = ev.Data.ID
				}
				if out.Cwd == "" {
					out.Cwd = ev.Data.Cwd
				}
			case "system/message":
				if out.SystemPrompt == "" && len(ev.Data.Message.Content) > 0 {
					out.SystemPrompt = ev.Data.Message.Content[0].Text
				}
			case "assistant/message":
				u := ev.Data.Usage
				if u == nil {
					continue
				}
				step := DSHStepUsage{
					Turn:                ev.Data.Turn,
					Step:                ev.Data.Step,
					CacheReadTokens:     u.CacheReadTokens,
					UncachedInputTokens: u.InputTokens,
					OutputTokens:        u.OutputTokens,
				}
				out.Steps = append(out.Steps, step)
				out.CacheReadTokens += step.CacheReadTokens
				out.UncachedInputTokens += step.UncachedInputTokens
				out.OutputTokens += step.OutputTokens
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return nil, fmt.Errorf("读 dsh 会话日志: %w", readErr)
		}
	}
	out.PromptTokens = out.CacheReadTokens + out.UncachedInputTokens
	sort.SliceStable(out.Steps, func(i, j int) bool {
		if out.Steps[i].Turn != out.Steps[j].Turn {
			return out.Steps[i].Turn < out.Steps[j].Turn
		}
		return out.Steps[i].Step < out.Steps[j].Step
	})
	return out, nil
}

// ReadDSHSessionUsageByID 是 FindDSHSessionLog + ReadDSHSessionUsage 的组合。
func ReadDSHSessionUsageByID(dshHome, sessionID string) (*DSHSessionUsage, error) {
	path, err := FindDSHSessionLog(dshHome, sessionID)
	if err != nil {
		return nil, err
	}
	return ReadDSHSessionUsage(path)
}
