# -*- coding: utf-8 -*-
"""
天枢台 (TianshuTai) · 运行环境自动安装器
=======================================

给最终用户使用的「一键环境准备」工具：

  1. 第一次运行自动检测本机环境（主程序 / Node.js / WebView2 / VC++ / 内核）
  2. 发现缺失就自动下载并静默安装，全程无需用户手工配置
  3. 环境齐全后自动启动天枢台

界面：深色桌面工具风格；窗口底部同时提供「环境检查进度条」与「下载进度条」。
打包：双击同目录下的「打包.bat」即可生成无控制台黑窗的单文件 exe。

命令行（仅供排查/打包使用，普通用户直接双击即可）：
  --selftest   不开窗口，直接把检测结果打印到控制台
  --build      调用 PyInstaller 打包成 exe（由「打包.bat」调用）
"""

from __future__ import annotations

import ctypes
import json
import os
import queue
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import winreg
import zipfile

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

# --------------------------------------------------------------------------- #
# 常量
# --------------------------------------------------------------------------- #

APP_TITLE = "天枢台"
TITLE = "天枢台 · 运行环境自动安装"
SUBTITLE = "首次运行自动检测并补齐运行环境，无需手动配置"
VERSION = "1.0.0"

CREATE_NO_WINDOW = 0x08000000
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TianshuTaiEnvSetup/1.0"

EXE_NAMES = ("TianshuTai.exe", "ai-browser.exe")
ICON_FILE = "天枢台.ico"
LOGO_FILE = "天枢台.png"

NODE_MIN_MAJOR = 18
NODE_MIRRORS = ("https://npmmirror.com/mirrors/node", "https://nodejs.org/dist")
NODE_FALLBACK = ("v24.21.0", "v22.14.0", "v20.18.1", "v18.20.4")

WV2_URLS = (
    "https://go.microsoft.com/fwlink/p/?LinkId=2124703",
    "https://go.microsoft.com/fwlink/?linkid=2124703",
)
VC_URLS = ("https://aka.ms/vs/17/release/vc_redist.x64.exe",)

WV2_GUIDS = (
    r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
)

# 组件表：key, 名称, 说明
ITEMS = (
    ("app", "天枢台主程序", "TianshuTai.exe 与 sidecar"),
    ("node", "Node.js 运行环境", "Sidecar 引擎依赖"),
    ("webview2", "WebView2 运行库", "界面渲染组件"),
    ("vcpp", "VC++ 运行库 x64", "系统运行组件"),
    ("kernels", "Chromium 浏览器内核", "本地指纹内核"),
    ("cloak", "CloakBrowser 指纹浏览器", "可选组件"),
)
ITEM_NAMES = {k: n for k, n, _ in ITEMS}
AUTO_ORDER = ("node", "webview2", "vcpp")        # 可自动安装的组件顺序
BLOCKING = {"app", "node", "webview2"}           # 未就绪就不启动程序

SKIP_SCAN_DIRS = {
    "windows", "program files", "program files (x86)", "programdata", "$recycle.bin",
    "system volume information", "perflogs", "users", "recovery", "msocache",
    "intel", "amd", "nvidia", "drivers", "config.msi", "documents and settings",
    ".git", "node_modules",
}

# 颜色（深色桌面工具风格）
C = {
    "bg": "#0e1621",
    "panel": "#151f2c",
    "panel2": "#1b2836",
    "line": "#26394c",
    "text": "#e8f0f9",
    "muted": "#8ba0b6",
    "dim": "#5c748c",
    "accent": "#2f9bff",
    "accent_dark": "#1d6fd0",
    "ok": "#3ddc97",
    "warn": "#ffc857",
    "err": "#ff6b6b",
    "idle": "#5c748c",
}


def base_dir() -> str:
    """程序所在目录（打包成 exe 后取 exe 所在目录）。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def resource_path(name: str) -> str:
    """图标等随包资源路径。"""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        p = os.path.join(meipass, name)
        if os.path.exists(p):
            return p
    return os.path.join(base_dir(), name)


def enable_dpi_awareness() -> None:
    """让高分屏下界面保持清晰（必须在创建窗口之前调用）。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:  # noqa: BLE001
        pass


def read_dpi() -> int:
    try:
        return int(ctypes.windll.user32.GetDpiForSystem())
    except Exception:  # noqa: BLE001
        return 96


def human(size) -> str:
    n = float(size or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return ("%d %s" % (int(n), unit)) if unit == "B" else ("%.1f %s" % (n, unit))
        n /= 1024.0
    return "%.1f TB" % n


def run_quiet(exe, args, timeout=25):
    """隐藏窗口执行命令，返回 (returncode, 输出文本)。"""
    try:
        proc = subprocess.run(
            [exe] + list(args),
            capture_output=True, text=True, timeout=timeout,
            creationflags=CREATE_NO_WINDOW, encoding="utf-8", errors="replace",
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:  # noqa: BLE001
        return -1, str(exc)


# --------------------------------------------------------------------------- #
# 注册表 / PATH
# --------------------------------------------------------------------------- #

def reg_read_path(root, sub) -> str:
    try:
        with winreg.OpenKey(root, sub) as key:
            value, _ = winreg.QueryValueEx(key, "Path")
            return value or ""
    except OSError:
        return ""


def refresh_process_path() -> None:
    """把最新的系统/用户 PATH 合并进本进程，避免刚装完检测不到。"""
    chunks = []
    for root, sub in (
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        (winreg.HKEY_CURRENT_USER, r"Environment"),
    ):
        value = reg_read_path(root, sub)
        if value:
            chunks.append(os.path.expandvars(value))
    if chunks:
        os.environ["PATH"] = ";".join(chunks) + ";" + os.environ.get("PATH", "")


def broadcast_env_change() -> None:
    try:
        HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG = 0xFFFF, 0x001A, 0x0002
        ctypes.windll.user32.SendMessageTimeoutW(
            HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment", SMTO_ABORTIFHUNG, 3000, None
        )
    except Exception:  # noqa: BLE001
        pass


def add_user_path(folder: str) -> bool:
    """把目录写进当前用户 PATH（不需要管理员权限）。"""
    folder = os.path.abspath(folder)
    current = reg_read_path(winreg.HKEY_CURRENT_USER, "Environment")
    parts = [p for p in current.split(";") if p.strip()]
    for p in parts:
        if os.path.normcase(os.path.expandvars(p).rstrip("\\")) == os.path.normcase(folder.rstrip("\\")):
            refresh_process_path()
            return False
    parts.append(folder)
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, "Path", 0, winreg.REG_EXPAND_SZ, ";".join(parts))
    except OSError:
        return False
    broadcast_env_change()
    refresh_process_path()
    return True


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:  # noqa: BLE001
        return False


class SHELLEXECUTEINFOW(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_ulong),
        ("fMask", ctypes.c_ulong),
        ("hwnd", ctypes.c_void_p),
        ("lpVerb", ctypes.c_wchar_p),
        ("lpFile", ctypes.c_wchar_p),
        ("lpParameters", ctypes.c_wchar_p),
        ("lpDirectory", ctypes.c_wchar_p),
        ("nShow", ctypes.c_int),
        ("hInstApp", ctypes.c_void_p),
        ("lpIDList", ctypes.c_void_p),
        ("lpClass", ctypes.c_wchar_p),
        ("hkeyClass", ctypes.c_void_p),
        ("dwHotKey", ctypes.c_ulong),
        ("hIcon", ctypes.c_void_p),
        ("hProcess", ctypes.c_void_p),
    ]


def shell_exec_wait(exe: str, params: str = "", elevate: bool = False, cwd: str | None = None) -> int:
    """运行安装程序并等待结束；elevate=True 时弹 UAC 提权。返回退出码，<0 表示失败。"""
    SEE_MASK_NOCLOSEPROCESS = 0x00000040
    info = SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = SEE_MASK_NOCLOSEPROCESS
    info.lpVerb = "runas" if elevate else "open"
    info.lpFile = exe
    info.lpParameters = params or None
    info.lpDirectory = cwd
    info.nShow = 0
    if not ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(info)):
        return -ctypes.windll.kernel32.GetLastError()
    if not info.hProcess:
        return 0
    INFINITE = 0xFFFFFFFF
    ctypes.windll.kernel32.WaitForSingleObject(info.hProcess, INFINITE)
    code = ctypes.c_ulong(0)
    ctypes.windll.kernel32.GetExitCodeProcess(info.hProcess, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(info.hProcess)
    return int(code.value)


# --------------------------------------------------------------------------- #
# 定位天枢台程序目录
# --------------------------------------------------------------------------- #

def first_exe(folder: str):
    if not folder:
        return None
    for name in EXE_NAMES:
        p = os.path.join(folder, name)
        if os.path.exists(p):
            return p
    return None


def looks_like_app_dir(folder: str) -> bool:
    if not folder or not os.path.isdir(folder):
        return False
    if first_exe(folder):
        return True
    return os.path.isdir(os.path.join(folder, "sidecar", "dist"))


def fixed_drive_roots():
    roots = []
    try:
        mask = ctypes.windll.kernel32.GetLogicalDrives()
        for i in range(26):
            if mask & (1 << i):
                root = "%s:\\" % chr(ord("A") + i)
                if ctypes.windll.kernel32.GetDriveTypeW(root) == 3:  # DRIVE_FIXED
                    roots.append(root)
    except Exception:  # noqa: BLE001
        pass
    return roots


def _scan(base: str, depth: int = 1):
    if looks_like_app_dir(base):
        return os.path.abspath(base)
    if depth <= 0:
        return None
    try:
        entries = sorted(os.listdir(base))
    except OSError:
        return None
    for name in entries:
        if name.lower() in SKIP_SCAN_DIRS:
            continue
        path = os.path.join(base, name)
        if os.path.isdir(path) and looks_like_app_dir(path):
            return os.path.abspath(path)
    return None


def find_app_dir():
    here = base_dir()
    home = os.path.expanduser("~")
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        here,
        os.path.dirname(here),
        os.path.join(here, "portable"),
        os.path.join(os.path.dirname(here), "portable"),
        os.path.join(home, "Desktop"), os.path.join(home, "桌面"),
        os.path.join(home, "Downloads"), os.path.join(home, "下载"),
        os.path.join(local, "TianshuTai") if local else "",
        os.path.join(local, "Programs", "TianshuTai") if local else "",
        os.path.join(os.environ.get("ProgramFiles", ""), "TianshuTai"),
    ]
    for cand in candidates:
        if cand and os.path.isdir(cand):
            hit = _scan(cand, 1)
            if hit:
                return hit
    roots = [r for r in fixed_drive_roots()]
    for root in roots:
        if root.lower().startswith("c:"):
            hit = _scan(root, 1)
            if hit:
                return hit
    for root in roots:
        hit = _scan(root, 1)
        if hit:
            return hit
    return None


# --------------------------------------------------------------------------- #
# 各项检测
# --------------------------------------------------------------------------- #

def node_bin_dirs(app_dir):
    dirs = []
    roots = []
    if app_dir:
        roots.append(os.path.join(app_dir, "runtime"))
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        roots.append(os.path.join(local, "TianshuTai", "runtime"))
    for root in roots:
        if not os.path.isdir(root):
            continue
        dirs.append(os.path.join(root, "node"))
        try:
            for name in os.listdir(root):
                dirs.append(os.path.join(root, name))
        except OSError:
            pass
    if app_dir:
        dirs.append(os.path.join(app_dir, "node"))
    return dirs


def check_node(app_dir):
    refresh_process_path()
    candidates = list(node_bin_dirs(app_dir))
    which = shutil.which("node")
    if which:
        candidates.append(os.path.dirname(which))
    candidates += [
        os.path.join(os.environ.get("ProgramFiles", ""), "nodejs"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "nodejs"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "nodejs"),
    ]
    nvm = os.path.join(os.environ.get("APPDATA", ""), "nvm")
    if os.path.isdir(nvm):
        try:
            for name in os.listdir(nvm):
                candidates.append(os.path.join(nvm, name))
        except OSError:
            pass
    seen = set()
    old_version = ""
    for folder in candidates:
        if not folder:
            continue
        key = os.path.normcase(os.path.abspath(folder))
        if key in seen:
            continue
        seen.add(key)
        exe = os.path.join(folder, "node.exe")
        if not os.path.exists(exe):
            continue
        version, major = node_version(exe)
        if not version:
            continue
        if major < NODE_MIN_MAJOR:
            old_version = version
            continue
        return "ok", "Node.js %s" % version, {"exe": exe, "dir": folder, "version": version}
    if old_version:
        return "missing", "Node.js %s 版本过低（需要 ≥ %d）" % (old_version, NODE_MIN_MAJOR), None
    return "missing", "未检测到 Node.js（Sidecar 引擎必需）", None


def node_version(exe: str):
    code, out = run_quiet(exe, ["-v"], timeout=15)
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", out or "")
    if code == 0 and match:
        return ".".join(match.groups()), int(match.group(1))
    return "", 0


def _wv2_exe_in(folder: str):
    if not folder or not os.path.isdir(folder):
        return None
    direct = os.path.join(folder, "msedgewebview2.exe")
    if os.path.exists(direct):
        return direct
    try:
        for name in os.listdir(folder):
            p = os.path.join(folder, name, "msedgewebview2.exe")
            if os.path.exists(p):
                return p
    except OSError:
        pass
    return None


def check_webview2(app_dir=None):
    for base in (
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), r"Microsoft\EdgeWebView\Application"),
        os.path.join(os.environ.get("ProgramFiles", ""), r"Microsoft\EdgeWebView\Application"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Microsoft\EdgeWebView\Application"),
    ):
        exe = _wv2_exe_in(base)
        if exe:
            version = os.path.basename(os.path.dirname(exe)) if os.path.basename(exe).lower().startswith("msedge") else ""
            detail = "WebView2 已安装" + ("（%s）" % version if version[0:1].isdigit() else "")
            return "ok", detail, {"exe": exe}
    for root, sub in ((winreg.HKEY_LOCAL_MACHINE, WV2_GUIDS[0]),
                      (winreg.HKEY_LOCAL_MACHINE, WV2_GUIDS[1]),
                      (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}")):
        try:
            with winreg.OpenKey(root, sub) as key:
                pv, _ = winreg.QueryValueEx(key, "pv")
            if pv:
                return "ok", "WebView2 已安装（%s）" % pv, None
        except OSError:
            continue
    return "missing", "未检测到 WebView2 运行库（界面必需）", None


def check_vcpp(app_dir=None):
    sys32 = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
    need = ("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll")
    missing = [n for n in need if not os.path.exists(os.path.join(sys32, n))]
    if not missing:
        return "ok", "VC++ 2015-2022 运行库已就绪", None
    return "missing", "缺少 %s" % "、".join(missing), None


def check_kernels(app_dir):
    if not app_dir:
        return "warn", "未找到程序目录", None
    found = []
    for sub in ("Browse", "内核", "Kernel"):
        folder = os.path.join(app_dir, sub)
        if not os.path.isdir(folder):
            continue
        try:
            for name in sorted(os.listdir(folder)):
                if os.path.exists(os.path.join(folder, name, "chrome.exe")):
                    found.append(name)
        except OSError:
            pass
    if found:
        head = "、".join(found[:2]) + ("…" if len(found) > 2 else "")
        return "ok", "已内置 %d 个内核（%s）" % (len(found), head), None
    return "warn", "未内置内核，可在应用内「设置 → 内核」下载", None


def check_cloak(app_dir):
    candidates = []
    env_path = os.environ.get("CLOAK_BROWSER_PATH", "")
    if env_path:
        candidates.append(env_path)
    for base in (os.environ.get("ProgramFiles", ""), os.environ.get("LOCALAPPDATA", "")):
        if base:
            candidates.append(os.path.join(base, "CloakBrowser", "CloakBrowser.exe"))
    if app_dir:
        candidates.append(os.path.join(app_dir, "CloakBrowser", "CloakBrowser.exe"))
    for path in candidates:
        if path and os.path.exists(path):
            return "ok", "已检测到 CloakBrowser", None
    return "info", "未检测到（可选；使用内置内核时不影响）", None


def check_app(app_dir):
    if not app_dir or not os.path.isdir(app_dir):
        return "missing", "未找到程序目录，请点「浏览…」选择天枢台所在文件夹", None
    exe = first_exe(app_dir)
    if not exe:
        return "missing", "缺少 TianshuTai.exe / ai-browser.exe", None
    if not os.path.exists(os.path.join(app_dir, "sidecar", "dist", "index.js")):
        return "missing", "缺少 sidecar 目录（请使用完整压缩包）", None
    return "ok", "%s 与 sidecar 已就绪" % os.path.basename(exe), {"exe": exe}


CHECKERS = {
    "app": check_app,
    "node": check_node,
    "webview2": check_webview2,
    "vcpp": check_vcpp,
    "kernels": check_kernels,
    "cloak": check_cloak,
}


# --------------------------------------------------------------------------- #
# 主界面
# --------------------------------------------------------------------------- #

class EnvInstaller:
    def __init__(self, root):
        self.root = root
        self.q = queue.Queue()
        self.busy = False
        self.cancel_evt = threading.Event()
        self.states = {}
        self.extras = {}
        self.rows = {}
        self.action_state = "idle"          # idle | busy | countdown
        self.countdown = 0
        self.spin = 0
        self.app_dir = find_app_dir()
        self.node_dir = None
        self.launched = False
        self.tmpdir = tempfile.mkdtemp(prefix="tst-env-")

        self.dpi = read_dpi()
        self.S = max(self.dpi / 96.0, 1.0)
        self.font = self._pick_font()
        self._build_ui()

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.after(120, self._pump)
        self.root.after(500, self._first_run)

    # ---------------- 基础 ----------------

    def px(self, n):
        return int(round(n * self.S))

    def _pick_font(self):
        try:
            from tkinter import font as tkfont
            families = set(tkfont.families())
        except Exception:  # noqa: BLE001
            families = set()
        for name in ("Microsoft YaHei UI", "Microsoft YaHei", "微软雅黑", "Segoe UI"):
            if name in families:
                return name
        return "Microsoft YaHei UI"

    def f(self, size, bold=False):
        return (self.font, size, "bold") if bold else (self.font, size)

    # ---------------- 界面搭建 ----------------

    def _build_ui(self):
        root = self.root
        root.title(TITLE)
        root.configure(bg=C["bg"])
        w, h = self.px(880), self.px(760)
        root.geometry("%dx%d" % (w, h))
        root.minsize(self.px(780), self.px(660))

        icon = resource_path(ICON_FILE)
        if os.path.exists(icon):
            try:
                root.iconbitmap(default=icon)
            except Exception:  # noqa: BLE001
                pass
        self.logo_img = None
        logo = resource_path(LOGO_FILE)
        if os.path.exists(logo):
            try:
                from tkinter import PhotoImage

                img = PhotoImage(file=logo)
                factor = max(1, img.width() // self.px(56))
                self.logo_img = img.subsample(factor, factor)
                root.iconphoto(True, img)
            except Exception:  # noqa: BLE001
                self.logo_img = None

        self._init_style()
        self._build_header()
        self._build_center()
        self._build_bottom()

    def _init_style(self):
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except Exception:  # noqa: BLE001
            pass
        for name, color in (("Check", C["accent"]), ("Down", C["ok"])):
            style.configure(
                "%s.Horizontal.TProgressbar" % name,
                troughcolor=C["panel2"], bordercolor=C["panel2"], background=color,
                lightcolor=color, darkcolor=color, thickness=self.px(13),
            )
        style.configure(
            "TS.Vertical.TScrollbar",
            background=C["panel2"], troughcolor=C["panel"], bordercolor=C["panel"],
            arrowcolor=C["muted"], lightcolor=C["panel2"], darkcolor=C["panel2"],
        )

    def _build_header(self):
        self.header_h = self.px(94)
        self.header = tk.Canvas(self.root, height=self.header_h, bd=0, highlightthickness=0, bg=C["bg"])
        self.header.pack(fill="x")
        self.header.bind("<Configure>", self._paint_header)

    def _paint_header(self, _event=None):
        canvas = self.header
        width = max(canvas.winfo_width(), self.px(200))
        height = self.header_h
        canvas.delete("all")
        start, end = (18, 34, 56), (14, 22, 33)
        for y in range(height):
            t = y / float(max(height - 1, 1))
            color = "#%02x%02x%02x" % tuple(int(start[i] + (end[i] - start[i]) * t) for i in range(3))
            canvas.create_line(0, y, width, y, fill=color)
        canvas.create_line(0, height - 1, width, height - 1, fill=C["line"])
        canvas.create_line(0, height - 1, width, height - 1, fill=C["accent"], width=2)

        x = self.px(24)
        if self.logo_img is not None:
            canvas.create_image(x, height // 2, image=self.logo_img, anchor="w")
            x += self.logo_img.width() + self.px(16)
        canvas.create_text(x, self.px(35), text=TITLE, anchor="w", fill="#eef5ff", font=self.f(15, True))
        canvas.create_text(x, self.px(64), text=SUBTITLE, anchor="w", fill="#93a9c0", font=self.f(9))
        canvas.create_text(width - self.px(20), self.px(20), text="v" + VERSION, anchor="e",
                           fill="#63798f", font=self.f(8))

    def _card(self, parent, title=None):
        outer = tk.Frame(parent, bg=C["panel"], highlightthickness=1, highlightbackground=C["line"])
        outer.pack(fill="x", padx=self.px(16), pady=(self.px(12), 0))
        if title:
            head = tk.Frame(outer, bg=C["panel"])
            head.pack(fill="x", padx=self.px(14), pady=(self.px(10), 0))
            tk.Label(head, text=title, bg=C["panel"], fg=C["muted"],
                     font=self.f(9, True)).pack(side="left")
            body = tk.Frame(outer, bg=C["panel"])
            body.pack(fill="x", padx=self.px(14), pady=(self.px(6), self.px(12)))
            return body
        return outer

    def _build_center(self):
        root = self.root

        # 程序目录
        body = self._card(root, "程序目录")
        row = tk.Frame(body, bg=C["panel"])
        row.pack(fill="x")
        self.dir_var = tk.StringVar(value=self.app_dir or "")
        entry = tk.Entry(
            row, textvariable=self.dir_var, font=self.f(9), bg=C["panel2"], fg=C["text"],
            insertbackground=C["text"], relief="flat", bd=0, highlightthickness=1,
            highlightbackground=C["line"], highlightcolor=C["accent"],
        )
        entry.pack(side="left", fill="x", expand=True, ipady=self.px(6), padx=(0, self.px(8)))
        self._button(row, "浏览…", self.on_browse, "ghost").pack(side="left")

        # 环境检查
        body = self._card(root, "环境检查")
        for key, name, desc in ITEMS:
            line = tk.Frame(body, bg=C["panel"])
            line.pack(fill="x", pady=self.px(2))
            dot = tk.Label(line, text="○", bg=C["panel"], fg=C["idle"], width=3,
                           anchor="w", font=self.f(10, True))
            dot.pack(side="left")
            tk.Label(line, text=name, bg=C["panel"], fg=C["text"], width=22, anchor="w",
                     font=self.f(10)).pack(side="left")
            detail = tk.Label(line, text=desc, bg=C["panel"], fg=C["muted"], anchor="w", font=self.f(9))
            detail.pack(side="left", fill="x", expand=True)
            self.rows[key] = {"dot": dot, "detail": detail, "state": "pending"}

        # 运行日志
        body = self._card(root, "运行日志")
        wrap = tk.Frame(body, bg=C["panel"])
        wrap.pack(fill="both", expand=True)
        self.log = tk.Text(
            wrap, height=9, bg=C["panel2"], fg=C["text"], bd=0, relief="flat",
            highlightthickness=1, highlightbackground=C["line"], font=self.f(9),
            padx=self.px(10), pady=self.px(8), wrap="word", insertbackground=C["text"],
        )
        scroll = ttk.Scrollbar(wrap, orient="vertical", style="TS.Vertical.TScrollbar",
                               command=self.log.yview)
        self.log.configure(yscrollcommand=scroll.set, state="disabled")
        scroll.pack(side="right", fill="y")
        self.log.pack(side="left", fill="both", expand=True)
        for tag, color in (("ok", C["ok"]), ("warn", C["warn"]), ("err", C["err"]),
                           ("step", C["accent"]), ("info", C["muted"])):
            self.log.tag_configure(tag, foreground=color)
        self.log.tag_configure("muted", foreground=C["dim"])

    def _build_bottom(self):
        root = self.root
        bottom = tk.Frame(root, bg=C["bg"])
        bottom.pack(fill="x", side="bottom", padx=self.px(16), pady=(self.px(10), self.px(12)))

        # 按钮行
        buttons = tk.Frame(bottom, bg=C["bg"])
        buttons.pack(fill="x")
        self.status_label = tk.Label(buttons, text="准备就绪", bg=C["bg"], fg=C["muted"],
                                     font=self.f(9), anchor="w")
        self.status_label.pack(side="left")
        self.btn_launch = self._button(buttons, "启动天枢台", self.on_launch, "ghost")
        self.btn_launch.pack(side="right")
        self.btn_action = self._button(buttons, "一键安装缺失组件", self.on_action, "primary")
        self.btn_action.pack(side="right", padx=(0, self.px(8)))
        self.btn_check = self._button(buttons, "重新检查", self.on_check, "ghost")
        self.btn_check.pack(side="right", padx=(0, self.px(8)))

        # 进度条
        bars = tk.Frame(bottom, bg=C["bg"])
        bars.pack(fill="x", pady=(self.px(12), 0))
        bars.columnconfigure(1, weight=1)

        tk.Label(bars, text="环境检查进度", bg=C["bg"], fg=C["muted"], font=self.f(9),
                 anchor="w", width=12).grid(row=0, column=0, sticky="w")
        self.bar_check = ttk.Progressbar(bars, style="Check.Horizontal.TProgressbar",
                                        mode="determinate", maximum=100.0)
        self.bar_check.grid(row=0, column=1, sticky="ew", padx=self.px(10))
        self.check_pct = tk.Label(bars, text="0%", bg=C["bg"], fg=C["text"], font=self.f(9),
                                  anchor="e", width=10)
        self.check_pct.grid(row=0, column=2, sticky="e")

        tk.Label(bars, text="下载进度", bg=C["bg"], fg=C["muted"], font=self.f(9),
                 anchor="w", width=12).grid(row=1, column=0, sticky="w", pady=(self.px(8), 0))
        self.bar_down = ttk.Progressbar(bars, style="Down.Horizontal.TProgressbar",
                                       mode="determinate", maximum=100.0)
        self.bar_down.grid(row=1, column=1, sticky="ew", padx=self.px(10), pady=(self.px(8), 0))
        self.down_pct = tk.Label(bars, text="—", bg=C["bg"], fg=C["muted"], font=self.f(9),
                                 anchor="e", width=10)
        self.down_pct.grid(row=1, column=2, sticky="e", pady=(self.px(8), 0))

    def _button(self, parent, text, command, kind="ghost"):
        palette = {
            "primary": (C["accent"], "#06131f", C["accent_dark"], "#04101a"),
            "ghost": (C["panel2"], C["text"], C["line"], C["text"]),
        }
        bg, fg, active_bg, active_fg = palette[kind]
        btn = tk.Button(
            parent, text=text, command=command, font=self.f(10, True), bd=0, relief="flat",
            bg=bg, fg=fg, activebackground=active_bg, activeforeground=active_fg,
            disabledforeground=C["dim"], cursor="hand2",
            padx=self.px(16), pady=self.px(8),
        )
        if kind == "ghost":
            btn.configure(highlightthickness=1, highlightbackground=C["line"])
        btn.bind("<Enter>", lambda _e, b=btn, c=active_bg: b.configure(bg=c) if str(b["state"]) != "disabled" else None)
        btn.bind("<Leave>", lambda _e, b=btn, c=bg: b.configure(bg=c) if str(b["state"]) != "disabled" else None)
        return btn

    # ---------------- 消息泵 ----------------

    def post(self, *msg):
        self.q.put(msg)

    def _pump(self):
        try:
            while True:
                self._handle(self.q.get_nowait())
        except queue.Empty:
            pass
        self._animate()
        self.root.after(90, self._pump)

    def _handle(self, msg):
        kind = msg[0]
        if kind == "log":
            self._log(msg[1], msg[2])
        elif kind == "item":
            self._set_item(msg[1], msg[2], msg[3])
        elif kind == "bar":
            self._set_bar(msg[1], msg[2], msg[3] if len(msg) > 3 else None)
        elif kind == "download":
            self._set_download(msg[1], msg[2], msg[3])
        elif kind == "status":
            self.status_label.configure(text=msg[1])
        elif kind == "busy":
            self._set_busy(bool(msg[1]))
        elif kind == "ready":
            self._on_ready(bool(msg[1]))
        elif kind == "bad":
            self._log("err", msg[1])

    def _log(self, level, text):
        prefix = {
            "ok": "  [完成] ", "warn": "  [注意] ", "err": "  [失败] ",
            "step": "▶ ", "info": "  [信息] ", "muted": "         ",
        }.get(level, "  ")
        self.log.configure(state="normal")
        self.log.insert("end", prefix + text + "\n", level)
        self.log.see("end")
        self.log.configure(state="disabled")

    def _set_item(self, key, state, detail):
        row = self.rows.get(key)
        if not row:
            return
        glyph, color = {
            "pending": ("○", C["idle"]),
            "checking": ("|", C["accent"]),
            "working": ("|", C["accent"]),
            "ok": ("●", C["ok"]),
            "warn": ("!", C["warn"]),
            "info": ("○", C["idle"]),
            "missing": ("×", C["err"]),
            "fail": ("×", C["err"]),
        }.get(state, ("○", C["idle"]))
        row["dot"].configure(text=glyph, fg=color)
        if detail is not None:
            row["detail"].configure(text=detail)
        row["state"] = state

    def _animate(self):
        self.spin = (self.spin + 1) % 4
        frames = ("|", "/", "-", "\\")
        for row in self.rows.values():
            if row["state"] in ("checking", "working"):
                row["dot"].configure(text=frames[self.spin])

    def _set_bar(self, name, mode, value, _label=None):
        bar = self.bar_check if name == "check" else self.bar_down
        pct = self.check_pct if name == "check" else self.down_pct
        if mode == "indeterminate":
            bar.configure(mode="indeterminate")
            bar.start(12)
            pct.configure(text="…")
            return
        bar.stop()
        bar.configure(mode="determinate")
        if value is None:
            return
        bar["value"] = max(0.0, min(100.0, float(value)))
        pct.configure(text="%d%%" % int(round(value)))

    def _set_download(self, mode, frac, text):
        if mode == "idle":
            self._set_bar("down", "determinate", 0.0)
            self.down_pct.configure(text="—")
            return
        if mode == "indeterminate":
            self._set_bar("down", "indeterminate", 0.0)
            self.down_pct.configure(text="…")
        else:
            self._set_bar("down", "determinate", float(frac) * 100.0)
        if text:
            self.status_label.configure(text=text)

    def _set_busy(self, busy):
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.btn_check.configure(state=state)
        self.btn_launch.configure(state="disabled" if busy else "normal")
        self.btn_action.configure(state="normal")
        if busy:
            self.action_state = "busy"
            self.btn_action.configure(text="取消", bg=C["err"], activebackground="#d95555",
                                      fg="#1b0a0a", activeforeground="#1b0a0a")
        elif self.action_state != "countdown":
            self.action_state = "idle"
            self._reset_action_button()

    def _reset_action_button(self, text=None):
        self.btn_action.configure(
            text=text or self._action_text(), bg=C["accent"], activebackground=C["accent_dark"],
            fg="#06131f", activeforeground="#04101a", state="normal",
        )

    def _action_text(self):
        return "一键安装缺失组件"

    # ---------------- 按键 ----------------

    def _first_run(self):
        self._log("step", "欢迎使用%s环境安装向导。" % APP_TITLE)
        if not self.app_dir:
            self._log("warn", "未能自动定位天枢台程序目录，请点「浏览…」手动选择。")
            self.dir_var.set("")
            self.status_label.configure(text="请选择天枢台程序目录")
            return
        self.dir_var.set(self.app_dir)
        self._log("info", "程序目录：%s" % self.app_dir)
        self.start_job()

    def on_browse(self):
        folder = filedialog.askdirectory(title="请选择天枢台程序所在文件夹",
                                         initialdir=self.app_dir or base_dir())
        if not folder:
            return
        self.app_dir = os.path.abspath(folder)
        self.dir_var.set(self.app_dir)
        self._log("info", "已选择程序目录：%s" % self.app_dir)
        self.start_job()

    def on_check(self):
        if self.busy:
            return
        self.start_job()

    def on_action(self):
        if self.action_state == "busy":
            self.cancel_evt.set()
            self._log("warn", "已请求取消当前任务…")
            self.btn_action.configure(state="disabled")
            return
        if self.action_state == "countdown":
            self.action_state = "idle"
            self.countdown = 0
            self._reset_action_button()
            self.status_label.configure(text="已取消自动启动")
            return
        self.start_job()

    def on_launch(self):
        if self.busy:
            return
        self.action_state = "idle"
        self.countdown = 0
        self._reset_action_button()
        exe = first_exe(self.app_dir or "")
        if not exe:
            self._log("err", "未找到天枢台主程序，无法启动。")
            return
        env = os.environ.copy()
        node_dir = self.node_dir or self._local_node_dir()
        if node_dir:
            env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")
        try:
            subprocess.Popen([exe], cwd=self.app_dir, env=env, close_fds=True)
        except OSError as exc:
            self._log("err", "启动失败：%s" % exc)
            return
        self.launched = True
        self._log("ok", "已启动天枢台，本窗口可以直接关闭。")
        self.status_label.configure(text="天枢台已启动")

    def _local_node_dir(self):
        for folder in node_bin_dirs(self.app_dir):
            if os.path.exists(os.path.join(folder, "node.exe")):
                return folder
        return None

    def _on_close(self):
        if self.busy:
            self.cancel_evt.set()
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        self.root.destroy()

    # ---------------- 任务线程 ----------------

    def start_job(self):
        if self.busy:
            return
        if not self.app_dir:
            self._log("warn", "请先选择天枢台程序目录。")
            return
        self.cancel_evt.clear()
        self.q.put(("busy", True))
        threading.Thread(target=self._job_guarded, daemon=True).start()

    def _job_guarded(self):
        try:
            self._job()
        except Exception as exc:  # noqa: BLE001
            self.q.put(("log", "err", "发生未预期错误：%s" % exc))
            self.q.put(("log", "muted", traceback.format_exc().strip().replace("\n", " | ")[:600]))
            self.q.put(("bar", "check", "determinate", 0))
        finally:
            self.q.put(("busy", False))

    def _job(self):
        self.q.put(("status", "正在检查运行环境…"))
        self.q.put(("log", "step", "开始检查运行环境 …"))
        self.q.put(("bar", "check", "determinate", 0))
        self._do_check()

        missing = [k for k in AUTO_ORDER if self.states.get(k) == "missing"]
        if not missing:
            self._log_result()
            self.q.put(("ready", self._ready()))
            return

        names = "、".join(ITEM_NAMES[k] for k in missing)
        self.q.put(("log", "warn", "检测到缺少：%s，开始自动安装 …" % names))
        for key in AUTO_ORDER:
            if key not in missing or self.cancel_evt.is_set():
                continue
            self.q.put(("item", key, "working", "正在安装…"))
            getattr(self, "install_" + key)()

        self.q.put(("log", "step", "安装结束，复查环境 …"))
        self.q.put(("bar", "check", "determinate", 0))
        self._do_check(recheck=True)
        self._log_result()
        self.q.put(("ready", self._ready()))

    def _do_check(self, recheck=False):
        keys = [k for k, _, _ in ITEMS]
        total = len(keys)
        self.q.put(("download", "idle", 0.0, ""))
        for index, key in enumerate(keys):
            if self.cancel_evt.is_set():
                break
            self.q.put(("item", key, "checking", "检测中…"))
            self.q.put(("status", "正在检测：%s" % ITEM_NAMES[key]))
            self.q.put(("bar", "check", "determinate", index / float(total) * 100.0))
            state, detail, extra = "warn", "检测异常", None
            try:
                state, detail, extra = CHECKERS[key](self.app_dir)
            except Exception as exc:  # noqa: BLE001
                state, detail = "warn", "检测异常：%s" % exc
            self.states[key] = state
            self.extras[key] = extra or {}
            self.q.put(("item", key, state, detail))
            if state == "ok":
                self.q.put(("log", "ok", "%s：%s" % (ITEM_NAMES[key], detail)))
            elif state == "missing":
                self.q.put(("log", "err", "%s：%s" % (ITEM_NAMES[key], detail)))
            elif state == "warn":
                self.q.put(("log", "warn", "%s：%s" % (ITEM_NAMES[key], detail)))
            else:
                self.q.put(("log", "info", "%s：%s" % (ITEM_NAMES[key], detail)))
        self.q.put(("bar", "check", "determinate", 100.0))
        if self.states.get("node") == "ok":
            self.node_dir = self.extras.get("node", {}).get("dir") or self._local_node_dir()
        return self.states

    def _ready(self):
        if any(self.states.get(k) != "ok" for k in BLOCKING):
            return False
        return first_exe(self.app_dir or "") is not None

    def _log_result(self):
        blocked = [k for k in BLOCKING if self.states.get(k) != "ok"]
        if not blocked:
            self.q.put(("log", "ok", "环境已就绪，可以启动%s。" % APP_TITLE))
            return
        self.q.put(("log", "err", "仍有组件未就绪：%s" % "、".join(ITEM_NAMES[k] for k in blocked)))
        for key in blocked:
            if key == "app":
                self.q.put(("log", "info", "请使用完整的便携包（需含 sidecar 目录），或点「浏览…」选择正确目录。"))
            elif key == "node":
                self.q.put(("log", "info", "可手动安装 Node.js LTS：https://nodejs.org/zh-cn/download"))
            elif key == "webview2":
                self.q.put(("log", "info", "可手动安装 WebView2：https://developer.microsoft.com/microsoft-edge/webview2/"))
            elif key == "vcpp":
                self.q.put(("log", "info", "可手动安装 VC++ 运行库：https://aka.ms/vs/17/release/vc_redist.x64.exe"))

    def _on_ready(self, ok):
        self.status_label.configure(text="环境已就绪" if ok else "部分组件未就绪")
        if not ok or self.launched:
            if ok:
                self._log("info", "点「启动天枢台」即可运行程序。")
            return
        self.countdown = 3
        self.action_state = "countdown"
        self._log("info", "3 秒后自动启动%s（可点「取消启动」中止）…" % APP_TITLE)
        self._tick_countdown()

    def _tick_countdown(self):
        if self.action_state != "countdown":
            return
        self.countdown -= 1
        if self.countdown <= 0:
            self.action_state = "idle"
            self._reset_action_button()
            self.on_launch()
            return
        self.btn_action.configure(text="取消启动 (%d)" % self.countdown)
        self.root.after(1000, self._tick_countdown)

    # ---------------- 下载 ----------------

    def _download(self, urls, dest, label, size_hint=0):
        """下载到 dest，边下边回报进度；成功返回路径，失败返回 None。"""
        last_error = None
        for url in urls:
            for _attempt in (1, 2):
                if self.cancel_evt.is_set():
                    return None
                try:
                    self.q.put(("download", "indeterminate", 0.0, "%s · 正在连接…" % label))
                    request = urllib.request.Request(url, headers={
                        "User-Agent": UA, "Accept-Encoding": "identity",
                    })
                    ctx = None
                    try:
                        response = urllib.request.urlopen(request, timeout=30)
                    except ssl.SSLError:
                        ctx = ssl._create_unverified_context()
                        response = urllib.request.urlopen(request, timeout=30, context=ctx)
                    with response:
                        total = int(response.headers.get("Content-Length") or 0) or int(size_hint or 0)
                        part = dest + ".part"
                        os.makedirs(os.path.dirname(dest), exist_ok=True)
                        done = 0
                        started = time.time()
                        self.q.put(("download", "determinate", 0.0, "%s · 开始下载…" % label))
                        with open(part, "wb") as handle:
                            while True:
                                if self.cancel_evt.is_set():
                                    handle.close()
                                    os.remove(part)
                                    return None
                                chunk = response.read(262144)
                                if not chunk:
                                    break
                                handle.write(chunk)
                                done += len(chunk)
                                elapsed = max(time.time() - started, 0.001)
                                speed = human(done / elapsed) + "/s"
                                if total:
                                    frac = min(done / float(total), 0.998)
                                    self.q.put(("download", "determinate", frac,
                                                "%s · %s / %s · %s" % (label, human(done), human(total), speed)))
                                else:
                                    self.q.put(("download", "determinate", 0.0,
                                                "%s · 已下载 %s · %s" % (label, human(done), speed)))
                        if total and done < total * 0.98:
                            raise IOError("下载不完整（%s/%s）" % (human(done), human(total)))
                        if os.path.getsize(part) < 1024:
                            raise IOError("下载内容无效")
                        os.replace(part, dest)
                        self.q.put(("download", "determinate", 1.0, "%s · 下载完成 %s" % (label, human(done))))
                        return dest
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    self.q.put(("log", "warn", "下载失败，正在重试：%s" % exc))
                    time.sleep(1.5)
        self.q.put(("log", "err", "%s 下载失败：%s" % (label, last_error)))
        return None

    # ---------------- 安装：Node.js ----------------

    def _resolve_node_version(self):
        for base in NODE_MIRRORS[:1]:
            try:
                self.q.put(("download", "indeterminate", 0.0, "正在获取 Node.js 版本列表…"))
                request = urllib.request.Request(base + "/index.json", headers={"User-Agent": UA})
                with urllib.request.urlopen(request, timeout=20) as response:
                    data = json.loads(response.read().decode("utf-8", "replace"))
                for entry in data:
                    version = str(entry.get("version", ""))
                    if not entry.get("lts") or not version.startswith("v"):
                        continue
                    try:
                        major = int(version[1:].split(".")[0])
                    except ValueError:
                        continue
                    if major >= NODE_MIN_MAJOR:
                        return version
            except Exception as exc:  # noqa: BLE001
                self.q.put(("log", "warn", "获取版本列表失败：%s" % exc))
        return NODE_FALLBACK[0]

    def _node_target_dir(self):
        app = self.app_dir or base_dir()
        if self._dir_writable(app):
            return os.path.join(app, "runtime", "node")
        local = os.environ.get("LOCALAPPDATA") or self.tmpdir
        return os.path.join(local, "TianshuTai", "runtime", "node")

    @staticmethod
    def _dir_writable(folder):
        try:
            os.makedirs(folder, exist_ok=True)
            probe = os.path.join(folder, ".tst_write_test")
            with open(probe, "w") as handle:
                handle.write("ok")
            os.remove(probe)
            return True
        except OSError:
            return False

    def install_node(self):
        version = self._resolve_node_version()
        archive = "node-%s-win-x64.zip" % version
        urls = ["%s/%s/%s" % (m, version, archive) for m in NODE_MIRRORS]
        self.q.put(("log", "step", "安装 Node.js %s …" % version))
        target_zip = os.path.join(self.tmpdir, archive)
        if not self._download(urls, target_zip, "Node.js %s" % version, size_hint=32 * 1024 * 1024):
            self.q.put(("item", "node", "missing", "下载失败，请检查网络后重试"))
            return
        if self.cancel_evt.is_set():
            return
        self.q.put(("download", "indeterminate", 0.0, "正在解压 Node.js …"))
        self.q.put(("log", "info", "正在解压到程序目录 …"))
        target = self._node_target_dir()
        if not self._extract_zip(target_zip, target):
            self.q.put(("item", "node", "missing", "解压失败"))
            self.q.put(("log", "err", "Node.js 解压失败"))
            return
        exe = os.path.join(target, "node.exe")
        if not os.path.exists(exe):
            for name in os.listdir(target):
                candidate = os.path.join(target, name, "node.exe")
                if os.path.exists(candidate):
                    exe = candidate
                    break
        ver, major = node_version(exe) if os.path.exists(exe) else ("", 0)
        if not ver or major < NODE_MIN_MAJOR:
            self.q.put(("item", "node", "missing", "安装结果校验失败"))
            self.q.put(("log", "err", "Node.js 安装结果校验失败"))
            return
        add_user_path(os.path.dirname(exe))
        self.node_dir = os.path.dirname(exe)
        self._write_launcher(os.path.dirname(exe))
        self.q.put(("item", "node", "ok", "Node.js %s（已内置到程序目录）" % ver))
        self.q.put(("log", "ok", "Node.js %s 安装完成" % ver))
        self.q.put(("download", "idle", 0.0, ""))

    @staticmethod
    def _extract_zip(archive, target):
        staging = target + ".tmp"
        shutil.rmtree(staging, ignore_errors=True)
        try:
            os.makedirs(staging, exist_ok=True)
            with zipfile.ZipFile(archive) as zip_file:
                names = [n for n in zip_file.namelist() if not n.endswith("/")]
                root = ""
                if names:
                    first = names[0].split("/")[0]
                    if all(n.startswith(first + "/") for n in names):
                        root = first + "/"
                for name in names:
                    relative = name[len(root):] if root and name.startswith(root) else name
                    if not relative:
                        continue
                    dst = os.path.join(staging, *relative.split("/"))
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    with zip_file.open(name) as src, open(dst, "wb") as dst_file:
                        shutil.copyfileobj(src, dst_file)
            shutil.rmtree(target, ignore_errors=True)
            os.replace(staging, target)
            return True
        except Exception as exc:  # noqa: BLE001
            shutil.rmtree(staging, ignore_errors=True)
            return False

    def _write_launcher(self, node_dir):
        """在程序目录写一个自带 PATH 的启动脚本（内容保持纯 ASCII）。"""
        app = self.app_dir or ""
        if not app:
            return
        try:
            relative = os.path.relpath(node_dir, app)
        except ValueError:
            return
        if relative.startswith("..") or not os.path.isdir(app):
            return
        lines = [
            "@echo off",
            "chcp 65001 >nul 2>&1",
            'cd /d "%~dp0"',
            'set "PATH=%%~dp0%s;%%PATH%%"' % relative,
            'if exist "%~dp0TianshuTai.exe" (start "" /D "%~dp0" "%~dp0TianshuTai.exe" & exit /b 0)',
            'if exist "%~dp0ai-browser.exe" (start "" /D "%~dp0" "%~dp0ai-browser.exe" & exit /b 0)',
            "echo [ERROR] TianshuTai.exe not found.",
            "pause",
            "exit /b 1",
            "",
        ]
        try:
            with open(os.path.join(app, "启动天枢台.bat"), "w", encoding="ascii", errors="ignore") as handle:
                handle.write("\r\n".join(lines))
            self.q.put(("log", "info", "已生成启动脚本：启动天枢台.bat"))
        except OSError:
            pass

    # ---------------- 安装：WebView2 ----------------

    def install_webview2(self):
        self.q.put(("log", "step", "安装 WebView2 运行库 …"))
        setup = os.path.join(self.tmpdir, "MicrosoftEdgeWebView2Setup.exe")
        if not self._download(list(WV2_URLS), setup, "WebView2 运行库", size_hint=2 * 1024 * 1024):
            self.q.put(("log", "warn", "下载失败，改用 winget 安装 …"))
            if self._winget_install("Microsoft.EdgeWebView2Runtime"):
                self._finish_webview2()
                return
            self.q.put(("item", "webview2", "missing", "安装失败，请手动安装"))
            self.q.put(("log", "err", "WebView2 自动安装失败"))
            return
        if self.cancel_evt.is_set():
            return
        self.q.put(("download", "indeterminate", 0.0, "正在安装 WebView2 …"))
        self.q.put(("log", "info", "正在静默安装（可能需要管理员授权）…"))
        code = shell_exec_wait(setup, "/silent /install")
        if code != 0:
            self.q.put(("log", "warn", "静默安装返回 %s，尝试提权安装 …" % code))
            code = shell_exec_wait(setup, "/silent /install", elevate=True)
        if code in (0, 3010):
            self._finish_webview2()
            return
        if self._winget_install("Microsoft.EdgeWebView2Runtime"):
            self._finish_webview2()
            return
        self.q.put(("item", "webview2", "missing", "安装未完成（返回码 %s）" % code))
        self.q.put(("log", "err", "WebView2 自动安装未完成"))

    def _finish_webview2(self):
        self.q.put(("download", "idle", 0.0, ""))
        state, detail, _ = check_webview2()
        if state == "ok":
            self.q.put(("item", "webview2", "ok", detail))
            self.q.put(("log", "ok", "WebView2 安装完成"))
        else:
            self.q.put(("item", "webview2", "warn", "已请求安装，重启后生效"))
            self.q.put(("log", "warn", "WebView2 已请求安装，如仍提示缺少请重启电脑"))

    # ---------------- 安装：VC++ 运行库 ----------------

    def install_vcpp(self):
        self.q.put(("log", "step", "安装 VC++ 运行库 …"))
        setup = os.path.join(self.tmpdir, "vc_redist.x64.exe")
        if not self._download(list(VC_URLS), setup, "VC++ 运行库 x64", size_hint=25 * 1024 * 1024):
            self.q.put(("item", "vcpp", "warn", "下载失败，可稍后重试"))
            return
        if self.cancel_evt.is_set():
            return
        self.q.put(("download", "indeterminate", 0.0, "正在安装 VC++ 运行库 …"))
        args = "/install /quiet /norestart"
        code = shell_exec_wait(setup, args, elevate=not is_admin())
        if code in (0, 3010, 1638, 1641):
            state, _, _ = check_vcpp()
            if state == "ok":
                self.q.put(("item", "vcpp", "ok", "VC++ 2015-2022 运行库已就绪"))
                self.q.put(("log", "ok", "VC++ 运行库安装完成"))
            else:
                self.q.put(("item", "vcpp", "warn", "已安装，重启后生效"))
                self.q.put(("log", "warn", "VC++ 运行库已安装，建议重启后生效"))
        elif code == -1223:
            self.q.put(("item", "vcpp", "warn", "已取消管理员授权"))
            self.q.put(("log", "warn", "VC++ 运行库需要管理员授权，已跳过（可选组件）"))
        else:
            self.q.put(("item", "vcpp", "warn", "安装未完成（返回码 %s）" % code))
            self.q.put(("log", "warn", "VC++ 运行库安装未完成，可手动安装（可选组件）"))
        self.q.put(("download", "idle", 0.0, ""))

    def _winget_install(self, package_id):
        winget = shutil.which("winget")
        if not winget:
            return False
        self.q.put(("log", "info", "使用 winget 安装 %s …" % package_id))
        code, _out = run_quiet(winget, [
            "install", "--id", package_id, "-e", "--silent",
            "--accept-package-agreements", "--accept-source-agreements",
        ], timeout=900)
        # -1978335189 = 已安装
        return code in (0, -1978335189)


# --------------------------------------------------------------------------- #
# 打包 / 自检
# --------------------------------------------------------------------------- #

def run_build() -> int:
    """由「打包.bat」调用：把本脚本打包成无控制台黑窗的单文件 exe。"""
    here = base_dir()
    source = os.path.abspath(__file__)
    out_name = "天枢台环境安装器"
    icon = os.path.join(here, ICON_FILE)
    logo = os.path.join(here, LOGO_FILE)
    dist = os.path.join(here, "dist")
    work = os.path.join(here, "build")

    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--noconsole",
           "--name", out_name, "--distpath", dist, "--workpath", work, "--specpath", work]
    for asset in (logo, icon):
        if os.path.exists(asset):
            cmd += ["--add-data", "%s;." % asset]
    if os.path.exists(icon):
        cmd += ["--icon", icon]
    cmd.append(source)

    print("[INFO] PyInstaller:", " ".join(cmd))
    code = subprocess.call(cmd, cwd=here)
    if code != 0:
        print("[FAIL] PyInstaller exit=%s" % code)
        return code

    built = os.path.join(dist, out_name + ".exe")
    if not os.path.exists(built):
        print("[FAIL] exe not found: %s" % built)
        return 1
    target = os.path.join(here, out_name + ".exe")
    shutil.copyfile(built, target)
    shutil.rmtree(dist, ignore_errors=True)
    shutil.rmtree(work, ignore_errors=True)
    print("[OK] EXE ready: %s" % target)
    return 0


def run_selftest() -> int:
    app_dir = find_app_dir()
    print("app_dir  =", app_dir)
    for key, name, _desc in ITEMS:
        try:
            state, detail, _extra = CHECKERS[key](app_dir)
        except Exception as exc:  # noqa: BLE001
            state, detail = "error", str(exc)
        print("%-9s %-6s %s" % (key, state, detail))
    return 0


def main() -> int:
    if "--build" in sys.argv:
        return run_build()
    if "--selftest" in sys.argv or "--check" in sys.argv:
        return run_selftest()

    enable_dpi_awareness()
    root = tk.Tk()
    EnvInstaller(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        detail = traceback.format_exc()
        try:
            log_path = os.path.join(tempfile.gettempdir(), "TianshuTaiEnvSetup-error.log")
            with open(log_path, "w", encoding="utf-8") as handle:
                handle.write(detail)
        except OSError:
            pass
        try:
            messagebox.showerror("天枢台环境安装器", "程序发生错误：\n%s" % detail[-800:])
        except Exception:  # noqa: BLE001
            pass
        sys.exit(1)
