package runner

import "strings"

// Conclusion 从执行的过程记录（Output，见 render：说明文字夹着「[工具] …」「[工具失败] …」行）里取结论：
// 最后一次工具调用之后的那段文字；最后一次工具调用之后没有文字时，退回最后一段非工具文字；整段都是工具行时回空。
// 给需求方、给我回报时只用它，不回执行过程（TSK-0470）。口径同 internal/events 里 run.finished 的 summary。
func Conclusion(output string) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	last := -1
	for i, l := range lines {
		if IsToolLine(l) {
			last = i
		}
	}
	if tail := strings.TrimSpace(strings.Join(lines[last+1:], "\n")); tail != "" {
		return tail
	}
	end := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if !IsToolLine(lines[i]) && strings.TrimSpace(lines[i]) != "" {
			end = i
			break
		}
	}
	if end < 0 {
		return ""
	}
	start := end
	for start > 0 && !IsToolLine(lines[start-1]) {
		start--
	}
	return strings.TrimSpace(strings.Join(lines[start:end+1], "\n"))
}

// IsToolLine 是过程记录里的一行工具调用（「[工具] 」「[工具失败] 」开头）。
func IsToolLine(l string) bool {
	l = strings.TrimSpace(l)
	return strings.HasPrefix(l, "[工具] ") || strings.HasPrefix(l, "[工具失败] ")
}
