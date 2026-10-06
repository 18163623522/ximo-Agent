$ErrorActionPreference = 'Stop'

Write-Host "=== Testing COM instantiation ==="

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class VDMTest5 {
    [DllImport("ole32.dll")]
    public static extern int CoInitialize(IntPtr pvReserved);
    
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        [In] ref Guid clsid, IntPtr pUnkOuter, int clsContext, [In] ref Guid iid, out IntPtr ppv);
    
    public static string TryCreate(Guid clsid, Guid iid) {
        IntPtr pUnk;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out pUnk);
        if (hr == 0) {
            object obj = Marshal.GetObjectForIUnknown(pUnk);
            Marshal.Release(pUnk);
            return string.Format("OK ({0})", obj.GetType().FullName);
        }
        return string.Format("FAILED hr=0x{0:X8}", hr);
    }
}
"@

[VDMTest5]::CoInitialize([IntPtr]::Zero) | Out-Null

$clsid = [Guid]'AA509086-5CA9-4C25-8F95-589D3C07B48A'

# Try IUnknown first
Write-Host "`nTrying IUnknown..."
$result = [VDMTest5]::TryCreate($clsid, [Guid]'00000000-0000-0000-C000-000000000046')
Write-Host "  Result: $result"

# Try IVirtualDesktopManager
Write-Host "`nTrying IVirtualDesktopManager..."
$result = [VDMTest5]::TryCreate($clsid, [Guid]'FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08')
Write-Host "  Result: $result"

# Check the InProcServer32 DLL
Write-Host "`n=== InProcServer32 DLL ==="
$regPath = "Registry::HKEY_CLASSES_ROOT\CLSID\{aa509086-5ca9-4c25-8f95-589d3c07b48a}\InProcServer32"
$props = Get-ItemProperty $regPath
Write-Host "DLL: $($props.'(default)')"
Write-Host "ThreadingModel: $($props.ThreadingModel)"
$dllPath = $props.'(default)' -replace '^"', '' -replace '"$', ''
Write-Host "DLL exists: $(Test-Path $dllPath)"
