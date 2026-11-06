package connector

import "regexp"

// 连接器的平台图标（TSK-0725）。
//
// 图标文件随前端打包（frontend/src/core/ui/connector-logos，来源与授权见那里的 README.md），后端只给键：
// 定义的 Logo 留空时按 tool 从这张表补，插件登记的连接器也一样（插件自己给了 Logo 的以它为准）。
// 键前端不认识时界面退回文字图标，所以这里加了键、前端没放图标不会坏，只是不显示。
// 自定义连接器按服务地址认平台在前端做（frontend/src/core/data/connectorLogo.ts），认出来的不写库。

var logoRe = regexp.MustCompile(`^[a-z0-9]{1,40}$`)

// builtinLogos 是内置连接器（内核的和第一方插件的）的图标键。
var builtinLogos = map[string]string{
	GoogleDriveTool:    "googledrive",
	GoogleCalendarTool: "googlecalendar",
	CustomMCPTool:      "modelcontextprotocol",
	CustomOpenAPITool:  "openapiinitiative",
	SlackTool:          "slack",
	// 下面是插件登记的（im、trade、video），按 tool 字面量写，免得内核引用插件包
	"telegram":        "telegram",
	"binance_market":  "binance",
	"binance_account": "binance",
	"okx_market":      "okx",
	"okx_account":     "okx",
	"bilibili":        "bilibili",
	"bilibili_web":    "bilibili",
	"youtube":         "youtube",
	// 抖音和 TikTok 同属字节跳动、标志相同；Simple Icons 只有 TikTok 的
	"douyin": "tiktok",
}
