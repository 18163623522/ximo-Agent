[CmdletBinding()]
param([string]$Action = 'list', [string]$DesktopId = '', [string]$WindowTitle = '')

$ErrorActionPreference = 'Stop'

$csCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class VDApi {
    [DllImport("ole32.dll")]
    public static extern int CoInitialize(IntPtr pvReserved);
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        [In] ref Guid clsid, IntPtr pUnkOuter, int clsContext, [In] ref Guid iid, out IntPtr ppv);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // CORRECT IIDs from Windows 10 registry
    [ComImport, Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IVirtualDesktopManager {
        bool IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow);
        Guid GetWindowDesktopId(IntPtr topLevelWindow);
        void MoveWindowToDesktop(IntPtr topLevelWindow, Guid desktopId);
    }

    public static IVirtualDesktopManager GetVDM() {
        CoInitialize(IntPtr.Zero);
        Guid clsid = new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A");
        Guid iid = new Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B");
        IntPtr pUnk;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 4 | 1, ref iid, out pUnk);
        if (hr != 0) throw new Exception("CoCreateInstance failed: 0x" + hr.ToString("X8"));
        object obj = Marshal.GetObjectForIUnknown(pUnk);
        Marshal.Release(pUnk);
        return (IVirtualDesktopManager)obj;
    }

    public static List<IntPtr> GetVisibleWindows() {
        var windows = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                if (sb.Length > 0) windows.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    public static string GetTitle(IntPtr hWnd) {
        var sb = new StringBuilder(256);
        GetWindowText(hWnd, sb, 256);
        return sb.ToString();
    }

    public static string GetApp(IntPtr hWnd) {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
        catch { return ""; }
    }

    public static int[] GetRect(IntPtr hWnd) {
        RECT r;
        GetWindowRect(hWnd, out r);
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    // Keyboard shortcuts for desktop management
    // Win+Ctrl+D = Create desktop, Win+Ctrl+Left/Right = Switch, Win+Ctrl+F4 = Close
    public static void SendWinCtrlKey(byte vk) {
        // VK_LWIN=0x5B, VK_CONTROL=0x11
        keybd_event(0x5B, 0, 0, IntPtr.Zero);       // Win down
        keybd_event(0x11, 0, 0, IntPtr.Zero);        // Ctrl down
        keybd_event(vk, 0, 0, IntPtr.Zero);           // Key down
        keybd_event(vk, 0, 2, IntPtr.Zero);           // Key up (KEYEVENTF_KEYUP=2)
        keybd_event(0x11, 0, 2, IntPtr.Zero);         // Ctrl up
        keybd_event(0x5B, 0, 2, IntPtr.Zero);         // Win up
    }

    // VK codes: D=0x44, Left=0x25, Right=0x27, F4=0x73
    public static void CreateDesktop() { SendWinCtrlKey(0x44); }
    public static void SwitchLeft() { SendWinCtrlKey(0x25); }
    public static void SwitchRight() { SendWinCtrlKey(0x27); }
    public static void CloseDesktop() { SendWinCtrlKey(0x73); }
}
'@

Add-Type -TypeDefinition $csCode -Language CSharp

$result = @{ success = $true }

try {
    $mgr = [VDApi]::GetVDM()

    switch ($Action) {
        'list' {
            # Enumerate all visible windows, group by desktop ID
            $allWindows = [VDApi]::GetVisibleWindows()
            $desktopMap = @{}
            $desktopOrder = @()

            foreach ($hWnd in $allWindows) {
                try {
                    $desktopId = $mgr.GetWindowDesktopId($hWnd)
                    $idStr = $desktopId.ToString()
                    if (-not $desktopMap.ContainsKey($idStr)) {
                        $desktopMap[$idStr] = @()
                        $desktopOrder += $idStr
                    }
                    $desktopMap[$idStr] += @{
                        hwnd = $hWnd.ToString()
                        title = [VDApi]::GetTitle($hWnd)
                        appName = [VDApi]::GetApp($hWnd)
                        isFocused = ($hWnd -eq [VDApi]::GetForegroundWindow())
                    }
                } catch {}
            }

            $desktops = @()
            for ($i = 0; $i -lt $desktopOrder.Count; $i++) {
                $id = $desktopOrder[$i]
                $wins = $desktopMap[$id]
                $isActive = $false
                foreach ($w in $wins) {
                    if ($w.isFocused) { $isActive = $true; break }
                }
                $desktops += @{
                    id = $id
                    name = "Desktop $($i+1)"
                    isActive = $isActive
                    windowCount = $wins.Count
                }
            }
            $result.desktops = $desktops
        }
        'list_windows' {
            $windows = @()
            $allWindows = [VDApi]::GetVisibleWindows()

            foreach ($hWnd in $allWindows) {
                try {
                    $desktopId = $mgr.GetWindowDesktopId($hWnd)
                    $idStr = $desktopId.ToString()

                    if ($DesktopId -and $idStr -ne $DesktopId) { continue }

                    $rect = [VDApi]::GetRect($hWnd)
                    $windows += @{
                        hwnd = $hWnd.ToString()
                        title = [VDApi]::GetTitle($hWnd)
                        appName = [VDApi]::GetApp($hWnd)
                        desktopId = $idStr
                        isFocused = ($hWnd -eq [VDApi]::GetForegroundWindow())
                        bounds = @{ x = $rect[0]; y = $rect[1]; width = $rect[2]; height = $rect[3] }
                    }
                } catch {}
            }
            $result.windows = $windows
        }
        'switch' {
            # Switch via keyboard shortcut — can only go left or right
            # Find current desktop index, find target index, calculate direction
            $allWindows = [VDApi]::GetVisibleWindows()
            $desktopMap = @{}
            $desktopOrder = @()
            foreach ($hWnd in $allWindows) {
                try {
                    $did = $mgr.GetWindowDesktopId($hWnd).ToString()
                    if (-not $desktopMap.ContainsKey($did)) {
                        $desktopMap[$did] = 0
                        $desktopOrder += $did
                    }
                } catch {}
            }

            $currentIdx = -1
            $targetIdx = -1
            for ($i = 0; $i -lt $desktopOrder.Count; $i++) {
                # Check if this desktop has the focused window
                # Actually we need to check each window
            }

            # Simpler: just switch right N times or left N times
            # But we need to know the target index. Let's get it from desktopId
            $targetIdx = [Array]::IndexOf($desktopOrder, $DesktopId)
            if ($targetIdx -lt 0) {
                $result.success = $false
                $result.error = "Desktop not found: $DesktopId"
                break
            }

            # Find current desktop by checking which desktop the foreground window is on
            $fgWnd = [VDApi]::GetForegroundWindow()
            $currentDesktopId = ""
            try { $currentDesktopId = $mgr.GetWindowDesktopId($fgWnd).ToString() } catch {}
            $currentIdx = [Array]::IndexOf($desktopOrder, $currentDesktopId)

            if ($currentIdx -lt 0 -or $targetIdx -eq $currentIdx) { break }

            $diff = $targetIdx - $currentIdx
            if ($diff -gt 0) {
                for ($i = 0; $i -lt $diff; $i++) { [VDApi]::SwitchRight(); Start-Sleep -Milliseconds 200 }
            } else {
                for ($i = 0; $i -lt (-$diff); $i++) { [VDApi]::SwitchLeft(); Start-Sleep -Milliseconds 200 }
            }
        }
        'create' {
            [VDApi]::CreateDesktop()
            Start-Sleep -Milliseconds 500
            # Return updated list
            $allWindows = [VDApi]::GetVisibleWindows()
            $desktopMap = @{}
            $desktopOrder = @()
            foreach ($hWnd in $allWindows) {
                try {
                    $did = $mgr.GetWindowDesktopId($hWnd).ToString()
                    if (-not $desktopMap.ContainsKey($did)) {
                        $desktopMap[$did] = 0
                        $desktopOrder += $did
                    }
                } catch {}
            }
            $desktops = @()
            for ($i = 0; $i -lt $desktopOrder.Count; $i++) {
                $desktops += @{ id = $desktopOrder[$i]; name = "Desktop $($i+1)"; isActive = ($i -eq $desktopOrder.Count - 1); windowCount = 0 }
            }
            $result.desktops = $desktops
        }
        'remove' {
            [VDApi]::CloseDesktop()
            Start-Sleep -Milliseconds 500
        }
        'move_window' {
            if ($WindowTitle) {
                $targetGuid = if ($DesktopId) { [Guid]::Parse($DesktopId) } else { $mgr.GetWindowDesktopId([VDApi]::GetForegroundWindow()) }
                $allWindows = [VDApi]::GetVisibleWindows()
                foreach ($hWnd in $allWindows) {
                    $title = [VDApi]::GetTitle($hWnd)
                    if ($title -like "*$WindowTitle*") {
                        try { $mgr.MoveWindowToDesktop($hWnd, $targetGuid) } catch {}
                    }
                }
            }
        }
        default {
            $result.success = $false
            $result.error = "Unknown action: $Action"
        }
    }
} catch {
    $result.success = $false
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 10 -Compress
