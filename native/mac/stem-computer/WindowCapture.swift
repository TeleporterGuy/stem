import CoreGraphics
import Foundation
import ScreenCaptureKit

/// A picture of one window wherever it is — another Space, behind everything,
/// minimized — through ScreenCaptureKit's desktop-independent window filter.
/// This is the one reason the helper needs macOS 14: SCScreenshotManager.
enum WindowCapture {
  /// Backing pixels per point of the display the window is (mostly) on.
  static func pixelScale(for bounds: CGRect) -> Double {
    var display = CGMainDisplayID()
    var count: UInt32 = 0
    var found: CGDirectDisplayID = 0
    if CGGetDisplaysWithRect(bounds, 1, &found, &count) == .success, count > 0 { display = found }
    guard let mode = CGDisplayCopyDisplayMode(display) else { return 2 }
    let points = CGDisplayBounds(display).width
    return points > 0 ? Double(mode.pixelWidth) / points : 2
  }

  /// Runs an async SCK call from the helper's synchronous command loop.
  private static func wait<T>(_ work: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var result: Result<T, Error>?
    Task.detached {
      do { result = .success(try await work()) } catch { result = .failure(error) }
      done.signal()
    }
    if done.wait(timeout: .now() + 10) == .timedOut {
      throw HelperError("Capturing the window took too long.")
    }
    switch result! {
    case .success(let v): return v
    case .failure(let e): throw e
    }
  }

  static func capture(windowID: CGWindowID, bounds: CGRect) throws -> CGImage {
    let image: CGImage? = try wait {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
        throw HelperError("That window is gone. Run list_windows and select again.")
      }
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let config = SCStreamConfiguration()
      let scale = pixelScale(for: bounds)
      config.width = max(1, Int((window.frame.width * scale).rounded()))
      config.height = max(1, Int((window.frame.height * scale).rounded()))
      config.showsCursor = false
      config.ignoreShadowsSingleWindow = true
      config.captureResolution = .best
      return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }
    guard let image else {
      throw HelperError("Could not capture the window. Stem needs Screen Recording access (System Settings → Privacy & Security → Screen Recording).")
    }
    return image
  }
}
