[CmdletBinding()]
param([string]$Action = 'list', [string]$DesktopId = '', [string]$WindowTitle = '')

$ErrorActionPreference = 'Stop'

Add-Type @"
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

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // CORRECT IIDs from Windows registry
    // CLSID: {AA509086-5CA9-4C25-8F95-589D3C07B48A}
    // IVirtualDesktopManager: {A5CD92FF-29BE-454C-8D04-D82879FB3F1B}
    [ComImport, Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IVirtualDesktopManager {
        bool IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow);
        Guid GetWindowDesktopId(IntPtr topLevelWindow);
        void MoveWindowToDesktop(IntPtr topLevelWindow, Guid desktopId);
    }

    // IVirtualDesktopManagerInternal: {F31574D6-B682-4CDC-BD56-1827860ABEC6}
    [ComImport, Guid("F31574D6-B682-4CDC-BD56-1827860ABEC6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IVirtualDesktopManagerInternal {
        int GetCount();
        IntPtr GetCurrentDesktop();
        void GetDesktops(out IObjectArray desktops);
        [PreserveSig] int GetAdjacentDesktop(IntPtr pDesktop, int direction, out IntPtr ppAdjacentDesktop);
        void SwitchDesktop(IntPtr pDesktop);
        IntPtr CreateDesktop();
        void RemoveDesktop(IntPtr pDesktop, IntPtr pFallbackDesktop);
        IntPtr FindDesktop(Guid desktopId);
    }

    // IVirtualDesktop: {FF72FFDD-BE7E-43FC-9C03-AD81681E88E4}
    [ComImport, Guid("FF72FFDD-BE7E-43FC-9C03-AD81681E88E4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IVirtualDesktop {
        Guid GetId();
        void GetName([MarshalAs(UnmanagedType.HString)] out string name);
    }

    // IObjectArray: {92CA9DCD-5628-4A3D-9B3C-4E0B9E3D4D4F}
    [ComImport, Guid("92CA9DCD-5628-4A3D-9B3C-4E0B9E3D4D4F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IObjectArray {
        uint GetCount();
        void GetAt(uint index, [In] ref Guid iid, out IntPtr ppv);
    }

    public static IVirtualDesktopManager GetVDM() {
        CoInitialize(IntPtr.Zero);
        Guid clsid = new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A");
        Guid iid = new Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B");
        IntPtr pUnk;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 4 | 1, ref iid, out pUnk);
        if (hr != 0) throw new Exception(string.Format("CoCreateInstance(IVirtualDesktopManager) failed: 0x{0:X8}", hr));
        object obj = Marshal.GetObjectForIUnknown(pUnk);
        Marshal.Release(pUnk);
        return (IVirtualDesktopManager)obj;
    }

    public static IVirtualDesktopManagerInternal GetVDMInternal() {
        CoInitialize(IntPtr.Zero);
        // IVirtualDesktopManagerInternal is obtained via IServiceProvider from ImmersiveShell
        // But let's try direct creation first
        Guid clsid = new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A");
        Guid iidInternal = new Guid("F31574D6-B682-4CDC-BD56-1827860ABEC6");
        IntPtr pUnk;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 4 | 1, ref iidInternal, out pUnk);
        if (hr == 0) {
            object obj = Marshal.GetObjectForIUnknown(pUnk);
            Marshal.Release(pUnk);
            return (IVirtualDesktopManagerInternal)obj;
        }
        throw new Exception(string.Format("CoCreateInstance(IVirtualDesktopManagerInternal) failed: 0x{0:X8}", hr));
    }

    // Window enumeration helper
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

    public static string GetWindowTitle(IntPtr hWnd) {
        var sb = new StringBuilder(256);
        GetWindowText(hWnd, sb, 256);
        return sb.ToString();
    }

    public static string GetAppName(IntPtr hWnd) {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        try {
            return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
        } catch { return ""; }
    }

    public static bool IsFocused(IntPtr hWnd) {
        return hWnd == GetForegroundWindow();
    }

    public static int[] GetWindowRect(IntPtr hWnd) {
        RECT r;
        GetWindowRect(hWnd, out r);
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }
}
"@

$result = @{ success = $true }

try {
    $mgr = [VDApi]::GetVDM()
    
    # Try to get VDMInternal — this may fail on some Windows versions
    $mgrInternal = $null
    try {
        $mgrInternal = [VDApi]::GetVDMInternal()
    } catch {
        # VDMInternal not directly available — try via ImmersiveShell IServiceProvider
        # For now, we can still do basic operations with just IVirtualDesktopManager
    }

    switch ($Action) {
        'list' {
            $desktops = @()
            
            if ($mgrInternal -ne $null) {
                $currentDesktop = $mgrInternal.GetCurrentDesktop()
                $currentId = ($currentDesktop -as [VDApi+IVirtualDesktop]).GetId()
                $count = $mgrInternal.GetCount()
                
                [Guid]$vdIid = [Guid]'FF72FFDD-BE7E-43FC-9C03-AD81681E88E4'
                $desktopArray = $null
                $mgrInternal.GetDesktops([ref]$desktopArray)
                $desktopCount = $desktopArray.GetCount()
                
                for ($i = 0; $i -lt $desktopCount; $i++) {
                    $pDesktop = [IntPtr]::Zero
                    $desktopArray.GetAt($i, [ref]$vdIid, [ref]$pDesktop)
                    $desktop = [System.Runtime.InteropServices.Marshal]::GetObjectForIUnknown($pDesktop)
                    $vd = $desktop -as [VDApi+IVirtualDesktop]
                    
                    $id = $vd.GetId()
                    $name = ""
                    try { $vd.GetName([ref]$name) } catch { $name = "Desktop $($i+1)" }
                    
                    $desktops += @{
                        id = $id.ToString()
                        name = $name
                        isActive = ($id -eq $currentId)
                        windowCount = 0
                    }
                }
            } else {
                # Fallback: can't enumerate desktops without VDMInternal
                $result.success = $false
                $result.error = "IVirtualDesktopManagerInternal not available on this system"
            }
            $result.desktops = $desktops
        }
        'list_windows' {
            $windows = @()
            $targetId = if ($DesktopId) { [Guid]::Parse($DesktopId) } else { [Guid]::Empty }
            
            $allWindows = [VDApi]::GetVisibleWindows()
            foreach ($hWnd in $allWindows) {
                try {
                    $wid = $mgr.GetWindowDesktopId($hWnd)
                    if ($targetId -eq [Guid]::Empty -or $wid -eq $targetId) {
                        $title = [VDApi]::GetWindowTitle($hWnd)
                        $appName = [VDApi]::GetAppName($hWnd)
                        $isFocused = [VDApi]::IsFocused($hWnd)
                        $rect = [VDApi]::GetWindowRect($hWnd)
                        
                        $windows += @{
                            hwnd = $hWnd.ToString()
                            title = $title
                            appName = $appName
                            desktopId = $wid.ToString()
                            isFocused = $isFocused
                            bounds = @{ x = $rect[0]; y = $rect[1]; width = $rect[2]; height = $rect[3] }
                        }
                    }
                } catch {}
            }
            $result.windows = $windows
        }
        'move_window' {
            if ($WindowTitle) {
                $targetGuid = if ($DesktopId) { [Guid]::Parse($DesktopId) } else { $mgr.GetWindowDesktopId([VDApi]::GetForegroundWindow()) }
                $allWindows = [VDApi]::GetVisibleWindows()
                foreach ($hWnd in $allWindows) {
                    $title = [VDApi]::GetWindowTitle($hWnd)
                    if ($title -like "*$WindowTitle*") {
                        $mgr.MoveWindowToDesktop($hWnd, $targetGuid)
                    }
                }
            }
        }
        'switch' {
            if ($mgrInternal -ne $null -and $DesktopId) {
                $guid = [Guid]::Parse($DesktopId)
                $desktop = $mgrInternal.FindDesktop($guid)
                if ($desktop -ne [IntPtr]::Zero) {
                    $mgrInternal.SwitchDesktop($desktop)
                }
            }
        }
        'create' {
            if ($mgrInternal -ne $null) {
                $newDesktop = $mgrInternal.CreateDesktop()
                $vd = $newDesktop -as [VDApi+IVirtualDesktop]
                $newId = $vd.GetId()
                $result.desktops = @(@{ id = $newId.ToString(); name = "New Desktop"; isActive = $false; windowCount = 0 })
            }
        }
        'remove' {
            if ($mgrInternal -ne $null -and $DesktopId) {
                $guid = [Guid]::Parse($DesktopId)
                $desktop = $mgrInternal.FindDesktop($guid)
                if ($desktop -ne [IntPtr]::Zero) {
                    $fallback = $mgrInternal.GetCurrentDesktop()
                    $mgrInternal.RemoveDesktop($desktop, $fallback)
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
