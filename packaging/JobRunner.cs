using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace OverleafMcp
{
    internal static class JobRunner
    {
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
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
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr hJob,
            int JobObjectInfoClass,
            IntPtr lpJobObjectInfo,
            uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        private static IntPtr CreateKillOnCloseJob()
        {
            IntPtr hJob = CreateJobObject(IntPtr.Zero, null);
            if (hJob == IntPtr.Zero) return IntPtr.Zero;

            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, ptr, (uint)size);
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
            return hJob;
        }

        public static bool IsStdioOrCliMode(string[] args, out string cliSubcommand)
        {
            cliSubcommand = null;
            if (args == null) return false;
            foreach (string raw in args)
            {
                if (raw == "--stdio") return true;
                if (raw == "login" || raw == "logout" || raw == "status")
                {
                    cliSubcommand = raw;
                    return true;
                }
            }
            return false;
        }

        public static int RunNodeLauncher(string appDir, Dictionary<string, string> extraEnv)
        {
            return RunNodeScript(appDir, "launcher.mjs", null, extraEnv, false);
        }

        public static int RunNodeStdioOrCli(string appDir, string cliSubcommand, Dictionary<string, string> extraEnv)
        {
            string args = string.IsNullOrEmpty(cliSubcommand)
                ? "server/index.js"
                : ("server/index.js " + cliSubcommand);
            return RunNodeScript(appDir, "server/index.js", args, extraEnv, true);
        }

        private static int RunNodeScript(
            string appDir,
            string requiredRelPath,
            string explicitArguments,
            Dictionary<string, string> extraEnv,
            bool stdioMode)
        {
            if (!stdioMode)
            {
                try
                {
                    Console.OutputEncoding = Encoding.UTF8;
                    Console.InputEncoding = Encoding.UTF8;
                    Console.Title = "Overleaf MCP Gateway";
                }
                catch { }
            }

            string nodeExe = Path.Combine(appDir, "node", "node.exe");
            if (!File.Exists(nodeExe))
            {
                nodeExe = "node";
            }
            string targetFile = Path.Combine(appDir, requiredRelPath.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(targetFile))
            {
                Console.Error.WriteLine("[ERROR] Missing " + requiredRelPath + " in: " + appDir);
                return 1;
            }

            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = explicitArguments ?? requiredRelPath,
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = false
            };

            if (extraEnv != null)
            {
                foreach (var kv in extraEnv)
                {
                    psi.EnvironmentVariables[kv.Key] = kv.Value;
                }
            }

            IntPtr hJob = CreateKillOnCloseJob();
            try
            {
                using (var proc = Process.Start(psi))
                {
                    if (proc == null)
                    {
                        Console.Error.WriteLine("[ERROR] Failed to start node process.");
                        return 1;
                    }

                    if (hJob != IntPtr.Zero)
                    {
                        AssignProcessToJobObject(hJob, proc.Handle);
                    }

                    Console.CancelKeyPress += (sender, e) =>
                    {
                        e.Cancel = true;
                        try
                        {
                            if (!proc.HasExited)
                            {
                                proc.WaitForExit(3000);
                            }
                        }
                        catch { }
                    };

                    proc.WaitForExit();
                    return proc.ExitCode;
                }
            }
            finally
            {
                if (hJob != IntPtr.Zero)
                {
                    CloseHandle(hJob);
                }
            }
        }

        public static void PauseIfError(int exitCode)
        {
            if (exitCode != 0)
            {
                Console.WriteLine();
                Console.WriteLine("Exited with code " + exitCode + ". Press any key to close...");
                try { Console.ReadKey(true); } catch { }
            }
        }
    }
}
