// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package plugin

import "path/filepath"

// 附件目录（IM-04a）：数据目录下的 attachments/，和库文件同级，备份数据目录时一起带走（docs/dev-decisions.md「消息附件存在哪」）。
// 只给路径、不建目录；子目录怎么分由插件定（IM 按渠道）。数据目录本身不给：库文件、vault.key 都在里面。

// AttachmentsSubdir 是附件目录在数据目录下的名字。
const AttachmentsSubdir = "attachments"

func (c *core) AttachmentDir() string {
	if c.reg == nil || c.reg.DataDir == "" {
		return ""
	}
	abs, err := filepath.Abs(c.reg.DataDir)
	if err != nil {
		return ""
	}
	return filepath.Join(abs, AttachmentsSubdir)
}

// 工作区目录（AUTO-07）：数据目录下的 worktrees/，项目插件在这里给每个进研发的任务建 git worktree，不放进代码库。
// 同附件目录只给路径、不建目录。

// WorktreesSubdir 是工作区目录在数据目录下的名字。
const WorktreesSubdir = "worktrees"

func (c *core) WorktreeDir() string {
	if c.reg == nil || c.reg.DataDir == "" {
		return ""
	}
	abs, err := filepath.Abs(c.reg.DataDir)
	if err != nil {
		return ""
	}
	return filepath.Join(abs, WorktreesSubdir)
}

// 插件缓存目录（TSK-0456）：数据目录下的 cache/<插件 id>/，放能重新生成的东西（视频插件的缩略图）。
// 同附件目录只给路径、不建目录；删了不丢数据，备份时可以跳过。写自己的缓存目录不要权限。

// CacheSubdir 是缓存目录在数据目录下的名字。
const CacheSubdir = "cache"

func (c *core) CacheDir() string {
	if c.reg == nil || c.reg.DataDir == "" || c.id == "" {
		return ""
	}
	abs, err := filepath.Abs(c.reg.DataDir)
	if err != nil {
		return ""
	}
	return filepath.Join(abs, CacheSubdir, c.id)
}
