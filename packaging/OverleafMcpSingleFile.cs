using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

namespace OverleafMcp
{
    internal static class Program
    {
        private const string BundleVersion = "__BUNDLE_VERSION__";

        private static readonly string DefaultConfig = "{\n" +
            "  \"PORT\": 0,\n" +
            "  \"HOSTNAME\": \"\",\n" +
            "  \"TUNNEL_MODE\": \"auto\",\n" +
            "  \"AUTH_MODE\": \"auto\",\n" +
            "  \"APIKEY\": \"\",\n" +
            "  \"PROMPT_ON_START\": true,\n" +
            "  \"AUTO_LOGIN_ON_START\": true,\n" +
            "  \"COOKIE_TTL_DAYS\": 30,\n" +
            "  \"COOKIE_KEEPALIVE_MIN\": 180\n" +
            "}\n";

        public static int Main(string[] args)
        {
            string cliSub;
            bool stdioOrCli = JobRunner.IsStdioOrCliMode(args, out cliSub);
            bool pureStdio = stdioOrCli && string.IsNullOrEmpty(cliSub);
            if (!pureStdio)
            {
                try
                {
                    Console.OutputEncoding = Encoding.UTF8;
                    Console.InputEncoding = Encoding.UTF8;
                    Console.Title = "Overleaf MCP Gateway";
                }
                catch { }
            }

            TextWriter msgOut = pureStdio ? Console.Error : Console.Out;

            string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
            string localCfg = Path.Combine(exeDir, "config.json");
            string dataDir = File.Exists(localCfg)
                ? exeDir
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Overleaf-MCP");

            string appDir = Path.Combine(dataDir, "runtime-" + BundleVersion);
            string readyMarker = Path.Combine(appDir, ".bundle-ready");

            try
            {
                Directory.CreateDirectory(dataDir);

                string cfgPath = Path.Combine(dataDir, "config.json");
                if (!File.Exists(cfgPath))
                {
                    File.WriteAllText(cfgPath, DefaultConfig, new UTF8Encoding(false));
                }

                bool needsExtract = !File.Exists(readyMarker);
                if (needsExtract)
                {
                    msgOut.WriteLine("=========================================");
                    msgOut.WriteLine("  First-run setup: extracting runtime...");
                    msgOut.WriteLine("  Target: " + appDir);
                    msgOut.WriteLine("=========================================");

                    string tmpExtract = Path.Combine(dataDir, "extract-" + BundleVersion + "-" + Guid.NewGuid().ToString("N").Substring(0, 8));
                    Directory.CreateDirectory(tmpExtract);

                    string tmpZip = Path.Combine(dataDir, "payload-" + BundleVersion + ".zip");
                    using (Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                    {
                        if (res == null)
                        {
                            Console.Error.WriteLine("[ERROR] Embedded payload.zip resource missing.");
                            if (!stdioOrCli) JobRunner.PauseIfError(1);
                            return 1;
                        }
                        using (FileStream fs = File.Create(tmpZip))
                        {
                            res.CopyTo(fs);
                        }
                    }

                    ZipFile.ExtractToDirectory(tmpZip, tmpExtract);
                    File.Delete(tmpZip);

                    if (Directory.Exists(appDir))
                    {
                        try { Directory.Delete(appDir, true); } catch { }
                    }
                    if (!Directory.Exists(appDir))
                    {
                        Directory.Move(tmpExtract, appDir);
                    }
                    else
                    {
                        try { Directory.Delete(tmpExtract, true); } catch { }
                    }
                    File.WriteAllText(readyMarker, BundleVersion, new UTF8Encoding(false));
                    CleanupOldRuntimes(dataDir, appDir);
                    msgOut.WriteLine("[OK] Runtime ready.");
                    msgOut.WriteLine();
                }

                var env = new Dictionary<string, string>
                {
                    { "OL_CONFIG_PATH", cfgPath },
                    { "OL_DATA_DIR", dataDir }
                };

                if (stdioOrCli)
                {
                    return JobRunner.RunNodeStdioOrCli(appDir, cliSub, env);
                }

                int code = JobRunner.RunNodeLauncher(appDir, env);
                JobRunner.PauseIfError(code);
                return code;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[ERROR] " + ex.ToString());
                if (!stdioOrCli) JobRunner.PauseIfError(1);
                return 1;
            }
        }
        private static void CleanupOldRuntimes(string dataDir, string currentAppDir)
        {
            try
            {
                string currentName = Path.GetFileName(currentAppDir);
                foreach (string dir in Directory.GetDirectories(dataDir))
                {
                    string name = Path.GetFileName(dir);
                    if (name == currentName) continue;
                    if (name == "app" || name.StartsWith("runtime-") || name.StartsWith("extract-") || name == "app_extract_tmp")
                    {
                        try { Directory.Delete(dir, true); } catch { /* in use by older instance */ }
                    }
                }
            }
            catch { }
        }
    }
}
