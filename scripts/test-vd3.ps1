$ErrorActionPreference = 'Stop'

# The registry shows the CLSID is {aa509086-5ca9-4c25-8f95-589d3c07b48a}
# Let's verify and try with the correct GUID

Write-Host "=== Testing with correct CLSID from registry ==="

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class VDMTest {
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        ref Guid clsid, IntPtr pUnkOuter, int clsContext, ref Guid iid, out object ppv);
    
    [DllImport("ole32.dll")]
    public static extern int CoInitialize(IntPtr pvReserved);
    
    public static object CreateVDM() {
        CoInitialize(IntPtr.Zero);
        // Correct CLSID from registry
        Guid clsid = new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A");
        Guid iid = new Guid("FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08"); // IVirtualDesktopManager
        object obj;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 4 | 1, ref iid, out obj);
        if (hr != 0) throw new Exception(string.Format("CoCreateInstance failed: 0x{0:X8}", hr));
        return obj;
    }
}
"@

try {
    $obj = [VDMTest]::CreateVDM()
    Write-Host "Success! Type: $($obj.GetType().FullName)"
    
    # List methods
    Write-Host "`nMethods on IVirtualDesktopManager:"
    $obj.GetType().GetMethods() | Where-Object { $_.DeclaringType.IsInterface -or $_.Name -notmatch '^(Get|Set|Equals|GetHashCode|GetType|ToString)' } | ForEach-Object { 
        Write-Host "  $($_.Name)" 
    }
    
    # Try IsWindowOnCurrentVirtualDesktop
    Write-Host "`nTrying IsWindowOnCurrentVirtualDesktop with handle 0..."
    try {
        $result = $obj.IsWindowOnCurrentVirtualDesktop([IntPtr]::Zero)
        Write-Host "Result: $result"
    } catch {
        Write-Host "Method call error: $($_.Exception.Message)"
    }
    
    # Try GetWindowDesktopId
    Write-Host "`nTrying GetWindowDesktopId with shell window..."
    try {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ShellHelper {
    [DllImport("user32.dll")]
    public static extern IntPtr GetShellWindow();
}
"@
        $shellWnd = [ShellHelper]::GetShellWindow()
        Write-Host "Shell window: $shellWnd"
        $desktopId = $obj.GetWindowDesktopId($shellWnd)
        Write-Host "Desktop ID: $desktopId"
    } catch {
        Write-Host "GetWindowDesktopId error: $($_.Exception.Message)"
    }
} catch {
    Write-Host "Failed: $($_.Exception.Message)"
}

# Also check the registry entry more thoroughly
Write-Host "`n=== Registry details ==="
$regPath = "Registry::HKEY_CLASSES_ROOT\CLSID\{aa509086-5ca9-4c25-8f95-589d3c07b48a}"
Get-ItemProperty $regPath | ForEach-Object { Write-Host "Default: $($_.'(default)')" }
$subkeys = Get-ChildItem $regPath -ErrorAction SilentlyContinue
foreach ($sk in $subkeys) {
    Write-Host "  Subkey: $($sk.PSChildName)"
    $sk.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object {
        Write-Host "    $($_.Name) = $($_.Value)"
    }
}
