#Requires -Version 5.1
<#
.SYNOPSIS
  Internal launcher used by start.ps1. Assigns THIS PowerShell process to a
  Windows Job Object configured with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, then
  runs the command in $env:LOCUS_CMD (from directory $env:LOCUS_DIR).

  Because child processes inherit the job, closing this window - by Ctrl+C, by
  the X button, or by Stop-Process - terminates the whole process tree. This is
  what lets us run `uvicorn --reload` (and vite) without leaking orphaned
  reloader/worker/node processes.
#>

if ($env:LOCUS_TITLE) { $host.UI.RawUI.WindowTitle = $env:LOCUS_TITLE }

Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class MasJobGuard {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [StructLayout(LayoutKind.Sequential)]
    struct BASIC_LIMIT {
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
        public ulong r, w, o, rt, wt, ot;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct EXTENDED_LIMIT {
        public BASIC_LIMIT BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    static IntPtr _job; // kept alive for the life of the process

    public static void Enable() {
        _job = CreateJobObject(IntPtr.Zero, null);
        if (_job == IntPtr.Zero) throw new Exception("CreateJobObject failed");
        var info = new EXTENDED_LIMIT();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int len = Marshal.SizeOf(info);
        IntPtr p = Marshal.AllocHGlobal(len);
        try {
            Marshal.StructureToPtr(info, p, false);
            if (!SetInformationJobObject(_job, JobObjectExtendedLimitInformation, p, (uint)len))
                throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
        } finally {
            Marshal.FreeHGlobal(p);
        }
        if (!AssignProcessToJobObject(_job, Process.GetCurrentProcess().Handle))
            throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
    }
}
'@

try {
    [MasJobGuard]::Enable()
} catch {
    Write-Warning "Process-tree guard unavailable ($($_.Exception.Message)). Closing this window with the X button may leave child processes; press Ctrl+C to stop cleanly."
}

if (-not $env:LOCUS_CMD) { Write-Host "Nothing to run (LOCUS_CMD not set)."; return }
Set-Location $env:LOCUS_DIR
Invoke-Expression $env:LOCUS_CMD
