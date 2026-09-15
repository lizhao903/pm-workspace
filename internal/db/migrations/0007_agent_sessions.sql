-- 0007_agent_sessions: 主工作区底部对话框的会话、消息与产物
--
-- 三张表一条主线：一次对话（agent_sessions）产生若干消息（agent_messages），
-- 其中 Agent 写盘的那些额外在 agent_artifacts 里留一条索引。
--
-- 关于 workdir 存绝对路径：它是用户在界面上挑的本机目录，语义就是「这台机器上的
-- 这个位置」，没有可移植的相对基准。与之相对，agent_artifacts.path 存的是相对
-- workdir 的路径——换目录时只要改会话一行，产物索引整体跟着搬，不用逐行重写。
-- 路径越界（../、绝对路径、软链逃逸）由 internal/agent 在写盘前堵死，库这层不做校验：
-- SQLite 没有能力理解文件系统语义，把检查放在这里只会给出虚假的安全感。
--
-- provider_id 有意不加外键。会话是一份历史记录，删掉供应商不该连带删掉或
-- 阻塞历史对话；ON DELETE SET NULL 又会让「这轮对话当时用的哪个模型」丢失。
-- 留一个可能悬空的 id + 一份 model 快照，比两者都强。
--
-- 时间戳存的是带固定 9 位小数的 RFC3339（其余表是秒级）。一轮对话里
-- 「用户提问、工具调用、模型回复」几乎必然落在同一秒内，秒级精度下三条消息的
-- created_at 完全相同，排序会退化成按 id 比较，而 id 的低位是随机数——
-- 对话就会乱序显示。小数位补满 9 位是为了让 TEXT 字典序仍然等于时间序。
-- 具体见 internal/store/sqlite/agent.go 的 agentTimeLayout。
--
-- 不塞种子数据：会话由用户真实对话产生，预置的假会话只会让界面一打开就是脏的。

PRAGMA foreign_keys = ON;

CREATE TABLE agent_sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',   -- 可能指向已删除的供应商，见文件头
  model       TEXT NOT NULL DEFAULT '',   -- 快照：供应商改模型后，旧会话仍显示当时用的那个
  workdir     TEXT NOT NULL DEFAULT '',   -- 绝对路径，产物落盘根目录
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 会话列表按最近活跃排序，这是侧栏唯一的读法。
CREATE INDEX idx_agent_sessions_updated ON agent_sessions(updated_at DESC);

CREATE TABLE agent_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,              -- user | assistant | tool
  content    TEXT NOT NULL DEFAULT '',
  tool_name  TEXT NOT NULL DEFAULT '',   -- 仅 role=tool
  tool_args  TEXT NOT NULL DEFAULT '',   -- 仅 role=tool，JSON 原文，用于界面回放
  created_at TEXT NOT NULL
);

-- 取某会话的消息永远是「按时间正序全量」，id 兜底保证同毫秒写入的顺序稳定。
CREATE INDEX idx_agent_messages_session ON agent_messages(session_id, created_at, id);

CREATE TABLE agent_artifacts (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,              -- 相对 workdir，见文件头
  size       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 同一个文件被覆盖写多次只留一条，size 与 created_at 跟着最后一次更新。
-- 不这么做的话，反复改一份文档会在产物面板里堆出十几行同名记录。
CREATE UNIQUE INDEX idx_agent_artifacts_unique ON agent_artifacts(session_id, path);
