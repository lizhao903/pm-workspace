-- 0001_settings: 终端插件自己的设置（交给 Claude Code「切换到终端」）
--
-- 一项一行，key / value 都是文本。目前只有 claude_command：在终端里开 Claude Code 会话的启动命令模板，
-- 没有这行时按默认值 gogogo。接口 GET / PATCH /api/terminal/settings，改了下次发起就用新的。

CREATE TABLE terminal_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
