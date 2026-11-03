-- 0034_knowledge_bases: 知识库、知识库文档和切块（AG-01b3）
--
-- knowledge_bases 一行是一个知识库，对应原型 web-next/src/agentdata.ts 的 KnowledgeBase，id 前缀 kb。
-- 原型的 desc 是 SQL 关键字，列名用 description，接口里仍叫 desc。
-- sources 是文档分类（categories，type_id = doc）id 的 JSON 数组；不建外键，分类删了照留，同步时跳过。
-- 设置对应原型 KbSettings：auto_sync、dirs（JSON [{path, auto_sync, synced_at?}]）、chunk_size、overlap，
-- 加上检索返回条数 top；embed 是 JSON {provider_id, model}，只存不用（先不做向量检索）。
-- Agent 挂载知识库存在 agents.kbs（0032），删除知识库时由代码从里面摘掉。
--
-- kb_docs 一行是知识库里的一篇资料，对应原型 KbDoc，id 前缀 kd。
-- source_type 为 library / dir / upload / link / note，source_ref 是对象 id、文件绝对路径、上传的文件名、网址，笔记为空串。
-- text 是索引用的正文；chunks 是上次索引切出的段数，status 为 indexed / pending / failed，error 是失败原因。
--
-- kb_chunks 是上次索引的切块，start_at / end_at 是在正文里的字符（rune）位置，text 是这一段的正文。
-- 关键词检索的 FTS5 索引 kb_chunks_fts 不在迁移里建：由代码在第一次用到时建，SQLite 不支持 FTS5 时退回逐块匹配。
-- 时间列用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

CREATE TABLE knowledge_bases (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  sources       TEXT NOT NULL DEFAULT '[]',
  auto_sync     INTEGER NOT NULL DEFAULT 1,
  dirs          TEXT NOT NULL DEFAULT '[]',
  chunk_size    INTEGER NOT NULL DEFAULT 300,
  overlap       INTEGER NOT NULL DEFAULT 50,
  top           INTEGER NOT NULL DEFAULT 5,
  embed         TEXT NOT NULL DEFAULT '{"provider_id":"","model":""}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE kb_docs (
  id            TEXT PRIMARY KEY,
  kb_id         TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  source_type   TEXT NOT NULL,
  source_ref    TEXT NOT NULL DEFAULT '',
  text          TEXT NOT NULL DEFAULT '',
  chunks        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  excluded      INTEGER NOT NULL DEFAULT 0,
  error         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_kb_docs_kb ON kb_docs(kb_id, created_at);
CREATE INDEX idx_kb_docs_source ON kb_docs(kb_id, source_type, source_ref);

CREATE TABLE kb_chunks (
  id            INTEGER PRIMARY KEY,
  doc_id        TEXT NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,
  text          TEXT NOT NULL
);

CREATE INDEX idx_kb_chunks_doc ON kb_chunks(doc_id, idx);
