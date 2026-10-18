using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

namespace StemComputer
{
    // UI Automation: how a run reaches a window that is not in front — the
    // Windows twin of the Mac helper's AX.swift. Where screen mode moves the
    // real mouse, window mode asks the window's automation tree: press this
    // button, set that field's value. Coverage follows the app's own tree:
    // Win32, WinForms, WPF, UWP and Chromium answer; canvases and games are blank.
    class Uia
    {
        public readonly IntPtr Hwnd;
        public readonly uint Pid;
        AutomationElement root;
        readonly Dictionary<int, AutomationElement> nodes = new Dictionary<int, AutomationElement>();
        bool snapshotTaken;
        public int LastSnapshotCount;
        const int MaxNodes = 400;

        static readonly CacheRequest cache = MakeCache();

        static CacheRequest MakeCache()
        {
            var cr = new CacheRequest();
            cr.AutomationElementMode = AutomationElementMode.Full;
            foreach (var p in new AutomationProperty[] {
                AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty,
                AutomationElement.IsEnabledProperty, AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsOffscreenProperty,
                AutomationElement.IsPasswordProperty, AutomationElement.HelpTextProperty, AutomationElement.NativeWindowHandleProperty,
                AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty,
                AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
                AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsScrollPatternAvailableProperty,
                ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty })
            {
                cr.Add(p);
            }
            cr.TreeScope = TreeScope.Element;
            return cr;
        }

        public Uia(IntPtr hwnd, uint pid)
        {
            Hwnd = hwnd;
            Pid = pid;
        }

        AutomationElement Root()
        {
            if (root != null) return root;
            try
            {
                root = AutomationElement.FromHandle(Hwnd);
            }
            catch (Exception e)
            {
                throw new HelperError("This window exposes no UI Automation tree (" + e.Message + "); clear the window (select_window with no arguments) and use the screen.");
            }
            return root;
        }

        static List<AutomationElement> Children(AutomationElement el)
        {
            try
            {
                using (cache.Activate())
                {
                    return el.FindAll(TreeScope.Children, Condition.TrueCondition).Cast<AutomationElement>().ToList();
                }
            }
            catch (Exception)
            {
                // The element went away, or the app stopped answering.
                return new List<AutomationElement>();
            }
        }

        static T Cached<T>(AutomationElement el, AutomationProperty p, T fallback)
        {
            try
            {
                object v = el.GetCachedPropertyValue(p, true);
                if (v == AutomationElement.NotSupported || v == null) return fallback;
                return (T)v;
            }
            catch (Exception)
            {
                try
                {
                    object v = el.GetCurrentPropertyValue(p, true);
                    if (v == AutomationElement.NotSupported || v == null) return fallback;
                    return (T)v;
                }
                catch (Exception)
                {
                    return fallback;
                }
            }
        }

        static string Clip(string s, int limit = 80)
        {
            if (s == null) return null;
            s = s.Replace("\r\n", "⏎").Replace("\n", "⏎").Trim();
            if (s.Length == 0) return null;
            return s.Length > limit ? s.Substring(0, limit - 1) + "…" : s;
        }

        static readonly Dictionary<string, string> roleNames = new Dictionary<string, string> {
            { "Button", "button" }, { "SplitButton", "menubutton" }, { "RadioButton", "radio" }, { "CheckBox", "checkbox" },
            { "Edit", "textfield" }, { "Document", "document" }, { "Text", "text" }, { "Hyperlink", "link" }, { "Image", "image" },
            { "MenuItem", "menuitem" }, { "Menu", "menu" }, { "MenuBar", "menubar" }, { "List", "list" }, { "ListItem", "row" },
            { "DataGrid", "table" }, { "DataItem", "row" }, { "Table", "table" }, { "Tree", "outline" }, { "TreeItem", "row" },
            { "Tab", "tabs" }, { "TabItem", "tab" }, { "ToolBar", "toolbar" }, { "Slider", "slider" }, { "ComboBox", "combobox" },
            { "Group", "group" }, { "Pane", "pane" }, { "Window", "window" }, { "ScrollBar", "scrollbar" }, { "Header", "header" },
            { "HeaderItem", "column" }, { "StatusBar", "statusbar" }, { "ProgressBar", "progress" }, { "Spinner", "stepper" },
            { "TitleBar", "titlebar" }, { "Separator", "separator" }, { "Calendar", "calendar" }, { "Custom", "custom" },
            { "Thumb", "thumb" }, { "ToolTip", "tooltip" }, { "SemanticZoom", "zoom" }, { "AppBar", "toolbar" }
        };

        static readonly HashSet<string> structural = new HashSet<string> { "Group", "Pane", "Custom", "List", "Table", "DataGrid", "Tree", "ToolBar", "Tab", "Document", "Header", "TitleBar", "Separator", "ScrollBar", "Thumb" };

        static string RoleOf(AutomationElement el)
        {
            var ct = Cached<ControlType>(el, AutomationElement.ControlTypeProperty, ControlType.Custom);
            string name = ct.ProgrammaticName.Replace("ControlType.", "");
            return name;
        }

        /// The window's controls, one line each with a fresh id, positioned in
        /// pixels of the current window picture (`toPixel`).
        public string Snapshot(int maxDepth, RECT window, Func<int, int, int[]> toPixel, double pixelsPerShotPixel)
        {
            var top = Root();
            nodes.Clear();
            snapshotTaken = true;
            var lines = new List<string>();
            int next = 0;
            bool truncated = false;
            var visible = new Rect(window.Left - 2, window.Top - 2, window.Width + 4, window.Height + 4);
            var clock = Stopwatch.StartNew();

            Action<AutomationElement, int, int> walk = null;
            walk = (el, depth, indent) =>
            {
                if (nodes.Count >= MaxNodes || clock.ElapsedMilliseconds > 8000) { truncated = true; return; }
                string role = RoleOf(el);
                var frame = Cached<Rect>(el, AutomationElement.BoundingRectangleProperty, Rect.Empty);
                bool hasFrame = !frame.IsEmpty && frame.Width > 0 && frame.Height > 0;
                if (hasFrame && !frame.IntersectsWith(visible)) return;
                string label = Clip(Cached<string>(el, AutomationElement.NameProperty, null));
                string help = Clip(Cached<string>(el, AutomationElement.HelpTextProperty, null));
                bool password = Cached<bool>(el, AutomationElement.IsPasswordProperty, false);
                bool valueAvailable = Cached<bool>(el, AutomationElement.IsValuePatternAvailableProperty, false);
                string value = valueAvailable && !password ? Clip(Cached<string>(el, ValuePattern.ValueProperty, null)) : null;
                bool readOnly = Cached<bool>(el, ValuePattern.IsReadOnlyProperty, true);
                bool focused = Cached<bool>(el, AutomationElement.HasKeyboardFocusProperty, false);
                bool enabled = Cached<bool>(el, AutomationElement.IsEnabledProperty, true);
                bool pressable = Cached<bool>(el, AutomationElement.IsInvokePatternAvailableProperty, false)
                    || Cached<bool>(el, AutomationElement.IsTogglePatternAvailableProperty, false)
                    || Cached<bool>(el, AutomationElement.IsSelectionItemPatternAvailableProperty, false)
                    || Cached<bool>(el, AutomationElement.IsExpandCollapsePatternAvailableProperty, false);
                bool isStructure = structural.Contains(role) && label == null && !focused;
                if (!isStructure && hasFrame && role != "Window")
                {
                    int id = next++;
                    nodes[id] = el;
                    var caps = new List<string>();
                    if (pressable) caps.Add("press");
                    caps.Add("menu");
                    if (valueAvailable && !readOnly) caps.Add("setvalue");
                    string roleName;
                    if (!roleNames.TryGetValue(role, out roleName)) roleName = role.ToLowerInvariant();
                    if (password) roleName = "password";
                    string line = new string(' ', Math.Min(indent, 12)) + id + "  " + roleName;
                    if (label != null) line += " \"" + label + "\"";
                    else if (help != null) line += " \"" + help + "\"";
                    if (value != null && value != label && role != "Text") line += " = \"" + value + "\"";
                    if (focused) line += " focused";
                    if (!enabled) line += " disabled";
                    line += "  [" + string.Join(",", caps) + "]";
                    var xy = toPixel((int)frame.X, (int)frame.Y);
                    line += "  (" + xy[0] + "," + xy[1] + " " + (int)Math.Round(frame.Width / pixelsPerShotPixel) + "x" + (int)Math.Round(frame.Height / pixelsPerShotPixel) + ")";
                    lines.Add(line);
                }
                if (depth >= maxDepth) return;
                foreach (var child in Children(el)) walk(child, depth + 1, isStructure ? indent : indent + 1);
            };

            using (cache.Activate())
            {
                try { top = top.GetUpdatedCache(cache); } catch (Exception) { }
            }
            walk(top, 0, 0);
            // A Chromium window builds its tree on the first question and fills
            // it over a second or two: look again before believing a bare one.
            int waited = 0;
            while (lines.Count < 12 && !truncated && waited < 6)
            {
                Thread.Sleep(500);
                waited++;
                nodes.Clear(); lines.Clear(); next = 0;
                walk(top, 0, 0);
            }
            LastSnapshotCount = lines.Count;
            string head = "Controls of this window (id  role \"label\" [what it can do]  (x,y wxh in window pixels)). Ids are valid until the next snapshot.";
            if (truncated) head += " Only the first " + nodes.Count + " controls are listed; lower `depth` or scroll to see others.";
            if (lines.Count == 0) return head + "\n(none exposed — this window may be a canvas; act on it in screen mode)";
            return head + "\n" + string.Join("\n", lines);
        }

        AutomationElement Node(int id)
        {
            if (!snapshotTaken) throw new HelperError("Take a snapshot first; element ids come from it.");
            AutomationElement el;
            if (!nodes.TryGetValue(id, out el)) throw new HelperError("No element " + id + " in the last snapshot. Take a new snapshot and use one of its ids.");
            return el;
        }

        static object Pattern(AutomationElement el, AutomationPattern p)
        {
            object pattern;
            try
            {
                return el.TryGetCurrentPattern(p, out pattern) ? pattern : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// The element's own action (invoke, toggle, select, expand), or its nearest ancestor's.
        bool Press(AutomationElement el)
        {
            var walker = TreeWalker.ControlViewWalker;
            var at = el;
            for (int i = 0; i < 4 && at != null; i++)
            {
                try
                {
                    var invoke = Pattern(at, InvokePattern.Pattern) as InvokePattern;
                    if (invoke != null) { invoke.Invoke(); return true; }
                    var toggle = Pattern(at, TogglePattern.Pattern) as TogglePattern;
                    if (toggle != null) { toggle.Toggle(); return true; }
                    var select = Pattern(at, SelectionItemPattern.Pattern) as SelectionItemPattern;
                    if (select != null) { select.Select(); return true; }
                    var expand = Pattern(at, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
                    if (expand != null)
                    {
                        if (expand.Current.ExpandCollapseState == ExpandCollapseState.Expanded) expand.Collapse(); else expand.Expand();
                        return true;
                    }
                }
                catch (ElementNotAvailableException)
                {
                    throw new HelperError("The control is gone; take a new snapshot.");
                }
                catch (InvalidOperationException)
                {
                    // Disabled, or the app refused: try the parent.
                }
                if (at == Root()) break;
                try { at = walker.GetParent(at); } catch (Exception) { break; }
            }
            return false;
        }

        static Rect Frame(AutomationElement el)
        {
            try { return el.Current.BoundingRectangle; } catch (Exception) { return Rect.Empty; }
        }

        /// The child window under a screen point (deepest), to post a click to.
        IntPtr WindowAt(POINT screen)
        {
            IntPtr at = Hwnd;
            for (int i = 0; i < 16; i++)
            {
                var client = screen;
                Native.ScreenToClient(at, ref client);
                // CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT
                IntPtr child = Native.ChildWindowFromPointEx(at, client, 0x1 | 0x2 | 0x4);
                if (child == IntPtr.Zero || child == at) break;
                at = child;
            }
            return at;
        }

        /// A click posted to the window under a point: reaches the control without activating the window.
        public void PostClick(POINT screen, string button, int count)
        {
            IntPtr target = WindowAt(screen);
            var client = screen;
            Native.ScreenToClient(target, ref client);
            IntPtr lp = Native.MakeLParam(client.X, client.Y);
            int down = Native.WM_LBUTTONDOWN, up = Native.WM_LBUTTONUP, dbl = Native.WM_LBUTTONDBLCLK, mk = 1;
            if (button == "right") { down = Native.WM_RBUTTONDOWN; up = Native.WM_RBUTTONUP; dbl = 0x206; mk = 2; }
            else if (button == "middle") { down = Native.WM_MBUTTONDOWN; up = Native.WM_MBUTTONUP; dbl = 0x209; mk = 0x10; }
            Native.PostMessage(target, Native.WM_MOUSEMOVE, IntPtr.Zero, lp);
            for (int n = 1; n <= Math.Max(1, Math.Min(count, 2)); n++)
            {
                Native.PostMessage(target, n == 2 ? dbl : down, (IntPtr)mk, lp);
                Thread.Sleep(20);
                Native.PostMessage(target, up, IntPtr.Zero, lp);
                Thread.Sleep(40);
            }
            if (button == "right") Native.PostMessage(target, Native.WM_CONTEXTMENU, target, Native.MakeLParam(screen.X, screen.Y));
        }

        static POINT Center(Rect r)
        {
            return new POINT { X = (int)(r.X + r.Width / 2), Y = (int)(r.Y + r.Height / 2) };
        }

        public void Press(int id)
        {
            var el = Node(id);
            if (Press(el)) return;
            var r = Frame(el);
            if (r.IsEmpty) throw new HelperError("press " + id + ": the control is gone or has no size; take a new snapshot.");
            PostClick(Center(r), "left", 1);
        }

        public void Menu(int id)
        {
            var r = Frame(Node(id));
            if (r.IsEmpty) throw new HelperError("menu " + id + ": the control is gone or has no size; take a new snapshot.");
            PostClick(Center(r), "right", 1);
        }

        /// Focus without bringing the window forward: a posted click on the control.
        public void Focus(int id)
        {
            var r = Frame(Node(id));
            if (r.IsEmpty) throw new HelperError("focus " + id + ": the control is gone or has no size; take a new snapshot.");
            PostClick(Center(r), "left", 1);
        }

        public void SetValue(int id, string text)
        {
            var el = Node(id);
            var value = Pattern(el, ValuePattern.Pattern) as ValuePattern;
            if (value == null || value.Current.IsReadOnly)
            {
                throw new HelperError("set_value " + id + ": this control does not take a value directly. Focus it and use type instead.");
            }
            try
            {
                value.SetValue(text);
            }
            catch (Exception e)
            {
                throw new HelperError("set_value " + id + " failed: " + e.Message);
            }
        }

        /// The deepest control under a screen point, found through the tree
        /// (not the screen), so a covered window answers for itself.
        AutomationElement ElementAt(POINT p)
        {
            var at = Root();
            var point = new System.Windows.Point(p.X, p.Y);
            for (int depth = 0; depth < 40; depth++)
            {
                AutomationElement hit = null;
                double best = double.MaxValue;
                foreach (var child in Children(at))
                {
                    var r = Cached<Rect>(child, AutomationElement.BoundingRectangleProperty, Rect.Empty);
                    if (r.IsEmpty || !r.Contains(point)) continue;
                    double area = r.Width * r.Height;
                    if (area < best) { best = area; hit = child; }
                }
                if (hit == null) break;
                at = hit;
            }
            return at == Root() ? null : at;
        }

        /// A window-mode click: the control's own action where it has one, else a posted click.
        public void Click(POINT p, string button, int count)
        {
            if (button != "left" || count >= 2)
            {
                PostClick(p, button, count);
                return;
            }
            var el = ElementAt(p);
            if (el != null)
            {
                string role = RoleOf(el);
                // Fields are focused by clicking; they rarely invoke.
                if (role != "Edit" && role != "Document" && role != "ComboBox" && Press(el)) return;
            }
            PostClick(p, button, count);
        }

        public void Scroll(POINT p, string direction, int amount)
        {
            int pages = Math.Max(1, Math.Min(amount / 5, 5));
            var el = ElementAt(p);
            var walker = TreeWalker.ControlViewWalker;
            for (int i = 0; i < 8 && el != null; i++)
            {
                var scroll = Pattern(el, ScrollPattern.Pattern) as ScrollPattern;
                if (scroll != null)
                {
                    bool vertical = direction == "up" || direction == "down";
                    if (vertical ? scroll.Current.VerticallyScrollable : scroll.Current.HorizontallyScrollable)
                    {
                        var step = direction == "up" || direction == "left" ? ScrollAmount.LargeDecrement : ScrollAmount.LargeIncrement;
                        for (int n = 0; n < pages; n++)
                        {
                            if (vertical) scroll.ScrollVertical(step); else scroll.ScrollHorizontal(step);
                        }
                        return;
                    }
                }
                try { el = walker.GetParent(el); } catch (Exception) { break; }
            }
            // No scroll pattern: a wheel message to the window under the point.
            IntPtr target = WindowAt(p);
            int lines = Math.Max(1, Math.Min(amount, 50));
            int delta = (direction == "up" || direction == "right" ? 120 : -120) * lines;
            int msg = direction == "up" || direction == "down" ? Native.WM_MOUSEWHEEL : Native.WM_MOUSEHWHEEL;
            Native.PostMessage(target, msg, (IntPtr)(delta << 16), Native.MakeLParam(p.X, p.Y));
        }

        /// Does anything in this window hold keyboard focus (so typing has somewhere to go)?
        public bool HasFocusedControl()
        {
            uint pid;
            uint thread = Native.GetWindowThreadProcessId(Hwnd, out pid);
            var info = new GUITHREADINFO { cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(GUITHREADINFO)) };
            return Native.GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero;
        }

        /// The window's readable text for "Ask about this window": static text,
        /// field values (never passwords), link and image names, top to bottom.
        public string ReadableText(RECT window, int maxChars)
        {
            var top = Root();
            var parts = new List<string>();
            int total = 0, visited = 0;
            var visible = new Rect(window.Left - 2, window.Top - 2, window.Width + 4, window.Height + 4);
            var clock = Stopwatch.StartNew();
            Action<string> take = s =>
            {
                if (s == null) return;
                s = s.Trim();
                if (s.Length == 0 || (parts.Count > 0 && parts[parts.Count - 1] == s)) return;
                parts.Add(s);
                total += s.Length + 1;
            };
            Action<AutomationElement, int> walk = null;
            walk = (el, depth) =>
            {
                if (total >= maxChars || depth > 60 || visited > 8000 || clock.ElapsedMilliseconds > 6000) return;
                visited++;
                var frame = Cached<Rect>(el, AutomationElement.BoundingRectangleProperty, Rect.Empty);
                if (!frame.IsEmpty && frame.Width > 0 && frame.Height > 0 && !frame.IntersectsWith(visible)) return;
                if (Cached<bool>(el, AutomationElement.IsPasswordProperty, false)) return;
                string role = RoleOf(el);
                string name = Cached<string>(el, AutomationElement.NameProperty, null);
                var kids = Children(el);
                switch (role)
                {
                    case "Text": take(name); break;
                    case "Edit": case "ComboBox": take(Cached<string>(el, ValuePattern.ValueProperty, null)); break;
                    case "Hyperlink": if (kids.Count == 0) take(name); break;
                    case "Image": if (!string.IsNullOrWhiteSpace(name)) take("[image: " + name.Trim() + "]"); break;
                    case "ListItem": case "TreeItem": case "DataItem": if (kids.Count == 0) take(name); break;
                }
                foreach (var child in kids) walk(child, depth + 1);
            };
            using (cache.Activate())
            {
                try { top = top.GetUpdatedCache(cache); } catch (Exception) { }
            }
            walk(top, 0);
            int waited = 0;
            while (parts.Count < 5 && waited < 4)
            {
                Thread.Sleep(400);
                waited++;
                parts.Clear(); total = 0; visited = 0;
                walk(top, 0);
            }
            if (parts.Count == 0) return null;
            string text = string.Join("\n", parts);
            if (text.Length > maxChars) text = text.Substring(0, maxChars) + "\n…";
            return text;
        }
    }
}
