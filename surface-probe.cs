// DockPad 透明表面探针
// 由主进程按需编译（csc.exe），编译失败时回退到脚本版。
// 职责：每 2.5 秒判断前台是否全屏应用 + 采样 Dock 窗口两个上角像素，
// 判定窗口透明表面是否被 DWM 打碎（整窗变纯黑）。
// 输出（stdout，一行一条）：
//   FS 1 quns=3            前台进入全屏
//   FS 0                   前台退出全屏
//   BROKEN hit=2           表面损坏
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class SurfaceProbe
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    const uint SYNCHRONIZE = 0x00100000;
    const uint MONITOR_DEFAULTTONEAREST = 2;

    static string why = "";
    static bool outDead = false;

    static bool IsFullScreen()
    {
        why = "";
        int state;
        if (SHQueryUserNotificationState(out state) == 0)
        {
            // 2 = 全屏应用（F11 等） 3 = 全屏 D3D 游戏 7 = 全屏商店应用
            if (state == 2 || state == 3 || state == 7) { why = "quns=" + state; return true; }
        }

        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return false;
        if (h == GetShellWindow()) return false;
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, 256);
        string cls = sb.ToString();
        if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd") return false;
        int style = GetWindowLong(h, -16);
        // 有标题栏的一律当普通窗口：任务栏自动隐藏时任何最大化窗口都铺满屏幕
        if ((style & 0x00C00000) != 0) return false;

        RECT r;
        if (!GetWindowRect(h, out r)) return false;
        IntPtr mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(mon, ref mi)) return false;
        RECT m = mi.rcMonitor;
        if (r.Left <= m.Left && r.Top <= m.Top && r.Right >= m.Right && r.Bottom >= m.Bottom)
        {
            why = "rect cls=" + cls + " st=" + style;
            return true;
        }
        return false;
    }

    static bool IsBlack(Color c) { return c.R < 12 && c.G < 12 && c.B < 12; }

    static bool BigDiff(Color a, Color b)
    {
        return Math.Abs(a.R - b.R) + Math.Abs(a.G - b.G) + Math.Abs(a.B - b.B) > 70;
    }

    static void Say(string s)
    {
        if (outDead) return;
        try { Console.WriteLine(s); Console.Out.Flush(); }
        catch { outDead = true; }
    }

    static void Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch { }

        if (args.Length < 1) return;
        string boundsFile = args[0];
        int ppid = 0;
        if (args.Length > 1) int.TryParse(args[1], out ppid);

        // 用同步句柄等父进程退出，比每轮枚举进程便宜得多
        IntPtr parent = ppid > 0 ? OpenProcess(SYNCHRONIZE, false, ppid) : IntPtr.Zero;

        Bitmap bmp = new Bitmap(1, 1);
        Graphics g = Graphics.FromImage(bmp);
        Size one = new Size(1, 1);
        int lastFs = -1;
        int hits = 0;

        while (true)
        {
            Thread.Sleep(2500);
            if (outDead) return;
            if (parent != IntPtr.Zero && WaitForSingleObject(parent, 0) == 0) return;

            bool fs = false;
            try { fs = IsFullScreen(); } catch { }
            int fsNow = fs ? 1 : 0;
            if (fsNow != lastFs)
            {
                lastFs = fsNow;
                Say(fs ? "FS 1 " + why : "FS 0");
            }
            if (fs) { hits = 0; continue; }

            string raw;
            try
            {
                using (FileStream f = new FileStream(boundsFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (StreamReader sr = new StreamReader(f))
                    raw = sr.ReadToEnd().Trim();
            }
            catch { continue; }
            if (raw.Length == 0 || raw == "hidden") continue;

            string[] p = raw.Split(' ');
            if (p.Length < 4) continue;
            int x, y, w, h;
            if (!int.TryParse(p[0], out x) || !int.TryParse(p[1], out y) ||
                !int.TryParse(p[2], out w) || !int.TryParse(p[3], out h)) continue;

            int lx = x + 6, rx = x + w - 7, cy = y + 3;
            // 参考点优先取窗口上方；Dock 贴屏幕顶边时上方越界，改用窗口下方
            int ry = y - 12;
            if (ry < 0) ry = y + h + 12;
            if (rx <= lx) continue;

            try
            {
                g.CopyFromScreen(lx, cy, 0, 0, one);
                Color l1 = bmp.GetPixel(0, 0);
                g.CopyFromScreen(lx, ry, 0, 0, one);
                Color l2 = bmp.GetPixel(0, 0);
                g.CopyFromScreen(rx, cy, 0, 0, one);
                Color r1 = bmp.GetPixel(0, 0);
                g.CopyFromScreen(rx, ry, 0, 0, one);
                Color r2 = bmp.GetPixel(0, 0);

                bool bad = IsBlack(l1) && IsBlack(r1) && BigDiff(l1, l2) && BigDiff(r1, r2);
                if (bad)
                {
                    hits++;
                    if (hits >= 2) { Say("BROKEN hit=" + hits); hits = 0; }
                }
                else hits = 0;
            }
            catch { }
        }
    }
}
