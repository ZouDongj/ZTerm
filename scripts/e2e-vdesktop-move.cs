// e2e-vdesktop-move.exe <pid> <desktopIndex> <expectedExePath>
// Moves the main window of the given process to the virtual desktop at
// <desktopIndex> (0-based, matching the order in Task View) without switching
// desktops. Used by scripts/e2e-check.mjs so E2E runs stop popping a window
// onto the user's active desktop. The pid must still belong to the exact exe
// the harness launched (pid-reuse guard) or the move is refused.
//
// Exit codes: 0 moved+verified, 2 usage error, 3 desktop list/index problem,
// 4 COM init/FindDesktop/move failure, 5 process exited or no main window
// within 30 s, 6 GetViewForHwnd failed, 7 post-move verify failed,
// 8 pid is not the expected exe.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

class E2eVDesktopMove {
    // Reverse-engineered shell COM ids for Windows 11 24H2+ (the old documented
    // IVirtualDesktopManager IID was retired). Source: github.com/MScholtes/VirtualDesktop
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

    [ComImport, Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationViewCollection {
        [PreserveSig] int GetViews(out IntPtr array);
        [PreserveSig] int GetViewsByZOrder(out IntPtr array);
        [PreserveSig] int GetViewsByAppUserModelId([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr array);
        [PreserveSig] int GetViewForHwnd(IntPtr hwnd, out IApplicationView view);
    }

    [ComImport, Guid("53F5CA0B-158F-4124-900C-057158060B27"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVirtualDesktopManagerInternal {
        // Vtable padding — never call. .NET COM interop assigns vtable slots
        // strictly in declaration order and the native object has GetCount at
        // this position (see the MScholtes source above); the slot must stay
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

    // Process.MainWindowHandle alone proved unreliable here (a WebView2 host
    // can report a handle the shell never registered as an application view),
    // so the candidate list walks every top-level window of the process.
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    static List<IntPtr> TopLevelWindowsOf(int pid) {
        var list = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == (uint)pid) list.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static int Main(string[] args) {
        int pid, index;
        if (args.Length != 3 || !int.TryParse(args[0], out pid) || pid <= 0 || !int.TryParse(args[1], out index)) {
            Console.WriteLine("usage: e2e-vdesktop-move.exe <pid> <desktopIndex> <expectedExePath>");
            return 2;
        }
        string expectedExe = args[2];

        // Desktop GUID list: 16-byte GUIDs concatenated, in Task View order.
        // `as byte[]` instead of a cast so a value of the wrong registry type
        // exits 3 here instead of throwing InvalidCastException.
        var raw = Registry.GetValue(
            @"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops",
            "VirtualDesktopIDs", null) as byte[];
        if (raw == null || raw.Length % 16 != 0) { Console.WriteLine("no desktop list in registry"); return 3; }
        int count = raw.Length / 16;
        if (index < 0 || index >= count) { Console.WriteLine("desktop index " + index + " out of range (" + count + " desktops)"); return 3; }
        var gb = new byte[16]; Array.Copy(raw, index * 16, gb, 0, 16); var target = new Guid(gb);

        IVirtualDesktopManagerInternal manager;
        IApplicationViewCollection views;
        IVirtualDesktop desktop;
        try {
            var shell = (IServiceProvider10)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_ImmersiveShell));
            var svc = CLSID_VirtualDesktopManagerInternal;
            var iidInternal = typeof(IVirtualDesktopManagerInternal).GUID;
            manager = (IVirtualDesktopManagerInternal)shell.QueryService(ref svc, ref iidInternal);
            var iidColl = typeof(IApplicationViewCollection).GUID;
            views = (IApplicationViewCollection)shell.QueryService(ref iidColl, ref iidColl);
            desktop = manager.FindDesktop(ref target);
        } catch (Exception e) {
            Console.WriteLine("COM init failed: " + e.Message);
            return 4;
        }
        if (desktop == null) { Console.WriteLine("FindDesktop failed"); return 4; }

        // Identity check before any move: the pid must still belong to the
        // exact exe the harness launched, or pid reuse could move a
        // stranger's window. MainModule is reliable because helper and target
        // are same-bitness (both 64-bit) processes.
        Process p;
        string actualExe;
        try {
            p = Process.GetProcessById(pid);
            actualExe = p.MainModule.FileName;
        } catch (Exception e) {
            Console.WriteLine("process " + pid + " unavailable: " + e.Message);
            return 5;
        }
        string actual = (actualExe ?? "").Replace('/', '\\');
        string wanted = (expectedExe ?? "").Replace('/', '\\');
        if (!string.Equals(actual, wanted, StringComparison.OrdinalIgnoreCase)) {
            Console.WriteLine("pid " + pid + " is '" + actualExe + "', expected '" + expectedExe + "' - refusing to move another process");
            return 8;
        }

        // Cross-process moves must go through GetViewForHwnd+MoveViewToDesktop;
        // IVirtualDesktopManager.MoveWindowToDesktop is denied (0x80070005)
        // for foreign windows. The shell view registration can lag window
        // creation (TYPE_E_ELEMENTNOTFOUND on a fresh window), so the whole
        // find+move sequence retries for up to 30 s. The watchdog exit on
        // p.HasExited also bounds the helper's life when the app dies first:
        // no external kill is needed.
        int lastHr = 0;
        int preVisible = -1;
        bool gotView = false;
        IntPtr movedHwnd = IntPtr.Zero;
        IApplicationView movedView = null;
        for (int i = 0; i < 120 && movedHwnd == IntPtr.Zero; i++) {
            if (p.HasExited) { Console.WriteLine("process exited before the move"); return 5; }
            // Candidate order: the process main window first (it is the
            // likeliest registered shell view), then the remaining top-level
            // windows of the process in Z-order, deduplicated.
            var hwnds = new List<IntPtr>();
            try {
                p.Refresh();
                if (p.MainWindowHandle != IntPtr.Zero) hwnds.Add(p.MainWindowHandle);
            } catch (InvalidOperationException) {
                // The process died between HasExited and the access above.
                Console.WriteLine("process exited before the move");
                return 5;
            }
            foreach (var h in TopLevelWindowsOf(pid)) {
                if (!hwnds.Contains(h)) hwnds.Add(h);
            }
            foreach (var hwnd in hwnds) {
                IApplicationView view;
                int hr = views.GetViewForHwnd(hwnd, out view);
                if (hr != 0 || view == null) { lastHr = hr; continue; }
                gotView = true;
                int visible = -1;
                desktop.IsViewVisible(view, out visible); // diagnostic: expect 0 before the move
                lastHr = manager.MoveViewToDesktop(view, desktop);
                if (lastHr == 0) { movedHwnd = hwnd; movedView = view; preVisible = visible; break; }
            }
            if (movedHwnd == IntPtr.Zero) Thread.Sleep(250);
        }
        if (movedHwnd == IntPtr.Zero) {
            if (!gotView && TopLevelWindowsOf(pid).Count == 0) { Console.WriteLine("no top-level window after 30s"); return 5; }
            Console.WriteLine((gotView ? "MoveViewToDesktop" : "GetViewForHwnd") + " hr=0x" + lastHr.ToString("X8") + " (after retries)");
            return gotView ? 4 : 6;
        }

        Thread.Sleep(200);
        // Real post-move check on the moved view: the target desktop must now
        // report it as visible (a window is visible on exactly one desktop).
        int postVisible;
        int vhr = desktop.IsViewVisible(movedView, out postVisible);
        if (vhr != 0 || postVisible == 0) {
            Console.WriteLine("verify failed: IsViewVisible on target desktop hr=0x" + vhr.ToString("X8") + " visible=" + postVisible);
            return 7;
        }
        Guid id;
        desktop.GetId(out id);
        Console.WriteLine("IsViewVisible pre-move=" + preVisible + " post-move=" + postVisible);
        Console.WriteLine("moved hwnd=0x" + movedHwnd.ToString("X") + " to desktop index " + index + " id=" + id);
        return 0;
    }
}
