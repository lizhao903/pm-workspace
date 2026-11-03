-- 0027_contact_identities: IM 身份表（CT-01b）
--
-- 原型 web-next/src/data.ts 的 Contact.im 是「渠道 key → 编号」挂在联系人身上，消息按
-- channel + sender_id 去扫全部联系人认人（messages.tsx 的 contactFor）。这里拆成独立的表：
-- 一个联系人可以有多个渠道身份，同一渠道同一编号只能属于一个联系人，靠唯一索引兜底。
--
-- stakeholder_id 指向干系人名册（联系人沿用名册，见 0026）。联系人删除时身份跟着删（CASCADE）：
-- 身份是联系人自己的属性，和电话、邮箱一样，不是别处对他的引用。
-- channel 是渠道 key（wechat、lark、slack、telegram、qq，可扩展），不建外键也不约束取值。
-- external_id 是渠道里的编号（微信号、Slack Member ID……），去首尾空白后存；telegram 去掉开头的 @。
-- display_name 是在该渠道里看到的名字（昵称），可空；account 是在哪个自己的账号下认识的，可空。
-- created_at、updated_at 用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

CREATE TABLE contact_identities (
  id              TEXT PRIMARY KEY,
  stakeholder_id  TEXT NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  display_name    TEXT NOT NULL DEFAULT '',
  account         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (channel, external_id)
);

CREATE INDEX idx_contact_identities_stakeholder ON contact_identities(stakeholder_id, channel);
