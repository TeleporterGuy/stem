import CoreGraphics
import Foundation
import ImageIO

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ text: String) { description = text }
}

/// Longest side of a frame handed to the model, in pixels. Anthropic's
/// computer-use guidance: past ~1568 px the image is downscaled by the API
/// anyway, and coordinates the model returns then drift from what it saw.
let MAX_SIDE = 1568.0

/// Screen capture of the main display, downscaled, plus the geometry needed to
/// turn screenshot pixels back into display points.
final class Capture {
  /// Size (in screenshot pixels) of the last frame produced, and the factor
  /// that maps one of its pixels to display points. Both are re-derived on
  /// every full screenshot; a zoom leaves them alone (a zoom is a magnified
  /// look, not a new coordinate space).
  private(set) var lastWidth = 0
  private(set) var lastHeight = 0
  private(set) var pointsPerPixel = 1.0

  private var displayID: CGDirectDisplayID { CGMainDisplayID() }

  private func grab() throws -> CGImage {
    guard let image = CGDisplayCreateImage(displayID) else {
      throw HelperError("Could not capture the screen. Stem needs Screen Recording access (System Settings → Privacy & Security → Screen Recording).")
    }
    return image
  }

  /// A frame of the whole main display: {jpegBase64, width, height, scale}.
  func screenshot() throws -> [String: Any] {
    let image = try grab()
    let bounds = CGDisplayBounds(displayID)
    let longest = Double(max(image.width, image.height))
    let factor = longest > MAX_SIDE ? MAX_SIDE / longest : 1.0
    let width = max(1, Int((Double(image.width) * factor).rounded()))
    let height = max(1, Int((Double(image.height) * factor).rounded()))
    let scaled = try resize(image, width: width, height: height)
    lastWidth = width
    lastHeight = height
    pointsPerPixel = bounds.width / Double(width)
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

  /// Screenshot pixels → global display points (CG coordinates, origin top-left).
  func toPoint(x: Double, y: Double) throws -> CGPoint {
    guard lastWidth > 0 else { throw HelperError("Take a screenshot before pointing at it.") }
    let bounds = CGDisplayBounds(displayID)
    let px = min(max(x, 0), Double(lastWidth - 1))
    let py = min(max(y, 0), Double(lastHeight - 1))
    return CGPoint(x: bounds.origin.x + px * pointsPerPixel, y: bounds.origin.y + py * pointsPerPixel)
  }

  /// Global display points → screenshot pixels (for reporting the cursor).
  func toPixel(_ p: CGPoint) -> [String: Any] {
    guard lastWidth > 0 else { return ["x": Int(p.x), "y": Int(p.y)] }
    let bounds = CGDisplayBounds(displayID)
    return [
      "x": Int(((p.x - bounds.origin.x) / pointsPerPixel).rounded()),
      "y": Int(((p.y - bounds.origin.y) / pointsPerPixel).rounded())
    ]
  }
}
