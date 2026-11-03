# 桌面图标显示 / 隐藏
# Windows 没有命令行开关，只能给桌面的 SHELLDLL_DefView 发 WM_COMMAND 0x7402。
# 注意：消息必须发给 DefView，发给 Progman 在 Win11 上不生效（实测）。
# 用法：python deskicons.py toggle|query   → 输出 {"ok":true,"visible":false}
import ctypes
import json
import sys
import time

u = ctypes.windll.user32
u.FindWindowW.restype = ctypes.c_void_p
u.FindWindowExW.restype = ctypes.c_void_p
u.FindWindowExW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p]
u.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]

WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

_hits = []


def _cb(hwnd, _):
    # 有些系统把 DefView 挂在 WorkerW 下，Progman 里找不到时要全局扫一遍
    v = u.FindWindowExW(hwnd, None, "SHELLDLL_DefView", None)
    if v:
        _hits.append(v)
        return False
    return True


def defview():
    prog = u.FindWindowW("Progman", None)
    if prog:
        v = u.FindWindowExW(prog, None, "SHELLDLL_DefView", None)
        if v:
            return v
    _hits.clear()
    u.EnumWindows(WNDENUMPROC(_cb), None)
    return _hits[0] if _hits else None


def icons_visible(v):
    lst = u.FindWindowExW(v, None, "SysListView32", None)
    return bool(u.IsWindowVisible(lst or v))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "query"
    v = defview()
    if not v:
        print(json.dumps({"ok": False, "error": "找不到桌面窗口（explorer 可能没运行）"}))
        return 1
    if cmd == "toggle":
        u.SendMessageW(v, 0x111, 0x7402, 0)
        time.sleep(0.1)
    print(json.dumps({"ok": True, "visible": icons_visible(v)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
