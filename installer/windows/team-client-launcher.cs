using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class TeamClientLauncher
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        try
        {
            string runtime = Path.Combine(root, "runtime", "electron.exe");
            string launcher = Path.Combine(root, "launcher.mjs");
            if (!File.Exists(runtime) || !File.Exists(launcher))
                throw new IOException("客户端文件不完整，请重新运行安装程序。");
            var info = new ProcessStartInfo(runtime, "\"" + launcher + "\" --root \"" + root.TrimEnd('\\') + "\"");
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardError = true;
            info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            using (var process = Process.Start(info))
            {
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0)
                    throw new IOException("客户端启动失败。\r\n" + error);
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message + "\r\n日志目录：" + Path.Combine(root, "client-state", "logs"),
                "林视客户端", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
