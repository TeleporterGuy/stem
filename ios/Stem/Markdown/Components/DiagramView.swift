import SwiftUI
import WebKit

/// Draws Mermaid source the way the desktop's <Diagram> does: with pele, in a
/// web view, links and images off so a diagram can only be a picture, and the
/// SVG sanitized by DOMPurify before it is inserted, as on the desktop.
/// pele.global.js and purify.min.js ship in the app bundle (project.yml copies
/// them from the repo's node_modules, the versions the desktop renders with) and
/// are injected as user scripts with the draw function; the page itself runs no
/// script at all (its CSP allows none), has no base URL, may fetch nothing and
/// may not navigate anywhere. The web view reports the drawing's
/// height back and the cell sizes to it.
///
/// While `live` (the reply is still streaming), each new source redraws in
/// place from its complete lines, keeping the last drawing that worked, so the
/// diagram grows as it is written. Once the source is final, one pele can't
/// parse reports an error and the caller shows the source instead.
struct DiagramView: View {
    let source: String
    var live = false
    /// Called once if pele could not draw the final source.
    var onError: () -> Void = {}

    @Environment(\.colorScheme) private var scheme
    @State private var height: CGFloat = 0

    var body: some View {
        DiagramWebView(source: source, live: live, dark: scheme == .dark, height: $height, onError: onError)
            // Keyed on the scheme, so a light/dark flip redraws in the new colors.
            .id(scheme)
            .frame(height: max(height, 60))
            .overlay {
                if height == 0 { ProgressView().controlSize(.small) }
            }
    }
}

private struct DiagramWebView: UIViewRepresentable {
    let source: String
    let live: Bool
    let dark: Bool
    @Binding var height: CGFloat
    let onError: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        // A weak hop: the controller retains its handlers, and the coordinator owns nothing of the view.
        config.userContentController.add(WeakHandler(context.coordinator), name: "diagram")
        // User scripts are not subject to the page's CSP, so these run while the page itself may run nothing.
        for script in [Self.peleScript, Self.purifyScript].compactMap({ $0 }) {
            config.userContentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
        }
        config.userContentController.addUserScript(
            WKUserScript(source: Self.drawScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.backgroundColor = .clear
        view.navigationDelegate = context.coordinator
        context.coordinator.drawn = (source, live)
        // The first drawing comes from didFinish, once the draw function is in place.
        view.loadHTMLString(Self.page(dark: dark), baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        // A streaming source grew (or settled): redraw in place, no reload.
        guard coordinator.drawn != (source, live) else { return }
        coordinator.drawn = (source, live)
        // Before the page has loaded, didFinish draws the latest source instead.
        if coordinator.ready { coordinator.redraw(view) }
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "diagram")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: DiagramWebView
        /// The source and mode the page was last asked to draw.
        var drawn: (String, Bool) = ("", false)
        /// True once the page (and its draw function) has loaded.
        var ready = false
        private var failed = false
        private var loaded = false
        init(_ parent: DiagramWebView) { self.parent = parent }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            if let h = body["height"] as? Double, h > 0 {
                parent.height = CGFloat(h)
            } else if body["error"] != nil, !failed {
                failed = true
                parent.onError()
            }
        }

        func redraw(_ view: WKWebView) {
            view.evaluateJavaScript("draw(\(DiagramWebView.json(drawn.0)), \(drawn.1))")
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            ready = true
            redraw(webView)
        }

        // The one page we load, and nothing after it: a diagram never navigates anywhere.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor action: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if !loaded, action.targetFrame?.isMainFrame == true, action.request.url?.absoluteString == "about:blank" {
                loaded = true
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }
    }

    private final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: WKScriptMessageHandler?
        init(_ target: WKScriptMessageHandler) { self.target = target }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            target?.userContentController(controller, didReceive: message)
        }
    }

    /// The colors the desktop draws with (Stem's light and dark tokens), as pele's CSS variables.
    private static func themeVariables(dark: Bool) -> String {
        let vars: [(String, String)] = [
            ("bg", dark ? "#242119" : "#faf8f3"),
            ("fg", dark ? "#f0ece4" : "#23211d"),
            ("muted", dark ? "#9b948a" : "#6d675d"),
            ("line", dark ? "#9b948a" : "#6d675d"),
            ("surface", dark ? "#2e2a23" : "#fffdf9"),
            ("surface-alt", dark ? "#2f2b25" : "#efeae0"),
            ("border", dark ? "#9b948a" : "#6d675d"),
            ("accent", dark ? "#c79257" : "#9a6230"),
            ("critical", "#c53030"),
            ("font", "-apple-system, system-ui, sans-serif"),
            ("series-1", dark ? "#3987e5" : "#2a78d6"), ("series-2", dark ? "#d95926" : "#eb6834"),
            ("series-3", dark ? "#199e70" : "#1baf7a"), ("series-4", dark ? "#c98500" : "#eda100"),
            ("series-5", dark ? "#d55181" : "#e87ba4"), ("series-6", "#008300"),
            ("series-7", dark ? "#9085e9" : "#4a3aa7"), ("series-8", dark ? "#e66767" : "#e34948"),
        ]
        return vars.map { "--pele-\($0.0): \($0.1);" }.joined(separator: " ")
    }

    /// pele.global.js and DOMPurify from the bundle, read once.
    private static let peleScript = bundledScript("pele.global")
    private static let purifyScript = bundledScript("purify.min")

    private static func bundledScript(_ name: String) -> String? {
        Bundle.main.url(forResource: name, withExtension: "js").flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    }

    /// Draws into #d; the coordinator calls draw(source, live) for every source.
    /// Streaming: only complete lines, and a line that doesn't parse yet keeps the last drawing.
    private static let drawScript = """
    const post = (m) => window.webkit.messageHandlers.diagram.postMessage(m);
    const box = document.getElementById('d');
    const report = () => post({ height: Math.ceil(box.getBoundingClientRect().height) });
    new ResizeObserver(report).observe(box);
    function draw(source, live) {
      const cut = source.lastIndexOf('\\n');
      const code = (live ? (cut === -1 ? '' : source.slice(0, cut)) : source).trim();
      if (!code) return;
      try {
        const { svg } = pele.render(code, {
          idPrefix: 'stem-diagram', maxWidth: box.clientWidth || undefined,
          fontFamily: '-apple-system, system-ui, sans-serif', fontSize: 14,
          links: false, images: false
        });
        // Pele escapes labels itself; the source is model text, so DOMPurify too.
        box.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        report();
      } catch (e) {
        if (!live) post({ error: String(e && e.message || e) });
      }
    }
    """

    fileprivate static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        // Inside a <script>, "</" would end it early.
        return text.replacingOccurrences(of: "</", with: "<\\/")
    }

    static func page(dark: Bool) -> String {
        """
        <!doctype html>
        <html><head>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          #d { display: flex; justify-content: center; \(themeVariables(dark: dark)) }
          #d svg { max-width: 100% !important; height: auto; }
        </style>
        </head><body><div id="d"></div></body></html>
        """
    }
}
