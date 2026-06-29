using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class CreativeStudioLauncher
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    const uint MB_ICONERROR = 0x00000010;
    const uint MB_OK = 0x00000000;

    static void ShowError(string message)
    {
        MessageBoxW(IntPtr.Zero, message, "Creative Studio", MB_ICONERROR | MB_OK);
    }

    static void Main(string[] args)
    {
        try
        {
            Run();
        }
        catch (Exception ex)
        {
            ShowError("启动失败：\n" + ex.Message);
            Environment.Exit(1);
        }
    }

    static void Run()
    {
        // ── Port ──
        string portEnv = Environment.GetEnvironmentVariable("CREATIVE_STUDIO_PORT");
        if (string.IsNullOrWhiteSpace(portEnv)) portEnv = "3000";
        int port;
        if (!int.TryParse(portEnv, out port) || port < 1 || port > 65535)
        {
            ShowError("端口号无效：" + portEnv + "\nCREATIVE_STUDIO_PORT 需为 1–65535 之间的整数。");
            Environment.Exit(1);
        }

        // ── Detect layout (installed vs dev) ──
        string serverJs, nodeExe, root, launcherHtml, storageBase;
        DetectLayout(out serverJs, out nodeExe, out root, out launcherHtml, out storageBase);

        string logDir  = Path.Combine(storageBase, "storage", "logs");
        string runDir  = Path.Combine(storageBase, "storage", "run");
        string stdoutLog = Path.Combine(logDir, "server.out.log");
        string stderrLog = Path.Combine(logDir, "server.err.log");
        string pidFile   = Path.Combine(runDir,  "server.pid");

        // ── Already running? Open browser and exit ──
        if (IsPortListening(port))
        {
            bool isWebServer = false;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/");
                req.Timeout = 2000;
                req.AllowAutoRedirect = false;
                using (req.GetResponse()) { isWebServer = true; }
            }
            catch (WebException ex)
            {
                if (ex.Response != null) isWebServer = true; // got an HTTP response (even 4xx)
            }
            catch { }

            if (isWebServer)
            {
                OpenBrowser(launcherHtml, port);
                return;
            }
            ShowError("端口 " + port + " 已被其他程序占用，无法启动 Creative Studio。\n请设置 CREATIVE_STUDIO_PORT 更换端口，或关闭占用该端口的程序后重试。");
            Environment.Exit(1);
        }

        // ── Create storage directories ──
        try
        {
            Directory.CreateDirectory(logDir);
            Directory.CreateDirectory(runDir);
        }
        catch (Exception ex)
        {
            ShowError("无法创建存储目录：\n" + logDir + "\n\n错误：" + ex.Message);
            Environment.Exit(1);
        }

        // ── Launch node via cmd.exe wrapper (logs survive launcher exit) ──
        // Escape % so cmd.exe doesn't expand env-var references inside paths.
        string cmdNode    = nodeExe.Replace("%", "%%");
        string cmdStdout  = stdoutLog.Replace("%", "%%");
        string cmdStderr  = stderrLog.Replace("%", "%%");

        string cmdArgs = string.Format(
            "/c \"\"{0}\" server.js >> \"{1}\" 2>> \"{2}\"\"",
            cmdNode, cmdStdout, cmdStderr);

        var psi = new ProcessStartInfo("cmd.exe", cmdArgs)
        {
            UseShellExecute  = false,
            CreateNoWindow   = true,
            WorkingDirectory = root
        };
        psi.EnvironmentVariables["PORT"]      = port.ToString();
        psi.EnvironmentVariables["HOSTNAME"]  = "127.0.0.1";
        psi.EnvironmentVariables["NODE_ENV"]  = "production";
        // Overrides process.cwd() for data/storage paths (server.js does process.chdir(__dirname)
        // which would otherwise point cwd at .next/standalone in dev mode).
        psi.EnvironmentVariables["CREATIVE_STUDIO_DATA_ROOT"] = storageBase;

        var wrapper = Process.Start(psi);
        if (wrapper == null)
        {
            ShowError("无法启动 Node.js 服务进程，请检查 " + nodeExe + " 是否可执行。");
            Environment.Exit(1);
        }

        // ── Brief crash-detection window (1.5 s) ──
        // If node exits immediately (bad binary, missing file) we catch it here.
        // Otherwise we open the browser and let launcher.html handle the "still starting" UI.
        Thread.Sleep(1500);
        if (wrapper.HasExited)
        {
            ShowError("Creative Studio 服务启动失败，进程已意外退出。\n请查看日志：\n" + stderrLog);
            Environment.Exit(1);
        }

        // ── Write PID file (best-effort) ──
        WritePidFile(pidFile, nodeExe, wrapper.Id);

        // ── Open brand launch page immediately; launcher.html polls for readiness ──
        OpenBrowser(launcherHtml, port);
    }

    // ── Layout detection ──

    static void DetectLayout(
        out string serverJs,
        out string nodeExe,
        out string root,
        out string launcherHtml,
        out string storageBase)
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');

        // Installed layout: server.js and runtime\node.exe alongside the EXE
        string instServerJs = Path.Combine(exeDir, "server.js");
        string instNodeExe  = Path.Combine(exeDir, "runtime", "node.exe");

        if (File.Exists(instServerJs) && File.Exists(instNodeExe))
        {
            serverJs    = instServerJs;
            nodeExe     = instNodeExe;
            root        = exeDir;
            launcherHtml = Path.Combine(exeDir, "launcher.html");
            storageBase  = exeDir;
            return;
        }

        // Dev layout: EXE is at project root; standalone is in .next\standalone
        string standaloneDir   = Path.Combine(exeDir, ".next", "standalone");
        string devServerJs     = Path.Combine(standaloneDir, "server.js");

        if (File.Exists(devServerJs))
        {
            string devNode = FindNodeInCache(Path.Combine(exeDir, ".cache", "windows-installer"));
            if (devNode == null)
                throw new Exception(
                    "开发模式：找不到 Node.js 运行时。\n" +
                    "请确保已运行 npm run build 且 .cache\\windows-installer 目录存在。\n" +
                    "查找路径：" + Path.Combine(exeDir, ".cache", "windows-installer"));

            serverJs     = devServerJs;
            nodeExe      = devNode;
            root         = standaloneDir;
            launcherHtml = Path.Combine(exeDir, "launcher.html");
            storageBase  = exeDir;   // logs → project-root\storage\logs
            return;
        }

        throw new Exception(
            "找不到服务端文件，请重新安装 Creative Studio 或在项目根目录运行 npm run build。\n\n" +
            "已查找：\n  " + instServerJs + "\n  " + devServerJs);
    }

    static string FindNodeInCache(string cacheDir)
    {
        if (!Directory.Exists(cacheDir)) return null;
        foreach (string sub in Directory.GetDirectories(cacheDir, "node-v*-win-x64"))
        {
            string candidate = Path.Combine(sub, "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    // ── Helpers ──

    static bool IsPortListening(int port)
    {
        try
        {
            using (var tcp = new TcpClient())
            {
                tcp.Connect("127.0.0.1", port);
                return true;
            }
        }
        catch (SocketException) { return false; }
    }

    static void WritePidFile(string pidFile, string nodeExe, int fallbackPid)
    {
        int pid = fallbackPid;
        try
        {
            foreach (var proc in Process.GetProcessesByName("node"))
            {
                try
                {
                    if (proc.MainModule.FileName.Equals(nodeExe, StringComparison.OrdinalIgnoreCase))
                    {
                        pid = proc.Id;
                        break;
                    }
                }
                catch { }
                finally { proc.Dispose(); }
            }
        }
        catch { }

        try { File.WriteAllText(pidFile, pid.ToString(), Encoding.UTF8); }
        catch { }
    }

    static void OpenBrowser(string launcherHtmlPath, int port)
    {
        string url;
        if (File.Exists(launcherHtmlPath))
        {
            // Uri handles Windows drive-letter paths; escape # (NTFS allows it in dir names).
            string escaped = launcherHtmlPath.Replace("#", "%23");
            url = new Uri(escaped).AbsoluteUri + "?port=" + port;
        }
        else
        {
            url = "http://127.0.0.1:" + port;
        }
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
