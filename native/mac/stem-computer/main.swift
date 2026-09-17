import Foundation

// stem-computer — the Mac half of Stem's computer-control persona.
//
// A long-lived child of the Stem desktop app that speaks one JSON object per
// line on stdin/stdout: the app sends {id, cmd, ...}, this answers {id, ok,
// ...}, and while a run is being watched it may also write an unsolicited
// {"event":"human-input"} the moment the person at the keyboard touches
// anything. Everything that needs a macOS permission — capturing the screen
// (Screen Recording), posting events (Accessibility), listening for the user's
// own input (Input Monitoring) — is attributed to the PARENT app by TCC, which
// is why this is a plain child process and never a launchd job or a separate
// app of its own.
//
// Coordinates on the wire are pixels of the LAST SCREENSHOT this helper
// produced (downscaled so the long side is at most MAX_SIDE); the helper keeps
// the scale and maps them to global display points itself. The model on the
// far end never sees points, backing pixels, or a Retina factor.

let stdoutLock = NSLock()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8) else { return }
  stdoutLock.lock()
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
  stdoutLock.unlock()
}

func fail(_ id: Any, _ message: String) {
  emit(["id": id, "ok": false, "error": message])
}

func number(_ v: Any?) -> Double? {
  if let d = v as? Double { return d }
  if let i = v as? Int { return Double(i) }
  if let n = v as? NSNumber { return n.doubleValue }
  return nil
}

let capture = Capture()
let input = Input(capture: capture)
let watch = Watch()

/// Every input command settles for a beat and then answers with a fresh frame,
/// so one round-trip carries both the effect and the evidence of it.
func answerWithScreenshot(_ id: Any, settleMs: Int = 300) {
  if settleMs > 0 { usleep(useconds_t(settleMs) * 1000) }
  do {
    let shot = try capture.screenshot()
    let cursor = input.cursorInScreenshot()
    emit(["id": id, "ok": true, "screenshot": shot, "cursor": cursor])
  } catch {
    fail(id, "\(error)")
  }
}

while let line = readLine(strippingNewline: true) {
  guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
  guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    emit(["ok": false, "error": "unreadable command"])
    continue
  }
  let id: Any = obj["id"] ?? NSNull()
  let cmd = obj["cmd"] as? String ?? ""
  do {
    switch cmd {
    case "status":
      emit(["id": id, "ok": true, "status": Status.check()])
    case "request-access":
      emit(["id": id, "ok": true, "status": Status.request()])
    case "screenshot":
      answerWithScreenshot(id, settleMs: 0)
    case "cursor":
      emit(["id": id, "ok": true, "cursor": input.cursorInScreenshot()])
    case "move":
      try input.move(x: number(obj["x"]), y: number(obj["y"]))
      answerWithScreenshot(id)
    case "click":
      try input.click(
        x: number(obj["x"]), y: number(obj["y"]),
        button: obj["button"] as? String ?? "left",
        count: Int(number(obj["count"]) ?? 1))
      answerWithScreenshot(id)
    case "drag":
      let from = obj["from"] as? [String: Any] ?? [:]
      let to = obj["to"] as? [String: Any] ?? [:]
      try input.drag(fromX: number(from["x"]), fromY: number(from["y"]), toX: number(to["x"]), toY: number(to["y"]))
      answerWithScreenshot(id)
    case "scroll":
      try input.scroll(
        x: number(obj["x"]), y: number(obj["y"]),
        direction: obj["dir"] as? String ?? "down",
        amount: Int(number(obj["amount"]) ?? 3))
      answerWithScreenshot(id)
    case "type":
      try input.type(text: obj["text"] as? String ?? "")
      answerWithScreenshot(id)
    case "key":
      try input.key(combo: obj["combo"] as? String ?? "")
      answerWithScreenshot(id)
    case "hold":
      try input.hold(combo: obj["combo"] as? String ?? "", ms: Int(number(obj["ms"]) ?? 0))
      answerWithScreenshot(id)
    case "wait":
      answerWithScreenshot(id, settleMs: Int(number(obj["ms"]) ?? 1000))
    case "zoom":
      let shot = try capture.zoom(
        x: number(obj["x"]) ?? 0, y: number(obj["y"]) ?? 0,
        w: number(obj["w"]) ?? 0, h: number(obj["h"]) ?? 0)
      emit(["id": id, "ok": true, "screenshot": shot, "cursor": input.cursorInScreenshot()])
    case "watch":
      let on = obj["on"] as? Bool ?? true
      if on {
        try watch.start { kind in emit(["event": "human-input", "kind": kind]) }
      } else {
        watch.stop()
      }
      emit(["id": id, "ok": true])
    case "stop":
      watch.stop()
      emit(["id": id, "ok": true])
      exit(0)
    default:
      fail(id, "unknown command \"\(cmd)\"")
    }
  } catch {
    fail(id, "\(error)")
  }
}
watch.stop()
