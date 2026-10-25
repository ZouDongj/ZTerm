// Read-only desktop and foreground observer for background E2E.
// It never moves windows, switches desktops, activates windows, or changes input.
// Legacy filename retained; native placement now happens inside the owned app
// through the documented IVirtualDesktopManager interface.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

class E2eDesktopObserver {
    // Internal shell interfaces are used only for read-only desktop inspection.
    // Public IVirtualDesktopManager remains supported; the app moves its own HWND.
    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IServiceProvider10 { [return: MarshalAs(UnmanagedType.IUnknown)] object QueryService(ref Guid service, ref Guid riid); }

    [ComImport, Guid("372E1D3B-38D3-42E4-A15B-8AB2B178F513"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationView {} // token only: no methods are ever called on it

    [ComImport, Guid("3F07F4BE-B107-441A-AF0F-39D82529072C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVirtualDesktop {
        [PreserveSig] int IsViewVisible(IApplicationView view, out int visible);
        // GetId must be [PreserveSig] with an int return: a marshalled
        // non-int return throws MarshalDirectiveException on this runtime.
        [PreserveSig] int GetId(out Guid id);
    }

    [ComImport, Guid("53F5CA0B-158F-4124-900C-057158060B27"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVirtualDesktopManagerInternal {
        // Vtable padding — never call. .NET COM interop assigns vtable slots
        // strictly in declaration order and the native object has GetCount at
        // this position; the slot must stay
        // occupied or every method below would bind to the wrong native
        // function. The exact shape is irrelevant because it is never invoked.
        [PreserveSig] int VtableSlot_GetCount();
        [PreserveSig] int MoveViewToDesktop(IApplicationView view, IVirtualDesktop desktop);
        // Same padding story: natively this slot is CanViewMoveDesktops.
        [PreserveSig] int VtableSlot_CanViewMoveDesktops(IApplicationView view);
        [return: MarshalAs(UnmanagedType.Interface)] IVirtualDesktop GetCurrentDesktop();
        [PreserveSig] int GetDesktops(out IntPtr desktops);
        [PreserveSig] int GetAdjacentDesktop(IVirtualDesktop from, int direction, out IVirtualDesktop desktop);
        [PreserveSig] int SwitchDesktop(IVirtualDesktop desktop);
        [PreserveSig] int SwitchDesktopAndMoveForegroundView(IVirtualDesktop desktop);
        [return: MarshalAs(UnmanagedType.Interface)] IVirtualDesktop CreateDesktop();
        [PreserveSig] int MoveDesktop(IVirtualDesktop desktop, int nIndex);
        [PreserveSig] int RemoveDesktop(IVirtualDesktop desktop, IVirtualDesktop fallback);
        [return: MarshalAs(UnmanagedType.Interface)] IVirtualDesktop FindDesktop(ref Guid desktopid);
    }

    static readonly Guid CLSID_ImmersiveShell = new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239");
    static readonly Guid CLSID_VirtualDesktopManagerInternal = new Guid("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();

    static string Quote(string value) {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\"";
    }

    static string Snapshot(IVirtualDesktopManagerInternal manager, Guid target) {
        IVirtualDesktop current = manager.GetCurrentDesktop();
        Guid currentId;
        if (current == null || current.GetId(out currentId) != 0) throw new Exception("current desktop identity unavailable");
        IVirtualDesktop destination = manager.FindDesktop(ref target);
        Guid targetId;
        if (destination == null || destination.GetId(out targetId) != 0 || targetId != target) throw new Exception("target desktop identity unavailable");
        IntPtr foreground = GetForegroundWindow();
        uint foregroundPid;
        if (foreground == IntPtr.Zero || GetWindowThreadProcessId(foreground, out foregroundPid) == 0 || foregroundPid == 0)
            throw new Exception("foreground identity unavailable");
        var owners = new List<string>();
        var visited = new HashSet<IntPtr>();
        IntPtr owner = foreground;
        for (int i = 0; i < 8 && owner != IntPtr.Zero; i++) {
            if (!visited.Add(owner)) throw new Exception("foreground owner chain is cyclic");
            uint pid;
            if (GetWindowThreadProcessId(owner, out pid) == 0 || pid == 0) throw new Exception("foreground owner identity unavailable");
            owners.Add(pid.ToString());
            owner = GetWindow(owner, 4); // GW_OWNER, read only.
        }
        if (owner != IntPtr.Zero) throw new Exception("foreground owner chain exceeded its bound");
        Guid confirmedCurrentId;
        if (manager.GetCurrentDesktop().GetId(out confirmedCurrentId) != 0 || confirmedCurrentId != currentId
            || GetForegroundWindow() != foreground) throw new Exception("desktop or foreground changed while observing");
        ulong now = GetTickCount64();
        return "{\"ok\":true,\"clockDomain\":\"windows-boot-ms\",\"currentDesktopId\":" + Quote(currentId.ToString("D"))
            + ",\"targetDesktopId\":" + Quote(targetId.ToString("D"))
            + ",\"foregroundHwnd\":" + Quote("0x" + foreground.ToInt64().ToString("x"))
            + ",\"foregroundPid\":" + foregroundPid + ",\"foregroundOwnerPids\":[" + string.Join(",", owners.ToArray())
            + "],\"observedAt\":" + now + "}";
    }

    [STAThread]
    static int Main(string[] args) {
        int index;
        bool watch = args.Length == 3 && args[0] == "watch";
        if ((!watch && (args.Length != 2 || args[0] != "inspect")) || !int.TryParse(args[1], out index) || index < 0) {
            Console.WriteLine("{\"ok\":false,\"error\":\"usage: inspect <index> | watch <index> <parentPid>\"}"); return 2;
        }
        try {
            var raw = Registry.GetValue(@"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops", "VirtualDesktopIDs", null) as byte[];
            if (raw == null || raw.Length % 16 != 0 || index >= raw.Length / 16) throw new Exception("target desktop index is unavailable");
            var bytes = new byte[16]; Array.Copy(raw, index * 16, bytes, 0, 16);
            var target = new Guid(bytes);
            var shell = (IServiceProvider10)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_ImmersiveShell));
            var service = CLSID_VirtualDesktopManagerInternal;
            var iid = typeof(IVirtualDesktopManagerInternal).GUID;
            var manager = (IVirtualDesktopManagerInternal)shell.QueryService(ref service, ref iid);
            Process parent = null;
            if (watch) {
                int parentPid;
                if (!int.TryParse(args[2], out parentPid) || parentPid <= 0) throw new Exception("invalid observer parent");
                parent = Process.GetProcessById(parentPid);
                var handle = parent.Handle; // Pin this process identity for HasExited.
            }
            do {
                if (parent != null && parent.HasExited) break;
                Console.WriteLine(Snapshot(manager, target));
                Console.Out.Flush();
                if (!watch) break;
                Thread.Sleep(100);
            } while (true);
            return 0;
        } catch (Exception error) {
            Console.WriteLine("{\"ok\":false,\"error\":" + Quote(error.Message) + "}");
            return 3;
        }
    }
}
