$ErrorActionPreference = 'Stop'

# Test: Try different approaches to get VirtualDesktopManager

# Approach 1: New-Object with CLSID
Write-Host "=== Approach 1: New-Object -ComObject ==="
try {
    $obj = New-Object -ComObject VirtualDesktopManager.Application -ErrorAction Stop
    Write-Host "Success: $obj"
} catch {
    Write-Host "Failed: $($_.Exception.Message)"
}

# Approach 2: Type.GetTypeFromCLSID + Activator (with CLSCTX)
Write-Host "`n=== Approach 2: Direct CoCreateInstance via P/Invoke ==="
try {
    Add-Type @"
using System;
using System.Runtime.InteropServices;

public class COMHelper {
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        ref Guid clsid, IntPtr pUnkOuter, int clsContext, ref Guid iid, out object ppv);
    
    [DllImport("ole32.dll")]
    public static extern int CoInitialize(IntPtr pvReserved);
    
    public static object CreateVDM() {
        CoInitialize(IntPtr.Zero);
        Guid clsid = new Guid("AA509086-5CA9-4C25-8F95-589D35C1934C");
        Guid iid = new Guid("FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08");
        object obj;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 4 | 1, ref iid, out obj);
        if (hr != 0) throw new Exception(string.Format("CoCreateInstance failed: 0x{0:X8}", hr));
        return obj;
    }
}
"@
    $obj = [COMHelper]::CreateVDM()
    Write-Host "Success! Type: $($obj.GetType().FullName)"
    
    # Try calling methods
    Write-Host "Methods:"
    $obj.GetType().GetMethods() | ForEach-Object { Write-Host "  $($_.Name)" }
} catch {
    Write-Host "Failed: $($_.Exception.Message)"
}

# Approach 3: Check registry for virtual desktop
Write-Host "`n=== Approach 3: Registry check ==="
try {
    $reg = Get-ChildItem "Registry::HKEY_CLASSES_ROOT\CLSID" -ErrorAction Stop | Where-Object { $_.PSChildName -like "*AA509086*" }
    if ($reg) {
        Write-Host "Found: $($reg.PSPath)"
    } else {
        Write-Host "CLSID not found in HKCR"
    }
} catch {
    Write-Host "Registry check failed: $($_.Exception.Message)"
}

# Approach 4: Check if explorer.exe exposes it
Write-Host "`n=== Approach 4: Check via IServiceProvider ==="
try {
    # The virtual desktop manager is actually a local server (explorer.exe)
    # Let's try CLSCTX_LOCAL_SERVER only
    Add-Type @"
using System;
using System.Runtime.InteropServices;

public class COMHelper2 {
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        ref Guid clsid, IntPtr pUnkOuter, int clsContext, ref Guid iid, out object ppv);
    
    public static object CreateVDMLocal() {
        Guid clsid = new Guid("AA509086-5CA9-4C25-8F95-589D35C1934C");
        Guid iid = new Guid("FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08");
        object obj;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 4, ref iid, out obj); // CLSCTX_LOCAL_SERVER = 4
        if (hr != 0) throw new Exception(string.Format("CoCreateInstance (LOCAL_SERVER) failed: 0x{0:X8}", hr));
        return obj;
    }
    
    public static object CreateVDMInproc() {
        Guid clsid = new Guid("AA509086-5CA9-4C25-8F95-589D35C1934C");
        Guid iid = new Guid("FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08");
        object obj;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out obj); // CLSCTX_INPROC_SERVER = 1
        if (hr != 0) throw new Exception(string.Format("CoCreateInstance (INPROC_SERVER) failed: 0x{0:X8}", hr));
        return obj;
    }
    
    public static object CreateVDMAll() {
        Guid clsid = new Guid("AA509086-5CA9-4C25-8F95-589D35C1934C");
        Guid iid = new Guid("FF72FFDD-BE7E-43CA-84F7-8BCE0AAABC08");
        object obj;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 4 | 1 | 16, ref iid, out obj); // LOCAL | INPROC | REMOTE
        if (hr != 0) throw new Exception(string.Format("CoCreateInstance (ALL) failed: 0x{0:X8}", hr));
        return obj;
    }
}
"@
    try {
        $obj = [COMHelper2]::CreateVDMLocal()
        Write-Host "LOCAL_SERVER success: $($obj.GetType().FullName)"
    } catch {
        Write-Host "LOCAL_SERVER failed: $($_.Exception.Message)"
    }
    try {
        $obj = [COMHelper2]::CreateVDMInproc()
        Write-Host "INPROC_SERVER success: $($obj.GetType().FullName)"
    } catch {
        Write-Host "INPROC_SERVER failed: $($_.Exception.Message)"
    }
    try {
        $obj = [COMHelper2]::CreateVDMAll()
        Write-Host "ALL success: $($obj.GetType().FullName)"
    } catch {
        Write-Host "ALL failed: $($_.Exception.Message)"
    }
} catch {
    Write-Host "Failed: $($_.Exception.Message)"
}
