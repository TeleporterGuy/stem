import AppKit
import CoreGraphics
import Foundation

/// The window a run works on once it has selected one. Nil target = the whole
/// main display, driven with the real mouse; a target = that window alone,
/// captured wherever it is (another Space, behind other windows, minimized)
/// and driven through Accessibility so the app never has to come forward.
struct Target {
  let pid: pid_t
  let windowID: CGWindowID
  let app: String
  let bundleId: String?
  var title: String
  /// Global CG points, top-left origin. Refreshed on every capture: windows move.
  var bounds: CGRect

  var summary: [String: Any] {
    ["app": app, "title": title, "windowId": Int(windowID)]
  }
}

/// One line of `list-windows`.
struct WindowInfo {
  let id: CGWindowID
  let pid: pid_t
  let app: String
  let bundleId: String?
  let title: String
  let bounds: CGRect
  let onScreen: Bool
  let minimized: Bool
  let appHidden: Bool
  let frontmost: Bool
}

enum Windows {
  /// Every ordinary window (layer 0, a real size, not ours), whatever Space it
  /// is on. Titles need Screen Recording, which the helper has anyway.
  static func list() -> [WindowInfo] {
    guard let raw = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [] }
    trace("window list: \(raw.count) entries")
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let ours = getppid()
    var seen = Set<CGWindowID>()
    var apps: [pid_t: NSRunningApplication?] = [:]
    var minimizedByPid: [pid_t: Set<CGWindowID>] = [:]
    let axTrusted = AXIsProcessTrusted()
    var out: [WindowInfo] = []
    for w in raw {
      guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
            let idNum = w[kCGWindowNumber as String] as? Int,
            let pidNum = w[kCGWindowOwnerPID as String] as? Int,
            let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: boundsDict) else { continue }
      let id = CGWindowID(idNum)
      let pid = pid_t(pidNum)
      if pid == ours || pid == getpid() { continue }
      if bounds.width < 50 || bounds.height < 50 { continue }
      if let alpha = w[kCGWindowAlpha as String] as? Double, alpha == 0 { continue }
      if seen.contains(id) { continue }
      seen.insert(id)
      // Only apps a person would name: the Dock kind, not view services and helpers.
      let app: NSRunningApplication?
      if let known = apps[pid] { app = known } else {
        app = NSRunningApplication(processIdentifier: pid)
        apps[pid] = app
      }
      guard let app, app.activationPolicy == .regular else { continue }
      let name = app.localizedName ?? (w[kCGWindowOwnerName as String] as? String) ?? "pid \(pid)"
      let onScreen = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
      let title = (w[kCGWindowName as String] as? String) ?? ""
      var minimized = false
      if !onScreen && axTrusted {
        if minimizedByPid[pid] == nil { minimizedByPid[pid] = AX.minimizedWindows(pid: pid) }
        minimized = minimizedByPid[pid]!.contains(id)
      }
      out.append(WindowInfo(
        id: id, pid: pid, app: name, bundleId: app.bundleIdentifier, title: title, bounds: bounds,
        onScreen: onScreen, minimized: minimized, appHidden: app.isHidden,
        frontmost: front != nil && front == pid))
    }
    trace("window list: \(out.count) kept")
    return out
  }

  /// The listing the model reads: one window per line, front app first.
  static func describe(_ windows: [WindowInfo]) -> String {
    if windows.isEmpty { return "No windows are open." }
    let sorted = windows.sorted { a, b in
      if a.frontmost != b.frontmost { return a.frontmost }
      if a.onScreen != b.onScreen { return a.onScreen }
      return a.app.localizedCaseInsensitiveCompare(b.app) == .orderedAscending
    }
    var lines = ["Windows (id  app  \"title\"  where  size). select_window by window_id, or by app (+ title)."]
    for w in sorted {
      let place: String
      if w.appHidden { place = "app hidden" }
      else if w.minimized { place = "minimized" }
      else if w.onScreen { place = "on screen" }
      else { place = "other Space or covered" }
      let title = w.title.isEmpty ? "(untitled)" : "\"\(w.title)\""
      let size = "\(Int(w.bounds.width))x\(Int(w.bounds.height))"
      lines.append("\(w.id)  \(w.app)  \(title)  \(place)  \(size)\(w.frontmost ? "  ← frontmost app" : "")")
    }
    return lines.joined(separator: "\n")
  }

  /// Resolve a `select-window` request against the live list.
  static func find(windowId: Int?, app: String?, title: String?) throws -> WindowInfo {
    let all = list()
    if let windowId {
      guard let w = all.first(where: { Int($0.id) == windowId }) else {
        throw HelperError("No window \(windowId) is open now. Run list_windows again.")
      }
      return w
    }
    guard let app, !app.isEmpty else { throw HelperError("select_window needs window_id, or app (and optionally title).") }
    let needle = app.lowercased()
    var candidates = all.filter {
      $0.app.lowercased() == needle || ($0.bundleId?.lowercased() == needle)
    }
    if candidates.isEmpty {
      candidates = all.filter { $0.app.lowercased().contains(needle) || ($0.bundleId?.lowercased().contains(needle) ?? false) }
    }
    if candidates.isEmpty {
      let names = Set(all.map(\.app)).sorted().joined(separator: ", ")
      throw HelperError("No running app called \"\(app)\" has a window. Apps with windows: \(names).")
    }
    if let title, !title.isEmpty {
      let t = title.lowercased()
      candidates = candidates.filter { $0.title.lowercased().contains(t) }
      if candidates.isEmpty { throw HelperError("\(app) has no window whose title contains \"\(title)\". Run list_windows to see its windows.") }
    }
    // The app's front window: on screen first, then the largest.
    return candidates.sorted { a, b in
      if a.onScreen != b.onScreen { return a.onScreen }
      if a.minimized != b.minimized { return !a.minimized }
      return a.bounds.width * a.bounds.height > b.bounds.width * b.bounds.height
    }.first!
  }

  /// The window server's current record of one window, on any Space, or nil once it is gone.
  /// (`optionIncludingWindow` alone answers only for on-screen windows, so scan the full list.)
  static func record(of id: CGWindowID) -> [String: Any]? {
    guard let raw = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return nil }
    return raw.first { ($0[kCGWindowNumber as String] as? Int).map { CGWindowID($0) } == id }
  }

  /// A window's current bounds (it may have moved since selection), or nil once it is gone.
  static func bounds(of id: CGWindowID) -> CGRect? {
    guard let w = record(of: id), let dict = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: dict)
  }

  static func title(of id: CGWindowID) -> String? {
    record(of: id)?[kCGWindowName as String] as? String
  }
}
