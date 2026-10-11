import SwiftUI

// Quiz, Form and Replies: the components that answer back. Each sends a plain
// user message through `mdxActions` (the composer's own send path), only from
// a tap, in the same wording as the desktop (src/renderer/mdx/components.tsx,
// Replies.tsx), so the assistant reads the same thing from either device.

struct MdxQuiz: View {
    let topic: String?
    let children: [MdxBlock]
    @Environment(\.mdxActions) private var actions
    @State private var selected: [Int: Int] = [:]
    @State private var checked = false
    @State private var sent = false

    private struct Question { var prompt: String?; var answer: String?; var choices: [String] }

    private var questions: [Question] {
        MdxText.components(children, named: "Question").map { q in
            Question(prompt: q.attrs["prompt"], answer: q.attrs["answer"],
                     choices: MdxText.components(q.children, named: "Choice").map { MdxText.plain($0.children) })
        }
    }

    private func norm(_ s: String?) -> String { (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    private func isCorrect(_ qi: Int, _ q: Question) -> Bool {
        guard let sel = selected[qi], sel < q.choices.count else { return false }
        return norm(q.choices[sel]) == norm(q.answer)
    }

    var body: some View {
        let qs = questions
        if qs.isEmpty {
            MdxBlocksView(blocks: children)
        } else {
            let score = qs.enumerated().filter { isCorrect($0.offset, $0.element) }.count
            VStack(alignment: .leading, spacing: 14) {
                if let topic, !topic.isEmpty {
                    Label(topic, systemImage: "checkmark.seal").font(.subheadline.weight(.semibold))
                }
                ForEach(Array(qs.enumerated()), id: \.offset) { qi, q in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(q.prompt ?? "Question \(qi + 1)").font(.subheadline.weight(.semibold))
                        ForEach(Array(q.choices.enumerated()), id: \.offset) { ci, choice in
                            choiceButton(qi: qi, ci: ci, text: choice, question: q)
                        }
                    }
                }
                HStack(spacing: 10) {
                    if !checked {
                        Button("Check answers") { checked = true }
                            .buttonStyle(.borderedProminent)
                            .disabled(!qs.indices.allSatisfy { selected[$0] != nil })
                    } else {
                        Text("Score: \(score)/\(qs.count)").font(.subheadline.weight(.semibold)).monospacedDigit()
                        if let actions {
                            Button(sent ? "Sent" : "Send results") { send(qs, score: score, actions) }
                                .buttonStyle(.bordered)
                                .disabled(actions.running || sent)
                        }
                    }
                }
                .font(.subheadline)
            }
            .mdxCard()
        }
    }

    private func choiceButton(qi: Int, ci: Int, text: String, question q: Question) -> some View {
        let picked = selected[qi] == ci
        let correct = checked && norm(text) == norm(q.answer)
        let wrongPick = checked && picked && !correct
        let tint: Color? = correct ? .green : wrongPick ? .red : picked ? .accentColor : nil
        return Button {
            selected[qi] = ci
        } label: {
            HStack {
                Inline(text).multilineTextAlignment(.leading)
                Spacer(minLength: 6)
                if correct { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                else if wrongPick { Image(systemName: "xmark.circle.fill").foregroundStyle(.red) }
            }
            .font(.subheadline)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((tint ?? Color(.systemBackground)).opacity(tint == nil ? 1 : 0.14), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(tint ?? Color(.separator), lineWidth: tint == nil ? 0.5 : 1.2))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(checked)
    }

    /// Only ever from the user's tap: the assistant can't start its own follow-ups.
    private func send(_ qs: [Question], score: Int, _ actions: MdxActions) {
        guard !actions.running, !sent else { return }
        let wrong = qs.enumerated().filter { !isCorrect($0.offset, $0.element) }.map { qi, q -> String in
            let chosen = selected[qi].flatMap { $0 < q.choices.count ? q.choices[$0].trimmingCharacters(in: .whitespacesAndNewlines) : nil } ?? "(no answer)"
            return "- \"\(q.prompt ?? "Question \(qi + 1)")\" — I answered \"\(chosen)\" (correct: \"\(q.answer ?? "")\")."
        }
        let head = "I took the \(topic.flatMap { $0.isEmpty ? nil : "\($0) " } ?? "")quiz and scored \(score)/\(qs.count)."
        let body = wrong.isEmpty
            ? "\nI got them all right — anything else worth knowing about \(topic ?? "this topic")?"
            : "\nI got these wrong:\n\(wrong.joined(separator: "\n"))\nPlease explain the ones I missed."
        actions.submit(head + body)
        sent = true
    }
}

struct MdxForm: View {
    let prompt: String?
    let submitLabel: String?
    let children: [MdxBlock]
    @Environment(\.mdxActions) private var actions
    @Environment(\.mdxFormHost) private var host
    @Environment(\.mdxSource) private var source
    /// The field whose "Other…" was just picked: its text field takes the caret.
    @FocusState private var otherFocus: String?

    private var drafts: FormDrafts { FormDrafts.shared }

    var body: some View {
        let fs = MdxFieldSpec.list(children)
        if fs.isEmpty {
            MdxBlocksView(blocks: children)
        } else if let actions {
            live(fs, actions)
        } else {
            // Read where nothing can be sent back (a fact's source, approvals):
            // what is being asked, and how to answer.
            VStack(alignment: .leading, spacing: 6) {
                if let prompt, !prompt.isEmpty { Text(prompt).font(.subheadline.weight(.semibold)) }
                ForEach(fs, id: \.key) { f in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(.secondary)
                        Text(f.label) + Text(f.options.isEmpty ? "" : " (\(f.options.joined(separator: " / ")))").foregroundStyle(.secondary)
                    }
                    .font(.subheadline)
                }
                Text("Reply with these to answer.").font(.caption).foregroundStyle(.secondary)
            }
            .mdxCard()
        }
    }

    private func key(_ fs: [MdxFieldSpec]) -> String {
        "\(source?.key ?? "")|\(prompt ?? "")|\(fs.map(\.key).joined(separator: ","))"
    }

    private func live(_ fs: [MdxFieldSpec], _ actions: MdxActions) -> some View {
        let key = key(fs)
        let draft = drafts.draft(key)
        let locked = draft.sent
        let answered = draft.answered(fs)
        return VStack(alignment: .leading, spacing: 14) {
            if let prompt, !prompt.isEmpty { Text(prompt).font(.subheadline.weight(.semibold)) }
            ForEach(fs, id: \.key) { f in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(f.label).font(.subheadline)
                        Spacer(minLength: 6)
                        if let host, !locked {
                            Button { host.ask(f.label) } label: {
                                Label("Ask", systemImage: "questionmark.bubble").font(.caption)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityHint("Ask about this question. Your answers so far are kept.")
                        }
                    }
                    if let hint = f.hint, !hint.isEmpty {
                        Text(hint).font(.caption).foregroundStyle(.secondary)
                    }
                    if f.type == "choice" {
                        choices(f, key: key, draft: draft, locked: locked)
                    } else {
                        input(f, key: key, draft: draft)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(.separator), lineWidth: 0.5))
                            .disabled(locked)
                    }
                }
            }
            if locked {
                Label("Answers sent", systemImage: "checkmark").font(.caption).foregroundStyle(.secondary)
            } else if let host {
                Text("\(answered) of \(fs.count) answered · skip any you are unsure about · send from the bar \(host.place == .below ? "below" : "above")")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Button(submitLabel ?? "Submit") { submit(fs, key: key, actions) }
                    .buttonStyle(.borderedProminent)
                    .disabled(actions.running || answered == 0)
            }
        }
        .mdxCard()
        .opacity(locked ? 0.75 : 1)
        .overlay(RoundedRectangle(cornerRadius: 10)
            .strokeBorder(Color.accentColor, lineWidth: 2)
            .opacity(host?.flashKey == key ? 1 : 0)
            .animation(.easeOut(duration: 0.4), value: host?.flashKey == key))
        .onAppear { register(fs, key: key, locked: locked, actions) }
        .onChange(of: locked) { _, now in register(fs, key: key, locked: now, actions) }
    }

    private func register(_ fs: [MdxFieldSpec], key: String, locked: Bool, _ actions: MdxActions) {
        guard let host else { return }
        if locked { host.unregister(key); return }
        host.register(key: key, prompt: prompt, fields: fs,
                      source: source ?? MdxSource(key: "", scrollId: "", order: 0), submit: actions.submit)
    }

    private func update(_ key: String, _ change: (inout MdxFormDraft) -> Void) {
        var d = drafts.draft(key)
        change(&d)
        drafts.set(key, d, persist: !(source?.key ?? "").isEmpty)
    }

    private func choices(_ f: MdxFieldSpec, key: String, draft: MdxFormDraft, locked: Bool) -> some View {
        let picked = draft.values[f.key] ?? []
        let options = f.options + (f.other ? [MdxFormDraft.other] : [])
        return VStack(alignment: .leading, spacing: 8) {
            MdxFlowLayout(spacing: 6) {
                ForEach(options, id: \.self) { o in
                    Button {
                        update(key) { d in
                            let cur = d.values[f.key] ?? []
                            if f.multiple {
                                d.values[f.key] = cur.contains(o) ? cur.filter { $0 != o } : cur + [o]
                            } else {
                                d.values[f.key] = cur == [o] ? [] : [o]
                            }
                        }
                        if o == MdxFormDraft.other, !picked.contains(o) { otherFocus = f.key }
                    } label: {
                        Text(o == MdxFormDraft.other ? "Other…" : o).multilineTextAlignment(.leading)
                    }
                    .chipStyle(on: picked.contains(o))
                    .font(.subheadline)
                    .overlay(Capsule().strokeBorder(Color(.separator), lineWidth: picked.contains(o) ? 0 : 0.5))
                    .accessibilityAddTraits(picked.contains(o) ? .isSelected : [])
                    .disabled(locked)
                }
            }
            if f.other, picked.contains(MdxFormDraft.other) {
                TextField("Your answer", text: Binding(
                    get: { drafts.draft(key).others[f.key] ?? "" },
                    set: { v in update(key) { $0.others[f.key] = v } }))
                    .focused($otherFocus, equals: f.key)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(.separator), lineWidth: 0.5))
                    .disabled(locked)
            }
        }
    }

    @ViewBuilder private func input(_ f: MdxFieldSpec, key: String, draft: MdxFormDraft) -> some View {
        let binding = Binding(
            get: { drafts.draft(key).values[f.key]?.first ?? "" },
            set: { v in update(key) { $0.values[f.key] = [v] } })
        switch f.type {
        case "textarea":
            TextField(f.placeholder ?? "", text: binding, axis: .vertical).lineLimit(3...8)
        case "number":
            TextField(f.placeholder ?? "", text: binding).keyboardType(.decimalPad)
        default:
            TextField(f.placeholder ?? "", text: binding)
        }
    }

    /// Without a host (no input on screen to send beside): the form's own button.
    private func submit(_ fs: [MdxFieldSpec], key: String, _ actions: MdxActions) {
        let d = drafts.draft(key)
        guard !actions.running, !d.sent, d.answered(fs) > 0 else { return }
        actions.submit(d.text(prompt: prompt, fields: fs))
        update(key) { $0.sent = true }
    }
}

/// Suggested follow-ups: only on the newest settled reply of a chat.
struct MdxReplies: View {
    let children: [MdxBlock]
    @Environment(\.mdxActions) private var actions
    @Environment(\.mdxIsLatest) private var isLatest

    var body: some View {
        let items = MdxText.components(children, named: "Reply")
            .map { MdxText.plain($0.children) }
            .filter { !$0.isEmpty }
            .prefix(4)
        if let actions, isLatest, !items.isEmpty {
            MdxFlowLayout(spacing: 6) {
                ForEach(Array(items), id: \.self) { t in
                    Button {
                        if !actions.running { actions.submit(t) }
                    } label: {
                        Text(t).multilineTextAlignment(.leading)
                    }
                    .chipStyle(on: false)
                    .font(.subheadline)
                    .overlay(Capsule().strokeBorder(Color.accentColor.opacity(0.35), lineWidth: 0.8))
                    .disabled(actions.running)
                }
            }
        }
    }
}

/// Lays children out left to right, wrapping onto new lines.
struct MdxFlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for (i, size) in zip(row.items, row.sizes) {
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var items: [Int] = []; var sizes: [CGSize] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(_ maxWidth: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for (i, v) in subviews.enumerated() {
            var size = v.sizeThatFits(.unspecified)
            if size.width > maxWidth { size = v.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil)) }
            let needed = row.items.isEmpty ? size.width : row.width + spacing + size.width
            if !row.items.isEmpty, needed > maxWidth {
                rows.append(row)
                row = Row()
            }
            row.width = row.items.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.items.append(i)
            row.sizes.append(size)
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}
