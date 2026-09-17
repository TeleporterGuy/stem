import CoreGraphics
import Foundation

/// A listen-only event tap that fires once when the PERSON touches the mouse or
/// keyboard while a run is on — the kill switch. Events this helper posted are
/// tagged (see Input) and ignored; session-level posts do not reach a HID tap
/// in the first place.
final class Watch {
  private var tap: CFMachPort?
  private var thread: Thread?
  private var runLoop: CFRunLoop?
  private var fired = false
  private var onHuman: ((String) -> Void)?
  private let lock = NSLock()

  func start(_ handler: @escaping (String) -> Void) throws {
    stop()
    lock.lock(); fired = false; onHuman = handler; lock.unlock()
    let mask: CGEventMask =
      (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.rightMouseDown.rawValue) |
      (1 << CGEventType.otherMouseDown.rawValue) | (1 << CGEventType.mouseMoved.rawValue) |
      (1 << CGEventType.scrollWheel.rawValue) | (1 << CGEventType.keyDown.rawValue) |
      (1 << CGEventType.flagsChanged.rawValue)
    let selfPtr = Unmanaged.passUnretained(self).toOpaque()
    guard let port = CGEvent.tapCreate(
      tap: .cghidEventTap, place: .headInsertEventTap, options: .listenOnly,
      eventsOfInterest: mask,
      callback: { _, type, event, userInfo in
        guard let userInfo else { return Unmanaged.passUnretained(event) }
        let watch = Unmanaged<Watch>.fromOpaque(userInfo).takeUnretainedValue()
        watch.saw(type: type, event: event)
        return Unmanaged.passUnretained(event)
      },
      userInfo: selfPtr
    ) else {
      throw HelperError("Could not watch for your input. Stem needs Input Monitoring access (System Settings → Privacy & Security → Input Monitoring).")
    }
    tap = port
    let t = Thread { [weak self] in
      guard let self, let port = self.tap else { return }
      let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
      let loop = CFRunLoopGetCurrent()
      self.runLoop = loop
      CFRunLoopAddSource(loop, source, .commonModes)
      CGEvent.tapEnable(tap: port, enable: true)
      CFRunLoopRun()
    }
    t.name = "stem-computer-watch"
    thread = t
    t.start()
  }

  private func saw(type: CGEventType, event: CGEvent) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return
    }
    if event.getIntegerValueField(.eventSourceUserData) == STEM_EVENT_TAG { return }
    lock.lock()
    if fired { lock.unlock(); return }
    fired = true
    let handler = onHuman
    lock.unlock()
    let kind: String
    switch type {
    case .keyDown, .flagsChanged: kind = "key"
    default: kind = "mouse"
    }
    handler?(kind)
  }

  func stop() {
    if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
    if let runLoop { CFRunLoopStop(runLoop) }
    tap = nil
    runLoop = nil
    thread = nil
    lock.lock(); onHuman = nil; lock.unlock()
  }
}
