-- 0008_im_trigger: IM 触发的过滤条件、执行顺序与拦截（TSK-0481，插件 0.14.0）
--
-- im_filter 是触发方式为 im 时的过滤条件（JSON）：
--   {"conversations": ["cv_…"], "relevance": ["me", "all", "dm", "none"], "relevance_mode": "include" | "exclude"}
--   conversations 是内核会话 id，空表示全部会话；relevance 是「与我的关系」，none 指无关（事件里 relevance 为空串），
--   空表示不限；relevance_mode 是 include（只要这几种）或 exclude（除了这几种）。缺省 '{}' 即不过滤。
-- im_order 是 IM 流程的执行顺序，小的先判断、先发起；同值按 created_at、rowid。接口回的 order 是在 IM 流程里排第几（1 起）。
-- im_stop 为 1 时，这条流程对某条消息命中过滤并发起了执行后，排在它后面的 IM 流程对这条消息不再发起（拦截）。
--
-- 已有流程：不过滤、不拦截，im_order 都是 0，同值按 created_at、rowid 排，和以前「按新建先后逐条发起」一致；
-- 之后新建的排在最后（im_order 取最大值加 1），调整顺序时插件把 IM 流程重新从 1 编号。
-- （插件迁移只许 CREATE TABLE、CREATE INDEX、ALTER TABLE ADD COLUMN，不在这里回填。）

ALTER TABLE sop_flows ADD COLUMN im_filter TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sop_flows ADD COLUMN im_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sop_flows ADD COLUMN im_stop INTEGER NOT NULL DEFAULT 0;
