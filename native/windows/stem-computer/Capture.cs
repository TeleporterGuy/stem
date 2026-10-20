using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;

namespace StemComputer
{
    class HelperError : Exception
    {
        public HelperError(string message) : base(message) { }
    }

    /// The window a run works on once it has selected one.
    class Target
    {
        public IntPtr Hwnd;
        public uint Pid;
        public string App;
        public string Title;
        public RECT Bounds;

        public Dictionary<string, object> Summary()
        {
            return new Dictionary<string, object> { { "app", App }, { "title", Title }, { "windowId", Hwnd.ToInt64() } };
        }
    }

    /// Capture of the primary display, or of the selected window alone,
    /// downscaled, plus the geometry that turns screenshot pixels back into
    /// screen pixels. The same contract as the Mac helper's Capture.swift.
    class Capture
    {
        /// Longest side of a frame handed to the model (Anthropic's computer-use guidance).
        public const double MaxSide = 1568.0;

        public int LastWidth, LastHeight;
        public double PixelsPerShotPixel = 1.0;
        public int OriginX, OriginY;

        Target target;
        public Target Target
        {
            get { return target; }
            set
            {
                bool changed = (target == null) != (value == null) || (target != null && value != null && target.Hwnd != value.Hwnd);
                target = value;
                if (!changed) return;
                LastWidth = LastHeight = 0;
                PixelsPerShotPixel = 1.0;
                OriginX = OriginY = 0;
            }
        }

        RECT CurrentBounds()
        {
            if (target == null)
            {
                return new RECT { Left = 0, Top = 0, Right = Native.GetSystemMetrics(Native.SM_CXSCREEN), Bottom = Native.GetSystemMetrics(Native.SM_CYSCREEN) };
            }
            if (!Native.IsWindow(target.Hwnd))
            {
                var left = Windows.AppWindows(target.Pid).Select(Windows.Brief).ToList();
                string others = left.Count == 0 ? "Run list_windows and select again." : target.App + "'s windows now: " + string.Join("; ", left) + " — select_window one of them.";
                throw new HelperError("The selected window has closed (an action that closed it went through). " + others);
            }
            if (Native.IsIconic(target.Hwnd))
            {
                throw new HelperError(target.App + "'s window is minimized, and Windows draws nothing for a minimized window. Ask the user to restore it (it can stay behind other windows), or clear the window and use the screen.");
            }
            target.Bounds = Native.Frame(target.Hwnd);
            target.Title = Native.WindowText(target.Hwnd);
            return target.Bounds;
        }

        Bitmap Grab(RECT bounds)
        {
            if (target != null) return GrabWindow(target.Hwnd, bounds);
            var bmp = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppRgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, new Size(bounds.Width, bounds.Height), CopyPixelOperation.SourceCopy);
            }
            return bmp;
        }

        /// One window wherever it is in the stack: PrintWindow with full content
        /// (Chromium and DirectX surfaces included), cropped to the visible frame.
        public static Bitmap GrabWindow(IntPtr hwnd, RECT frame)
        {
            RECT outer;
            Native.GetWindowRect(hwnd, out outer);
            int w = Math.Max(1, outer.Width), h = Math.Max(1, outer.Height);
            IntPtr screen = Native.GetDC(IntPtr.Zero);
            IntPtr mem = Native.CreateCompatibleDC(screen);
            IntPtr bitmap = Native.CreateCompatibleBitmap(screen, w, h);
            IntPtr old = Native.SelectObject(mem, bitmap);
            try
            {
                if (!Native.PrintWindow(hwnd, mem, Native.PW_RENDERFULLCONTENT))
                {
                    throw new HelperError("Windows would not draw that window (PrintWindow failed). Clear the window and use the screen.");
                }
                Native.SelectObject(mem, old);
                using (var whole = Image.FromHbitmap(bitmap))
                {
                    var crop = new Rectangle(frame.Left - outer.Left, frame.Top - outer.Top, frame.Width, frame.Height);
                    crop.Intersect(new Rectangle(0, 0, whole.Width, whole.Height));
                    if (crop.Width < 1 || crop.Height < 1) crop = new Rectangle(0, 0, whole.Width, whole.Height);
                    var outBmp = new Bitmap(crop.Width, crop.Height, PixelFormat.Format32bppRgb);
                    using (var g = Graphics.FromImage(outBmp))
                    {
                        g.DrawImage(whole, new Rectangle(0, 0, crop.Width, crop.Height), crop, GraphicsUnit.Pixel);
                    }
                    return outBmp;
                }
            }
            finally
            {
                Native.SelectObject(mem, old);
                Native.DeleteObject(bitmap);
                Native.DeleteDC(mem);
                Native.ReleaseDC(IntPtr.Zero, screen);
            }
        }

        public Dictionary<string, object> Screenshot()
        {
            var bounds = CurrentBounds();
            using (var image = Grab(bounds))
            {
                double longest = Math.Max(image.Width, image.Height);
                double factor = longest > MaxSide ? MaxSide / longest : 1.0;
                int width = Math.Max(1, (int)Math.Round(image.Width * factor));
                int height = Math.Max(1, (int)Math.Round(image.Height * factor));
                LastWidth = width;
                LastHeight = height;
                PixelsPerShotPixel = bounds.Width / (double)width;
                OriginX = bounds.Left;
                OriginY = bounds.Top;
                return new Dictionary<string, object> {
                    { "jpegBase64", Jpeg(image, width, height) },
                    { "width", width },
                    { "height", height },
                    { "scale", PixelsPerShotPixel }
                };
            }
        }

        public Dictionary<string, object> Zoom(double x, double y, double w, double h)
        {
            if (LastWidth <= 0 || LastHeight <= 0) throw new HelperError("Take a screenshot before zooming.");
            if (w < 1 || h < 1) throw new HelperError("The zoom region needs a positive width and height.");
            var bounds = CurrentBounds();
            using (var image = Grab(bounds))
            {
                double toFull = image.Width / (double)LastWidth;
                var rect = new Rectangle((int)Math.Max(0, x * toFull), (int)Math.Max(0, y * toFull), (int)Math.Round(w * toFull), (int)Math.Round(h * toFull));
                rect.Intersect(new Rectangle(0, 0, image.Width, image.Height));
                if (rect.Width < 1 || rect.Height < 1) throw new HelperError("The zoom region lies outside the screen.");
                using (var cropped = image.Clone(rect, image.PixelFormat))
                {
                    double factor = MaxSide / Math.Max(cropped.Width, cropped.Height);
                    int width = Math.Max(1, (int)Math.Round(cropped.Width * factor));
                    int height = Math.Max(1, (int)Math.Round(cropped.Height * factor));
                    return new Dictionary<string, object> {
                        { "jpegBase64", Jpeg(cropped, width, height) },
                        { "width", width },
                        { "height", height },
                        { "zoomed", true }
                    };
                }
            }
        }

        static ImageCodecInfo jpegCodec;

        public static string Jpeg(Image image, int width, int height)
        {
            Image scaled = image;
            if (image.Width != width || image.Height != height)
            {
                var bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb);
                using (var g = Graphics.FromImage(bmp))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(image, 0, 0, width, height);
                }
                scaled = bmp;
            }
            try
            {
                if (jpegCodec == null) jpegCodec = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
                var parameters = new EncoderParameters(1);
                parameters.Param[0] = new EncoderParameter(Encoder.Quality, 80L);
                using (var ms = new MemoryStream())
                {
                    scaled.Save(ms, jpegCodec, parameters);
                    return Convert.ToBase64String(ms.ToArray());
                }
            }
            finally
            {
                if (!ReferenceEquals(scaled, image)) scaled.Dispose();
            }
        }

        /// Screenshot pixels → screen pixels.
        public POINT ToPoint(double x, double y)
        {
            if (LastWidth <= 0) throw new HelperError("Take a screenshot before pointing at it.");
            double px = Math.Min(Math.Max(x, 0), LastWidth - 1);
            double py = Math.Min(Math.Max(y, 0), LastHeight - 1);
            return new POINT { X = OriginX + (int)Math.Round(px * PixelsPerShotPixel), Y = OriginY + (int)Math.Round(py * PixelsPerShotPixel) };
        }

        /// Screen pixels → screenshot pixels.
        public int[] Pixel(int x, int y)
        {
            if (LastWidth <= 0) return new[] { x, y };
            return new[] { (int)Math.Round((x - OriginX) / PixelsPerShotPixel), (int)Math.Round((y - OriginY) / PixelsPerShotPixel) };
        }

        public Dictionary<string, object> ToPixel(POINT p)
        {
            var xy = Pixel(p.X, p.Y);
            return new Dictionary<string, object> { { "x", xy[0] }, { "y", xy[1] } };
        }
    }
}
