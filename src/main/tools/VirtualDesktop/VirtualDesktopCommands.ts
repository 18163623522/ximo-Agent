/**
 * VirtualDesktopCommands — 虚拟桌面 PowerShell / Win32 命令构造
 *
 * 从 VirtualDesktopManager.ts 拆出的无状态命令层：
 * - ShowWindow 命令常量（SW_*），内联到 C# 代码中使用
 * - CS_CODE：极简内联 C#（EnumWindows 窗口枚举 + ShowWindowAsync 最小化/恢复/聚焦）
 * - buildPsCommand：构建一次性 PowerShell 命令（-Command 直接执行，不写文件）
 */

// ShowWindow 命令常量
const SW_MINIMIZE = 6
const SW_RESTORE = 9
const SW_FORCEMINIMIZE = 11

// ---------------------------------------------------------------------------
// 极简 C# 代码 — 仅 EnumWindows + ShowWindowAsync + GetForegroundWindow
// ---------------------------------------------------------------------------

const CS_CODE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class AgentWorkspace {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);

    public struct RECT { public int Left, Top, Right, Bottom; }

    public class WinInfo {
        public long hwnd;
        public string title;
        public string app;
        public bool isFocused;
        public bool isMinimized;
        public int x, y, w, h;
    }

    public static List<WinInfo> EnumVisible() {
        var result = new List<WinInfo>();
        EnumWindows((hWnd, _) => {
            if (IsWindowVisible(hWnd)) {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                if (sb.Length > 0) {
                    var info = new WinInfo();
                    info.hwnd = hWnd.ToInt64();
                    info.title = sb.ToString();
                    info.isFocused = (hWnd == GetForegroundWindow());
                    info.isMinimized = IsIconic(hWnd);
                    uint pid; GetWindowThreadProcessId(hWnd, out pid);
                    try { info.app = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
                    RECT r; GetWindowRect(hWnd, out r);
                    info.x = r.Left; info.y = r.Top; info.w = r.Right - r.Left; info.h = r.Bottom - r.Top;
                    result.Add(info);
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static void MinimizeWindow(long hwnd) {
        ShowWindowAsync(new IntPtr(hwnd), ${SW_FORCEMINIMIZE});
    }

    public static void RestoreWindow(long hwnd) {
        ShowWindowAsync(new IntPtr(hwnd), ${SW_RESTORE});
    }

    public static void FocusWindow(long hwnd) {
        var h = new IntPtr(hwnd);
        if (IsIconic(h)) ShowWindowAsync(h, ${SW_RESTORE});
        SetForegroundWindow(h);
    }
}
`

/**
 * 构建一次性 PowerShell 命令（不写文件，直接 -Command 执行）
 * 将 C# 代码内联，然后执行指定的操作
 */
export function buildPsCommand(operation: string): string {
  // C# 代码只需 Add-Type 一次，每次调用都重新 Add-Type（幂等，因为类名固定但 PowerShell 会跳过重复定义）
  // 用 -ErrorAction SilentlyContinue 避免重复 Add-Type 报错
  const addType = `try { Add-Type -TypeDefinition @'\n${CS_CODE}\n'@ -Language CSharp -ErrorAction SilentlyContinue } catch {}`

  switch (operation) {
    case 'enum':
      return `${addType}; [AgentWorkspace]::EnumVisible() | ConvertTo-Json -Depth 5 -Compress`

    case 'minimize_all':
      // 由 Node 层传入 hwnds 列表，通过 $env:VD_HWNDS 传递
      return `${addType}
        $hwnds = $env:VD_HWNDS -split ',' | Where-Object { $_ }
        foreach ($h in $hwnds) { [AgentWorkspace]::MinimizeWindow([long]$h) }
        @{ success = $true } | ConvertTo-Json -Compress`

    case 'restore_all':
      return `${addType}
        $hwnds = $env:VD_HWNDS -split ',' | Where-Object { $_ }
        foreach ($h in $hwnds) { [AgentWorkspace]::RestoreWindow([long]$h) }
        @{ success = $true } | ConvertTo-Json -Compress`

    case 'focus':
      return `${addType}
        [AgentWorkspace]::FocusWindow([long]$env:VD_HWND)
        @{ success = $true } | ConvertTo-Json -Compress`

    default:
      return `@{ success = $false; error = 'Unknown operation' } | ConvertTo-Json -Compress`
  }
}
