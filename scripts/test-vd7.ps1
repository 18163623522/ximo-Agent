$ErrorActionPreference = 'Stop'

# The VirtualDesktopManager is implemented by explorer.exe (out-of-process COM server)
# We need to get it via the running instance of explorer, not create a new one.
# The correct approach is to use IShellDispatch + IServiceProvider

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class VirtualDesktopInterop {
    [DllImport("ole32.dll")]
    public static extern int CoInitialize(IntPtr pvReserved);
    
    [DllImport("ole32.dll")]
    public static extern int GetActiveObject(ref Guid rclsid, IntPtr pvReserved, out IntPtr ppunk);
    
    [DllImport("ole32.dll")]
    public static extern int CreateBindCtx(uint reserved, out IntPtr ppbc);
    
    [DllImport("ole32.dll", CharSet = CharSet.Unicode)]
    public static extern int CLSIDFromProgID(string lpszProgID, out Guid pclsid);
    
    [DllImport("ole32.dll", CharSet = CharSet.Unicode)]
    public static extern int CLSIDFromString(string lpsz, out Guid pclsid);
    
    [DllImport("ole32.dll")]
    public static extern int IIDFromString(string lpsz, out Guid lpiid);
}
"@

[VirtualDesktopInterop]::CoInitialize([IntPtr]::Zero) | Out-Null

# Method 1: Try to get the running explorer instance
# The shell object (Shell.Application / IShellDispatch) exposes IServiceProvider
Write-Host "=== Method 1: Shell.Application -> IServiceProvider -> IVirtualDesktopManager ==="
try {
    $shell = New-Object -ComObject Shell.Application
    Write-Host "Shell.Application created: $($shell.GetType().FullName)"
    
    # Get IServiceProvider from Shell
    $sp = [VirtualDesktopInterop]::GetActiveObject
    Write-Host "Shell methods:"
    $shell.GetType().GetMethods() | ForEach-Object { Write-Host "  $($_.Name)" }
} catch {
    Write-Host "Failed: $($_.Exception.Message)"
}

# Method 2: Try the known CLSID for ImmersiveShell (which has IServiceProvider)
Write-Host "`n=== Method 2: ImmersiveShell ==="
try {
    # CLSID_ImmersiveShell = {C2F03A33-21F5-47FA-B4BB-156362A2F231}
    $immersiveShellClsid = [Guid]'C2F03A33-21F5-47FA-B4BB-156362A2F231'
    
    Add-Type @"
using System;
using System.Runtime.InteropServices;

public class ImmersiveShellHelper {
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        [In] ref Guid clsid, IntPtr pUnkOuter, int clsContext, [In] ref Guid iid, out IntPtr ppv);
    
    public static IntPtr GetImmersiveShell() {
        Guid clsid = new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F231");
        Guid iid = new Guid("00000000-0000-0000-C000-000000000046"); // IUnknown
        IntPtr pUnk;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 4 | 1, ref iid, out pUnk);
        if (hr != 0) throw new Exception(string.Format("Failed: 0x{0:X8}", hr));
        return pUnk;
    }
    
    // IServiceProvider.QueryService
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int QueryServiceDelegate(IntPtr This, ref Guid guidService, ref Guid riid, out IntPtr ppvObject);
    
    public static string TryGetVDM(IntPtr pServiceProvider) {
        // Get IServiceProvider vtable (3rd method after IUnknown: QI, AddRef, Release, QueryService)
        IntPtr pVtbl = Marshal.ReadIntPtr(pServiceProvider);
        // Skip IUnknown (3 pointers: QI, AddRef, Release = 3 * IntPtr.Size)
        IntPtr pQueryService = Marshal.ReadIntPtr(pVtbl, 3 * IntPtr.Size);
        
        var queryService = (QueryServiceDelegate)Marshal.GetDelegateForFunctionPointer(pQueryService, typeof(QueryServiceDelegate));
        
        // Query for IVirtualDesktopManager service
        Guid serviceGuid = new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"); // SID_VirtualDesktopManager
        Guid iid = new Guid("FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08"); // IID_IVirtualDesktopManager
        
        IntPtr pVdm;
        int hr = queryService(pServiceProvider, ref serviceGuid, ref iid, out pVdm);
        if (hr == 0) {
            object vdm = Marshal.GetObjectForIUnknown(pVdm);
            Marshal.Release(pVdm);
            return string.Format("OK ({0})", vdm.GetType().FullName);
        }
        return string.Format("QueryService failed: 0x{0:X8}", hr);
    }
}
"@
    
    $pShell = [ImmersiveShellHelper]::GetImmersiveShell()
    Write-Host "ImmersiveShell IUnknown: $pShell"
    
    # Try getting VDM via IServiceProvider
    $result = [ImmersiveShellHelper]::TryGetVDM($pShell)
    Write-Host "VDM result: $result"
    
} catch {
    Write-Host "Failed: $($_.Exception.Message)"
}

# Method 3: Try using known VirtualDesktopAccessor approach
# The correct CLSID for the COM object that implements IVirtualDesktopManager is not the one we tried
# Let's check registry for all interfaces with "VirtualDesktop" in name
Write-Host "`n=== Method 3: Registry scan for VirtualDesktop interfaces ==="
try {
    $ifaceKey = "Registry::HKEY_CLASSES_ROOT\Interface"
    $interfaces = Get-ChildItem $ifaceKey -ErrorAction SilentlyContinue | Where-Object {
        (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).'(default)' -like '*VirtualDesktop*'
    }
    foreach ($iface in $interfaces) {
        $name = (Get-ItemProperty $iface.PSPath).'(default)'
        Write-Host "  $($iface.PSChildName) = $name"
    }
} catch {
    Write-Host "Registry scan failed: $($_.Exception.Message)"
}
