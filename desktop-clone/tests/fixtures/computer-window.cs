using System;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Text;

// An isolated native fixture. Never attach the smoke test to a user's document.
class ComputerWindow : Form {
    readonly string statePath;
    readonly TextBox draft = new TextBox { Name = "draft", AccessibleName = "Draft", Multiline = true, Left = 20, Top = 30, Width = 450, Height = 110 };
    readonly Label count = new Label { Text = "Count: 0", Left = 20, Top = 160, Width = 200 };
    int clicks, sends;
    int maxVisibleCuaTerminals;
    delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    static int VisibleCuaTerminals() {
        int count = 0;
        // Observe only the helper's console title. No user window text is saved.
        EnumWindows((window, parameter) => {
            if (!IsWindowVisible(window)) return true;
            var title = new StringBuilder(1024);
            GetWindowText(window, title, title.Capacity);
            if (title.ToString().IndexOf("cua-driver.exe", StringComparison.OrdinalIgnoreCase) >= 0) count++;
            return true;
        }, IntPtr.Zero);
        return count;
    }
    readonly Timer stateReader = new Timer { Interval = 100 };
    protected override bool ShowWithoutActivation { get { return true; } }
    ComputerWindow(string path) {
        statePath = path;
        Text = "TinyGPT Computer Fixture"; Width = 510; Height = 350;
        var increment = new Button { AccessibleName = "Increment", Text = "Increment", Left = 20, Top = 190, Width = 120 };
        var send = new Button { AccessibleName = "Send", Text = "Send", Left = 160, Top = 190, Width = 120 };
        var connect = new Button { AccessibleName = "Connect", Text = "Connect", Left = 300, Top = 190, Width = 150 };
        var connection = new Label { Text = "Disconnected", Left = 20, Top = 280, Width = 430 };
        var connectionTimer = new Timer { Interval = 1800 };
        connectionTimer.Tick += (s, e) => { connectionTimer.Stop(); connection.Text = "Connected"; };
        connect.Click += (s, e) => { connection.Text = "Connecting"; connectionTimer.Start(); };
        FormClosed += (s, e) => connectionTimer.Dispose();
        var password = new TextBox { AccessibleName = "Password", Text = "fixture-secret", UseSystemPasswordChar = true, Left = 20, Top = 240, Width = 250 };
        Controls.AddRange(new Control[] { draft, count, increment, send, password, connect, connection });
        draft.TextChanged += (s, e) => Save();
        increment.Click += (s, e) => { clicks++; count.Text = "Count: " + clicks; Save(); };
        send.Click += (s, e) => { sends++; Save(); };
        Shown += (s, e) => { if (Array.IndexOf(Environment.GetCommandLineArgs(), "--minimized") >= 0) WindowState = FormWindowState.Minimized; Save(); };
        stateReader.Tick += (s, e) => Save();
        stateReader.Start();
    }
    void Save() {
        // Atomic publication: a test reader must never see a half-written file,
        // and a short sharing conflict must not close the native fixture.
        try {
            maxVisibleCuaTerminals = Math.Max(maxVisibleCuaTerminals, VisibleCuaTerminals());
            var next = statePath + ".next";
            File.WriteAllText(next, new JavaScriptSerializer().Serialize(new { draft = draft.Text, clicks, sends, maxVisibleCuaTerminals, minimized = WindowState == FormWindowState.Minimized, windowId = Handle.ToInt64(), pid = System.Diagnostics.Process.GetCurrentProcess().Id }));
            if (File.Exists(statePath)) File.Replace(next, statePath, null);
            else File.Move(next, statePath);
        } catch (IOException) { /* The next timer tick republishes live state. */ }
    }
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles();
        var state = args.Length > 0 ? args[0] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launch-" + System.Diagnostics.Process.GetCurrentProcess().Id + ".json");
        Application.Run(new ComputerWindow(state));
    }
}
