import CoreGraphics
import Foundation
import ImageIO

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ text: String) { description = text }
}

/// macOS gave no picture: a capture that timed out, came back empty or was
/// refused. Whatever action came before it still happened; only the frame is
/// missing, and a window's controls (snapshot, press, set_value) need
/// Accessibility alone, so the run can go on without pictures.
struct NoPicture: Error, CustomStringConvertible {
  let reason: String
  /// A wait ran out: worth a fresh window lookup only if it was not this.
  var timedOut = false
  /// Said again within a minute of the first refusal: the advice is not repeated.
  var again = false

  var description: String {
    if again {
      return "\(reason) Keep working through the window's controls (snapshot, press, set_value, type, key)."
    }
    let advice: String
    if CGPreflightScreenCaptureAccess() {
      // 2026-10-20 and 2026-10-22: preflight said granted while every capture
      // under Stem's identity failed, and re-granting the permission did not help.
      advice = "Screen Recording shows as granted, so macOS itself is not answering Stem's capture requests; when this happened before it lasted until the user logged out or restarted the Mac, and removing and re-adding the permission did not help."
    } else {
      advice = "Stem needs Screen Recording access (System Settings → Privacy & Security → Screen Recording)."
    }
    return "\(reason) \(advice) Without pictures, work through a window's controls: select_window still selects, and snapshot, press, set_value, type and key need only Accessibility. If they cannot get you what you need, tell the user pictures are blocked rather than asking for a screenshot first."
  }
}

/// Longest side of a frame handed to the model, in pixels. Anthropic's
/// computer-use guidance: past ~1568 px the image is downscaled by the API
/// anyway, and coordinates the model returns then drift from what it saw.
let MAX_SIDE = 1568.0

/// Capture of the main display — or, once a run has selected a window, of that
/// window alone — downscaled, plus the geometry needed to turn screenshot
/// pixels back into global points. One coordinate space at a time: selecting
/// or clearing a window resets it, and the next screenshot re-derives it.
final class Capture {
  /// Size (in screenshot pixels) of the last frame produced, and the factor
  /// that maps one of its pixels to display points. Both are re-derived on
  /// every full screenshot; a zoom leaves them alone (a zoom is a magnified
  /// look, not a new coordinate space).
  private(set) var lastWidth = 0
  private(set) var lastHeight = 0
  private(set) var pointsPerPixel = 1.0
  /// Where the last frame's (0,0) sits in global points: the display's origin,
  /// or the window's top-left.
  private(set) var origin = CGPoint.zero

  /// The window this capture is of; nil = the whole main display.
  var target: Target? {
    didSet {
      // A new window (or none) is a new coordinate space; a refreshed title or
      // bounds of the same window is not.
      guard oldValue?.windowID != target?.windowID else { return }
      lastWidth = 0
      lastHeight = 0
      pointsPerPixel = 1.0
      origin = .zero
    }
  }

  private var displayID: CGDirectDisplayID { CGMainDisplayID() }

  /// When macOS last refused a picture. Each refusal costs a 10 s wait (5 s
  /// for the screen), so for a minute after one a capture fails at once and
  /// the run carries on through controls; then it tries again. Shared by
  /// every Capture, the window peek's included.
  private static var refusedAt: Date?

  /// The coordinate space a frame of `bounds` would have, `pixels` across.
  private func adopt(_ bounds: CGRect, width: Int, height: Int) {
    lastWidth = width
    lastHeight = height
    pointsPerPixel = bounds.width / Double(width)
    origin = bounds.origin
  }

  /// A frame's size once its long side fits MAX_SIDE.
  private func fitted(_ width: Int, _ height: Int) -> (Int, Int) {
    let longest = Double(max(width, height))
    let factor = longest > MAX_SIDE ? MAX_SIDE / longest : 1.0
    return (max(1, Int((Double(width) * factor).rounded())), max(1, Int((Double(height) * factor).rounded())))
  }

  /// The coordinate space of a frame that could not be taken, from the
  /// window's (or display's) bounds alone — the same one a real frame would
  /// have, so snapshot positions and clicks still line up. Throws when the
  /// selected window has closed.
  func frameWithoutPicture(records: [[String: Any]]? = nil) throws {
    let bounds = try currentBounds(records)
    let scale = WindowCapture.pixelScale(for: bounds)
    let (width, height) = fitted(Int((bounds.width * scale).rounded()), Int((bounds.height * scale).rounded()))
    adopt(bounds, width: width, height: height)
  }

  /// The area the frame covers, in global points — refreshed for a window,
  /// which may have moved. One read of the window server for bounds and title
  /// (`records`, when the caller already has them).
  private func currentBounds(_ records: [[String: Any]]?) throws -> CGRect {
    guard let t = target else { return CGDisplayBounds(displayID) }
    let all = records ?? Windows.records()
    guard let record = Windows.record(of: t.windowID, in: all), let b = Windows.bounds(record) else {
      // A dialog that closed on the action just taken is the usual case: name
      // the app's windows left so the model can pick one without a full list.
      let left = Windows.appWindows(pid: t.pid, in: all).map(Windows.brief)
      let others = left.isEmpty ? "Run list_windows and select again." : "\(t.app)'s windows now: \(left.joined(separator: "; ")) — select_window one of them."
      throw HelperError("The selected window has closed (an action that closed it went through). \(others)")
    }
    target?.bounds = b
    if let title = record[kCGWindowName as String] as? String { target?.title = title }
    return b
  }

  private func grab() throws -> CGImage {
    if let at = Capture.refusedAt, Date().timeIntervalSince(at) < 60 {
      throw NoPicture(reason: "No picture: macOS refused one less than a minute ago.", again: true)
    }
    do {
      let image: CGImage
      if let t = target {
        image = try WindowCapture.capture(windowID: t.windowID, bounds: t.bounds)
      } else {
        guard let screen = CGDisplayCreateImage(displayID) else { throw NoPicture(reason: "Could not capture the screen.") }
        image = screen
      }
      Capture.refusedAt = nil
      return image
    } catch let refused as NoPicture {
      Capture.refusedAt = Date()
      throw refused
    }
  }

  /// A frame of the whole main display or the selected window: {jpegBase64, width, height, scale}.
  /// `records`: the window server's list, when the caller has just read it.
  func screenshot(records: [[String: Any]]? = nil) throws -> [String: Any] {
    let bounds = try currentBounds(records)
    let image = try grab()
    let (width, height) = fitted(image.width, image.height)
    let scaled = try resize(image, width: width, height: height)
    adopt(bounds, width: width, height: height)
    return [
      "jpegBase64": try jpeg(scaled),
      "width": width,
      "height": height,
      "scale": pointsPerPixel
    ]
  }

  /// A magnified look at a region given in LAST-SCREENSHOT pixels. The region is
  /// cropped from a fresh full-resolution capture and scaled to fit MAX_SIDE, so
  /// small text becomes legible; coordinates in the reply are NOT usable for
  /// clicking (the model is told so) — that is what the next screenshot is for.
  func zoom(x: Double, y: Double, w: Double, h: Double) throws -> [String: Any] {
    guard lastWidth > 0, lastHeight > 0 else {
      throw HelperError("Take a screenshot before zooming.")
    }
    guard w >= 1, h >= 1 else { throw HelperError("The zoom region needs a positive width and height.") }
    let image = try grab()
    let toBacking = Double(image.width) / Double(lastWidth)
    let rect = CGRect(
      x: max(0, x * toBacking), y: max(0, y * toBacking),
      width: min(Double(image.width), w * toBacking), height: min(Double(image.height), h * toBacking)
    ).integral
    guard rect.width >= 1, rect.height >= 1, let cropped = image.cropping(to: rect) else {
      throw HelperError("The zoom region lies outside the screen.")
    }
    let longest = Double(max(cropped.width, cropped.height))
    let factor = MAX_SIDE / longest
    let width = max(1, Int((Double(cropped.width) * factor).rounded()))
    let height = max(1, Int((Double(cropped.height) * factor).rounded()))
    let scaled = try resize(cropped, width: width, height: height)
    return [
      "jpegBase64": try jpeg(scaled),
      "width": width,
      "height": height,
      "zoomed": true
    ]
  }

  private func resize(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
    if image.width == width && image.height == height { return image }
    guard let ctx = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { throw HelperError("Could not allocate a drawing context.") }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let out = ctx.makeImage() else { throw HelperError("Could not scale the screenshot.") }
    return out
  }

  private func jpeg(_ image: CGImage) throws -> String {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else {
      throw HelperError("Could not encode the screenshot.")
    }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw HelperError("Could not encode the screenshot.") }
    return (data as Data).base64EncodedString()
  }

  /// Screenshot pixels → global points (CG coordinates, origin top-left).
  func toPoint(x: Double, y: Double) throws -> CGPoint {
    guard lastWidth > 0 else { throw HelperError("Take a screenshot before pointing at it.") }
    let px = min(max(x, 0), Double(lastWidth - 1))
    let py = min(max(y, 0), Double(lastHeight - 1))
    return CGPoint(x: origin.x + px * pointsPerPixel, y: origin.y + py * pointsPerPixel)
  }

  /// Global points → screenshot pixels, as a pair.
  func pixel(_ p: CGPoint) -> (Int, Int) {
    guard lastWidth > 0 else { return (Int(p.x), Int(p.y)) }
    return (Int(((p.x - origin.x) / pointsPerPixel).rounded()), Int(((p.y - origin.y) / pointsPerPixel).rounded()))
  }

  /// Global points → screenshot pixels (for reporting the cursor).
  func toPixel(_ p: CGPoint) -> [String: Any] {
    let (x, y) = pixel(p)
    return ["x": x, "y": y]
  }
}
