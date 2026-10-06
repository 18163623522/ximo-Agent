[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$csCode = @'
using System;
using System.Runtime.InteropServices;

public class VDMTestSP2 {
    [DllImport("ole32.dll")]
    public static extern int CoInitialize(IntPtr pvReserved);
    
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        [In] ref Guid clsid, IntPtr pUnkOuter, int clsContext, [In] ref Guid iid, out IntPtr ppv);
    
    [Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [ComImport]
    public interface IServiceProvider {
        [PreserveSig]
        int QueryService([In] ref Guid guidService, [In] ref Guid riid, out IntPtr ppvObject);
    }
    
    public static string Test() {
        CoInitialize(IntPtr.Zero);
        
        Guid clsidShell = new Guid("13709620-C279-11CE-A49E-444553540000");
        Guid iidSP = new Guid("6D5140C1-7436-11CE-8034-00AA006009FA");
        Guid iidUnknown = new Guid("00000000-0000-0000-C000-000000000046");
        
        IntPtr pSP;
        int hr = CoCreateInstance(ref clsidShell, IntPtr.Zero, 1 | 4, ref iidSP, out pSP);
        if (hr != 0) {
            hr = CoCreateInstance(ref clsidShell, IntPtr.Zero, 1 | 4, ref iidUnknown, out pSP);
            if (hr != 0) return "Shell create failed: 0x" + hr.ToString("X8");
        }
        
        object spObj = Marshal.GetObjectForIUnknown(pSP);
        
        try {
            IServiceProvider sp = (IServiceProvider)spObj;
            Guid iidInternal = new Guid("F31574D6-B682-4CDC-BD56-1827860ABEC6");
            
            Guid g1 = new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A");
            IntPtr p1;
            hr = sp.QueryService(ref g1, ref iidInternal, out p1);
            if (hr == 0) return "OK via service g1 (CLSID)";
            
            Guid g2 = new Guid("C5E0CDCA-2DF6-473B-A8D5-1D0F8B8B4B43");
            IntPtr p2;
            hr = sp.QueryService(ref g2, ref iidInternal, out p2);
            if (hr == 0) return "OK via service g2";
            
            Guid g3 = new Guid("F31574D6-B682-4CDC-BD56-1827860ABEC6");
            IntPtr p3;
            hr = sp.QueryService(ref g3, ref iidInternal, out p3);
            if (hr == 0) return "OK via service g3 (IID)";
            
            return "All failed. Last hr=0x" + hr.ToString("X8");
        } catch (Exception ex) {
            return "Cast failed: " + ex.Message;
        }
    }
}
'@

Add-Type -TypeDefinition $csCode -Language CSharp

Write-Host "=== Shell.Application -> IServiceProvider -> VDMInternal ==="
try {
    $result = [VDMTestSP2]::Test()
    Write-Host $result
} catch {
    Write-Host "Error: $($_.Exception.Message)"
}
