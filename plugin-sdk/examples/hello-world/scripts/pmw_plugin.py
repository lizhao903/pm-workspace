# powered by dsh - https://github.com/deepseek-ai/deepseek-harness

"""PMW 外部插件开发工具（草案 v0.1，宿主 P1 未实现）。

五个子命令：

  init <dir> --id=... --owner=...   用模板生成插件骨架（默认顺带构建后端二进制）
  validate <dir>                    校验 plugin.json 与包内文件
  pack <dir> [--os --arch]          打发布包 dist/<id>-<version>-<os>-<arch>.tar.gz + SHA256SUMS
  self-test                         在临时目录跑 init → validate → pack → 解包复校验
  install-check <dir> [--pmw-url]   探测目标 PMW 是否支持外部插件

只用 Python 标准库；除 install-check 只请求本机 PMW 外不联网。
规范和字段定义见 PMW 仓库的 docs/plugin-spec-v2.md 与 plugin-sdk 的 references/。
"""

import argparse
import base64
import binascii
import datetime
import gzip
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# 规范常量（与 docs/plugin-spec-v2.md、docs/plugin-manifest.schema.json 保持一致）
# ---------------------------------------------------------------------------

SCRIPT_PATH = Path(__file__).resolve()
# 安装 skill 后脚本在 <skill>/scripts/pmw_plugin.py，模板在 <skill>/assets/templates。
SKILL_ROOT = SCRIPT_PATH.parent.parent
TEMPLATES_DIR = SKILL_ROOT / "assets" / "templates"

HOST_API_VERSION = "2.0.0"
HOST_MIN_PMW = "0.3.0"
DEFAULT_API_RANGE = ">=2.0.0 <3.0.0"
DEFAULT_PMW_RANGE = ">=0.3.0 <1.0.0"
MANIFEST_VERSION = 2
PROTOCOL = "pmw-plugin-rpc/1"

# 发布矩阵（和 assets/templates/.github/workflows/release.yml.tmpl 一致；发布检查强制前两个）。
RELEASE_MATRIX = ["darwin-arm64", "linux-amd64", "windows-amd64"]

ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,23}$")
KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
VERSION_RE = re.compile(r"^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$")
COMPARATOR_RE = re.compile(
    r"^(>=|<=|>|<|=|\^|~)?"
    r"(0|[1-9][0-9]{0,8})"
    r"(?:\.(0|[1-9][0-9]{0,8}))?"
    r"(?:\.(0|[1-9][0-9]{0,8}))?$"
)
EVENT_RE = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")
SECRETS_RE = re.compile(r"^secrets:[a-z][a-z0-9_]*$")
PLATFORM_RE = re.compile(r"^(darwin|linux|windows)-(amd64|arm64)$")
URL_RE = re.compile(r"^(https?://|git\+https?://|git@)")
CJK_RE = re.compile(r"[\u4e00-\u9fff]")

# 内核保留字，照抄 internal/plugin/manifest.go 的 ReservedIDs（v2 继续沿用）。
RESERVED_IDS = frozenset(
    """
    api admin agent agent_providers agents artifacts audits categories connectors
    contacts conversations core counts dict_items dictionaries events fs health hooks
    incident incidents kernel knowledge_bases library links notifications objects
    object_types plugins revisions runs schedules sessions settings shortcut_groups
    shortcuts skills stakeholders stats tags tasks today webhooks workspaces
    """.split()
)

# 当前编译进内核的第一方插件 id（以 internal/plugins/ 目录为准）；外部插件 id 不能和它们冲突。
BUILTIN_PLUGIN_IDS = frozenset(
    "browser domains etf im jobs projects recording sop terminal trade tts video".split()
)

# 清单 v2 可申请的权限（brief 3.4）。隐式权限不写进清单。
REQUESTABLE_PERMISSIONS = frozenset(
    """
    objects:read objects:write events:subscribe
    fs:read:project fs:write:project fs:read:attachments fs:write:attachments
    fs:read:any fs:write:any
    network:localhost network:im network:media-platforms network:github network:market-data
    network:model network:exchanges network:any
    process:spawn agent:run notify schedule artifacts:write audit:write
    """.split()
)
IMPLICIT_PERMISSIONS = frozenset({"store:plugin", "log:write"})
# v0.1 外部插件一律不授予实盘；评审也不接受。保留在识别表里是为了给出明确错误。
FORBIDDEN_PERMISSIONS = frozenset({"trade:live"})
# 高风险权限：安装时不授予，安装后单独申请 + 二次确认。
SEPARATE_AUTH_PERMISSIONS = frozenset({"fs:write:any", "network:any", "process:spawn", "trade:live"})

PROVIDES_KEYS = [
    "modules",
    "settings",
    "object_types",
    "connectors",
    "skills",
    "agent_tools",
    "sop_nodes",
    "today_cards",
    "commands",
    "search",
    "schedule_actions",
]
# 允许出现在清单里的顶层字段。v2 禁止 adopts / table_prefix / core（用 api 代替）。
ALLOWED_MANIFEST_KEYS = frozenset(
    [
        "manifest_version",
        "id",
        "name",
        "description",
        "version",
        "api",
        "pmw",
        "license",
        "homepage",
        "repository",
        "publisher",
        "icon",
        "provides",
        "permissions",
        "permissions_reason",
        "runtime",
        "depends",
        "optional_depends",
        "emits",
        "subscribes",
        "migrations",
    ]
)
FORBIDDEN_MANIFEST_KEYS = {
    "adopts": "v2 不再支持 adopts（外部插件只认领自己的对象类型）",
    "table_prefix": "v2 不再有 table_prefix（插件库由宿主分配，走 host.store.*）",
    "core": "v2 用 api 字段声明宿主插件 API 范围，不用 core",
    "icons": "v2 的图标是包内文件路径（icon），不是外壳内置图标 key",
}

# init 时替换的占位符。模板里不写死作者和日期，全部由 init 填。
PLACEHOLDERS = ("{{PMW_ID}}", "{{PMW_NAME}}", "{{PMW_DESCRIPTION}}", "{{PMW_OWNER}}", "{{PMW_VERSION}}", "{{PMW_YEAR}}")

EXIT_OK = 0
EXIT_FAIL = 1


class Fatal(Exception):
    """工具自身的致命错误（参数错、模板缺失、构建失败等），退出码 1。"""


# ---------------------------------------------------------------------------
# 版本范围：与 internal/plugin/semver.go 同一套规则
# ---------------------------------------------------------------------------


def parse_version(text):
    """解析 MAJOR.MINOR.PATCH；不支持预发布标签。返回 (a, b, c) 或 None。"""
    if not isinstance(text, str):
        return None
    m = VERSION_RE.match(text)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _cmp(a, b):
    if a < b:
        return -1
    if a > b:
        return 1
    return 0


def _comparator_match(op, bound, version):
    d = _cmp(version, bound)
    if op == ">=":
        return d >= 0
    if op == ">":
        return d > 0
    if op == "<=":
        return d <= 0
    if op == "<":
        return d < 0
    return d == 0


def parse_range(text):
    """解析版本范围，返回比较元组列表；不合法返回 None。

    规则同 Go：空格分隔表示同时满足；省略三段中的后两段只允许跟比较运算符；
    ^、~、精确版本必须写全三段；不支持 ||、*、x 和预发布标签。
    """
    if not isinstance(text, str):
        return None
    parts = text.split()
    if not parts:
        return None
    comparators = []
    for part in parts:
        m = COMPARATOR_RE.match(part)
        if not m:
            return None
        op = m.group(1) or ""
        minor = m.group(3)
        patch = m.group(4)
        full = minor is not None and patch is not None
        if not full and op in ("", "=", "^", "~"):
            return None
        version = (
            int(m.group(2)),
            int(minor) if minor is not None else 0,
            int(patch) if patch is not None else 0,
        )
        if op == "^":
            major, minor_v, patch_v = version
            if major > 0:
                upper = (major + 1, 0, 0)
            elif minor_v > 0:
                upper = (0, minor_v + 1, 0)
            else:
                upper = (0, 0, patch_v + 1)
            comparators.append((">=", version))
            comparators.append(("<", upper))
        elif op == "~":
            comparators.append((">=", version))
            comparators.append(("<", (version[0], version[1] + 1, 0)))
        elif op == "":
            comparators.append(("=", version))
        else:
            comparators.append((op, version))
    return comparators


def range_satisfies(version_text, range_text):
    """version 是否落在 range 里；任一边不合法都返回 False。"""
    version = parse_version(version_text)
    comparators = parse_range(range_text)
    if version is None or comparators is None:
        return False
    return all(_comparator_match(op, bound, version) for op, bound in comparators)


# ---------------------------------------------------------------------------
# 校验结果
# ---------------------------------------------------------------------------


class Report:
    """一次校验的错误和警告。错误让命令失败，警告只提示。"""

    def __init__(self):
        self.issues = []  # [(level, field, message), ...]

    def error(self, field, message):
        self.issues.append(("error", field, message))

    def warn(self, field, message):
        self.issues.append(("warning", field, message))

    @property
    def errors(self):
        return [i for i in self.issues if i[0] == "error"]

    @property
    def warnings(self):
        return [i for i in self.issues if i[0] == "warning"]

    def extend(self, other):
        self.issues.extend(other.issues)

    def print(self):
        for level, field, message in self.issues:
            prefix = "[error]" if level == "error" else "[warn] "
            if field:
                print("  %s %s: %s" % (prefix, field, message))
            else:
                print("  %s %s" % (prefix, message))

    def summary(self, title):
        if self.errors:
            extra = "，另有 %d 个警告" % len(self.warnings) if self.warnings else ""
            return "清单校验失败：%s 有 %d 个错误%s" % (title, len(self.errors), extra)
        if self.warnings:
            return "清单校验通过：%s（0 错误，%d 警告）" % (title, len(self.warnings))
        return "清单校验通过：%s（0 错误，0 警告）" % title


# ---------------------------------------------------------------------------
# 校验：清单 + 包内文件
# ---------------------------------------------------------------------------


def _safe_rel_path(value):
    """插件目录内的相对路径：非空、不以 / 开头、不含 .. 段和反斜杠。"""
    if not isinstance(value, str) or value == "":
        return False
    if value.startswith("/") or "\\" in value:
        return False
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return False
    return True


def _in_package(package_dir, rel):
    """把清单里的相对路径解析成包内绝对路径；不安全的路径返回 None。"""
    if not _safe_rel_path(rel):
        return None
    candidate = (package_dir / rel).resolve()
    try:
        candidate.relative_to(package_dir.resolve())
    except ValueError:
        return None
    return candidate


def _current_platform():
    system = platform.system().lower()
    goos = {"darwin": "darwin", "linux": "linux", "windows": "windows"}.get(system, system)
    machine = platform.machine().lower()
    if machine in ("arm64", "aarch64"):
        goarch = "arm64"
    elif machine in ("x86_64", "amd64", "x64"):
        goarch = "amd64"
    else:
        goarch = machine
    return "%s-%s" % (goos, goarch)


def _check_path(report, package_dir, rel, field, required_file=True, what="文件"):
    """检查清单引用的相对路径是否存在。返回绝对路径或 None。"""
    if not isinstance(rel, str) or not rel:
        report.error(field, "必须是非空字符串")
        return None
    if not _safe_rel_path(rel):
        report.error(field, "必须是插件目录内的相对路径（不能以 / 开头、不能含 .. 或反斜杠）：%s" % rel)
        return None
    full = _in_package(package_dir, rel)
    if full is None:
        report.error(field, "路径越出插件目录：%s" % rel)
        return None
    if required_file and not full.exists():
        report.error(field, "文件不存在：%s" % rel)
        return None
    if not required_file and not full.is_dir():
        report.error(field, "目录不存在：%s" % rel)
        return None
    return full


def _expect_str(report, obj, key, field, required=True, allow_empty=False):
    if key not in obj:
        if required:
            report.error(field, "必填")
        return None
    value = obj[key]
    if not isinstance(value, str):
        report.error(field, "必须是字符串")
        return None
    if not allow_empty and value.strip() == "":
        report.error(field, "不能为空")
        return None
    return value


def _expect_list(report, obj, key, field, required=False):
    if key not in obj:
        if required:
            report.error(field, "必填")
        return None
    value = obj[key]
    if not isinstance(value, list):
        report.error(field, "必须是数组")
        return None
    return value


def _strings_in_list(report, values, field):
    """检查数组里每项都是字符串，返回 (字符串数组, 是否有类型错误)。"""
    strings = []
    ok = True
    for index, value in enumerate(values):
        if not isinstance(value, str):
            report.error("%s[%d]" % (field, index), "必须是字符串")
            ok = False
        else:
            strings.append(value)
    return strings, ok


def _check_unique(report, values, field):
    seen = set()
    for index, value in enumerate(values):
        if value in seen:
            report.error("%s[%d]" % (field, index), "重复：%s" % value)
        seen.add(value)


def _check_provides(report, manifest, provides):
    plugin_id = manifest.get("id") or ""
    if not isinstance(provides, dict):
        report.error("provides", "必须是对象")
        return
    for key in provides:
        if key not in PROVIDES_KEYS:
            report.error("provides.%s" % key, "是未知扩展点（允许：%s）" % ", ".join(PROVIDES_KEYS))

    lists = {}
    for key in PROVIDES_KEYS:
        raw = provides.get(key)
        if raw is None:
            lists[key] = []
            continue
        if not isinstance(raw, list):
            report.error("provides.%s" % key, "必须是数组")
            lists[key] = []
            continue
        values, type_ok = _strings_in_list(report, raw, "provides." + key)
        lists[key] = values
        if not type_ok:
            continue
        _check_unique(report, values, "provides." + key)
        for index, value in enumerate(values):
            field = "provides.%s[%d]" % (key, index)
            if key == "commands":
                suffix = value[len(plugin_id) + 1:] if plugin_id and value.startswith(plugin_id + ".") else ""
                if not suffix or not KEY_RE.match(suffix):
                    report.error(field, "必须是 %s.<动作>：%s" % (plugin_id, value))
                continue
            if not KEY_RE.match(value):
                report.error(field, "只能用 ^[a-z][a-z0-9_]*$：%s" % value)
                continue
            if key in ("modules", "settings", "search", "connectors"):
                continue
            if not plugin_id or not ID_RE.match(plugin_id):
                continue
            if key == "object_types":
                if value != plugin_id and not value.startswith(plugin_id + "_"):
                    report.error(field, "必须等于 %s 或以 %s_ 开头：%s" % (plugin_id, plugin_id, value))
            elif key == "skills":
                if not value.startswith("sk_"):
                    report.error(field, "必须以 sk_ 开头：%s" % value)
            elif key in ("agent_tools", "sop_nodes", "today_cards", "schedule_actions"):
                if not value.startswith(plugin_id + "_"):
                    report.error(field, "必须以 %s_ 开头：%s" % (plugin_id, value))

    manifest["_provides_lists"] = lists

    permissions = manifest.get("permissions") or []
    if lists.get("connectors") and not any(p.startswith("network:") for p in permissions):
        report.error(
            "provides.connectors",
            "声明了连接器，但 permissions 里没有对应的 network:* 权限",
        )


def _check_permissions(report, manifest):
    raw = manifest.get("permissions")
    if not isinstance(raw, list):
        report.error("permissions", "必须是数组（可以是空数组）")
        return []
    values, type_ok = _strings_in_list(report, raw, "permissions")
    if not type_ok:
        return values
    _check_unique(report, values, "permissions")
    for index, perm in enumerate(values):
        field = "permissions[%d]" % index
        if perm in IMPLICIT_PERMISSIONS:
            report.error(field, "%s 是隐式权限（宿主默认授予），不要写进清单" % perm)
        elif perm in FORBIDDEN_PERMISSIONS:
            # 规范 3.2/5.3：声明 trade:live 不阻塞安装，但 v0.1 一律不授予、目录评审不接受。
            # 默认给警告（--strict 视为错误），不把它当成清单结构错误。
            report.warn(
                field,
                "%s 在 v0.1 外部插件一律不授予、目录评审不接受；声明了不会生效" % perm,
            )
        elif perm in REQUESTABLE_PERMISSIONS or SECRETS_RE.match(perm):
            if perm in SEPARATE_AUTH_PERMISSIONS:
                report.warn(field, "%s 属于高风险权限，安装时不授予，需安装后单独申请 + 二次确认" % perm)
        else:
            report.error(field, "是未知权限：%s" % perm)
    return values


def _validate_manifest(manifest, package_dir, report, only_platform=None):
    """校验从 JSON 解析出来的清单；成功时把解析结果补充回 manifest。"""
    if not isinstance(manifest, dict):
        report.error("", "清单必须是 JSON 对象")
        return

    for key in sorted(manifest):
        if key.startswith("_"):
            continue
        if key in FORBIDDEN_MANIFEST_KEYS:
            report.error(key, FORBIDDEN_MANIFEST_KEYS[key])
        elif key not in ALLOWED_MANIFEST_KEYS:
            report.error(key, "是未知字段（v2 清单字段见 references/manifest.md）")

    # manifest_version
    if "manifest_version" not in manifest:
        report.error("manifest_version", "必填")
    else:
        value = manifest["manifest_version"]
        if type(value) is not int:
            report.error("manifest_version", "必须是整数 2")
        elif value != MANIFEST_VERSION:
            report.error("manifest_version", "必须是 2（PMW Plugin 2.0），当前是 %r" % value)

    # id
    plugin_id = _expect_str(report, manifest, "id", "id")
    if plugin_id is not None:
        if not ID_RE.match(plugin_id):
            report.error("id", "不合法：必须匹配 %s：%s" % (ID_RE.pattern, plugin_id))
        elif plugin_id in RESERVED_IDS:
            report.error("id", "是内核保留字：%s" % plugin_id)
        elif plugin_id in BUILTIN_PLUGIN_IDS:
            report.error("id", "和内置插件 id 冲突：%s" % plugin_id)

    # name / description
    if "name" in manifest:
        _expect_str(report, manifest, "name", "name")
    else:
        report.error("name", "必填")
    description = manifest.get("description")
    if description is not None:
        if not isinstance(description, str):
            report.error("description", "必须是字符串")
        elif not description.strip():
            report.warn("description", "为空，插件管理页会没有说明")

    # version / api / pmw
    version = manifest.get("version")
    if version is None:
        report.error("version", "必填")
    else:
        parsed = parse_version(version)
        if parsed is None:
            report.error("version", "不是合法的 SemVer（MAJOR.MINOR.PATCH，不支持预发布）：%r" % (version,))
        else:
            manifest["_version_tuple"] = parsed

    api = manifest.get("api")
    if api is None:
        report.error("api", "必填")
    elif parse_range(api) is None:
        report.error("api", "版本范围不合法（只支持 >= > <= < = ^ ~，空格分隔；不支持 || * x）：%r" % (api,))
    elif not range_satisfies(HOST_API_VERSION, api):
        report.error(
            "api",
            "不包含当前宿主插件 API 版本 %s（写 >=2.0.0 <3.0.0 这类范围）：%s"
            % (HOST_API_VERSION, api),
        )

    pmw = manifest.get("pmw")
    if pmw is None:
        report.error("pmw", "必填")
    elif parse_range(pmw) is None:
        report.error("pmw", "版本范围不合法（只支持 >= > <= < = ^ ~，空格分隔；不支持 || * x）：%r" % (pmw,))

    # license / repository / homepage
    if "license" in manifest:
        _expect_str(report, manifest, "license", "license")
    else:
        report.error("license", "必填（如 MIT）")
    repository = manifest.get("repository")
    if repository is None:
        report.error("repository", "必填")
    elif not isinstance(repository, str):
        report.error("repository", "必须是字符串")
    elif not repository.startswith("https://github.com/"):
        report.error("repository", "v0.1 只接受 https://github.com/... 仓库地址：%r" % (repository,))
    homepage = manifest.get("homepage")
    if homepage is not None and (not isinstance(homepage, str) or not URL_RE.match(homepage)):
        report.error("homepage", "必须是 http(s) URL：%r" % (homepage,))

    # publisher
    publisher = manifest.get("publisher")
    if publisher is not None:
        if not isinstance(publisher, dict):
            report.error("publisher", "必须是对象")
        else:
            for key in publisher:
                if key not in ("id", "key"):
                    report.error("publisher.%s" % key, "是未知字段（只允许 id、key）")
            publisher_id = publisher.get("id")
            if not isinstance(publisher_id, str) or not publisher_id.strip():
                report.error("publisher.id", "必填且必须是非空字符串（如 github:owner）")
            elif not publisher_id.startswith("github:"):
                report.warn("publisher.id", "v0.1 建议写 github:<owner>，便于信任分级展示：%s" % publisher_id)
            publisher_key = publisher.get("key")
            if publisher_key is not None:
                if not isinstance(publisher_key, str):
                    report.error("publisher.key", "必须是 base64 字符串")
                else:
                    try:
                        decoded = base64.b64decode(publisher_key, validate=True)
                    except (ValueError, binascii.Error):
                        report.error("publisher.key", "不是合法的 base64")
                    else:
                        if len(decoded) != 32:
                            report.error("publisher.key", "ed25519 公钥解码后必须是 32 字节，当前 %d" % len(decoded))

    # icon
    icon = manifest.get("icon")
    if icon is not None:
        full = _check_path(report, package_dir, icon, "icon")
        if full is not None:
            if full.stat().st_size > 256 * 1024:
                report.warn("icon", "超过 256 KiB，插件管理页会压缩显示")
            if full.suffix.lower() not in (".svg", ".png", ".jpg", ".jpeg", ".webp"):
                report.warn("icon", "建议用 svg/png/jpeg/webp：%s" % full.suffix)

    # provides
    provides = manifest.get("provides")
    if provides is not None:
        _check_provides(report, manifest, provides)
    else:
        manifest["_provides_lists"] = {}

    # permissions / permissions_reason
    permissions = _check_permissions(report, manifest) if "permissions" in manifest else []
    if "permissions" not in manifest:
        report.error("permissions", "必填（没有权限也要写 []）")

    reasons = manifest.get("permissions_reason")
    if reasons is None:
        report.error("permissions_reason", "必填（每项权限都要有中文理由，没有权限时写 {}）")
    elif not isinstance(reasons, dict):
        report.error("permissions_reason", "必须是对象")
    else:
        for key in sorted(reasons):
            if key not in permissions:
                report.error("permissions_reason.%s" % key, "对应的权限没有在 permissions 里声明")
                continue
            reason = reasons[key]
            if not isinstance(reason, str):
                report.error("permissions_reason.%s" % key, "必须是非空字符串")
                continue
            reason = reason.strip()
            if not reason:
                report.error("permissions_reason.%s" % key, "不能为空")
            elif len(reason) > 80:
                report.error("permissions_reason.%s" % key, "不能超过 80 字（当前 %d 字）" % len(reason))
            elif not CJK_RE.search(reason):
                report.warn("permissions_reason.%s" % key, "建议写中文理由（规范要求中文，1–80 字）")
        for perm in permissions:
            if perm not in reasons:
                report.error("permissions_reason", "权限 %s 缺少中文理由" % perm)

    # depends / optional_depends
    for key in ("depends", "optional_depends"):
        deps = manifest.get(key)
        if deps is None:
            continue
        if not isinstance(deps, dict):
            report.error(key, "必须是对象：{ \"<插件 id>\": \"<版本范围>\" }")
            continue
        for dep_id, dep_range in sorted(deps.items()):
            field = "%s.%s" % (key, dep_id)
            if not ID_RE.match(dep_id):
                report.error(field, "不是合法的插件 id")
                continue
            if dep_id in RESERVED_IDS:
                report.error(field, "是内核保留字")
            elif dep_id in BUILTIN_PLUGIN_IDS:
                report.error(field, "不能依赖内置插件（depends 的目标是外部插件）")
            if not isinstance(dep_range, str) or parse_range(dep_range) is None:
                report.error(field, "版本范围不合法：%r" % (dep_range,))

    # emits / subscribes
    emits = _expect_list(report, manifest, "emits", "emits")
    if emits is not None:
        values, type_ok = _strings_in_list(report, emits, "emits")
        if type_ok:
            _check_unique(report, values, "emits")
            for index, event in enumerate(values):
                field = "emits[%d]" % index
                if not EVENT_RE.match(event):
                    report.error(field, "不是合法的事件类型：%s" % event)
                elif plugin_id and not event.startswith(plugin_id + "."):
                    report.error(field, "必须是 %s.<事件名>：%s" % (plugin_id, event))

    subscribes = _expect_list(report, manifest, "subscribes", "subscribes")
    if subscribes is not None:
        values, type_ok = _strings_in_list(report, subscribes, "subscribes")
        if type_ok:
            _check_unique(report, values, "subscribes")
            deps = manifest.get("depends") or {}
            optional = manifest.get("optional_depends") or {}
            kernel_namespaces = {"object", "task", "run", "contact"}
            for index, event in enumerate(values):
                field = "subscribes[%d]" % index
                if not EVENT_RE.match(event):
                    report.error(field, "不是合法的事件类型：%s" % event)
                    continue
                namespace = event.split(".", 1)[0]
                if namespace in kernel_namespaces or namespace == plugin_id:
                    continue
                if namespace in deps or namespace in optional:
                    continue
                if namespace in RESERVED_IDS:
                    report.error(field, "是未知的内核事件：%s" % event)
                else:
                    report.error(
                        field,
                        "订阅了 %s 的事件，但 %s 不在 depends 或 optional_depends 里" % (namespace, namespace),
                    )

    # subscribes ↔ events:subscribe 一致性（规范 5.6）
    has_events_permission = "events:subscribe" in permissions
    subscribe_list = manifest.get("subscribes") or []
    if isinstance(subscribe_list, list) and subscribe_list and not has_events_permission:
        report.error("subscribes", "非空时必须声明 events:subscribe 权限")
    if has_events_permission and not subscribe_list:
        report.error("permissions", "声明了 events:subscribe，但 subscribes 为空（没有要订阅的事件）")

    # migrations（可选）：插件库迁移目录，P1 宿主执行，待实现
    migrations = manifest.get("migrations")
    if migrations is not None:
        full = _check_path(report, package_dir, migrations, "migrations", required_file=False, what="目录")
        if full is not None:
            sql_files = sorted(full.glob("*.sql"))
            if not sql_files:
                report.warn("migrations", "目录里没有 .sql 文件")

    # runtime
    runtime = manifest.get("runtime")
    if runtime is None:
        report.error("runtime", "必填")
        return
    if not isinstance(runtime, dict):
        report.error("runtime", "必须是对象")
        return
    for key in runtime:
        if key not in ("backend", "web"):
            report.error("runtime.%s" % key, "是未知字段（只允许 backend、web）")

    backend = runtime.get("backend")
    web = runtime.get("web")
    if backend is None and web is None:
        report.error("runtime", "backend 和 web 至少要有一个")
        return

    provides_lists = manifest.get("_provides_lists") or {}
    if provides_lists.get("modules") and web is None:
        report.error("runtime.web", "provides.modules 不为空时必须提供前端入口 runtime.web")

    if web is not None:
        if not isinstance(web, dict):
            report.error("runtime.web", "必须是对象")
        else:
            for key in web:
                if key not in ("entry", "styles"):
                    report.error("runtime.web.%s" % key, "是未知字段（只允许 entry、styles）")
            entry = _expect_str(report, web, "entry", "runtime.web.entry")
            if entry is not None:
                _check_path(report, package_dir, entry, "runtime.web.entry")
                if not entry.endswith((".js", ".mjs")):
                    report.warn("runtime.web.entry", "外部插件前端入口应该是 ESM（.js/.mjs）：%s" % entry)
            styles = _expect_list(report, web, "styles", "runtime.web.styles")
            if styles is not None:
                values, type_ok = _strings_in_list(report, styles, "runtime.web.styles")
                if type_ok:
                    _check_unique(report, values, "runtime.web.styles")
                    for index, style in enumerate(values):
                        _check_path(report, package_dir, style, "runtime.web.styles[%d]" % index)
                        if not style.endswith(".css"):
                            report.warn("runtime.web.styles[%d]" % index, "建议是 .css 文件")

    if backend is not None:
        if not isinstance(backend, dict):
            report.error("runtime.backend", "必须是对象")
            return
        for key in backend:
            if key not in ("kind", "protocol", "entry", "health_timeout_ms"):
                report.error("runtime.backend.%s" % key, "是未知字段（只允许 kind、protocol、entry、health_timeout_ms）")
        kind = _expect_str(report, backend, "kind", "runtime.backend.kind")
        if kind is not None and kind != "process":
            report.error("runtime.backend.kind", "第一版只支持 process，当前是 %r" % (kind,))
        protocol = _expect_str(report, backend, "protocol", "runtime.backend.protocol")
        if protocol is not None and protocol != PROTOCOL:
            report.error("runtime.backend.protocol", "必须是 %s，当前是 %r" % (PROTOCOL, protocol))
        entries = backend.get("entry")
        if entries is None:
            report.error("runtime.backend.entry", "必填（至少声明一个目标平台的入口）")
        elif not isinstance(entries, dict) or not entries:
            report.error("runtime.backend.entry", "必须是非空对象：{ \"<goos>-<goarch>\": \"bin/...\" }")
        else:
            platforms = []
            for key in sorted(entries):
                field = "runtime.backend.entry.%s" % key
                if not PLATFORM_RE.match(key):
                    report.error(field, "平台 key 必须是 <goos>-<goarch>（如 darwin-arm64）：%s" % key)
                    continue
                platforms.append(key)
                if key not in RELEASE_MATRIX:
                    report.warn(field, "不在当前发布矩阵（%s）里，用户装不到这个平台" % ", ".join(RELEASE_MATRIX))
                if only_platform is not None and key != only_platform:
                    # 安装/解包后的目录里只有目标平台的那个二进制，其余平台入口不查文件。
                    continue
                full = _check_path(report, package_dir, entries[key], field)
                if full is not None and key == _current_platform():
                    if not os.access(str(full), os.X_OK):
                        report.warn(field, "当前平台的入口没有可执行权限（chmod +x）")
            missing = [p for p in ("darwin-arm64", "linux-amd64") if p not in platforms]
            if missing:
                report.warn(
                    "runtime.backend.entry",
                    "发布检查要求覆盖 Darwin arm64 与 Linux amd64，缺少：%s" % ", ".join(missing),
                )
        health_timeout = backend.get("health_timeout_ms")
        if health_timeout is not None:
            if type(health_timeout) is not int or not (100 <= health_timeout <= 60000):
                report.error("runtime.backend.health_timeout_ms", "必须是 100–60000 的整数")

    # 包级文件（不阻断校验，但发布前应补齐）
    if not (package_dir / "LICENSE").is_file():
        report.warn("LICENSE", "缺少许可证文件（发布包必须带 LICENSE）")
    if not (package_dir / "README.md").is_file():
        report.warn("README.md", "缺少 README.md，插件管理页/仓库说明会不完整")


def validate_package(package_dir, only_platform=None):
    """校验一个插件目录，返回 (Report, manifest 或 None)。

    only_platform 非空时只检查该平台的后端入口是否存在：安装产物只带目标平台二进制，
    清单里仍然声明发布矩阵的全部平台。源码仓库校验时传 None，全部平台都要存在。
    """
    report = Report()
    package_dir = package_dir.resolve()
    if not package_dir.is_dir():
        report.error("", "目录不存在：%s" % package_dir)
        return report, None
    manifest_path = package_dir / "plugin.json"
    if not manifest_path.is_file():
        report.error("", "找不到 plugin.json：%s" % manifest_path)
        return report, None
    try:
        text = manifest_path.read_text(encoding="utf-8")
        manifest = json.loads(text)
    except UnicodeDecodeError as exc:
        report.error("plugin.json", "不是合法 UTF-8：%s" % exc)
        return report, None
    except json.JSONDecodeError as exc:
        report.error("plugin.json", "不是合法 JSON：%s" % exc)
        return report, None
    _validate_manifest(manifest, package_dir, report, only_platform=only_platform)
    return report, manifest


# ---------------------------------------------------------------------------
# init：模板渲染
# ---------------------------------------------------------------------------


def _render_template(template_path, context, json_escape=False):
    text = template_path.read_text(encoding="utf-8")
    for placeholder in PLACEHOLDERS:
        value = context[placeholder]
        if json_escape:
            value = json.dumps(value, ensure_ascii=False)[1:-1]
        text = text.replace(placeholder, value)
    return text


def _output_rel_path(rel):
    """模板文件相对路径 -> 生成后的相对路径。"""
    name = rel.name
    if name.endswith(".tmpl"):
        rel = rel.with_name(name[: -len(".tmpl")])
    if rel.as_posix() == "gitignore":
        rel = Path(".gitignore")
    return rel


def _check_init_args(plugin_id, owner):
    if not ID_RE.match(plugin_id):
        raise Fatal("插件 id 不合法：必须匹配 %s（小写字母开头，2–24 位字母/数字/下划线）" % ID_RE.pattern)
    if plugin_id in RESERVED_IDS:
        raise Fatal("插件 id %s 是内核保留字，换一个" % plugin_id)
    if not isinstance(owner, str) or not owner.strip():
        raise Fatal("--owner 必填（GitHub 用户/组织名，用于 repository 和 publisher）")
    if not re.match(r"^[A-Za-z0-9_.-]+$", owner.strip()):
        raise Fatal("--owner 只能包含字母、数字、下划线、点和连字符：%r" % owner)


def do_init(dest, plugin_id, name, owner, description, version, license_name, build):
    """生成骨架。返回 (dest, built: bool)。"""
    _check_init_args(plugin_id, owner)
    if not TEMPLATES_DIR.is_dir():
        raise Fatal(
            "找不到模板目录：%s\n"
            "init 只能在安装好的 skill 目录里运行（plugin-sdk/skill/pmw-plugin-builder/scripts/pmw_plugin.py）；"
            "插件仓库内的副本只用于 validate/pack。" % TEMPLATES_DIR
        )
    if parse_version(version) is None:
        raise Fatal("--version 不是合法的 SemVer：%r" % (version,))
    if not isinstance(name, str) or not name.strip():
        raise Fatal("--name 不能为空")

    dest = Path(dest).resolve()
    if dest.exists() and any(dest.iterdir()):
        raise Fatal("%s 已存在且非空；换一个目录，或先清空" % dest)
    dest.mkdir(parents=True, exist_ok=True)

    context = {
        "{{PMW_ID}}": plugin_id,
        "{{PMW_NAME}}": name.strip(),
        "{{PMW_DESCRIPTION}}": (description or "一个 PMW 外部插件").strip(),
        "{{PMW_OWNER}}": owner.strip(),
        "{{PMW_VERSION}}": version,
        "{{PMW_YEAR}}": str(datetime.date.today().year),
    }

    created = []
    for template_path in sorted(TEMPLATES_DIR.rglob("*")):
        if not template_path.is_file():
            continue
        rel = template_path.relative_to(TEMPLATES_DIR)
        out_rel = _output_rel_path(rel)
        target = dest / out_rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            _render_template(template_path, context, json_escape=(out_rel.as_posix() == "plugin.json")),
            encoding="utf-8",
        )
        created.append(out_rel.as_posix())

    # 把工具脚本一起放进插件仓库，让 make validate / make pack 开箱可用。
    scripts_dir = dest / "scripts"
    scripts_dir.mkdir(exist_ok=True)
    shutil.copy2(str(SCRIPT_PATH), str(scripts_dir / "pmw_plugin.py"))

    # 前端产物：entry.ts 只用 JS 语法子集，entry.js 先复制一份，make web 会再同步。
    entry_js = dest / "web" / "entry.js"
    shutil.copyfile(str(dest / "web" / "entry.ts"), str(entry_js))

    built = False
    if build:
        built = _build_backend(dest, plugin_id)
    else:
        print("[init] 跳过构建（--no-build）；validate 前先 make build-all，或删掉清单里未构建的平台入口")

    print("[init] 已生成 %s（%d 个文件 + scripts/pmw_plugin.py）" % (dest, len(created)))
    if build and not built:
        print("[init] 未找到 go，后端没有编译；装好 Go 1.22+ 后执行 make build-all")
    print("[init] 下一步：")
    print("  cd %s" % dest)
    print("  make validate   # 校验清单和包内文件")
    print("  make lint       # gofmt + go vet + validate")
    print("  make pack       # 打当前平台发布包到 dist/")
    return dest, built


def _build_backend(package_dir, plugin_id):
    """按发布矩阵构建三个平台（纯 Go 标准库，可离线交叉编译）。返回是否真的构建了。"""
    go = shutil.which("go")
    if not go:
        return False
    targets = [
        ("darwin", "arm64", ""),
        ("linux", "amd64", ""),
        ("windows", "amd64", ".exe"),
    ]
    bin_dir = package_dir / "bin"
    bin_dir.mkdir(exist_ok=True)
    for goos, goarch, exe in targets:
        output = bin_dir / ("%s-%s-%s%s" % (plugin_id, goos, goarch, exe))
        env = os.environ.copy()
        env.update({"CGO_ENABLED": "0", "GOOS": goos, "GOARCH": goarch})
        proc = subprocess.run(
            [go, "build", "-trimpath", "-ldflags", "-s -w", "-o", str(output), "."],
            cwd=str(package_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if proc.returncode != 0:
            raise Fatal(
                "go build 失败（%s-%s）：\n%s" % (goos, goarch, proc.stderr.strip() or proc.stdout.strip())
            )
        print("[init] 已构建 %s" % output.relative_to(package_dir))
    return True


# ---------------------------------------------------------------------------
# pack：打包清单声明的文件 + web/、assets/ 运行时资源 + SHA256SUMS
# ---------------------------------------------------------------------------


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(str(path), "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _collect_pack_files(package_dir, manifest, platform_key):
    """返回 [(包内相对路径, 绝对路径), ...]，顺序固定。

    收集范围 = 清单声明的入口/资源 + `web/` 与 `assets/` 目录下的全部普通文件
    （前端相对 import 的 chunk、样式、图片等一起发布；spec 2.4/8.2）。
    """
    entries = []
    seen = set()

    def add(rel, field):
        if rel is None:
            return
        if not _safe_rel_path(rel):
            raise Fatal("%s 不是插件目录内的相对路径：%r" % (field, rel))
        full = package_dir / rel
        if not full.is_file():
            raise Fatal("%s 指向的文件不存在：%s（先 make build-all / make web）" % (field, rel))
        if rel in seen:
            return
        seen.add(rel)
        entries.append((rel, full))

    def add_dir(rel_dir):
        """递归收集目录下的普通文件；拒绝符号链接和逃逸路径，跳过点文件。"""
        base = package_dir / rel_dir
        if not base.is_dir():
            return
        base_resolved = package_dir.resolve()
        for full in sorted(base.rglob("*")):
            rel = full.relative_to(package_dir).as_posix()
            if full.is_dir():
                if full.is_symlink():
                    raise Fatal("%s 是符号链接，发布包不允许" % rel)
                continue
            if full.is_symlink():
                raise Fatal("%s 是符号链接，发布包不允许" % rel)
            if any(part.startswith(".") for part in full.relative_to(base).parts):
                continue  # .DS_Store 等
            if rel_dir == "web" and full.suffix.lower() in (".ts", ".tsx", ".jsx", ".map"):
                continue  # 前端源码/映射不进发布包，运行时只用构建后的 .js/.css
            try:
                full.resolve().relative_to(base_resolved)
            except ValueError:
                raise Fatal("%s 解析后不在插件目录内" % rel)
            if not _safe_rel_path(rel):
                raise Fatal("包内路径不安全：%r" % rel)
            add(rel, "目录 %s" % rel_dir)

    add("plugin.json", "plugin.json")
    runtime = manifest.get("runtime") or {}
    backend = runtime.get("backend")
    if backend:
        entry = (backend.get("entry") or {}).get(platform_key)
        if entry is None:
            raise Fatal(
                "清单 runtime.backend.entry 没有 %s 平台的入口（已有：%s）"
                % (platform_key, ", ".join(sorted(backend.get("entry") or {})) or "无")
            )
        add(entry, "runtime.backend.entry.%s" % platform_key)
    web = runtime.get("web")
    if web:
        add(web.get("entry"), "runtime.web.entry")
        for index, style in enumerate(web.get("styles") or []):
            add(style, "runtime.web.styles[%d]" % index)
    if manifest.get("icon"):
        add(manifest["icon"], "icon")
    license_path = package_dir / "LICENSE"
    if license_path.is_file():
        entries.append(("LICENSE", license_path))
    migrations = manifest.get("migrations")
    if migrations:
        migration_dir = package_dir / migrations
        for sql in sorted(migration_dir.glob("*.sql")):
            entries.append((sql.relative_to(package_dir).as_posix(), sql))

    # 前端 chunk / 静态资源整目录发布：相对 import 的 chunk、图片、字体等不写在清单里。
    add_dir("web")
    add_dir("assets")
    return entries


def _build_tarball(entries, tarball_path):
    """生成确定性 tar.gz：mtime=0、uid/gid=0、固定权限，内容含 SHA256SUMS。"""
    checksums = []
    for rel, full in entries:
        checksums.append((_sha256_file(full), rel))
    checksum_lines = "".join("%s  %s\n" % (digest, rel) for digest, rel in checksums)

    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0, filename="") as gzip_file:
        with tarfile.open(fileobj=gzip_file, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for rel, full in entries:
                data = full.read_bytes()
                info = tarfile.TarInfo(rel)
                info.size = len(data)
                info.mtime = 0
                info.mode = 0o755 if (full.suffix == "" or full.suffix == ".exe") and full.stat().st_mode & 0o111 else 0o644
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                tar.addfile(info, io.BytesIO(data))
            sum_bytes = checksum_lines.encode("utf-8")
            info = tarfile.TarInfo("SHA256SUMS")
            info.size = len(sum_bytes)
            info.mtime = 0
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(sum_bytes))
    tarball_path.write_bytes(buffer.getvalue())
    return checksums


def do_pack(package_dir, os_name, arch, version_override, dist_dir):
    package_dir = Path(package_dir).resolve()
    report, manifest = validate_package(package_dir)
    if report.errors:
        report.print()
        print(report.summary(str(package_dir)), file=sys.stderr)
        raise Fatal("打包前校验没通过，先修上面的错误")
    if report.warnings:
        report.print()

    plugin_id = manifest.get("id")
    version = manifest.get("version")
    if version_override is not None and version_override != version:
        raise Fatal(
            "--version=%s 和 plugin.json 的 version=%s 不一致；版本只在 plugin.json 维护" % (version_override, version)
        )
    os_name = (os_name or _current_platform().split("-")[0]).strip()
    arch = (arch or _current_platform().split("-")[1]).strip()
    platform_key = "%s-%s" % (os_name, arch)
    tarball_name = "%s-%s-%s-%s.tar.gz" % (plugin_id, version, os_name, arch)
    dist_dir = Path(dist_dir).resolve() if dist_dir else package_dir / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)
    tarball_path = dist_dir / tarball_name

    entries = _collect_pack_files(package_dir, manifest, platform_key)
    checksums = _build_tarball(entries, tarball_path)
    digest = _sha256_file(tarball_path)

    # dist/SHA256SUMS 汇总所有平台产物：同名更新，其余保留，按文件名排序。
    sums_path = dist_dir / "SHA256SUMS"
    lines = {}
    if sums_path.is_file():
        for line in sums_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            if len(parts) == 2:
                lines[parts[1]] = parts[0]
    lines[tarball_name] = digest
    sums_path.write_text(
        "".join("%s  %s\n" % (lines[name], name) for name in sorted(lines)),
        encoding="utf-8",
    )

    size_kib = tarball_path.stat().st_size / 1024.0
    print("[pack] 平台：%s" % platform_key)
    print("[pack] 包内文件（%d）：" % len(entries))
    for digest_i, rel in checksums:
        print("  %s  %s" % (digest_i, rel))
    print("  %s  SHA256SUMS" % "(包内生成)")
    print("[pack] 已生成 %s（%.1f KiB）" % (tarball_path, size_kib))
    print("[pack] sha256: %s" % digest)
    print("[pack] 已更新 %s" % sums_path)
    return tarball_path


# ---------------------------------------------------------------------------
# self-test：临时目录 init -> validate -> pack -> 解包复校验
# ---------------------------------------------------------------------------


def _write_placeholder_binaries(package_dir, plugin_id):
    package_dir = Path(package_dir)
    bin_dir = package_dir / "bin"
    bin_dir.mkdir(exist_ok=True)
    for platform_key in RELEASE_MATRIX:
        name = "%s-%s" % (plugin_id, platform_key)
        if platform_key.startswith("windows-"):
            name += ".exe"
        path = bin_dir / name
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)
        print("[self-test] 占位二进制：bin/%s" % name)


def _verify_inner_checksums(extract_dir, report):
    sums_path = extract_dir / "SHA256SUMS"
    if not sums_path.is_file():
        report.error("", "解包后缺少 SHA256SUMS")
        return
    for line in sums_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            report.error("SHA256SUMS", "行格式不对：%r" % line)
            continue
        expected, rel = parts
        target = extract_dir / rel
        if not target.is_file():
            report.error("SHA256SUMS", "列出的文件不在包里：%s" % rel)
            continue
        actual = _sha256_file(target)
        if actual != expected:
            report.error("SHA256SUMS", "哈希不匹配：%s" % rel)


def cmd_self_test(args):
    temp_root = Path(tempfile.mkdtemp(prefix="pmw-plugin-selftest-"))
    try:
        package_dir = temp_root / "selftest_plugin"
        print("[self-test] 临时目录：%s" % temp_root)
        print("[self-test] 1/5 init（id=selftest_plugin）")
        _, built = do_init(
            package_dir,
            plugin_id="selftest_plugin",
            name="Self Test",
            owner="pmw-selftest",
            description="plugin-sdk self-test 生成的临时插件",
            version="0.1.0",
            license_name="MIT",
            build=True,
        )
        if not built:
            print("[self-test] [warn] 未找到 go，用占位可执行文件代替真实构建（只验证工具链，不验证编译）")
            _write_placeholder_binaries(package_dir, "selftest_plugin")

        print("[self-test] 2/5 validate")
        report, _ = validate_package(package_dir)
        if report.errors:
            report.print()
            raise Fatal("self-test 的 validate 没通过")
        if report.warnings:
            report.print()

        print("[self-test] 3/5 pack")
        tarball = do_pack(package_dir, None, None, None, None)

        print("[self-test] 4/5 解包并复校验")
        extract_dir = temp_root / "extracted"
        extract_dir.mkdir()
        with tarfile.open(str(tarball), "r:gz") as tar:
            for member in tar.getmembers():
                member_path = Path(member.name)
                if member_path.is_absolute() or ".." in member_path.parts:
                    raise Fatal("包里出现不安全路径：%s" % member.name)
            if sys.version_info >= (3, 12):
                tar.extractall(str(extract_dir), filter="data")
            else:
                tar.extractall(str(extract_dir))
        platform_key = _current_platform()
        report, _ = validate_package(extract_dir, only_platform=platform_key)
        _verify_inner_checksums(extract_dir, report)
        if report.errors:
            report.print()
            raise Fatal("self-test 的解包复校验没通过")

        print("[self-test] 5/5 校验 dist/SHA256SUMS")
        dist_sums = package_dir / "dist" / "SHA256SUMS"
        expected = _sha256_file(tarball)
        found = False
        for line in dist_sums.read_text(encoding="utf-8").splitlines():
            parts = line.split(None, 1)
            if len(parts) == 2 and parts[1] == tarball.name:
                found = parts[0] == expected
        if not found:
            raise Fatal("dist/SHA256SUMS 里没有 %s 或哈希不一致" % tarball.name)

        print("[self-test] PASS：init → validate → pack → 解包 → 复校验 全部通过")
        print("[self-test] 产物示例：%s" % tarball)
        return EXIT_OK
    finally:
        if args.keep:
            print("[self-test] --keep：保留临时目录 %s" % temp_root)
        else:
            shutil.rmtree(str(temp_root), ignore_errors=True)


# ---------------------------------------------------------------------------
# install-check：探测宿主是否支持外部插件（不支持不算失败，退出 0）
# ---------------------------------------------------------------------------


def _http_get_json(url, timeout):
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "pmw-plugin-sdk/0.1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(2 << 20)
            try:
                return response.status, json.loads(body.decode("utf-8")), body
            except (UnicodeDecodeError, json.JSONDecodeError):
                return response.status, None, body
    except urllib.error.HTTPError as exc:
        return exc.code, None, b""
    except urllib.error.URLError as exc:
        return None, None, str(exc.reason).encode("utf-8", "replace")
    except (TimeoutError, OSError) as exc:
        return None, None, str(exc).encode("utf-8", "replace")


def _detect_external_support(base_url, timeout):
    """返回 (status: 'supported'|'unsupported'|'unreachable', details dict)。"""
    status, payload, raw = _http_get_json(base_url + "/api/plugins", timeout)
    details = {"plugins_status": status, "plugins": payload}
    if status is None:
        details["error"] = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        return "unreachable", details

    # 显式能力探测接口（P1-a 起提供，GET /api/plugins/external/capabilities）；老宿主回 404。
    cap_status, cap_payload, cap_raw = _http_get_json(base_url + "/api/plugins/external/capabilities", timeout)
    details["capabilities_status"] = cap_status
    if cap_status is None:
        # 超时、连接被拒：判断不了支不支持，不能当成「老宿主 404」（以前这里误报成「不支持外部插件」）
        details["error"] = "探测外部插件接口时" + (
            cap_raw.decode("utf-8", "replace") if isinstance(cap_raw, bytes) else str(cap_raw))
        return "unreachable", details
    if cap_status == 200 and isinstance(cap_payload, dict):
        data = cap_payload.get("data") if isinstance(cap_payload.get("data"), dict) else cap_payload
        if not isinstance(data, dict) or data.get("external_plugins") is not False:
            details["capabilities"] = cap_payload
            return "supported", details

    # 兼容更早设计的探测接口；老宿主回 404。
    external_status, external_payload, external_raw = _http_get_json(base_url + "/api/plugins/external/updates", timeout)
    details["external_status"] = external_status
    if external_status is None:
        details["error"] = "探测外部插件接口时" + (
            external_raw.decode("utf-8", "replace") if isinstance(external_raw, bytes) else str(external_raw))
        return "unreachable", details
    if external_status == 200 and isinstance(external_payload, dict):
        details["external"] = external_payload
        return "supported", details

    if isinstance(payload, dict):
        for key in ("external_plugins", "external", "plugin_runtime"):
            if key in payload:
                return "supported", details
        meta = payload.get("meta")
        if isinstance(meta, dict):
            for key in ("external_plugins", "external_plugins_supported", "external_supported"):
                if meta.get(key):
                    return "supported", details
        if payload.get("external_plugins_supported") is True:
            return "supported", details
        details["plugin_count"] = len(payload.get("data") or []) if isinstance(payload.get("data"), list) else None
    return "unsupported", details


def cmd_install_check(args):
    package_dir = Path(args.dir).resolve()
    report, manifest = validate_package(package_dir)
    if report.errors:
        report.print()
        print(report.summary(str(package_dir)), file=sys.stderr)
        return EXIT_FAIL
    if report.warnings:
        report.print()

    base_url = args.pmw_url.rstrip("/")
    print("[install-check] 目标 PMW：%s" % base_url)
    state, details = _detect_external_support(base_url, args.timeout)
    if state == "unreachable":
        print(
            "[install-check] 无法连接 %s（%s）。请确认 PMW 已启动、--pmw-url 端口正确；"
            "没连上不算插件问题，也不代表宿主不支持外部插件，换个能连上的地址再查。" % (base_url, details.get("error", "未知原因"))
        )
    elif state == "supported":
        caps = details.get("capabilities") or {}
        data = caps.get("data") if isinstance(caps.get("data"), dict) else caps
        api_version = data.get("api_version", "?") if isinstance(data, dict) else "?"
        host_version = data.get("host_version", "") if isinstance(data, dict) else ""
        print("[install-check] 宿主已支持外部插件（检测到外部插件 API，api_version=%s，host_version=%s）。"
              % (api_version, host_version or "?"))
        pmw_range = manifest.get("pmw", "")
        if parse_version(host_version) is None:
            print("[install-check] 宿主版本 %s 不是正式版本号（开发构建），宿主不按 pmw 范围 %s 拦"
                  "（需要宿主已含 2026-11-23 的兼容修复，旧宿主会报「pmw 不包含当前 PMW 版本」）。"
                  % (host_version or "（空）", pmw_range))
        elif pmw_range and not range_satisfies(host_version, pmw_range):
            print("[install-check] 宿主版本 %s 不在插件声明的 pmw 范围 %s 里，安装会被拒绝。" % (host_version, pmw_range))
            state = "incompatible"
        if api_version != "?" and manifest.get("api") and not range_satisfies(api_version, manifest.get("api")):
            print("[install-check] 宿主插件 API %s 不在插件声明的 api 范围 %s 里，安装会被拒绝。" % (api_version, manifest.get("api")))
            state = "incompatible"
        print("[install-check] 本地安装：走「设置 → 插件 → 外部插件」，选本地目录、发布包或 GitHub 地址。")
    else:
        plugin_count = details.get("plugin_count")
        count_text = "，当前列出 %d 个内置插件" % plugin_count if plugin_count is not None else ""
        print("[install-check] GET /api/plugins 返回 %s%s。" % (details.get("plugins_status"), count_text))
        print("[install-check] 未发现外部插件 API：当前 PMW 版本不支持外部插件（需要 >= %s，且宿主 P1 已实现）。" % HOST_MIN_PMW)

    version = manifest.get("version")
    plugin_id = manifest.get("id")
    dist_dir = package_dir / "dist"
    tarballs = sorted(dist_dir.glob("*.tar.gz")) if dist_dir.is_dir() else []
    if tarballs:
        print("[install-check] 已生成可发布包：")
        for tarball in tarballs:
            print("  %s（sha256 %s）" % (tarball, _sha256_file(tarball)[:16] + "…"))
    else:
        print("[install-check] 还没有发布包：先执行 python3 scripts/pmw_plugin.py pack .")
    print("[install-check] 下一步：按 references/release.md 发布到 GitHub Release。")
    if state == "supported":
        print("[install-check] 结论：插件 %s v%s 本地校验通过，宿主已支持外部插件，可以进入安装流程。" % (plugin_id, version))
    elif state == "incompatible":
        print("[install-check] 结论：插件 %s v%s 本地校验通过，但和这个宿主版本不兼容，见上面的原因（退出码 0）。" % (plugin_id, version))
    elif state == "unreachable":
        print("[install-check] 结论：插件 %s v%s 本地校验通过，没连上宿主，无法判断能不能装（退出码 0）。" % (plugin_id, version))
    else:
        print(
            "[install-check] 结论：插件 %s v%s 本地校验通过，等待宿主支持（退出码 0，不算失败）。"
            % (plugin_id, version)
        )
    return EXIT_OK


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------


def cmd_validate(args):
    package_dir = Path(args.dir).resolve()
    report, _ = validate_package(package_dir, only_platform=args.platform)
    if report.issues:
        report.print()
    print(report.summary(str(package_dir)))
    if report.errors:
        return EXIT_FAIL
    if args.strict and report.warnings:
        print("--strict：把警告视为错误", file=sys.stderr)
        return EXIT_FAIL
    return EXIT_OK


def cmd_init(args):
    name = args.name or args.id.replace("_", " ").title()
    dest, built = do_init(
        args.dir,
        plugin_id=args.id,
        name=name,
        owner=args.owner,
        description=args.description,
        version=args.version,
        license_name=args.license,
        build=not args.no_build,
    )
    if built:
        report, _ = validate_package(dest)
        report.print()
        print(report.summary(str(dest)))
        if report.errors:
            return EXIT_FAIL
    return EXIT_OK


def cmd_pack(args):
    tarball = do_pack(Path(args.dir).resolve(), args.os, args.arch, args.version, args.dist)
    print("[pack] 完成：%s" % tarball)
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(
        prog="pmw_plugin.py",
        description="PMW 外部插件开发工具（草案 v0.1，宿主 P1 未实现）。只用标准库。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python3 pmw_plugin.py init ./my-plugin --id=my_plugin --owner=octocat --name='我的插件'\n"
            "  python3 pmw_plugin.py validate ./my-plugin\n"
            "  python3 pmw_plugin.py pack ./my-plugin\n"
            "  python3 pmw_plugin.py self-test\n"
            "  python3 pmw_plugin.py install-check ./my-plugin --pmw-url http://127.0.0.1:7796\n"
        ),
    )
    sub = parser.add_subparsers(dest="command", metavar="子命令")

    init = sub.add_parser("init", help="用模板生成插件骨架")
    init.add_argument("dir", help="目标目录（不存在或为空）")
    init.add_argument("--id", required=True, help="插件 id（^[a-z][a-z0-9_]{1,23}$，不能是内核保留字）")
    init.add_argument("--owner", required=True, help="GitHub 用户/组织名（用于 repository、publisher）")
    init.add_argument("--name", help="显示名，默认由 id 推导")
    init.add_argument("--description", default="一个 PMW 外部插件", help="一句话说明")
    init.add_argument("--version", default="0.1.0", help="初始版本（默认 0.1.0）")
    init.add_argument("--license", default="MIT", help="许可证标识（默认 MIT）")
    init.add_argument("--no-build", action="store_true", help="只生成源码，不构建后端二进制")
    init.set_defaults(func=cmd_init)

    validate = sub.add_parser("validate", help="校验 plugin.json 与包内文件")
    validate.add_argument("dir", help="插件目录")
    validate.add_argument("--strict", action="store_true", help="把警告视为错误")
    validate.add_argument(
        "--platform",
        help="只检查这个平台的后端入口是否存在（如 darwin-arm64）；默认检查清单里的全部平台",
    )
    validate.set_defaults(func=cmd_validate)

    pack = sub.add_parser("pack", help="打发布包到 dist/")
    pack.add_argument("dir", help="插件目录")
    pack.add_argument("--version", help="必须和 plugin.json 的 version 一致")
    pack.add_argument("--os", help="目标 GOOS（默认当前平台），如 darwin/linux/windows")
    pack.add_argument("--arch", help="目标 GOARCH（默认当前平台），如 arm64/amd64")
    pack.add_argument("--dist", help="输出目录（默认 <dir>/dist）")
    pack.set_defaults(func=cmd_pack)

    self_test = sub.add_parser("self-test", help="在临时目录跑完整工具链自检")
    self_test.add_argument("--keep", action="store_true", help="保留临时目录")
    self_test.set_defaults(func=cmd_self_test)

    install_check = sub.add_parser("install-check", help="探测 PMW 是否支持外部插件（不支持也退出 0）")
    install_check.add_argument("dir", help="插件目录")
    install_check.add_argument("--pmw-url", default="http://127.0.0.1:7796", help="PMW 地址（默认本机 7796 开发实例）")
    install_check.add_argument("--timeout", type=float, default=3.0, help="HTTP 超时秒数（默认 3）")
    install_check.set_defaults(func=cmd_install_check)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return EXIT_FAIL
    try:
        return int(args.func(args))
    except Fatal as exc:
        print("错误：%s" % exc, file=sys.stderr)
        return EXIT_FAIL
    except KeyboardInterrupt:
        print("已中断", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
