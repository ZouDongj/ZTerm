// Independent process-tree supervisor for isolated E2E runs.
// The job handle belongs only to this process. Closing it for any reason,
// including watchdog termination, asks Windows to kill every assigned child.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class E2eProcessWatchdog {
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int JobObjectExtendedLimitInformation = 9;
    const int JobObjectBasicProcessIdList = 3;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 0x102;
    const uint WAIT_FAILED = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, int informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int informationClass,
        IntPtr information, int informationLength, out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int handle);

    static string QuoteArgument(string value) {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        var result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char c in value) {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(c);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    static string CommandLine(string[] args, int start) {
        var command = new StringBuilder();
        for (int i = start; i < args.Length; i++) {
            if (i > start) command.Append(' ');
            command.Append(QuoteArgument(args[i]));
        }
        return command.ToString();
    }

    static void WaitOne(IntPtr handle) {
        uint result = WaitForSingleObject(handle, 0);
        if (result == WAIT_FAILED) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (result != WAIT_OBJECT_0 && result != WAIT_TIMEOUT) throw new Exception("unexpected process wait result");
    }

    static bool IsExited(IntPtr handle) {
        WaitOne(handle);
        return WaitForSingleObject(handle, 0) == WAIT_OBJECT_0;
    }

    static void WaitForJobEmpty(IntPtr job, int timeoutMs) {
        int size = 8 + IntPtr.Size * 1024;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (true) {
                int returned;
                if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, size, out returned))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                int assigned = Marshal.ReadInt32(buffer, 0);
                if (assigned == 0) return;
                if (DateTime.UtcNow >= deadline) throw new Exception("process job did not become empty before the cleanup deadline");
                Thread.Sleep(10);
            }
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }

    static int Run(string[] args) {
        if (args.Length < 6 || args[0] != "--parent-pid" || args[2] != "--parent-start-ms" || args[4] != "--")
            throw new Exception("usage: --parent-pid <pid> --parent-start-ms <unix-ms> -- <executable> [args...]");
        int parentPid;
        long parentStartMs;
        if (!int.TryParse(args[1], out parentPid) || parentPid <= 0 || !long.TryParse(args[3], out parentStartMs))
            throw new Exception("invalid parent identity");

        Process parent = null;
        IntPtr job = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool childStarted = false;
        bool assigned = false;
        try {
            parent = Process.GetProcessById(parentPid);
            long actualStartMs = new DateTimeOffset(parent.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
            if (actualStartMs != parentStartMs) throw new Exception("parent process identity changed before supervision");
            IntPtr parentHandle = parent.Handle;
            if (IsExited(parentHandle)) return 1;

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(-10);
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);
            string commandText = CommandLine(args, 5);
            var command = new StringBuilder(commandText, commandText.Length + 32768);
            if (!CreateProcess(args[5], command, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            childStarted = true;
            if (!AssignProcessToJobObject(job, child.hProcess)) {
                TerminateProcess(child.hProcess, 1);
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            assigned = true;
            if (ResumeThread(child.hThread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(child.hThread);
            child.hThread = IntPtr.Zero;

            bool childExited = false;
            bool parentExited = false;
            while (!childExited && !parentExited) {
                uint result = WaitForSingleObject(parentHandle, 50);
                if (result == WAIT_FAILED) throw new Win32Exception(Marshal.GetLastWin32Error());
                parentExited = result == WAIT_OBJECT_0;
                if (parentExited) break;
                result = WaitForSingleObject(child.hProcess, 0);
                if (result == WAIT_FAILED) throw new Win32Exception(Marshal.GetLastWin32Error());
                childExited = result == WAIT_OBJECT_0;
            }

            if (!TerminateJobObject(job, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            WaitForJobEmpty(job, 5000);
            if (parentExited) return 1;
            uint exitCode;
            if (!GetExitCodeProcess(child.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return unchecked((int)exitCode);
        } finally {
            if (assigned && job != IntPtr.Zero) TerminateJobObject(job, 1);
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (childStarted && child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (parent != null) parent.Dispose();
        }
    }

    static int Main(string[] args) {
        try { return Run(args); }
        catch (Exception error) {
            Console.Error.WriteLine("[e2e watchdog] " + error.Message);
            return 3;
        }
    }
}
