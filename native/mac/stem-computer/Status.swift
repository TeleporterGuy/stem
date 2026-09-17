import ApplicationServices
import CoreGraphics
import Foundation

/// The three grants this helper (and so its parent app) needs.
enum Status {
  static func check() -> [String: Any] {
    [
      "screen": CGPreflightScreenCaptureAccess(),
      "accessibility": AXIsProcessTrusted(),
      "inputMonitoring": CGPreflightListenEventAccess()
    ]
  }

  /// Ask for whatever is missing. macOS shows its own prompt (or, once
  /// refused, nothing — the user then flips it in System Settings), and the
  /// answer is whatever is granted right now, which is usually still "no":
  /// the grant lands after the user acts, and the app re-asks on its next check.
  static func request() -> [String: Any] {
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    if !AXIsProcessTrusted() {
      let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(opts)
    }
    if !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
    return check()
  }
}
