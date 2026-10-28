package runner

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 执行前后各扫一遍工作目录，差集就是这次执行的产出。
//
// 为什么是「扫目录」而不是「解析 claude 的工具调用」：Claude Code 写盘的方式不止一种
// （Write、Edit、Bash 里的重定向、它自己起的脚本），逐个认工具名必然漏。
// 漏掉的那些不会报错，只会让产物清单比真实产出少——而少了的部分看起来和没产出一样。
//
// 代价是会把「顺手改的源码」也算成产出。这个偏差是有意选的：宁可多记几条让用户删，
// 也好过安静地漏掉他真正要找的那份交付物。skipDirs 把最没有争议的几类挡在外面。

// skipDirs 是不参与扫描的目录名。
//
// 这几个都不是「产出」而是「产出的副产品或来源」：依赖、版本库、构建中间物。
// 一次 npm install 会在 node_modules 下动几万个文件，全记进产物表的话，
// 用户打开产物页看到的是几万行依赖，他真正要找的那份方案在第三万行。
//
// .pmw-runs 是本工作台自己写的执行日志（见 0009 迁移），把它记成用户的产出是错的。
var skipDirs = map[string]bool{
	".git": true, ".hg": true, ".svn": true,
	"node_modules": true, "vendor": true, "__pycache__": true,
	".venv": true, "venv": true, ".tox": true,
	"dist": true, "build": true, "target": true, ".next": true, ".nuxt": true,
	".pmw-runs": true, ".DS_Store": true,
	".idea": true, ".vscode": true, ".cache": true, ".pytest_cache": true,
}

// maxScanFiles 是单次扫描最多遍历的文件数。
//
// 有上限是因为用户可以把 workdir 指到任何目录，包括主目录。没有上限的话，
// 一次执行的收尾会变成对整块盘的遍历，而这发生在用户正等着看 done 事件的时候。
// 到达上限就停，宁可少记也不能把收尾卡死。
const maxScanFiles = 50000

// MaxRecordedArtifacts 是一次执行最多登记的产物条数。
//
// 到达上限**不是**静默截断：调用方拿到 Truncated=true，界面上要说出来。
// 安静地只记前 100 条，会让用户以为这次执行就产出了这些。
const MaxRecordedArtifacts = 100

// fileMark 是一个文件在某一时刻的样子。用（大小, 修改时间）而不是内容哈希：
// 哈希要读一遍全部文件内容，几百 MB 的工作目录下收尾会卡住好几秒。
// 代价是「内容变了但大小和 mtime 都没变」会漏——那需要在同一纳秒里写入等长的内容，
// 实际写盘做不到。
type fileMark struct {
	size    int64
	modTime int64
}

// Snapshot 是工作目录在某一时刻的文件清单，key 是绝对路径。
type Snapshot map[string]fileMark

// TakeSnapshot 扫一遍目录。错误一律吞掉只返回扫到的部分：
// 快照是个尽力而为的东西，因为一个没权限的子目录就让整次执行失败是本末倒置。
func TakeSnapshot(root string) Snapshot {
	snap := Snapshot{}
	if strings.TrimSpace(root) == "" {
		return snap
	}
	n := 0
	// 用 WalkDir 而不是 Walk：前者不对每个条目 stat，遍历大目录快得多。
	// 只有真正要记录的文件才 Info()。
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// 读不了的目录跳过，不中断整次遍历。
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if p != root && skipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		// 软链不跟：它可能指向工作目录之外，把那边的文件记成这次的产出是错的。
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if n++; n > maxScanFiles {
			return filepath.SkipAll
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		snap[p] = fileMark{size: info.Size(), modTime: info.ModTime().UnixNano()}
		return nil
	})
	return snap
}

// ChangedFile 是一个被这次执行新建或改动的文件。
type ChangedFile struct {
	Path string // 绝对路径
	Size int64
	New  bool // true = 执行前不存在
}

// Diff 返回 after 相对 before 新增或改动的文件，按路径排序。
//
// 只看新增和改动，**不报告删除**。删掉的文件不是产出，而且它可能本来就登记过产物
// ——那条记录该不该留是用户的判断（云端副本可能还在），不该由一次执行替他决定。
//
// Truncated 为 true 表示改动数超过了 MaxRecordedArtifacts，返回的是前 N 条。
// 调用方必须把这件事告诉用户，见 MaxRecordedArtifacts 的注释。
func Diff(before, after Snapshot) (changed []ChangedFile, truncated bool) {
	for p, now := range after {
		was, existed := before[p]
		if existed && was == now {
			continue
		}
		changed = append(changed, ChangedFile{Path: p, Size: now.size, New: !existed})
	}
	// 排序是为了让登记顺序稳定：不排的话 map 遍历每次不同，
	// 同一次执行重跑会得到不同的产物先后，看上去像数据在跳。
	// 在截断**之前**排序，所以这里可能有几万条：必须用 O(n log n)。
	sort.Slice(changed, func(i, j int) bool { return changed[i].Path < changed[j].Path })
	if len(changed) > MaxRecordedArtifacts {
		return changed[:MaxRecordedArtifacts], true
	}
	return changed, false
}
