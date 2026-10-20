using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace StemComputer
{
    /// The kill switch: low-level mouse and keyboard hooks that report the
    /// person's first touch while a screen-mode run is driving. Events this
    /// helper sent come marked injected by Windows and are ignored. Starts
    /// disarmed, like the Mac's Watch.swift: looking never ends a run, and the
    /// first screen-mode input action arms it.
    class Watch
    {
        Thread thread;
        uint threadId;
        IntPtr mouseHook = IntPtr.Zero, keyHook = IntPtr.Zero;
        // Kept as fields: a hook delegate the GC collects crashes the process on the next event.
        HookProc mouseProc, keyProc;
        readonly object gate = new object();
        bool fired, suppressed = true;
        Action<string> onHuman;

        public void Arm()
        {
            lock (gate) { suppressed = false; fired = false; }
        }

        public void Disarm()
        {
            lock (gate) { suppressed = true; }
        }

        void Saw(string kind)
        {
            Action<string> handler;
            lock (gate)
            {
                if (fired || suppressed) return;
                fired = true;
                handler = onHuman;
            }
            if (handler != null) handler(kind);
        }

        public void Start(Action<string> handler)
        {
            Stop();
            lock (gate) { fired = false; onHuman = handler; }
            mouseProc = (code, wParam, lParam) =>
            {
                if (code >= 0)
                {
                    var info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                    if ((info.flags & (Native.LLMHF_INJECTED | Native.LLMHF_LOWER_IL_INJECTED)) == 0) Saw("mouse");
                }
                return Native.CallNextHookEx(mouseHook, code, wParam, lParam);
            };
            keyProc = (code, wParam, lParam) =>
            {
                if (code >= 0)
                {
                    var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    if ((info.flags & (Native.LLKHF_INJECTED | Native.LLKHF_LOWER_IL_INJECTED)) == 0) Saw("key");
                }
                return Native.CallNextHookEx(keyHook, code, wParam, lParam);
            };
            var ready = new ManualResetEvent(false);
            string failure = null;
            thread = new Thread(() =>
            {
                threadId = Native.GetCurrentThreadId();
                IntPtr module = Native.GetModuleHandle(null);
                mouseHook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, mouseProc, module, 0);
                keyHook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, keyProc, module, 0);
                if (mouseHook == IntPtr.Zero || keyHook == IntPtr.Zero) failure = "Could not watch for your input (Windows refused the input hooks).";
                ready.Set();
                if (failure != null) return;
                // Low-level hooks are called on this thread's message loop.
                MSG msg;
                while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
                Native.UnhookWindowsHookEx(mouseHook);
                Native.UnhookWindowsHookEx(keyHook);
                mouseHook = keyHook = IntPtr.Zero;
            });
            thread.IsBackground = true;
            thread.Name = "stem-computer-watch";
            thread.Start();
            ready.WaitOne();
            if (failure != null) throw new HelperError(failure);
        }

        public void Stop()
        {
            if (thread != null && threadId != 0) Native.PostThreadMessage(threadId, Native.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            thread = null;
            threadId = 0;
            lock (gate) { onHuman = null; }
        }
    }
}
