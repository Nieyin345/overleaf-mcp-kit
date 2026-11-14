using System;
using System.Collections.Generic;
using System.IO;

namespace OverleafMcp
{
    internal static class Program
    {
        public static int Main(string[] args)
        {
            string appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
            var env = new Dictionary<string, string>
            {
                { "OL_CONFIG_PATH", Path.Combine(appDir, "config.json") },
                { "OL_DATA_DIR", appDir }
            };

            string cliSub;
            if (JobRunner.IsStdioOrCliMode(args, out cliSub))
            {
                return JobRunner.RunNodeStdioOrCli(appDir, cliSub, env);
            }

            int code = JobRunner.RunNodeLauncher(appDir, env);
            JobRunner.PauseIfError(code);
            return code;
        }
    }
}
