-- 0012_artifacts: 把「输出产物」从 agent 的私有附属品提升为一等对象
--
-- 起因：agent_artifacts（0007）只记内置 agent 通过 write_file 落盘的文件，挂在会话上，
-- 存相对路径和大小。它答不了用户真正要问的那个问题——「这件事一共产出了什么」。
-- 真实的产出散在四个地方：内置 agent 写的文件、Claude Code 执行时直接写的文件、
-- 用户自己做的文档、以及别的 agent 发到 Confluence / Jira / 云盘上的东西。
-- 前者有记录，后三者一条都没有。
--
-- 用一张表而不是两张。「全部产物」这个数字如果只覆盖其中一个来源，它不会报错、
-- 不会为空、看上去完全正常——只是偏小。这个项目反复栽在这种数上，不再多造一个。
--
--
-- 一、一条产物可以同时有 path 和 url，不是二选一
--
-- 典型路径就是「先在本地写出 处理方案.md，再发到 Confluence」。这是同一份交付物的
-- 两个位置，拆成两行会让总数凭空翻倍，而「产出了几份东西」正是这张表存在的理由。
-- 所以 path 和 url 各自可空，CHECK 只要求至少有一个——一条哪儿都找不到的产物
-- 记录没有任何用途，那是一行噪音。
--
--
-- 二、object_id 用 ON DELETE SET NULL，跟 task_runs 的 CASCADE 相反
--
-- 看着不一致，但两者记的是不同性质的东西。task_runs 记的是「这个平台做过什么」，
-- 脱离了它的主体就是一堆没有主语的日志。artifacts 记的是**一个存在于这个库之外的
-- 东西在哪里**——Confluence 上那个页面、磁盘上那个文件，删掉工作对象它们照样在。
-- 而这一行往往是那个 URL 在本机唯一的索引。CASCADE 掉它，等于用户删了一条需求，
-- 顺手永久丢掉了当初发出去的页面地址，且没有任何提示。
-- 失去归属的产物会以「未归属」出现在产物页里，可以重新挂到别的对象上。
--
-- 注意软删（回收站）不触发这条，只有硬删才会。
--
--
-- 三、path 存绝对路径，另存 base_dir，不存相对路径
--
-- 0007 当初存相对路径，理由是「换目录时只改会话一行，产物索引整体跟着搬」。
-- 那个理由在这里不成立：手工登记的产物、别的 agent 回写的产物都没有会话，
-- 也就没有可依赖的基准目录，相对路径无从解释。
--
-- 但也没有退回成只存绝对路径。base_dir 记下登记当时的基准目录（没有就是空），
-- 相对路径 = Rel(base_dir, path) 现算。这样「搬目录只改一行」的性质还在，
-- 而绝对和相对两个值不可能互相矛盾——因为只存了一个。
-- 存两个路径字符串才是危险的：文件挪窝后改了一个漏了另一个，两边都不报错。
--
--
-- 四、platform 走 dictionaries，不硬编码
--
-- 平台名单是会变的（今天 Confluence，明天飞书），而 priority 和 link_relation
-- 已经用字典解决过同一个问题。复用它，用户在设置里就能自己加，不用改代码发版。
-- meta.hosts 是域名特征：界面上粘一个 URL 进来时靠它自动选中平台。
--
--
-- 五、唯一索引按「自动记录者」各管各的，手工登记不受约束
--
-- 0007 的索引是为了防止「反复改一份文档，产物面板堆出十几行同名记录」。这个保证要留。
-- 但把它推广成「同一对象下同一路径只能有一行」就错了：同一个本地文件先发 Confluence
-- 再发飞书，那是两条合理的产物记录，DB 不该拦。
-- 所以两个部分唯一索引，各自只覆盖自己那个自动来源的范围。

PRAGMA foreign_keys = ON;

CREATE TABLE artifacts (
  id         TEXT PRIMARY KEY,
  object_id  TEXT REFERENCES objects(id) ON DELETE SET NULL,          -- 见文件头第二节
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,   -- 出处：内置 agent 会话
  run_id     TEXT REFERENCES task_runs(id) ON DELETE SET NULL,        -- 出处：Claude Code 执行

  title      TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL DEFAULT '',   -- 绝对路径，空表示这条只在云端
  base_dir   TEXT NOT NULL DEFAULT '',   -- path 的基准目录，空表示没有基准；相对路径由两者现算
  url        TEXT NOT NULL DEFAULT '',   -- 空表示这条只在本地
  platform   TEXT NOT NULL DEFAULT '',   -- dict_items(dict_id='artifact_platform').key
  size       INTEGER NOT NULL DEFAULT 0, -- 字节；仅本地文件有意义，云端产物是 0
  source     TEXT NOT NULL,              -- manual | agent | run | mcp，记录是谁登记的
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  -- 两个位置都空的产物记录指不到任何东西，留着只会让统计数字虚高。
  CHECK (path <> '' OR url <> '')
);

-- 产物页和对象详情页的读法都是「按时间倒序」，前者不带 object_id 过滤，后者带。
CREATE INDEX idx_artifacts_object ON artifacts(object_id, created_at DESC);
-- 统计页按平台分组；全局列表不带过滤时也走这条。
CREATE INDEX idx_artifacts_platform ON artifacts(platform, created_at DESC);
CREATE INDEX idx_artifacts_created ON artifacts(created_at DESC);
CREATE INDEX idx_artifacts_session ON artifacts(session_id);
CREATE INDEX idx_artifacts_run ON artifacts(run_id);

-- 见文件头第五节：两个自动来源各自在自己的范围内去重，手工登记不受限。
CREATE UNIQUE INDEX idx_artifacts_session_path
  ON artifacts(session_id, path) WHERE session_id IS NOT NULL AND path <> '';
CREATE UNIQUE INDEX idx_artifacts_run_path
  ON artifacts(run_id, path) WHERE run_id IS NOT NULL AND path <> '';


-- --- 平台字典 ---
--
-- builtin=1：和 priority / link_relation 一样，整个字典不允许删；条目本身可以停用。
INSERT INTO dictionaries (id,name,description,scope,builtin,sort_order,created_at,updated_at) VALUES
 ('artifact_platform','产物平台','输出产物所在的平台，落在 artifacts.platform','global',1,30,datetime('now'),datetime('now'));

-- meta.hosts 是域名特征，界面粘 URL 时据此自动选平台；local 没有域名，给空数组。
-- 名单按用户现有的工具链来：Confluence / Jira 是需求和任务的落点，
-- 飞书、云盘、Slack 是交付和知会的落点，Figma 是设计稿，GitHub 是代码。
INSERT INTO dict_items (id,dict_id,type_id,key,label,color,description,sort_order,meta,archived_at,created_at,updated_at) VALUES
 ('dit_plt_local','artifact_platform',NULL,'local','本地文件','#868e96','只在这台机器上',10,'{"hosts":[]}',NULL,datetime('now'),datetime('now')),
 ('dit_plt_confluence','artifact_platform',NULL,'confluence','Confluence','#0c8599','',20,'{"hosts":["atlassian.net/wiki","confluence"]}',NULL,datetime('now'),datetime('now')),
 ('dit_plt_jira','artifact_platform',NULL,'jira','Jira','#3b5bdb','',30,'{"hosts":["atlassian.net/browse","atlassian.net/jira"]}',NULL,datetime('now'),datetime('now')),
 ('dit_plt_feishu','artifact_platform',NULL,'feishu','飞书','#0d9488','',40,'{"hosts":["feishu.cn","larksuite.com"]}',NULL,datetime('now'),datetime('now')),
 ('dit_plt_gdrive','artifact_platform',NULL,'gdrive','Google Drive','#e8590c','',50,'{"hosts":["drive.google.com","docs.google.com"]}',NULL,datetime('now'),datetime('now')),
 ('dit_plt_slack','artifact_platform',NULL,'slack','Slack','#7048e8','',60,'{"hosts":["slack.com"]}',NULL,datetime('now'),datetime('now')),
 ('dit_plt_figma','artifact_platform',NULL,'figma','Figma','#c2255c','',70,'{"hosts":["figma.com"]}',NULL,datetime('now'),datetime('now')),
 ('dit_plt_github','artifact_platform',NULL,'github','GitHub','#212529','',80,'{"hosts":["github.com","bitbucket.org"]}',NULL,datetime('now'),datetime('now')),
 ('dit_plt_pagehub','artifact_platform',NULL,'pagehub','PageHub','#1971c2','',90,'{"hosts":["pagehub"]}',NULL,datetime('now'),datetime('now')),
 ('dit_plt_other','artifact_platform',NULL,'other','其他','#495057','',100,'{"hosts":[]}',NULL,datetime('now'),datetime('now'));


-- --- 搬运 agent_artifacts ---
--
-- 真库里这张表是 0 行（唯一一次 write_file 因为会话没设产物目录而失败了）。
-- 仍然照实写搬运语句：别的机器上的库不一定是空的，而「反正是空的」这种假设
-- 一旦不成立，丢的是用户的数据且不会有任何报错。
--
-- 老表存的是相对 workdir 的路径，这里拼回绝对路径，并把会话的 workdir 记进 base_dir。
-- workdir 为空的老记录拼不出绝对路径，就原样留在 path 里、base_dir 留空——
-- 那是条不完整的记录，但丢掉它比留着更糟。
INSERT INTO artifacts (id, object_id, session_id, run_id, title, path, base_dir, url,
                       platform, size, source, note, created_at, updated_at)
SELECT
  a.id,
  s.object_id,
  a.session_id,
  NULL,
  '',
  CASE WHEN trim(coalesce(s.workdir,'')) = '' THEN a.path
       ELSE rtrim(s.workdir,'/') || '/' || a.path END,
  coalesce(s.workdir,''),
  '',
  'local',
  a.size,
  'agent',
  '',
  a.created_at,
  a.created_at
FROM agent_artifacts a
JOIN agent_sessions s ON s.id = a.session_id;

DROP TABLE agent_artifacts;
