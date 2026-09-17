import CoreGraphics
import Foundation

/// The mark every event this helper posts carries, so the watch tap can tell
/// the persona's clicks from the person's ("STEM" in ASCII).
let STEM_EVENT_TAG: Int64 = 0x5354_454D

/// Mouse and keyboard, posted as CGEvents at the session level. Session-level
/// posts do not pass a HID-level tap, and every one is tagged besides — both
/// belts, because some apps re-post what they receive.
final class Input {
  private let capture: Capture
  private let source: CGEventSource

  init(capture: Capture) {
    self.capture = capture
    guard let src = CGEventSource(stateID: .combinedSessionState) else {
      fatalError("no event source")
    }
    src.userData = STEM_EVENT_TAG
    source = src
  }

  private func post(_ event: CGEvent?) throws {
    guard let event else { throw HelperError("Could not build an input event.") }
    event.setIntegerValueField(.eventSourceUserData, value: STEM_EVENT_TAG)
    event.post(tap: .cgSessionEventTap)
  }

  private func pause(_ ms: Int) { usleep(useconds_t(max(0, ms)) * 1000) }

  private func currentPoint() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
  }

  func cursorInScreenshot() -> [String: Any] {
    capture.toPixel(currentPoint())
  }

  /// A point from the command, or the cursor's current place when both are absent.
  private func target(x: Double?, y: Double?) throws -> CGPoint {
    if let x, let y { return try capture.toPoint(x: x, y: y) }
    if x == nil && y == nil { return currentPoint() }
    throw HelperError("Give both x and y.")
  }

  func move(x: Double?, y: Double?) throws {
    let p = try target(x: x, y: y)
    try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
  }

  func click(x: Double?, y: Double?, button: String, count: Int) throws {
    let p = try target(x: x, y: y)
    let (down, up, btn): (CGEventType, CGEventType, CGMouseButton)
    switch button {
    case "right": (down, up, btn) = (.rightMouseDown, .rightMouseUp, .right)
    case "middle": (down, up, btn) = (.otherMouseDown, .otherMouseUp, .center)
    default: (down, up, btn) = (.leftMouseDown, .leftMouseUp, .left)
    }
    try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: btn))
    pause(30)
    let clicks = max(1, min(count, 3))
    for n in 1...clicks {
      let d = CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: p, mouseButton: btn)
      d?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
      try post(d)
      pause(20)
      let u = CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: p, mouseButton: btn)
      u?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
      try post(u)
      if n < clicks { pause(60) }
    }
  }

  func drag(fromX: Double?, fromY: Double?, toX: Double?, toY: Double?) throws {
    guard let fromX, let fromY, let toX, let toY else { throw HelperError("A drag needs from {x,y} and to {x,y}.") }
    let a = try capture.toPoint(x: fromX, y: fromY)
    let b = try capture.toPoint(x: toX, y: toY)
    try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: a, mouseButton: .left))
    pause(40)
    try post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left))
    pause(80)
    // A handful of intermediate drags: many apps only start a drag once the
    // pointer has travelled, and some ignore a single jump.
    let steps = 12
    for i in 1...steps {
      let t = Double(i) / Double(steps)
      let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
      try post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
      pause(20)
    }
    pause(60)
    try post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left))
  }

  func scroll(x: Double?, y: Double?, direction: String, amount: Int) throws {
    let p = try target(x: x, y: y)
    try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    pause(30)
    let lines = Int32(max(1, min(amount, 50)))
    var vertical: Int32 = 0
    var horizontal: Int32 = 0
    switch direction {
    case "up": vertical = lines
    case "down": vertical = -lines
    case "left": horizontal = lines
    case "right": horizontal = -lines
    default: throw HelperError("scroll direction must be up, down, left or right.")
    }
    try post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0))
  }

  /// Types text as Unicode, in short chunks: keyboardSetUnicodeString takes a
  /// bounded string per event, and a chunked stream also lets the app keep up.
  func type(text: String) throws {
    guard !text.isEmpty else { throw HelperError("Nothing to type.") }
    let scalars = Array(text.utf16)
    var i = 0
    while i < scalars.count {
      let end = min(i + 20, scalars.count)
      var chunk = Array(scalars[i..<end])
      let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
      down?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
      try post(down)
      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
      up?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
      try post(up)
      pause(15)
      i = end
    }
  }

  /// A key or chord in xdotool spelling: "Return", "cmd+shift+t", "ctrl+c".
  func key(combo: String) throws {
    let parsed = try KeyMap.parse(combo)
    let down = CGEvent(keyboardEventSource: source, virtualKey: parsed.code, keyDown: true)
    down?.flags = parsed.flags
    try post(down)
    pause(30)
    let up = CGEvent(keyboardEventSource: source, virtualKey: parsed.code, keyDown: false)
    up?.flags = parsed.flags
    try post(up)
  }

  func hold(combo: String, ms: Int) throws {
    let parsed = try KeyMap.parse(combo)
    let down = CGEvent(keyboardEventSource: source, virtualKey: parsed.code, keyDown: true)
    down?.flags = parsed.flags
    try post(down)
    pause(max(50, min(ms, 5000)))
    let up = CGEvent(keyboardEventSource: source, virtualKey: parsed.code, keyDown: false)
    up?.flags = parsed.flags
    try post(up)
  }
}
