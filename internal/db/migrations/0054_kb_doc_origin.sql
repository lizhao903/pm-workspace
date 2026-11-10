-- 0054_kb_doc_origin: 知识库文档记「谁加进来的」（TSK-0721）
--
-- 插件按自己的资料同步知识库（项目插件的「项目资料同步到知识库」节点）时，只增改删自己加进来的那些篇，人工加的不动。
-- origin 是加进来的一方：空串是人在知识库页加的、目录和文档分类同步收进来的（和以前一样）；
-- 插件加的是「<插件 id>:<插件自己的范围>」，例 projects:obj_06gsmkp93hh3k0aj（这个项目同步进来的）。
-- origin_key 是这一篇在插件那边对应哪一条资料，插件自己定（例 material:pm_…/file:/abs/path、doc:obj_…），同一 origin 下唯一，
-- 增量同步按它认「还是不是同一篇」。人工加的两列都是空串。
-- 来源类型多一种 file（本机单个文件，source_ref 是绝对路径，重新索引时重读），只能由插件同步加，source_type 没有 CHECK，不改表结构。

ALTER TABLE kb_docs ADD COLUMN origin TEXT NOT NULL DEFAULT '';
ALTER TABLE kb_docs ADD COLUMN origin_key TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_kb_docs_origin ON kb_docs(kb_id, origin, origin_key);
