$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class VDInterfaceScanner {
    [DllImport("ole32.dll")]
    public static extern int CoInitialize(IntPtr pvReserved);
    
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        [In] ref Guid clsid, IntPtr pUnkOuter, int clsContext, [In] ref Guid iid, out IntPtr ppv);
    
    public static string TryQI(Guid clsid, Guid iid) {
        IntPtr pUnk;
        Guid iidUnknown = new Guid("00000000-0000-0000-C000-000000000046");
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iidUnknown, out pUnk);
        if (hr != 0) return string.Format("CreateInstance failed: 0x{0:X8}", hr);
        
        // Try direct creation with target IID
        IntPtr pTarget;
        hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out pTarget);
        if (hr == 0) {
            Marshal.Release(pTarget);
            return "OK";
        }
        Marshal.Release(pUnk);
        return string.Format("FAILED 0x{0:X8}", hr);
    }
}
"@

[VdInterfaceScanner]::CoInitialize([IntPtr]::Zero) | Out-Null

$clsid = [Guid]'AA509086-5CA9-4C25-8F95-589D3C07B48A'

# Known Virtual Desktop interface IIDs from various Windows versions
$knownIIDs = @(
    @{ name = "IVirtualDesktopManager (Win10 1607+)"; guid = 'FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08' },
    @{ name = "IVirtualDesktopManagerInternal"; guid = 'F31574D6-BB2B-417B-A4CE-4D84DB51F1B7' },
    @{ name = "IVirtualDesktopManagerInternal (alt)"; guid = 'C2FBB838-2F2A-41DF-B1C4-E1D1C8A3B3A2' },
    @{ name = "IVirtualDesktop (Win10 1607)"; guid = 'FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08' },
    @{ name = "IObjectArray"; guid = '92CA9DCD-5628-4A3D-9B3C-4E0B9E3D4D4F' },
    @{ name = "IObjectCollection"; guid = '56B2B2AD-3D8E-4C55-9D76-2D6DEBF7B5AE' },
    @{ name = "IVirtualDesktopManager2 (Win11)"; guid = '0F3A1F7A-A6A9-4AD0-8DBA-53B6843D6E9A' },
    @{ name = "IVirtualDesktopManagerInternal2 (Win10 2004+)"; guid = 'F31574D6-BB2B-417B-A4CE-4D84DB51F1B7' },
    @{ name = "IServiceProvider"; guid = '6D5140C1-7436-11CE-8034-00AA006009FA' },
    @{ name = "IVirtualDesktopManagerInternal (Win10 1903+)"; guid = 'B5D6B5AC-E251-4299-9AAB-2A9B3ACD6B0C' },
    @{ name = "IVirtualDesktopManagerInternal (Win10 1809)"; guid = '39689BD2-47D1-4C1F-9E95-1F5AABC3D0B1' },
    @{ name = "IVirtualDesktopManagerInternal (Win10 2004)"; guid = 'F31574D6-BB2B-417B-A4CE-4D84DB51F1B7' },
    @{ name = "IVirtualDesktopManager (Win10 1903+)"; guid = 'A73FFD2A-4CD4-4CE2-A3B6-AB42F2E0F4A2' }
)

foreach ($iid in $knownIIDs) {
    $g = [Guid]$iid.guid
    $result = [VdInterfaceScanner]::TryQI($clsid, $g)
    Write-Host "$($iid.name) [$($iid.guid)]: $result"
}

# Also try using the object directly via late binding
Write-Host "`n=== Late binding test ==="
try {
    $type = [Type]::GetTypeFromCLSID($clsid)
    $obj = [Activator]::CreateInstance($type)
    Write-Host "Created: $($obj.GetType().FullName)"
    
    # Get type info
    $t = $obj.GetType()
    Write-Host "Type: $t"
    Write-Host "Members:"
    $t.GetMembers() | ForEach-Object { Write-Host "  $($_.MemberType): $($_.Name)" }
} catch {
    Write-Host "Late binding error: $($_.Exception.Message)"
}
