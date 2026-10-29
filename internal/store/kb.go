package store

import (
	"context"
	"time"
)

// 知识库（AG-01b3，0034），字段对齐原型 web-next/src/agentdata.ts 的 KnowledgeBase 和
// web-next/src/kbdata.ts 的 KbDoc、KbSettings（SPEC-settings-10 到 14）。

// 知识库文档的来源，同原型 KbDocSource。
const (
	KbSrcLibrary = "library" // 工作台文档，ref 是对象 id
	KbSrcDir     = "dir"     // 本地目录文件，ref 是文件绝对路径
	KbSrcUpload  = "upload"  // 上传的文件，ref 是文件名，原文件存在数据目录的 kb/ 下
	KbSrcLink    = "link"    // 网页链接，ref 是网址；不联网抓取，正文是用户贴的
	KbSrcNote    = "note"    // 手写笔记，没有 ref
)

// 索引状态，同原型 KbDocStatus。
const (
	KbIndexed = "indexed"
	KbPending = "pending"
	KbFailed  = "failed"
)

// KnowledgeBase 是一个知识库。Sources 是文档分类（type_id 为 doc 的 categories）id。
type KnowledgeBase struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Desc      string     `json:"desc"`
	Sources   []string   `json:"sources"`
	Settings  KbSettings `json:"settings"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// KbSettings 是知识库的设置。Top 是检索返回几段；Embed 只存不用。
type KbSettings struct {
	AutoSync  bool    `json:"auto_sync"`
	Dirs      []KbDir `json:"dirs"`
	ChunkSize int     `json:"chunk_size"`
	Overlap   int     `json:"overlap"`
	Top       int     `json:"top"`
	Embed     KbEmbed `json:"embed"`
}

// KbDir 是挂在知识库上的本地目录。Path 是解析软链后的绝对路径；SyncedAt 由同步写，接口传进来的忽略。
type KbDir struct {
	Path     string     `json:"path"`
	AutoSync bool       `json:"auto_sync"`
	SyncedAt *time.Time `json:"synced_at,omitempty"`
}

// KbEmbed 是向量化模型。
type KbEmbed struct {
	ProviderID string `json:"provider_id"`
	Model      string `json:"model"`
}

// KbInput 是新建、修改知识库的字段，nil 表示没给。Dirs 的路径由接口层校验过再传进来。
type KbInput struct {
	Name     *string          `json:"name"`
	Desc     *string          `json:"desc"`
	Sources  *[]string        `json:"sources"`
	Settings *KbSettingsInput `json:"settings"`
}

// KbSettingsInput 是设置里要改的字段，nil 表示没给。
type KbSettingsInput struct {
	AutoSync  *bool    `json:"auto_sync"`
	Dirs      *[]KbDir `json:"dirs"`
	ChunkSize *int     `json:"chunk_size"`
	Overlap   *int     `json:"overlap"`
	Top       *int     `json:"top"`
	Embed     *KbEmbed `json:"embed"`
}

// KbSource 是一篇资料的来源。
type KbSource struct {
	Type string `json:"type"`
	Ref  string `json:"ref,omitempty"`
}

// KbDoc 是知识库里的一篇资料。Chunks 是上次索引切出的段数，切分设置改了要重新索引才变。
type KbDoc struct {
	ID        string    `json:"id"`
	KbID      string    `json:"kb_id"`
	Title     string    `json:"title"`
	Source    KbSource  `json:"source"`
	Text      string    `json:"text"`
	Chunks    int       `json:"chunks"`
	Status    string    `json:"status"`
	Excluded  bool      `json:"excluded"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// KbChunk 是一次索引切出的一段，Start、End 是正文里的字符位置。
type KbChunk struct {
	Index int
	Start int
	End   int
	Text  string
}

// KbCounts 是一个知识库里各状态的篇数；Searchable、Chunks 是参与检索（已索引且没排除）的篇数和段数。
type KbCounts struct {
	Docs       int        `json:"docs"`
	Indexed    int        `json:"indexed"`
	Pending    int        `json:"pending"`
	Failed     int        `json:"failed"`
	Excluded   int        `json:"excluded"`
	Searchable int        `json:"searchable"`
	Chunks     int        `json:"chunks"`
	LastAt     *time.Time `json:"last_doc_at"`
}

// KbCandidate 是检索的一段候选。
type KbCandidate struct {
	DocID  string
	KbID   string
	Title  string
	Source KbSource
	Index  int
	Start  int
	End    int
	Text   string
}

// KnowledgeStore 是知识库的读写。校验名称、切分设置等在实现里；目录路径、文件读取、切块在 internal/kb。
type KnowledgeStore interface {
	// ListKnowledgeBases 新建的在前。DeleteKnowledgeBase 连同文档和切块一起删，
	// 同一个事务里从挂着它的 Agent 的 kbs 里摘掉，回删掉的那条和被摘掉它的 Agent id（按 Agent 新建的在前）。
	ListKnowledgeBases(ctx context.Context) ([]*KnowledgeBase, error)
	GetKnowledgeBase(ctx context.Context, id string) (*KnowledgeBase, error)
	CreateKnowledgeBase(ctx context.Context, in KbInput) (*KnowledgeBase, error)
	UpdateKnowledgeBase(ctx context.Context, id string, in KbInput) (*KnowledgeBase, error)
	DeleteKnowledgeBase(ctx context.Context, id string) (*KnowledgeBase, []string, error)
	// SetKbDirSynced 记一个目录的同步时间；目录已不在设置里时什么都不做。
	SetKbDirSynced(ctx context.Context, kbID, path string, at time.Time) error
	// KbCounts 是 知识库 id -> 篇数统计；没有文档的知识库不在里面。
	KbCounts(ctx context.Context) (map[string]KbCounts, error)

	// ListKbDocs 新加的在前。CreateKbDoc 的 ID、时间由实现填，状态为 pending、段数为 0。
	ListKbDocs(ctx context.Context, kbID string) ([]*KbDoc, error)
	GetKbDoc(ctx context.Context, kbID, docID string) (*KbDoc, error)
	CreateKbDoc(ctx context.Context, d *KbDoc) (*KbDoc, error)
	// UpdateKbDoc 改标题、正文、来源地址、排除；其余字段忽略。
	UpdateKbDoc(ctx context.Context, d *KbDoc) (*KbDoc, error)
	// IndexKbDoc 换掉这篇的切块并记状态：failed 时 chunks 应为空，errMsg 是原因。
	IndexKbDoc(ctx context.Context, docID, status, errMsg string, chunks []KbChunk) (*KbDoc, error)
	DeleteKbDocs(ctx context.Context, kbID string, ids []string) error

	// KbSearchCandidates 是这些知识库里已索引、没排除的文档中可能含任何一个检索词的切块，
	// 按 kbIDs 的顺序、文档新加的在前、段序号排列。有 FTS5 时用它预筛，没有就给全部切块，打分由调用方做。
	KbSearchCandidates(ctx context.Context, kbIDs []string, terms []string) ([]*KbCandidate, error)
}
