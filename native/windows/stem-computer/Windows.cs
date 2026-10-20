using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace StemComputer
{
    /// One line of `list-windows`.
    class WindowInfo
    {
        public IntPtr Hwnd;
        public uint Pid;
        public string App;
        public string Exe;
        public string Title;
        public RECT Bounds;
        public bool Minimized;
        /// On another virtual desktop (the shell cloaks it).
        public bool OtherDesktop;
        public bool Foreground;
        /// Built on Chromium (Electron apps, Chrome-family browsers).
        public bool Chromium;
        public long Id { get { return Hwnd.ToInt64(); } }
    }

    static class Windows
    {
        /// The process that started this helper (Stem): its windows are never listed.
        public static uint ParentPid;

        static readonly Dictionary<uint, string[]> processNames = new Dictionary<uint, string[]>();

        /// A process's name as a person would say it (its file description,
        /// "Microsoft Edge"), and its executable path.
        static string[] ProcessName(uint pid)
        {
            string[] known;
            if (processNames.TryGetValue(pid, out known)) return known;
            string name = "pid " + pid, exe = "";
            try
            {
                using (var p = Process.GetProcessById((int)pid))
                {
                    name = p.ProcessName;
                    try
                    {
                        exe = p.MainModule.FileName;
                        var desc = p.MainModule.FileVersionInfo.FileDescription;
                        if (!string.IsNullOrWhiteSpace(desc)) name = desc.Trim();
                    }
                    catch (Exception)
                    {
                        // An elevated or protected process: its name is all we may read.
                    }
                }
            }
            catch (Exception)
            {
                // Gone already.
            }
            known = new[] { name, exe };
            processNames[pid] = known;
            return known;
        }

        /// Top-level windows a person would call a window: visible, unowned or
        /// app-styled, not a tool window, a real size, not ours.
        public static List<WindowInfo> List()
        {
            var fg = Native.GetForegroundWindow();
            uint ours = (uint)Process.GetCurrentProcess().Id;
            var outList = new List<WindowInfo>();
            Native.EnumWindows((hwnd, _) =>
            {
                if (!Native.IsWindowVisible(hwnd)) return true;
                int ex = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
                if ((ex & Native.WS_EX_TOOLWINDOW) != 0) return true;
                uint pid;
                Native.GetWindowThreadProcessId(hwnd, out pid);
                if (pid == ours || pid == ParentPid) return true;
                string title = Native.WindowText(hwnd);
                string cls = Native.ClassName(hwnd);
                // The desktop and the taskbar are the shell, not windows.
                if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return true;
                bool minimized = Native.IsIconic(hwnd);
                var frame = Native.Frame(hwnd);
                if (!minimized && (frame.Width < 50 || frame.Height < 50)) return true;
                bool cloaked = Native.Cloaked(hwnd);
                // A cloaked window with no title is a suspended Store app's frame, not a window.
                if (cloaked && title.Length == 0) return true;
                var names = ProcessName(pid);
                outList.Add(new WindowInfo
                {
                    Hwnd = hwnd,
                    Pid = pid,
                    App = names[0],
                    Exe = names[1],
                    Title = title,
                    Bounds = frame,
                    Minimized = minimized,
                    OtherDesktop = cloaked,
                    Foreground = hwnd == fg,
                    Chromium = cls == "Chrome_WidgetWin_1"
                });
                return true;
            }, IntPtr.Zero);
            return outList;
        }

        public static string Describe(List<WindowInfo> windows)
        {
            if (windows.Count == 0) return "No windows are open.";
            var lines = new List<string> { "Windows (id  app  \"title\"  where  size). select_window by window_id, or by app (+ title)." };
            // EnumWindows walks the z-order, top first: the order a person sees them in.
            foreach (var w in windows.OrderBy(w => w.Foreground ? 0 : 1).ThenBy(w => w.Minimized || w.OtherDesktop ? 1 : 0))
            {
                string place = w.Minimized ? "minimized" : w.OtherDesktop ? "other desktop" : "on screen (maybe covered)";
                string title = w.Title.Length == 0 ? "(untitled)" : "\"" + w.Title + "\"";
                string hint = w.Minimized ? "  · minimized: cannot be pictured until restored" : "";
                lines.Add(w.Id + "  " + w.App + "  " + title + "  " + place + "  " + w.Bounds.Width + "x" + w.Bounds.Height + hint + (w.Foreground ? "  ← frontmost" : ""));
            }
            return string.Join("\n", lines);
        }

        public static WindowInfo Find(long? windowId, string app, string title)
        {
            var all = List();
            if (windowId.HasValue)
            {
                var hit = all.FirstOrDefault(w => w.Id == windowId.Value);
                if (hit == null) throw new HelperError("No window " + windowId.Value + " is open now. Run list_windows again.");
                return hit;
            }
            if (string.IsNullOrEmpty(app)) throw new HelperError("select_window needs window_id, or app (and optionally title).");
            string needle = app.ToLowerInvariant();
            Func<WindowInfo, string> exeName = w => System.IO.Path.GetFileNameWithoutExtension(w.Exe ?? "").ToLowerInvariant();
            var candidates = all.Where(w => w.App.ToLowerInvariant() == needle || exeName(w) == needle).ToList();
            if (candidates.Count == 0) candidates = all.Where(w => w.App.ToLowerInvariant().Contains(needle) || exeName(w).Contains(needle)).ToList();
            if (candidates.Count == 0)
            {
                var names = all.Select(w => w.App).Distinct().OrderBy(n => n);
                throw new HelperError("No running app called \"" + app + "\" has a window. Apps with windows: " + string.Join(", ", names) + ".");
            }
            if (!string.IsNullOrEmpty(title))
            {
                string t = title.ToLowerInvariant();
                candidates = candidates.Where(w => w.Title.ToLowerInvariant().Contains(t)).ToList();
                if (candidates.Count == 0) throw new HelperError(app + " has no window whose title contains \"" + title + "\". Run list_windows to see its windows.");
            }
            // The app's front window: not minimized, on this desktop, then the largest.
            return candidates
                .OrderBy(w => w.Minimized ? 1 : 0)
                .ThenBy(w => w.OtherDesktop ? 1 : 0)
                .ThenByDescending(w => (long)w.Bounds.Width * w.Bounds.Height)
                .First();
        }

        /// A process's windows as listed, for "the app opened a new window".
        public static List<WindowInfo> AppWindows(uint pid)
        {
            return List().Where(w => w.Pid == pid).ToList();
        }

        public static string Brief(WindowInfo w)
        {
            return w.Id + " " + (w.Title.Length == 0 ? "(untitled)" : "\"" + w.Title + "\"") + " " + w.Bounds.Width + "x" + w.Bounds.Height;
        }
    }
}
