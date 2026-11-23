#!/usr/bin/env python3
# powered by dsh - https://github.com/deepseek-ai/deepseek-harness
"""P1-a 外部插件端到端验收（本地包安装 → 子进程 → 调用 → 前端资源 → 停用卸载）。

用法（仓库根目录）：
    python3 scripts/e2e-external-plugin.py

不联网、不碰 data/pm.db：在临时目录起一个 7797 实例，用 plugin-sdk 的 hello-world 示例打包安装。
退出码 0 表示整条闭环通过；任何一步失败打印原因并退出 1。
"""

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADDR = "127.0.0.1:7797"
BASE = "http://" + ADDR
SKILL = ROOT / "plugin-sdk/skill/pmw-plugin-builder/scripts/pmw_plugin.py"
EXAMPLE = ROOT / "plugin-sdk/examples/hello-world"


def log(msg):
    print("[e2e] " + msg, flush=True)


def fail(msg):
    print("[e2e] FAIL: " + msg, file=sys.stderr, flush=True)
    sys.exit(1)


def http(method, path, body=None, timeout=20):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "application/json" in ctype:
                return resp.status, json.loads(raw or b"{}")
            return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            payload = raw.decode("utf-8", "replace")
        return e.code, payload


def expect_ok(method, path, body=None, timeout=20):
    status, payload = http(method, path, body, timeout)
    if status != 200:
        fail("%s %s -> %s %r" % (method, path, status, payload))
    return payload


def wait_health(deadline=60):
    end = time.time() + deadline
    while time.time() < end:
        try:
            status, _ = http("GET", "/api/health", timeout=2)
            if status == 200:
                return
        except Exception:
            pass
        time.sleep(0.3)
    fail("PMW 实例 60 秒内没有就绪")


def free_port(addr):
    host, port = addr.rsplit(":", 1)
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, int(port)))
        except OSError:
            fail("端口 %s 被占用，请先关掉占用进程" % addr)


def main():
    free_port(ADDR)
    tmp = Path(tempfile.mkdtemp(prefix="pmw-e2e-ext-"))
    proc = None
    try:
        # 1) 保证内嵌前端占位 + 构建带 0.3.0 版本的二进制（外部插件要求 pmw >=0.3.0）
        (ROOT / "internal/webui/dist").mkdir(parents=True, exist_ok=True)
        index = ROOT / "internal/webui/dist/index.html"
        if not index.exists():
            index.write_text("<!doctype html><meta charset=utf-8><title>e2e</title>", "utf-8")
        bin_path = tmp / "pmw"
        log("构建 pmw（version=0.3.0）")
        build = subprocess.run(
            ["go", "build", "-ldflags", "-X main.version=0.3.0", "-o", str(bin_path), "./cmd/pmw"],
            cwd=ROOT, capture_output=True, text=True,
        )
        if build.returncode != 0:
            fail("go build 失败：\n" + build.stderr[-4000:])

        # 2) 重新打包 hello-world（确保平台产物与脚本一致）
        log("打包 hello-world")
        pack = subprocess.run(
            [sys.executable, str(SKILL), "pack", str(EXAMPLE)],
            cwd=ROOT, capture_output=True, text=True,
        )
        if pack.returncode != 0:
            fail("pmw_plugin.py pack 失败：\n" + pack.stdout[-2000:] + pack.stderr[-2000:])
        tarballs = sorted((EXAMPLE / "dist").glob("hello_world-*.tar.gz"))
        if not tarballs:
            fail("没有找到 hello-world 打包产物")
        package = tarballs[-1]
        log("安装包：" + str(package))

        # 3) 起临时实例（重启恢复也复用这个函数）
        def spawn():
            return subprocess.Popen(
                [str(bin_path), "--db", str(tmp / "pm.db"), "--vault-keychain=false",
                 "--addr", ADDR, "--allow-external-plugins"],
                cwd=str(tmp), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )

        log("启动 PMW 测试实例 " + BASE)
        proc = spawn()
        wait_health()

        # 4) capabilities
        caps = expect_ok("GET", "/api/plugins/external/capabilities")["data"]
        if not caps.get("external_plugins"):
            fail("capabilities 没有声明 external_plugins: %r" % caps)
        log("capabilities ok: api=%s" % caps.get("api_version"))

        # 5) 解析预览
        preview = expect_ok("POST", "/api/plugins/external/resolve", {
            "source": {"type": "archive", "path": str(package)},
        })["data"]
        manifest = preview.get("manifest") or {}
        if manifest.get("id") != "hello_world":
            fail("预览清单 id 不对：%r" % manifest.get("id"))
        if not preview.get("compatible"):
            fail("预览判定不兼容：%r" % preview.get("checks"))
        perms = [p["name"] for p in preview.get("permissions", [])]
        log("预览 ok：version=%s 权限=%s" % (manifest.get("version"), perms))

        # 6) 安装（确认非高风险权限，默认启用）
        install = expect_ok("POST", "/api/plugins/external/install", {
            "source": {"type": "archive", "path": str(package)},
            "confirm_permissions": perms,
            "enable": True,
        })["data"]
        plugin = install.get("plugin") or {}
        if not plugin.get("enabled") or not plugin.get("running"):
            fail("安装后没有运行：%r" % plugin)
        pid = plugin["id"]
        log("安装并启用 ok：%s running=%s" % (pid, plugin.get("running")))

        # 7) 列表 + 命令调用（走子进程 RPC）
        listed = expect_ok("GET", "/api/plugins/external")["data"]
        if not any(p.get("id") == pid and p.get("running") for p in listed):
            fail("列表里没有运行中的插件：%r" % listed)
        reply = expect_ok("POST", "/api/plugins/external/%s/call" % pid, {
            "method": "plugin.command.run",
            "params": {"command": "hello_world.say_hi", "args": {}},
        })
        result = json.dumps(reply.get("data"), ensure_ascii=False)
        if "hello_world" not in result and "问候" not in result:
            fail("命令返回不符合预期：%r" % reply)
        log("plugin.command.run ok：%s" % result[:120])

        # 7.1) 前端 → 宿主 broker：设置 / 只读对象 / 通知
        expect_ok("POST", "/api/plugins/external/%s/call" % pid, {
            "method": "host.settings.set", "params": {"key": "greet_on_open", "value": True},
        })
        got = expect_ok("POST", "/api/plugins/external/%s/call" % pid, {
            "method": "host.settings.get", "params": {"key": "greet_on_open"},
        })["data"]
        if not (isinstance(got, dict) and got.get("value") is True):
            fail("host.settings 回读不对：%r" % got)
        objs = expect_ok("POST", "/api/plugins/external/%s/call" % pid, {
            "method": "host.objects.list", "params": {"limit": 5},
        })["data"]
        if not (isinstance(objs, dict) and isinstance(objs.get("items"), list)):
            fail("host.objects.list 返回不对：%r" % objs)
        expect_ok("POST", "/api/plugins/external/%s/call" % pid, {
            "method": "host.notify", "params": {"level": "info", "title": "e2e", "body": "来自外部插件 e2e"},
        })
        log("host.settings/objects/notify ok")

        # 7.2) 未放行的方法必须 400（前端不能借 /call 调生命周期/未实现的 broker）
        status, payload = http("POST", "/api/plugins/external/%s/call" % pid, {
            "method": "plugin.activate", "params": {},
        })
        if status != 400:
            fail("/call 应该拒绝 plugin.activate，实际 %s %r" % (status, payload))
        status, payload = http("POST", "/api/plugins/external/%s/call" % pid, {
            "method": "host.secrets.get", "params": {"scope": "im"},
        })
        if status != 400:
            fail("/call 应该拒绝未放行的 host.secrets.get，实际 %s %r" % (status, payload))
        log("未放行方法 400 ok")

        # 7.3) 重启 PMW 后 enabled 插件自动恢复
        log("重启实例验证自动恢复")
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=15)
        proc = spawn()
        wait_health()
        rows = expect_ok("GET", "/api/plugins/external")["data"]
        row = next((p for p in rows if p.get("id") == pid), None)
        if not row or not row.get("running"):
            fail("重启后插件没有自动恢复：%r" % rows)
        log("重启后 running=True ok")

        # 8) 前端资源 + 图标
        status, body = http("GET", "/api/plugins/external/%s/web/entry.js" % pid)
        if status != 200 or b"__PMW_PLUGIN__" not in body:
            fail("web/entry.js 不可用：status=%s bytes=%s" % (status, len(body) if body else 0))
        status, css = http("GET", "/api/plugins/external/%s/web/web/style.css" % pid)
        if status != 200:
            fail("web/style.css 不可用：status=%s" % status)
        listed = expect_ok("GET", "/api/plugins/external")["data"]
        row = next((p for p in listed if p.get("id") == pid), {})
        if "web/style.css" not in (row.get("web_styles") or []):
            fail("Info.web_styles 没带清单样式：%r" % row.get("web_styles"))
        status, _ = http("GET", "/api/plugins/external/%s/icon" % pid)
        if status != 200:
            fail("icon 不可用：status=%s" % status)
        log("前端资源 ok（entry.js + style.css + icon，web_styles 已暴露）")

        # 8.1) 升级到 0.2.0（同一份源码改版本号重新打包）→ 回滚到 0.1.0
        log("升级/回滚验证")
        v2dir = tmp / "hello-world-v2"
        shutil.copytree(EXAMPLE, v2dir)
        manifest_path = v2dir / "plugin.json"
        manifest_v2 = json.loads(manifest_path.read_text("utf-8"))
        manifest_v2["version"] = "0.2.0"
        manifest_path.write_text(json.dumps(manifest_v2, ensure_ascii=False, indent=2), "utf-8")
        pack2 = subprocess.run(
            [sys.executable, str(SKILL), "pack", str(v2dir)],
            cwd=ROOT, capture_output=True, text=True,
        )
        if pack2.returncode != 0:
            fail("打包 v2 失败：\n" + pack2.stdout[-1500:] + pack2.stderr[-1500:])
        v2tar = sorted((v2dir / "dist").glob("hello_world-0.2.0-*.tar.gz"))
        if not v2tar:
            fail("没有找到 v2 打包产物")
        up = expect_ok("POST", "/api/plugins/external/%s/upgrade" % pid, {
            "source": {"type": "archive", "path": str(v2tar[-1])},
            "confirm_permissions": perms,
        })["data"]
        if up.get("version") != "0.2.0" or not up.get("running") or up.get("previous_version") != "0.1.0":
            fail("升级后状态不对：%r" % up)
        rb = expect_ok("POST", "/api/plugins/external/%s/rollback" % pid, {})["data"]
        if rb.get("version") != "0.1.0" or not rb.get("running") or rb.get("previous_version") != "0.2.0":
            fail("回滚后状态不对：%r" % rb)
        log("升级 0.1.0→0.2.0、回滚 0.2.0→0.1.0 ok")

        # 9) 停用 → 进程退出、再次启用恢复
        off = expect_ok("POST", "/api/plugins/external/%s/disable" % pid, {})["data"]
        if off.get("running"):
            fail("停用后仍 running：%r" % off)
        on = expect_ok("POST", "/api/plugins/external/%s/enable" % pid, {})["data"]
        if not on.get("running"):
            fail("再次启用失败：%r" % on)
        log("停用/启用 ok")

        # 10) 卸载
        un = expect_ok("POST", "/api/plugins/external/%s/uninstall" % pid, {"delete_data": False})["data"]
        if un.get("enabled") or un.get("running"):
            fail("卸载后状态不对：%r" % un)
        left = expect_ok("GET", "/api/plugins/external")["data"]
        if any(p.get("id") == pid for p in left):
            fail("卸载后列表里还有：%r" % left)
        log("卸载 ok")

        log("PASS：外部插件 P1-a 闭环全部通过")
        return 0
    finally:
        if proc is not None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            try:
                out = proc.stdout.read() if proc.stdout else ""
            except Exception:
                out = ""
            if out and "fatal" in out:
                print("[e2e] 实例输出（含 fatal）：\n" + out[-3000:], file=sys.stderr)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
