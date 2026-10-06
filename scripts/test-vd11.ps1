[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$csCode = @'
using System;
using System.Runtime.InteropServices;

public class VDMExplorer2 {
    [DllImport("ole32.dll")]
    public static extern int CoInitialize(IntPtr pvReserved);
    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        [In] ref Guid clsid, IntPtr pUnkOuter, int clsContext, [In] ref Guid iid, out IntPtr ppv);
    [DllImport("ole32.dll")]
    public static extern int GetActiveObject(ref Guid rclsid, IntPtr pvReserved, out IntPtr ppunk);
    
    [Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [ComImport]
    public interface IServiceProvider {
        [PreserveSig]
        int QueryService([In] ref Guid guidService, [In] ref Guid riid, out IntPtr ppvObject);
    }
    
    public static string Test() {
        CoInitialize(IntPtr.Zero);
        Guid clsidImmersive = new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F231");
        Guid iidUnknown = new Guid("00000000-0000-0000-C000-000000000046");
        Guid iidSP = new Guid("6D5140C1-7436-11CE-8034-00AA006009FA");
        
        // Try GetActiveObject
        IntPtr pActive;
        int hr = GetActiveObject(ref clsidImmersive, IntPtr.Zero, out pActive);
        if (hr == 0) {
            object obj = Marshal.GetObjectForIUnknown(pActive);
            try {
                IServiceProvider sp = (IServiceProvider)obj;
                Guid svc = new Guid("F31574D6-B682-4CDC-BD56-1827860ABEC6");
                Guid iidInt = new Guid("F31574D6-B682-4CDC-BD56-1827860ABEC6");
                IntPtr pInt;
                hr = sp.QueryService(ref svc, ref iidInt, out pInt);
                if (hr == 0) return "OK via GetActiveObject";
                return "GetActiveObject OK, QS failed: 0x" + hr.ToString("X8");
            } catch (Exception ex) {
                return "GetActiveObject OK, cast: " + ex.Message;
            }
        }
        return "GetActiveObject failed: 0x" + hr.ToString("X8");
    }
}
'@

Add-Type -TypeDefinition $csCode -Language CSharp
$result = [VDMExplorer2]::Test()
Write-Host $result
