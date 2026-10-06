$ErrorActionPreference = 'Stop'

Write-Host "=== Testing COM instantiation with correct CLSID and various IIDs ==="

# First CoInitialize
[System.Runtime.InteropServices.Marshal]::GetIUnknownForObject((New-Object Object)) | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class VDMTest2 {
    [DllImport("ole32.dll")]
    public static extern int CoInitialize(IntPtr pvReserved);
    
    [DllImport("ole32.dll")]
    public static extern void CoUninitialize();
    
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        ref Guid clsid, IntPtr pUnkOuter, int clsContext, ref Guid iid, out IntPtr ppv);
    
    public static string TryCreate(Guid clsid, Guid iid) {
        IntPtr pUnk;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out pUnk);
        if (hr == 0) {
            return string.Format("OK (ptr={0})", pUnk);
        }
        return string.Format("FAILED hr=0x{0:X8}", hr);
    }
    
    public static string TryCreateObj(Guid clsid, Guid iid) {
        object obj;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out obj);
        if (hr == 0) {
            return string.Format("OK ({0})", obj.GetType().FullName);
        }
        return string.Format("FAILED hr=0x{0:X8}", hr);
    }
}
"@

[VDMTest2]::CoInitialize([IntPtr]::Zero) | Out-Null

# Correct CLSID from registry
$clsid = [Guid]'AA509086-5CA9-4C25-8F95-589D3C07B48A'

# Try different IIDs for IVirtualDesktopManager
$uids = @(
    @{ name = "IVirtualDesktopManager (FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08)"; guid = [Guid]'FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08' },
    @{ name = "IUnknown (00000000-0000-0000-C000-000000000046)"; guid = [Guid]'00000000-0000-0000-C000-000000000046' },
    @{ name = "IDispatch (00020400-0000-0000-C000-000000000046)"; guid = [Guid]'00020400-0000-0000-C000-000000000046' }
)

foreach ($u in $uids) {
    Write-Host "`nTrying $($u.name)..."
    try {
        $result = [VDMTest2]::TryCreate($clsid, $u.guid)
        Write-Host "  Result: $result"
    } catch {
        Write-Host "  Error: $($_.Exception.Message)"
    }
}

# If IUnknown worked, let's try to QueryInterface for IVirtualDesktopManager
Write-Host "`n=== Trying IUnknown then QueryInterface ==="
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class VDMTest3 {
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        ref Guid clsid, IntPtr pUnkOuter, int clsContext, ref Guid iid, out IntPtr ppv);
    
    [DllImport("ole32.dll")]
    public static extern int CoInitialize(IntPtr pvReserved);
    
    [StructLayout(LayoutKind.Sequential)]
    public struct IUnknownVtbl {
        public IntPtr QueryInterface;
        public IntPtr AddRef;
        public IntPtr Release;
    }
    
    public static string TryViaIUnknown(Guid clsid, Guid targetIid) {
        Guid iidUnknown = new Guid("00000000-0000-0000-C000-000000000046");
        IntPtr pUnk;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iidUnknown, out pUnk);
        if (hr != 0) return string.Format("CoCreateInstance(IUnknown) failed: 0x{0:X8}", hr);
        
        // Get vtable
        IntPtr pVtbl = Marshal.ReadIntPtr(pUnk);
        IUnknownVtbl vtbl = (IUnknownVtbl)Marshal.PtrToStructure(pVtbl, typeof(IUnknownVtbl));
        
        // Create QueryInterface delegate
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        delegate int QueryInterfaceDelegate(IntPtr This, ref Guid riid, out IntPtr ppv);
        
        var qi = (QueryInterfaceDelegate)Marshal.GetDelegateForFunctionPointer(vtbl.QueryInterface, typeof(QueryInterfaceDelegate));
        
        IntPtr pTarget;
        hr = qi(pUnk, ref targetIid, out pTarget);
        if (hr == 0) {
            return string.Format("QueryInterface OK (ptr={0})", pTarget);
        }
        return string.Format("QueryInterface failed: 0x{0:X8}", hr);
    }
}
"@

try {
    $result = [VDMTest3]::TryViaIUnknown($clsid, [Guid]'FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08')
    Write-Host "Result: $result"
} catch {
    Write-Host "Error: $($_.Exception.Message)"
}

# Also check the InProcServer32 DLL
Write-Host "`n=== InProcServer32 DLL ==="
$regPath = "Registry::HKEY_CLASSES_ROOT\CLSID\{aa509086-5ca9-4c25-8f95-589d3c07b48a}\InProcServer32"
$props = Get-ItemProperty $regPath
Write-Host "DLL: $($props.'(default)')"
Write-Host "ThreadingModel: $($props.ThreadingModel)"

# Check if DLL exists
if ($props.'(default)') {
    $dllPath = $props.'(default)' -replace '^"', '' -replace '"$', ''
    Write-Host "DLL exists: $(Test-Path $dllPath)"
}
