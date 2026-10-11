import Foundation
import Observation
import SwiftUI

// Where a <Form>'s answers are sent from. A view that hosts forms (a chat, a
// mail conversation) owns one Send button in its answer bar, next to the input
// the user already types in, instead of a submit button inside each form: the
// input stays free for asking about a question, and asking never costs the
// picks already made (they live in FormDrafts, not in the form's view state).
// Port of src/renderer/mdx/FormHost.tsx and AnswerBar.tsx.

/// One field of a form, as read from its <Field> tag.
struct MdxFieldSpec: Hashable {
    var key: String
    var label: String
    /// text, textarea, number or choice
    var type: String
    var placeholder: String?
    var hint: String?
    var options: [String]
    var multiple: Bool
    var other: Bool

    static func list(_ children: [MdxBlock]) -> [MdxFieldSpec] {
        MdxText.components(children, named: "Field").enumerated().map { i, f in
            let key = f.attrs["name"] ?? f.attrs["label"] ?? "field-\(i)"
            let options = MdxText.components(f.children, named: "Option")
                .map { MdxText.plain($0.children) }
                .filter { !$0.isEmpty }
            let t = f.attrs["type"]
            let type = t == "textarea" || t == "number" ? t! : t == "choice" || !options.isEmpty ? "choice" : "text"
            return MdxFieldSpec(key: key, label: f.attrs["label"] ?? f.attrs["name"] ?? key, type: type,
                                placeholder: f.attrs["placeholder"], hint: f.attrs["hint"], options: options,
                                multiple: f.attrs["multiple"] == "true", other: f.attrs["other"] == "true")
        }
    }
}

/// A form's picks and typed answers. Every value is a list: one entry for a
/// text field or a single choice, any number for a multiple choice.
struct MdxFormDraft: Codable, Equatable {
    var values: [String: [String]] = [:]
    /// Text typed under "Other…", per field.
    var others: [String: String] = [:]
    var sent = false

    static let other = "__other"

    func answer(_ f: MdxFieldSpec) -> String {
        let v = values[f.key] ?? []
        if f.type != "choice" { return (v.first ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        return v.map { $0 == Self.other ? (others[f.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) : $0 }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }

    func answered(_ fields: [MdxFieldSpec]) -> Int { fields.filter { !answer($0).isEmpty }.count }

    /// The answers as one readable message: the prompt, then a line per field.
    /// Same text as the desktop's formAnswerText, which mail's openForm reads back.
    func text(prompt: String?, fields: [MdxFieldSpec]) -> String {
        let lines = fields.map { f -> String in
            let a = answer(f)
            return "- \(f.label): \(a.isEmpty ? "(skipped)" : a)"
        }
        return (prompt.flatMap { $0.isEmpty ? nil : "\($0)\n" } ?? "") + lines.joined(separator: "\n")
    }
}

/// Drafts keyed by form (source + prompt + field keys), so picks survive leaving
/// the chat and coming back, and a relaunch.
@MainActor @Observable
final class FormDrafts {
    static let shared = FormDrafts()

    private static let storageKey = "stem.formDrafts"
    private static let maxDrafts = 200
    private(set) var drafts: [String: MdxFormDraft] = [:]
    /// Oldest first; the newest `maxDrafts` are the ones kept.
    @ObservationIgnored private var order: [String] = []

    private struct Stored: Codable { var key: String; var draft: MdxFormDraft }

    init() {
        guard let d = UserDefaults.standard.data(forKey: Self.storageKey),
              let list = try? JSONDecoder().decode([Stored].self, from: d) else { return }
        for s in list { drafts[s.key] = s.draft; order.append(s.key) }
    }

    func draft(_ key: String) -> MdxFormDraft { drafts[key] ?? MdxFormDraft() }

    func set(_ key: String, _ draft: MdxFormDraft, persist: Bool = true) {
        drafts[key] = draft
        guard persist else { return }
        order.removeAll { $0 == key }
        order.append(key)
        if order.count > Self.maxDrafts {
            for k in order.prefix(order.count - Self.maxDrafts) { drafts[k] = nil }
            order.removeFirst(order.count - Self.maxDrafts)
        }
        let list = order.compactMap { k in drafts[k].map { Stored(key: k, draft: $0) } }
        if let d = try? JSONEncoder().encode(list) { UserDefaults.standard.set(d, forKey: Self.storageKey) }
    }
}

/// Where a component renders: forms key their drafts by `key`, the answer bar
/// scrolls to `scrollId`, and `order` tells which form on screen is newest.
struct MdxSource: Equatable {
    var key: String
    var scrollId: String
    var order: Double
}

@MainActor @Observable
final class MdxFormHost {
    /// Where the bar sits relative to the forms. Below on the phone in both
    /// chat and mail: the input is at the bottom of either screen.
    enum Place { case below, above }

    struct Hosted {
        var key: String
        var prompt: String?
        var fields: [MdxFieldSpec]
        var source: MdxSource
        var seq: Int
        var submit: (String) -> Void
    }

    let place: Place
    private(set) var forms: [String: Hosted] = [:]
    /// The form the bar just revealed, flashed for a moment.
    var flashKey: String?
    /// Put "About “<label>”: " in the input and focus it.
    @ObservationIgnored var ask: (String) -> Void = { _ in }
    /// Scroll to a form's message or mail.
    @ObservationIgnored var scrollTo: (String) -> Void = { _ in }
    @ObservationIgnored private var seq = 0

    init(place: Place = .below) { self.place = place }

    /// A form on screen that can still be answered. Forms stay registered when
    /// a lazy list unloads them, so scrolling away doesn't take the bar along.
    func register(key: String, prompt: String?, fields: [MdxFieldSpec], source: MdxSource, submit: @escaping (String) -> Void) {
        var s = forms[key]?.seq ?? 0
        if s == 0 {
            seq += 1
            s = seq
        }
        forms[key] = Hosted(key: key, prompt: prompt, fields: fields, source: source, seq: s, submit: submit)
    }

    func unregister(_ key: String) { forms[key] = nil }

    /// The form the bar answers: the newest unsent one.
    var active: Hosted? {
        forms.values
            .filter { !FormDrafts.shared.draft($0.key).sent }
            .max { ($0.source.order, $0.seq) < ($1.source.order, $1.seq) }
    }

    func send(_ form: Hosted, running: Bool) {
        var draft = FormDrafts.shared.draft(form.key)
        guard !running, !draft.sent, draft.answered(form.fields) > 0 else { return }
        form.submit(draft.text(prompt: form.prompt, fields: form.fields))
        draft.sent = true
        FormDrafts.shared.set(form.key, draft)
        forms[form.key] = nil
    }

    func reveal(_ form: Hosted) {
        scrollTo(form.source.scrollId)
        flashKey = form.key
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            if flashKey == form.key { flashKey = nil }
        }
    }
}

extension EnvironmentValues {
    @Entry var mdxFormHost: MdxFormHost? = nil
    @Entry var mdxSource: MdxSource? = nil
}

/// The answer bar: sits against the view's input while a form there is waiting
/// for answers. It counts the answers and holds the one Send button; the input
/// next to it stays the input, for asking about a question or answering in words.
struct MdxAnswerBar: View {
    let host: MdxFormHost
    let running: Bool

    var body: some View {
        if let form = host.active {
            let total = form.fields.count
            let answered = FormDrafts.shared.draft(form.key).answered(form.fields)
            HStack(spacing: 8) {
                HStack(spacing: 3) {
                    ForEach(0..<total, id: \.self) { i in
                        Circle().fill(i < answered ? Color.accentColor : Color(.systemGray4)).frame(width: 6, height: 6)
                    }
                }
                .accessibilityHidden(true)
                Text("\(answered) of \(total) answered").font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                Button { withAnimation { host.reveal(form) } } label: {
                    Image(systemName: host.place == .below ? "arrow.up.to.line" : "arrow.down.to.line")
                        .font(.footnote.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Show the questions")
                Spacer(minLength: 4)
                Button(answered == 0 || answered == total ? "Send answers" : "Send \(answered) answer\(answered == 1 ? "" : "s")") {
                    host.send(form, running: running)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .disabled(answered == 0 || running)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .background(.bar)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Answers")
        }
    }
}
