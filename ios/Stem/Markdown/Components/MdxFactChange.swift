import Foundation
import Observation
import SwiftUI

// <FactChange>: one change a memory check made to a fact, or proposes. The
// mail carries what the change is (the fact, why, the quote that proves it);
// its status is read live from the server, so an Undo pressed on another
// device, or yesterday, shows here. The buttons act at once: each change is
// independent and needs no model, so nothing waits for a Send.
// Port of src/renderer/mdx/FactChange.tsx.

private struct MemoryCheckChangeState: Decodable {
    var id: String
    var status: String
}

/// Live status of memory-check changes, per check.
@MainActor @Observable
final class MemoryChecks {
    static let shared = MemoryChecks()

    private(set) var states: [String: [String: String]] = [:]
    @ObservationIgnored private var asked: Set<String> = []

    func status(_ checkId: String, _ changeId: String) -> String? { states[checkId]?[changeId] }

    /// The first card of a check fetches its states; the rest share them.
    func load(_ checkId: String, client: StemClient) async {
        guard !checkId.isEmpty, !asked.contains(checkId) else { return }
        asked.insert(checkId)
        await refresh(checkId, client: client)
    }

    /// A push said this check changed (another device pressed Undo).
    func changed(_ checkId: String, client: StemClient) {
        guard asked.contains(checkId) else { return }
        Task { await refresh(checkId, client: client) }
    }

    private func refresh(_ checkId: String, client: StemClient) async {
        // quiet on failure: the card falls back to the status the mail was written with.
        if let list = try? await client.call("memory:checkState", [.string(checkId)], as: [MemoryCheckChangeState].self) {
            apply(checkId, list)
        }
    }

    func act(_ checkId: String, _ changeId: String, _ action: String, client: StemClient) async throws {
        let list = try await client.call("memory:checkAct", [.string(checkId), .string(changeId), .string(action)],
                                         as: [MemoryCheckChangeState].self)
        apply(checkId, list)
    }

    private func apply(_ checkId: String, _ list: [MemoryCheckChangeState]) {
        states[checkId] = Dictionary(list.map { ($0.id, $0.status) }, uniquingKeysWith: { _, b in b })
    }
}

struct MdxFactChange: View {
    let attrs: [String: String]
    @Environment(Session.self) private var session: Session?
    @State private var busy = false
    @State private var error: String?

    private static let statuses: Set<String> = ["applied", "undone", "proposed", "dismissed", "removed"]

    private struct Act { var label: String; var action: String; var primary = false }

    var body: some View {
        let check = attrs["check"] ?? ""
        let change = attrs["change"] ?? ""
        let initial = attrs["status"].flatMap { Self.statuses.contains($0) ? $0 : nil } ?? "applied"
        let status = MemoryChecks.shared.status(check, change) ?? initial
        let saved = attrs["kind"] == "save"
        let label = attrs["label"]

        let pill: String, tone: Color, gone: Bool, acts: [Act]
        switch status {
        case "applied":
            pill = label.flatMap { !$0.isEmpty && !$0.hasSuffix("?") ? $0 : nil } ?? (saved ? "Saved" : "Retired")
            tone = .green
            gone = !saved
            acts = [Act(label: "Undo", action: "undo")]
        case "undone":
            pill = saved ? "Not saved" : "Restored"
            tone = .secondary
            gone = saved
            acts = [Act(label: "Redo", action: "redo")]
        case "proposed":
            pill = "Retire?"
            tone = .orange
            gone = false
            acts = [Act(label: "Keep", action: "dismiss"), Act(label: "Retire", action: "apply", primary: true)]
        case "removed":
            // The fact is gone (its folder was disconnected): nothing left to act on.
            pill = "Removed"
            tone = .secondary
            gone = true
            acts = []
        default:
            pill = "Kept"
            tone = .secondary
            gone = false
            acts = [Act(label: "Undo", action: "reopen")]
        }

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(pill.uppercased())
                    .font(.caption2.weight(.semibold))
                    .tracking(0.5)
                    .foregroundStyle(tone)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1)
                    .overlay(Capsule().strokeBorder(tone, lineWidth: 1))
                if let fact = attrs["fact"], !fact.isEmpty {
                    Text("#\(fact)").font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
            Text(attrs["text"] ?? "")
                .font(.subheadline)
                .strikethrough(gone)
                .foregroundStyle(gone ? .secondary : .primary)
            let reason = attrs["reason"] ?? ""
            let quote = attrs["quote"] ?? ""
            if !reason.isEmpty || !quote.isEmpty {
                (Text(reason) + Text(quote.isEmpty ? "" : "\(reason.isEmpty ? "" : " ")“\(quote)”").italic())
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            if !check.isEmpty, !change.isEmpty, !acts.isEmpty {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    ForEach(acts, id: \.action) { a in
                        if a.primary {
                            Button(a.label) { act(check, change, a.action) }.buttonStyle(.borderedProminent)
                        } else {
                            Button(a.label) { act(check, change, a.action) }.buttonStyle(.bordered)
                        }
                    }
                }
                .controlSize(.small)
                .disabled(busy || session == nil)
            }
        }
        .mdxCard()
        .task(id: check) {
            if let session { await MemoryChecks.shared.load(check, client: session.client) }
        }
    }

    private func act(_ check: String, _ change: String, _ action: String) {
        guard let session else { return }
        busy = true
        error = nil
        Task {
            do { try await MemoryChecks.shared.act(check, change, action, client: session.client) }
            catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}
