-- 0004_prototypes: 项目原型的定义和崩溃记录（PJ-04a）
--
-- 原型 web-next/src/projectdata.ts 的 Prototype 拆两半：命令、目录、端口这些定义落库；
-- 状态、日志、进程号只在服务进程内存里（服务关闭、插件停用时原型进程全部停掉，重启后都是已停止）。
-- argv 是 JSON 字符串数组，执行时不经 shell；command 是给人看的原文。
-- dir 存本机绝对路径（同项目资料）。端口不设唯一：同一端口的两个原型可以轮流跑，启动时再查冲突。
--
-- 崩溃记录：运行异常模块还没有后端，进程非 0 退出或被信号杀掉时先记在这里，以后对接。
-- 硬删项目、删原型时一起删；软删项目不动。

CREATE TABLE projects_prototypes (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  dir        TEXT NOT NULL,
  command    TEXT NOT NULL,
  argv       TEXT NOT NULL,
  port       INTEGER NOT NULL CHECK (port BETWEEN 1024 AND 65535),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX projects_prototypes_by_project ON projects_prototypes(project_id, created_at);

CREATE TABLE projects_prototype_crashes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  prototype_id TEXT NOT NULL REFERENCES projects_prototypes(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  exit_code    INTEGER NOT NULL,
  signal       TEXT NOT NULL DEFAULT '',
  reason       TEXT NOT NULL,
  log          TEXT NOT NULL DEFAULT '',
  started_at   TEXT NOT NULL,
  exited_at    TEXT NOT NULL
);

CREATE INDEX projects_prototype_crashes_by_prototype ON projects_prototype_crashes(prototype_id, id);
