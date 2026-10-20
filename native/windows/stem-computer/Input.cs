using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace StemComputer
{
    /// xdotool-style key names → Windows virtual keys. Modifiers: ctrl, alt,
    /// shift, win (super/meta). cmd/command mean Ctrl here: a model used to a
    /// Mac says cmd+c for copy, and Ctrl is what does that on Windows.
    static class KeyMap
    {
        public class Parsed
        {
            public ushort Vk;
            public bool Extended;
            public List<ushort> Modifiers = new List<ushort>();
        }

        public const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RETURN = 0x0D, VK_TAB = 0x09;

        static readonly Dictionary<string, ushort> named = new Dictionary<string, ushort> {
            { "return", 0x0D }, { "enter", 0x0D }, { "kp_enter", 0x0D }, { "tab", 0x09 }, { "space", 0x20 },
            { "delete", 0x2E }, { "backspace", 0x08 }, { "escape", 0x1B }, { "esc", 0x1B },
            { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
            { "home", 0x24 }, { "end", 0x23 }, { "page_up", 0x21 }, { "pageup", 0x21 }, { "page_down", 0x22 }, { "pagedown", 0x22 },
            { "insert", 0x2D }, { "caps_lock", 0x14 },
            { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 }, { "f5", 0x74 }, { "f6", 0x75 },
            { "f7", 0x76 }, { "f8", 0x77 }, { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B },
            { "minus", 0xBD }, { "equal", 0xBB }, { "plus", 0xBB }, { "bracketleft", 0xDB }, { "bracketright", 0xDD },
            { "semicolon", 0xBA }, { "apostrophe", 0xDE }, { "quote", 0xDE }, { "grave", 0xC0 }, { "backslash", 0xDC },
            { "comma", 0xBC }, { "period", 0xBE }, { "slash", 0xBF }
        };

        /// Keys whose scan code needs the extended flag, or they act as the numpad.
        static readonly HashSet<ushort> extended = new HashSet<ushort> { 0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28 };

        public static ushort? Modifier(string name)
        {
            switch (name.ToLowerInvariant())
            {
                case "ctrl": case "control": case "cmd": case "command": return VK_CONTROL;
                case "alt": case "option": case "opt": return VK_MENU;
                case "shift": return VK_SHIFT;
                case "super": case "win": case "meta": case "windows": return VK_LWIN;
                default: return null;
            }
        }

        public static Parsed Parse(string combo)
        {
            var parts = combo.Split('+');
            for (int i = 0; i < parts.Length; i++) parts[i] = parts[i].Trim();
            string last = parts[parts.Length - 1];
            if (last.Length == 0) throw new HelperError("Name a key, e.g. \"Return\" or \"ctrl+shift+t\".");
            var parsed = new Parsed();
            for (int i = 0; i < parts.Length - 1; i++)
            {
                var m = Modifier(parts[i]);
                if (!m.HasValue) throw new HelperError("Unknown modifier \"" + parts[i] + "\" (use ctrl, alt, shift, win).");
                parsed.Modifiers.Add(m.Value);
            }
            string name = last.ToLowerInvariant();
            ushort vk;
            if (named.TryGetValue(name, out vk))
            {
                parsed.Vk = vk;
                parsed.Extended = extended.Contains(vk);
                return parsed;
            }
            if (last.Length == 1)
            {
                char ch = last[0];
                if (ch >= 'a' && ch <= 'z') { parsed.Vk = (ushort)(0x41 + (ch - 'a')); return parsed; }
                if (ch >= 'A' && ch <= 'Z') { parsed.Vk = (ushort)(0x41 + (ch - 'A')); return parsed; }
                if (ch >= '0' && ch <= '9') { parsed.Vk = (ushort)(0x30 + (ch - '0')); return parsed; }
                short scan = Native.VkKeyScan(ch);
                if (scan != -1)
                {
                    parsed.Vk = (ushort)(scan & 0xFF);
                    if ((scan & 0x100) != 0) parsed.Modifiers.Add(VK_SHIFT);
                    if ((scan & 0x200) != 0) parsed.Modifiers.Add(VK_CONTROL);
                    if ((scan & 0x400) != 0) parsed.Modifiers.Add(VK_MENU);
                    return parsed;
                }
            }
            var alone = Modifier(name);
            if (alone.HasValue) { parsed.Vk = alone.Value; return parsed; }
            throw new HelperError("Unknown key \"" + last + "\". Use xdotool names: Return, Tab, Escape, space, BackSpace, Delete, Up/Down/Left/Right, Home, End, Page_Up, Page_Down, F1–F12, or a single character.");
        }
    }

    /// Real input. Screen mode: SendInput, the person's own mouse and keyboard
    /// (Windows marks these events injected, which is how the watch tells them
    /// apart). Window mode: messages posted to the selected window, so it never
    /// comes forward — which reaches classic Win32 controls and Chromium, but
    /// not shortcuts that hold Ctrl or Alt (apps read those from the real
    /// keyboard state).
    class Input
    {
        readonly Capture capture;
        /// Set in window mode: keys go to this window's focused control, not the session.
        public IntPtr KeyboardWindow = IntPtr.Zero;

        public Input(Capture capture)
        {
            this.capture = capture;
        }

        static void Pause(int ms)
        {
            Thread.Sleep(Math.Max(0, ms));
        }

        static void Send(params INPUT[] inputs)
        {
            uint sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length)
            {
                throw new HelperError("Windows refused the input (another app may be running as administrator and in front, or the screen is locked).");
            }
        }

        static INPUT Mouse(uint flags, int dx = 0, int dy = 0, int data = 0)
        {
            var i = new INPUT { type = Native.INPUT_MOUSE };
            i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
            return i;
        }

        static INPUT Key(ushort vk, bool up, bool extendedKey = false)
        {
            var i = new INPUT { type = Native.INPUT_KEYBOARD };
            uint flags = (up ? Native.KEYEVENTF_KEYUP : 0) | (extendedKey ? Native.KEYEVENTF_EXTENDEDKEY : 0);
            i.u.ki = new KEYBDINPUT { wVk = vk, wScan = (ushort)Native.MapVirtualKey(vk, Native.MAPVK_VK_TO_VSC), dwFlags = flags };
            return i;
        }

        static INPUT Unicode(char unit, bool up)
        {
            var i = new INPUT { type = Native.INPUT_KEYBOARD };
            i.u.ki = new KEYBDINPUT { wVk = 0, wScan = unit, dwFlags = Native.KEYEVENTF_UNICODE | (up ? Native.KEYEVENTF_KEYUP : 0) };
            return i;
        }

        public POINT CurrentPoint()
        {
            POINT p;
            Native.GetCursorPos(out p);
            return p;
        }

        public Dictionary<string, object> CursorInScreenshot()
        {
            return capture.ToPixel(CurrentPoint());
        }

        POINT At(double? x, double? y)
        {
            if (x.HasValue && y.HasValue) return capture.ToPoint(x.Value, y.Value);
            if (!x.HasValue && !y.HasValue) return CurrentPoint();
            throw new HelperError("Give both x and y.");
        }

        /// A move to screen pixel p, as absolute coordinates over the whole virtual desktop.
        static INPUT MoveTo(POINT p)
        {
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN), vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Math.Max(1, Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN) - 1), vh = Math.Max(1, Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN) - 1);
            int nx = (int)Math.Round((p.X - vx) * 65535.0 / vw), ny = (int)Math.Round((p.Y - vy) * 65535.0 / vh);
            return Mouse(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, nx, ny);
        }

        public void Move(double? x, double? y)
        {
            Send(MoveTo(At(x, y)));
        }

        public void Click(double? x, double? y, string button, int count)
        {
            var p = At(x, y);
            uint down = Native.MOUSEEVENTF_LEFTDOWN, up = Native.MOUSEEVENTF_LEFTUP;
            if (button == "right") { down = Native.MOUSEEVENTF_RIGHTDOWN; up = Native.MOUSEEVENTF_RIGHTUP; }
            else if (button == "middle") { down = Native.MOUSEEVENTF_MIDDLEDOWN; up = Native.MOUSEEVENTF_MIDDLEUP; }
            Send(MoveTo(p));
            Pause(30);
            int clicks = Math.Max(1, Math.Min(count, 3));
            for (int n = 1; n <= clicks; n++)
            {
                Send(Mouse(down));
                Pause(20);
                Send(Mouse(up));
                if (n < clicks) Pause(60);
            }
        }

        public void Drag(double? fx, double? fy, double? tx, double? ty)
        {
            if (!fx.HasValue || !fy.HasValue || !tx.HasValue || !ty.HasValue) throw new HelperError("A drag needs from {x,y} and to {x,y}.");
            var a = capture.ToPoint(fx.Value, fy.Value);
            var b = capture.ToPoint(tx.Value, ty.Value);
            Send(MoveTo(a));
            Pause(40);
            Send(Mouse(Native.MOUSEEVENTF_LEFTDOWN));
            Pause(80);
            const int steps = 12;
            for (int i = 1; i <= steps; i++)
            {
                double t = i / (double)steps;
                Send(MoveTo(new POINT { X = (int)(a.X + (b.X - a.X) * t), Y = (int)(a.Y + (b.Y - a.Y) * t) }));
                Pause(20);
            }
            Pause(60);
            Send(Mouse(Native.MOUSEEVENTF_LEFTUP));
        }

        public void Scroll(double? x, double? y, string direction, int amount)
        {
            var p = At(x, y);
            Send(MoveTo(p));
            Pause(30);
            int lines = Math.Max(1, Math.Min(amount, 50));
            switch (direction)
            {
                case "up": Send(Mouse(Native.MOUSEEVENTF_WHEEL, 0, 0, 120 * lines)); break;
                case "down": Send(Mouse(Native.MOUSEEVENTF_WHEEL, 0, 0, -120 * lines)); break;
                case "left": Send(Mouse(Native.MOUSEEVENTF_HWHEEL, 0, 0, -120 * lines)); break;
                case "right": Send(Mouse(Native.MOUSEEVENTF_HWHEEL, 0, 0, 120 * lines)); break;
                default: throw new HelperError("scroll direction must be up, down, left or right.");
            }
        }

        /// The control that has keyboard focus inside the window-mode window (its
        /// thread's focus), or the window itself.
        IntPtr FocusOf(IntPtr hwnd)
        {
            uint pid;
            uint thread = Native.GetWindowThreadProcessId(hwnd, out pid);
            var info = new GUITHREADINFO { cbSize = Marshal.SizeOf(typeof(GUITHREADINFO)) };
            if (Native.GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero) return info.hwndFocus;
            return hwnd;
        }

        static IntPtr KeyLParam(ushort vk, bool up, bool extendedKey)
        {
            uint scan = Native.MapVirtualKey(vk, Native.MAPVK_VK_TO_VSC);
            long l = 1 | (scan << 16) | (extendedKey ? 1L << 24 : 0);
            if (up) l |= (1L << 30) | (1L << 31);
            return (IntPtr)l;
        }

        public void Type(string text)
        {
            if (string.IsNullOrEmpty(text)) throw new HelperError("Nothing to type.");
            if (KeyboardWindow != IntPtr.Zero)
            {
                var focus = FocusOf(KeyboardWindow);
                for (int i = 0; i < text.Length; i++)
                {
                    char unit = text[i];
                    if (unit == '\r' && i + 1 < text.Length && text[i + 1] == '\n') continue;
                    if (unit == '\n' || unit == '\r' || unit == '\t')
                    {
                        // A key press, not WM_CHAR: rich edit controls (Windows 11
                        // Notepad) drop a posted '\r' character but take the key,
                        // and the app's own TranslateMessage still makes the
                        // character for a plain edit control.
                        ushort vk = unit == '\t' ? KeyMap.VK_TAB : KeyMap.VK_RETURN;
                        Native.PostMessage(focus, Native.WM_KEYDOWN, (IntPtr)vk, KeyLParam(vk, false, false));
                        Native.PostMessage(focus, Native.WM_KEYUP, (IntPtr)vk, KeyLParam(vk, true, false));
                    }
                    else Native.PostMessage(focus, Native.WM_CHAR, (IntPtr)unit, (IntPtr)1);
                    Pause(4);
                }
                return;
            }
            foreach (char unit in text)
            {
                if (unit == '\n' || unit == '\r') Send(Key(KeyMap.VK_RETURN, false), Key(KeyMap.VK_RETURN, true));
                else if (unit == '\t') Send(Key(KeyMap.VK_TAB, false), Key(KeyMap.VK_TAB, true));
                else Send(Unicode(unit, false), Unicode(unit, true));
                Pause(8);
            }
        }

        public void PressKey(string combo)
        {
            Hold(combo, 30);
        }

        public void Hold(string combo, int ms)
        {
            var parsed = KeyMap.Parse(combo);
            ms = Math.Max(30, Math.Min(ms, 5000));
            if (KeyboardWindow != IntPtr.Zero)
            {
                if (parsed.Modifiers.Count > 0)
                {
                    throw new HelperError("In window mode on Windows a background window only gets plain keys: anything with ctrl, alt, shift or win (shift+arrow selection too) needs the real keyboard. Use the menu through snapshot/press, or clear the window and send the shortcut in screen mode.");
                }
                var focus = FocusOf(KeyboardWindow);
                Native.PostMessage(focus, Native.WM_KEYDOWN, (IntPtr)parsed.Vk, KeyLParam(parsed.Vk, false, parsed.Extended));
                Pause(ms);
                Native.PostMessage(focus, Native.WM_KEYUP, (IntPtr)parsed.Vk, KeyLParam(parsed.Vk, true, parsed.Extended));
                return;
            }
            foreach (var m in parsed.Modifiers) Send(Key(m, false));
            Send(Key(parsed.Vk, false, parsed.Extended));
            Pause(ms);
            Send(Key(parsed.Vk, true, parsed.Extended));
            for (int i = parsed.Modifiers.Count - 1; i >= 0; i--) Send(Key(parsed.Modifiers[i], true));
        }
    }
}
