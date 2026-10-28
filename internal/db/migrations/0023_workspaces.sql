-- 0023_workspaces: 工作台配置（CORE-10a）
--
-- 工作台是一套菜单：开哪些模块、怎么分组、默认打开哪个、需要哪些插件。工作台之间数据不隔离，切工作台只换菜单。
-- 两张表：
--   workspace_templates 是预设模板（新建工作台时挑），只读，内容和原型 web-next/src/workspacedata.ts 的 TEMPLATES 一致；
--   workspaces 是用户的工作台，按六个预设模板（不含「自定义」）各建一个，id 和原型一致（ws_pm 等）。
-- groups 是 JSON：模板 [{name, modules}]，工作台 [{id, name, modules, collapsed}]；name 留空只分隔不显示标题。
-- mark 是 JSON {text, color, image?, icon?}，没有标识为 'null'。
-- plugins 是 JSON 数组，列出模块用到的插件 id（内核模块今日、任务、文档、联系人、会话不需要插件）。
-- template 记工作台从哪个模板建的，空串为空白新建；模板删不掉，删了预设工作台还能从模板重建。
-- created_at、updated_at 用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

CREATE TABLE workspace_templates (
  id           TEXT PRIMARY KEY,
  role         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  groups       TEXT NOT NULL DEFAULT '[]',
  home         TEXT NOT NULL,
  mark         TEXT NOT NULL DEFAULT 'null',
  plugins      TEXT NOT NULL DEFAULT '[]',
  position     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workspaces (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  groups       TEXT NOT NULL DEFAULT '[]',
  home         TEXT NOT NULL,
  mark         TEXT NOT NULL DEFAULT 'null',
  plugins      TEXT NOT NULL DEFAULT '[]',
  template     TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_workspaces_position ON workspaces(position);

INSERT INTO workspace_templates (id, role, name, description, groups, home, mark, plugins, position) VALUES
  ('ws_pm', '产品经理', '产品经理工作台', '需求、项目、原型、客户沟通都要管',
   '[{"name":"","modules":["today"]},{"name":"工作","modules":["projects","tasks","library"]},{"name":"沟通","modules":["messages","contacts","sessions"]},{"name":"自动化","modules":["sop","terminal","browser"]}]',
   'today', '{"text":"","color":"#3d4fd6","icon":"compass"}', '["projects","im","sop","terminal","browser"]', 1),
  ('ws_dev', '研发工程师', '研发工作台', '任务、项目原型、终端和浏览器为主',
   '[{"name":"","modules":["today"]},{"name":"研发","modules":["tasks","projects","terminal","browser"]},{"name":"资料","modules":["library","sessions"]},{"name":"自动化","modules":["sop"]}]',
   'tasks', '{"text":"","color":"#0f8a8a","icon":"code"}', '["projects","terminal","browser","sop"]', 2),
  ('ws_ops', '运营 / 客户成功', '运营工作台', '消息、联系人和流程为主',
   '[{"name":"","modules":["today"]},{"name":"客户","modules":["messages","contacts"]},{"name":"跟进","modules":["tasks","sop"]},{"name":"资料","modules":["library","sessions","browser"]}]',
   'messages', '{"text":"","color":"#b0570b","icon":"headset"}', '["im","sop","browser"]', 3),
  ('ws_video', '视频博主', '视频创作工作台', '视频制作、系列、多平台发布和粉丝合作',
   '[{"name":"","modules":["today"]},{"name":"创作","modules":["videos","library","sessions"]},{"name":"发布与互动","modules":["tasks","messages"]},{"name":"合作","modules":["contacts","projects"]},{"name":"工具","modules":["sop","terminal","browser"]}]',
   'videos', '{"text":"","color":"#e8590c","icon":"video"}', '["videos","im","projects","sop","terminal","browser"]', 4),
  ('ws_trader', '交易员', '交易工作台', '看盘盯盘、策略回测、账户执行和风控',
   '[{"name":"","modules":["today"]},{"name":"行情","modules":["markets","monitor"]},{"name":"策略与执行","modules":["strategy","trading"]},{"name":"资讯","modules":["messages","library","browser"]},{"name":"工具","modules":["tasks","sessions","terminal"]}]',
   'markets', '{"text":"","color":"#c0352b","icon":"candles"}', '["markets","monitor","strategy","trading","im","browser","terminal"]', 5),
  ('ws_all', '全部模块', '0xBroleez', '所有功能模块都开着',
   '[{"name":"","modules":["today"]},{"name":"工作","modules":["projects","tasks","library"]},{"name":"视频","modules":["videos"]},{"name":"交易","modules":["markets","monitor","strategy","trading"]},{"name":"沟通","modules":["messages","contacts","sessions"]},{"name":"工具","modules":["sop","terminal","browser"]}]',
   'today', '{"text":"0x","color":"#161823"}', '["projects","videos","markets","monitor","strategy","trading","im","sop","terminal","browser"]', 6),
  ('custom', '自定义', '我的工作台', '从空白开始，自己挑模块',
   '[{"name":"","modules":["today"]}]',
   'today', 'null', '[]', 7);

-- 预设工作台：分组 id 在一个工作台内唯一即可，按顺序写成 g1、g2…
INSERT INTO workspaces (id, name, role, description, groups, home, mark, plugins, template, position, created_at, updated_at)
SELECT t.id, t.name, t.role, t.description,
       (SELECT json_group_array(json_object('id', 'g' || (CAST(g.key AS INTEGER) + 1), 'name', json_extract(g.value, '$.name'),
                                            'modules', json(json_extract(g.value, '$.modules')), 'collapsed', json('false')))
          FROM json_each(t.groups) AS g),
       t.home, t.mark, t.plugins, t.id, t.position,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM workspace_templates AS t
 WHERE t.id <> 'custom'
 ORDER BY t.position;
