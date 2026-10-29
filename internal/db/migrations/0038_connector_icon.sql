-- 0038_connector_icon: 连接器实例的自定义图标（CONN-04）
--
-- 自定义分类（custom_mcp、custom_openapi）可以换图标，存 data:image/ 开头的 data URL，没换为空串，
-- 同原型 web-next/src/data.ts 的 Connector.icon。内置连接器用品牌标志，不能改。
-- 同一工具可以接多个实例（CONN-04），本来就没建唯一索引（0029），不用改表。

ALTER TABLE connectors ADD COLUMN icon TEXT NOT NULL DEFAULT '';
