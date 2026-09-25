using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal static class Setup
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool unattended = args.Length == 1 && args[0].StartsWith("/extract:", StringComparison.OrdinalIgnoreCase);
        string destination;
        if (unattended) destination = Path.GetFullPath(args[0].Substring(9));
        else
        {
            Application.EnableVisualStyles();
            using (var picker = new FolderBrowserDialog { Description = "选择 PnX Platform 的安装位置" })
            {
                if (picker.ShowDialog() != DialogResult.OK) return 1;
                destination = Path.Combine(picker.SelectedPath, "PnX Platform");
            }
        }

        Form progress = null;
        try
        {
            Directory.CreateDirectory(destination);
            using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("PnXPayload.zip"))
            {
                if (payload == null) throw new IOException("安装包缺少应用数据");
                using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
                {
                    ProgressBar bar = null;
                    if (!unattended)
                    {
                        progress = new Form { Text = "安装 PnX Platform", Width = 450, Height = 130, StartPosition = FormStartPosition.CenterScreen, ControlBox = false };
                        progress.Controls.Add(new Label { Text = "正在解压到 " + destination, Left = 14, Top = 12, Width = 410, AutoEllipsis = true });
                        bar = new ProgressBar { Left = 14, Top = 45, Width = 410, Height = 20, Maximum = archive.Entries.Count };
                        progress.Controls.Add(bar);
                        progress.Show();
                    }
                    string root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                    foreach (var entry in archive.Entries)
                    {
                        string target = Path.GetFullPath(Path.Combine(destination, entry.FullName));
                        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new IOException("安装包包含非法路径");
                        if (entry.Name.Length == 0) Directory.CreateDirectory(target);
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(target));
                            using (var input = entry.Open())
                            using (var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None)) input.CopyTo(output);
                        }
                        if (bar != null) { bar.Value++; Application.DoEvents(); }
                    }
                }
            }
            if (progress != null) progress.Close();
            string exe = Path.Combine(destination, "PnX-Platform.exe");
            if (!File.Exists(exe)) throw new IOException("安装包缺少 PnX-Platform.exe");
            if (!unattended)
            {
                MessageBox.Show("安装完成：" + destination, "PnX Platform", MessageBoxButtons.OK, MessageBoxIcon.Information);
                System.Diagnostics.Process.Start(exe);
            }
            return 0;
        }
        catch (Exception error)
        {
            if (progress != null) progress.Close();
            if (!unattended) MessageBox.Show(error.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            else Console.Error.WriteLine(error);
            return 2;
        }
    }
}
