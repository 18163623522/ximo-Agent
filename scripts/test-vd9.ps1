[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class VDMTestSP {
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
        
        // Shell.Application CLSID: {13709620-C279-11CE-A49E-444553540000}
        Guid clsidShell = new Guid("13709620-C279-11CE-A49E-444553540000");
        Guid iidSP = new Guid("6D5140C1-7436-11CE-8034-00AA006009FA");
        Guid iidUnknown = new Guid("00000000-0000-0000-C000-000000000046");
        
        IntPtr pSP;
        int hr = CoCreateInstance(ref clsidShell, IntPtr.Zero, 1 | 4, ref iidSP, out pSP);
        if (hr != 0) {
            hr = CoCreateInstance(ref clsidShell, IntPtr.Zero, 1 | 4, ref iidUnknown, out pSP);
            if (hr != 0) return "Shell.Application create failed: 0x" + hr.ToString("X8");
        }
        
        object spObj = Marshal.GetObjectForIUnknown(pSP);
        
        try {
            IServiceProvider sp = (IServiceProvider)spObj;
            
            // Try different service GUIDs
            Guid[] serviceGuids = new Guid[] {
                new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A"),
                new Guid("C5E0CDCA-2DF6-473B-A8D5-1D0F8B8B4B43"),
                new Guid("F31574D6-B682-4CDC-BD56-1827860ABEC6"),
            };
            
            Guid iidInternal = new Guid("F31574D6-B682-4CDC-BD56-1827860ABEC6");
            
            foreach (var sg in serviceGuids) {
                Guid g = sg; // Copy to avoid foreach ref issue
                IntPtr pInternal;
                hr = sp.QueryService(ref g, ref iidInternal, out pInternal);
                if (hr == 0) {
                    object vdmInternal = Marshal.GetObjectForIUnknown(pInternal);
                    return "VDMInternal OK via service " + sg.ToString() + " type: " + vdmInternal.GetType().FullName;
                }
            }
            
            return "All QueryService attempts failed. Last hr=0x" + hr.ToString("X8");
        } catch (Exception ex) {
            return "Cast to IServiceProvider failed: " + ex.Message;
        }
    }
}
"@

Write-Host "=== Shell.Application -> IServiceProvider -> VDMInternal ==="
try {
    $result = [VDMTestSP]::Test()
    Write-Host $result
} catch {
    Write-Host "Error: $($_.Exception.Message)"
}
