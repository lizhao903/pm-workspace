-- 0058_dsh_prefix_cache: deepseek 模块前缀复用与缓存用量（P0 模块前缀实验）
--
-- 目标：每任务仍起一个新的 dsh 会话，但首个 user 消息以同一段「模块简报」开头，
-- 让服务商的前缀缓存命中固定那一段；同时把 dsh 会话日志里的 token 用量落到执行记录上，
-- 以后好不好用数据说话。
--
-- module_prefixes 一行是一个模块（project:<项目 id> 或 workdir:<绝对路径>）的当前简报：
--   briefing 是逐字节发给模型的那段前缀，只追加不重写（重写会让缓存整段失效）；
--   version 每追加一次 +1，执行记录上的 prefix_version 记下这次用的是哪一版；
--   updated_at 是最后写入时间。
-- 简报只由工作台按库里的执行记录程序化生成（历史任务的一行结论摘要），不调用任何模型。
--
-- task_runs 新增模块归属与用量列：module_key / prefix_version 说明这次复用了哪版模块前缀，
-- cache_read_tokens / uncached_input_tokens / output_tokens 来自 dsh 会话日志（assistant/message 的 usage），
-- 老记录和新的一次性执行都是 0 / 空串。

ALTER TABLE task_runs ADD COLUMN module_key TEXT NOT NULL DEFAULT '';
ALTER TABLE task_runs ADD COLUMN prefix_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN uncached_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;

CREATE TABLE module_prefixes (
  module_key TEXT PRIMARY KEY,
  briefing   TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
