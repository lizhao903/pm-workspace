-- 0031_artifact_provenance: 产物的产出者、种类、状态和非对象归属（AG-03b）
--
-- 方案见 docs/file-artifact-model.md 第 4、5 节。0012 的表结构、CHECK、两个部分唯一索引、
-- source 的取值和判定规则一概不动，这里只加列、加索引、加字典、建 object_origins。
--
-- source 和 actor_type 两个都留，不是一回事：
--   source 是登记途径（manual / agent / run / mcp），服务端判定、不接受自报，统计只认它；
--   actor_* 是产出者，可由调用方声明（比如 MCP 回写时说明是哪个技能做的），只用来展示和筛选。
--
-- scope_type + scope_id 记不是工作对象的归属（知识库、视频插件自己的实体等），空串表示没有。
-- 不加外键：归属实体被删时由对应模块处理它名下的行。
--
-- files 表（资料）不在这个迁移里：本批没有 /api/files，先建表等于提前锁死表结构，
-- 由第一个用到它的任务（PJ-03a）连同接口一起加。

PRAGMA foreign_keys = ON;

ALTER TABLE artifacts ADD COLUMN kind        TEXT NOT NULL DEFAULT '';   -- 字典 artifact_kind 的 key，空表示未分类
ALTER TABLE artifacts ADD COLUMN status      TEXT NOT NULL DEFAULT '';   -- draft | review | final | published，空表示不跟踪
ALTER TABLE artifacts ADD COLUMN actor_type  TEXT NOT NULL DEFAULT '';   -- user | agent | skill | sop | run | mcp | im | sync
ALTER TABLE artifacts ADD COLUMN actor_id    TEXT NOT NULL DEFAULT '';   -- Agent id、技能名、SOP id；用户为空
ALTER TABLE artifacts ADD COLUMN actor_label TEXT NOT NULL DEFAULT '';   -- 产出当时的名字快照
ALTER TABLE artifacts ADD COLUMN scope_type  TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN scope_id    TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN props       TEXT NOT NULL DEFAULT '{}';

-- 老数据补产出者：登记途径能确定产出者的照填，manual 视为用户本人。
UPDATE artifacts SET actor_type = CASE source
  WHEN 'manual' THEN 'user' WHEN 'agent' THEN 'agent'
  WHEN 'run' THEN 'run' WHEN 'mcp' THEN 'mcp' ELSE '' END
WHERE actor_type = '';

-- 代码类产物以前把种类写在备注开头的标记里（[commit] / [branch] / [pr]），回填到 kind。
-- 只改数据，备注原样保留：pmw_record_artifact 还会再写一个版本的前缀做兼容。
UPDATE artifacts SET kind = 'commit' WHERE kind = '' AND note LIKE '[commit]%';
UPDATE artifacts SET kind = 'branch' WHERE kind = '' AND note LIKE '[branch]%';
UPDATE artifacts SET kind = 'pr'     WHERE kind = '' AND note LIKE '[pr]%';

CREATE INDEX idx_artifacts_kind  ON artifacts(kind, created_at DESC) WHERE kind <> '';
CREATE INDEX idx_artifacts_actor ON artifacts(actor_type, actor_id, created_at DESC);
CREATE INDEX idx_artifacts_scope ON artifacts(scope_type, scope_id, created_at DESC) WHERE scope_type <> '';


-- --- 种类字典 ---
--
-- 内核只放通用条目和代码类三种；视频类别由视频插件自己的迁移往这个字典里加。
INSERT INTO dictionaries (id,name,description,scope,builtin,sort_order,created_at,updated_at) VALUES
 ('artifact_kind','产物种类','输出产物的种类，落在 artifacts.kind','global',1,40,datetime('now'),datetime('now'));

INSERT INTO dict_items (id,dict_id,type_id,key,label,color,description,sort_order,meta,archived_at,created_at,updated_at) VALUES
 ('dit_akd_doc','artifact_kind',NULL,'doc','文档','#1971c2','',10,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_akd_prototype','artifact_kind',NULL,'prototype','原型','#c2255c','',20,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_akd_code','artifact_kind',NULL,'code','代码','#212529','',30,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_akd_commit','artifact_kind',NULL,'commit','提交','#495057','代码类：一次 commit',40,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_akd_branch','artifact_kind',NULL,'branch','分支','#5f3dc4','代码类：一个工作分支',50,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_akd_pr','artifact_kind',NULL,'pr','合并请求','#2b8a3e','代码类：一个 PR',60,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_akd_data','artifact_kind',NULL,'data','数据','#e8590c','',70,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_akd_other','artifact_kind',NULL,'other','其他','#868e96','',100,'{}',NULL,datetime('now'),datetime('now'));


-- --- object_origins ---
--
-- 工作对象是谁建的，只记创建那一刻，后续修改由 revisions 记。不往 objects 加列：
-- 绝大多数对象是用户手建的，溯源只对少数行有意义，objects 又是最热的表。
-- 老对象没有记录，视为用户建的。本迁移只建表，写入由 AG-01 接。
CREATE TABLE object_origins (
  object_id   TEXT PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  actor_type  TEXT NOT NULL DEFAULT '',
  actor_id    TEXT NOT NULL DEFAULT '',
  actor_label TEXT NOT NULL DEFAULT '',
  session_id  TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  run_id      TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_object_origins_actor ON object_origins(actor_type, actor_id, created_at DESC);
