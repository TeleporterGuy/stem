import SwiftUI

struct ChatListView: View {
    @Environment(AppModel.self) private var app
    @Environment(Session.self) private var session

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.chatPath) {
            ChatFolderList(folderId: nil)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .thread(let id): ThreadView(session: session, threadId: id).id(id)
                    case .newChat(let folderId): ThreadView(session: session, threadId: nil, folderId: folderId)
                    case .folder(let id): ChatFolderView(folderId: id)
                    case .mail(let id): MailConversationView(conversationId: id)
                    }
                }
                .task { if !session.chats.loaded { await session.chats.reload() } }
        }
    }
}

/// One folder opened from the list: its subfolders, then its chats.
struct ChatFolderView: View {
    let folderId: String
    var body: some View { ChatFolderList(folderId: folderId) }
}

/// The chat list at one level of the folder tree (nil = top level), the way
/// the desktop sidebar's Chats tab shows it: folders first, then the chats
/// filed right here. Search and the archive look through everything below.
struct ChatFolderList: View {
    @Environment(AppModel.self) private var app
    @Environment(Session.self) private var session
    let folderId: String?
    @State private var query = ""
    @State private var showArchived = false
    @State private var naming: FolderNaming?
    @State private var name = ""
    @State private var deleting: ChatFolder?
    @State private var moving: [String]?

    private enum FolderNaming: Identifiable {
        case create(parentId: String?)
        case rename(ChatFolder)
        var id: String {
            switch self {
            case .create(let p): "create:\(p ?? "")"
            case .rename(let f): "rename:\(f.id)"
            }
        }
    }

    private var chats: ChatListStore { session.chats }
    private var folder: ChatFolder? { chats.folder(folderId) }
    /// Searching or browsing the archive lists chats flat, folders out of the way.
    private var flat: Bool { !query.isEmpty || showArchived }

    var body: some View {
        List {
            if folderId == nil, !session.approvals.queue.isEmpty {
                Section("Waiting for you") {
                    ForEach(session.approvals.queue) { a in
                        ApprovalCard(approval: a, showThreadLink: true)
                            .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                    }
                }
            }
            if !flat, !subfolders.isEmpty {
                Section {
                    ForEach(subfolders) { f in folderRow(f) }
                }
            }
            Section {
                ForEach(rows) { chat in chatRow(chat) }
            }
        }
        .listStyle(.plain)
        .overlay {
            if !chats.loaded { ProgressView() }
            else if folderId != nil && folder == nil {
                ContentUnavailableView("Folder deleted", systemImage: "folder.badge.minus")
            } else if rows.isEmpty && (flat || subfolders.isEmpty) {
                if !query.isEmpty { ContentUnavailableView.search(text: query) }
                else if folderId != nil { ContentUnavailableView("No chats in this folder", systemImage: "folder") }
                else { ContentUnavailableView("No chats", systemImage: "bubble.left.and.bubble.right") }
            }
        }
        .searchable(text: $query, prompt: folder.map { "Search \($0.name)" } ?? "Search chats")
        .refreshable { await chats.reload() }
        .navigationTitle(showArchived ? "Archive" : folder?.name ?? (folderId == nil ? "Chats" : ""))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            OfflineToolbarItem()
            ToolbarItem(placement: .topBarTrailing) { menu }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.newChat(folderId: folderId)) { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel(folder.map { "New chat in \($0.name)" } ?? "New chat")
            }
        }
        .alert(namingTitle, isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
            TextField("Name", text: $name)
            Button(namingAction) { commitName() }
            Button("Cancel", role: .cancel) { naming = nil }
        }
        .confirmationDialog(deleting.map { "Delete “\($0.name)”?" } ?? "",
                            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible) {
            Button("Delete folder", role: .destructive) {
                if let f = deleting { delete(f) }
            }
        } message: {
            Text("Its chats and folders move up a level. No chat is deleted.")
        }
        .sheet(isPresented: Binding(get: { moving != nil }, set: { if !$0 { moving = nil } })) {
            if let ids = moving { MoveToFolderSheet(threadIds: ids).environment(session) }
        }
    }

    private var menu: some View {
        Menu {
            if folderId == nil { Toggle("Show archive", isOn: $showArchived) }
            Button { startNaming(.create(parentId: folderId)) } label: {
                Label(folderId == nil ? "New folder" : "New folder inside", systemImage: "folder.badge.plus")
            }
            Button { Task { await chats.setRead(scope.map(\.threadId), true) } } label: {
                Label("Mark all read", systemImage: "envelope.open")
            }
            if let f = folder {
                Divider()
                Button { startNaming(.rename(f)) } label: { Label("Rename folder", systemImage: "pencil") }
                Button(role: .destructive) { deleting = f } label: { Label("Delete folder", systemImage: "trash") }
            }
        } label: { Image(systemName: "line.3.horizontal.decrease.circle") }
    }

    private func folderRow(_ f: ChatFolder) -> some View {
        NavigationLink(value: Route.folder(f.id)) {
            HStack(spacing: 10) {
                Image(systemName: "folder").foregroundStyle(Color.accentColor).frame(width: 22)
                Text(f.name).lineLimit(1)
                Spacer()
                let unread = chats.unreadCount(in: f.id)
                if unread > 0 {
                    Text("\(unread)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        .accessibilityLabel("\(unread) unread")
                }
            }
        }
        .swipeActions(edge: .trailing) {
            Button { deleting = f } label: { Label("Delete", systemImage: "trash") }.tint(.red)
            Button { startNaming(.rename(f)) } label: { Label("Rename", systemImage: "pencil") }
        }
        .contextMenu {
            Button { startNaming(.rename(f)) } label: { Label("Rename", systemImage: "pencil") }
            Button { startNaming(.create(parentId: f.id)) } label: { Label("New folder inside", systemImage: "folder.badge.plus") }
            Button(role: .destructive) { deleting = f } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func chatRow(_ chat: ChatSummary) -> some View {
        let unread = chats.isUnread(chat)
        let archived = chats.isArchived(chat)
        return NavigationLink(value: Route.thread(chat.threadId)) {
            ChatRow(chat: chat, folderName: flat && chat.folderId != folderId ? chats.folder(chat.folderId)?.name : nil)
        }
        .swipeActions(edge: .leading) {
            Button { Task { await chats.setRead([chat.threadId], unread) } } label: {
                Label(unread ? "Read" : "Unread", systemImage: unread ? "envelope.open" : "envelope.badge")
            }
            .tint(.blue)
        }
        .swipeActions(edge: .trailing) {
            Button { Task { await chats.setArchived([chat.threadId], !archived) } } label: {
                Label(archived ? "Unarchive" : "Archive", systemImage: "archivebox")
            }
            .tint(.gray)
            Button { moving = [chat.threadId] } label: { Label("Move", systemImage: "folder") }
                .tint(.indigo)
            Button(role: .destructive) { Task { await chats.delete(chat.threadId) } } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .contextMenu {
            Button { moving = [chat.threadId] } label: { Label("Move to folder…", systemImage: "folder") }
            Button { Task { await chats.setRead([chat.threadId], unread) } } label: {
                Label(unread ? "Mark read" : "Mark unread", systemImage: unread ? "envelope.open" : "envelope.badge")
            }
            Button { Task { await chats.setArchived([chat.threadId], !archived) } } label: {
                Label(archived ? "Unarchive" : "Archive", systemImage: "archivebox")
            }
            Button(role: .destructive) { Task { await chats.delete(chat.threadId) } } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private var subfolders: [ChatFolder] { chats.childFolders(of: folderId) }

    /// Every chat this level reaches: all of them at the top, the subtree in a folder.
    private var scope: [ChatSummary] {
        guard let folderId else { return chats.chats }
        let ids = chats.subtree(folderId)
        return chats.chats.filter { $0.folderId.map(ids.contains) == true }
    }

    private var rows: [ChatSummary] {
        let q = query.lowercased()
        let base = flat ? scope : chats.chats.filter { $0.folderId == folderId }
        return base.filter { c in
            (showArchived == chats.isArchived(c))
                && (q.isEmpty || c.displayTitle.lowercased().contains(q) || (c.preview ?? "").lowercased().contains(q))
        }
    }

    private var namingTitle: String {
        switch naming {
        case .rename: "Rename folder"
        case .create(let p): p == nil ? "New folder" : "New folder in \(chats.folder(p)?.name ?? "folder")"
        case nil: ""
        }
    }

    private var namingAction: String {
        if case .rename = naming { return "Rename" }
        return "Create"
    }

    private func startNaming(_ n: FolderNaming) {
        if case .rename(let f) = n { name = f.name } else { name = "" }
        naming = n
    }

    private func commitName() {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let what = naming
        naming = nil
        guard !n.isEmpty, let what else { return }
        Task {
            switch what {
            case .create(let p): await chats.createFolder(n, in: p)
            case .rename(let f): if n != f.name { await chats.renameFolder(f.id, n) }
            }
        }
    }

    private func delete(_ f: ChatFolder) {
        deleting = nil
        // Deleting the folder on screen: step back out of it first.
        if f.id == folderId, app.chatPath.last == .folder(f.id) { app.chatPath.removeLast() }
        Task { await chats.deleteFolder(f.id) }
    }
}

/// Pick where chats go: the top level or any folder, with a way to make one.
struct MoveToFolderSheet: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    let threadIds: [String]
    @State private var creating = false
    @State private var name = ""

    private var current: String?? {
        let set = Set(session.chats.chats.filter { threadIds.contains($0.threadId) }.map(\.folderId))
        return set.count == 1 ? set.first : nil
    }

    var body: some View {
        NavigationStack {
            List {
                destination(nil, label: "Top level", icon: "tray", depth: 0)
                ForEach(session.chats.folderTree, id: \.folder.id) { row in
                    destination(row.folder.id, label: row.folder.name, icon: "folder", depth: row.depth)
                }
                Button { name = ""; creating = true } label: { Label("New folder…", systemImage: "folder.badge.plus") }
            }
            .navigationTitle("Move to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .alert("New folder", isPresented: $creating) {
                TextField("Name", text: $name)
                Button("Create and move") {
                    let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !n.isEmpty else { return }
                    Task {
                        if let id = await session.chats.createFolder(n, in: nil) { move(to: id) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func destination(_ id: String?, label: String, icon: String, depth: Int) -> some View {
        Button { move(to: id) } label: {
            HStack(spacing: 10) {
                Image(systemName: icon).foregroundStyle(Color.accentColor).frame(width: 22)
                Text(label).foregroundStyle(.primary).lineLimit(1)
                Spacer()
                if current == .some(id) { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
            .padding(.leading, CGFloat(depth) * 18)
        }
        .tint(.primary)
    }

    private func move(to id: String?) {
        dismiss()
        Task { await session.chats.moveChats(threadIds, to: id) }
    }
}

struct ChatRow: View {
    @Environment(Session.self) private var session
    let chat: ChatSummary
    /// Where the chat is filed, shown when the list mixes folders (search, archive).
    var folderName: String? = nil

    var body: some View {
        let unread = session.chats.isUnread(chat)
        let running = session.connection.liveTurns[chat.threadId] != nil
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(running ? Color.green : unread ? Color.accentColor : .clear)
                .frame(width: 8, height: 8)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    if chat.private == true { Image(systemName: "eye.slash").font(.caption).foregroundStyle(.secondary) }
                    Text(chat.displayTitle)
                        .font(.body.weight(unread ? .semibold : .regular))
                        .lineLimit(1)
                    Spacer()
                    Text(RelativeTime.short(Inbox.toMs(chat.updatedAt)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let p = chat.preview, !p.isEmpty {
                    Text(p).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                if let folderName {
                    Label(folderName, systemImage: "folder").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct ConnectionDot: View {
    @Environment(Session.self) private var session
    var body: some View {
        let status = session.connection.status
        Circle()
            .fill(status == .live ? Color.green : status == .connecting ? Color.gray : Color.red)
            .frame(width: 9, height: 9)
            .accessibilityLabel(status == .live ? "Connected" : status == .connecting ? "Connecting" : "Offline")
    }
}

/// Nothing while connected or reconnecting; a red badge once the server is unreachable.
struct OfflineToolbarItem: ToolbarContent {
    @Environment(Session.self) private var session
    var body: some ToolbarContent {
        if session.connection.status == .offline {
            ToolbarItem(placement: .topBarLeading) {
                Image(systemName: "wifi.slash")
                    .foregroundStyle(.red)
                    .accessibilityLabel("Offline")
            }
        }
    }
}

enum RelativeTime {
    static func short(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let cal = Calendar.current
        if cal.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        if abs(date.timeIntervalSinceNow) < 6 * 86400 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}
