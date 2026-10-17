import ChatAPI
import PhotosUI
import SwiftUI

/// Everything about a chat: for a direct chat the other person; for a group
/// its avatar, name, members and their roles, invite links, and leave or
/// delete. Who may do what follows the web's group dialog (`ChatPermissions`);
/// the server has the last word.
struct ChatInfoView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let chatId: Int
    let onJump: (Int) -> Void

    @State private var renaming = false
    @State private var titleDraft = ""
    @State private var adding = false
    @State private var avatarItem: PhotosPickerItem?
    @State private var invites: [ChatInvite] = []
    @State private var invitesPhase: LoadPhase = .idle
    @State private var confirm: Confirmation?
    @State private var working = false
    @State private var errorMessage: String?

    enum Confirmation: Identifiable {
        case leave, delete, remove(ChatParticipant), transfer(ChatParticipant)
        var id: String {
            switch self {
            case .leave: "leave"
            case .delete: "delete"
            case .remove(let p): "remove.\(p.userId)"
            case .transfer(let p): "transfer.\(p.userId)"
            }
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let chat = env.chats.chat(chatId) {
                    content(chat)
                } else {
                    EmptyState(title: "Chat not found", systemImage: "questionmark.bubble", identifier: "chatInfo.missing")
                }
            }
            .navigationTitle(env.chats.chat(chatId)?.isGroup == true ? "Group info" : "Chat info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("chatInfo.done") } }
            .alert("Something went wrong", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("OK") {}
            } message: { Text(errorMessage ?? "") }
            .sheet(isPresented: $adding) { AddMembersView(chatId: chatId) }
        }
    }

    @ViewBuilder
    private func content(_ chat: Chat) -> some View {
        let me = env.auth.user
        let permissions = ChatPermissions(chat: chat, me: me)
        List {
            Section {
                VStack(spacing: 10) {
                    ChatAvatar(chat: chat, size: 84)
                    Text(chat.displayName(me: me?.id)).font(.title2.bold()).multilineTextAlignment(.center)
                        .accessibilityIdentifier("chatInfo.name")
                    if chat.isGroup {
                        Text("\(chat.participants.count) members").foregroundStyle(.secondary)
                    }
                    if permissions.canManage {
                        HStack(spacing: 12) {
                            PhotosPicker(chat.avatarVariants == nil ? "Add photo" : "Change photo", selection: $avatarItem, matching: .images)
                                .accessibilityIdentifier("chatInfo.avatar")
                            if chat.avatarVariants != nil {
                                Button("Remove photo", role: .destructive) { run { try await env.chats.removeAvatar(chatId) } }
                                    .accessibilityIdentifier("chatInfo.avatar.remove")
                            }
                        }
                        .font(.subheadline)
                        .buttonStyle(.borderless)
                    }
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }

            if chat.isGroup, permissions.canManage {
                Section("Name") {
                    if renaming {
                        TextField("Group name", text: $titleDraft)
                            .accessibilityIdentifier("chatInfo.rename.field")
                            .onSubmit { saveTitle() }
                        HStack {
                            Button("Cancel") { renaming = false }.buttonStyle(.borderless)
                            Spacer()
                            Button("Save") { saveTitle() }.buttonStyle(.borderless)
                                .disabled(titleDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                                .accessibilityIdentifier("chatInfo.rename.save")
                        }
                    } else {
                        Button { titleDraft = chat.title ?? ""; renaming = true } label: {
                            Label("Rename group", systemImage: "pencil")
                        }
                        .accessibilityIdentifier("chatInfo.rename")
                    }
                }
            }

            Section(chat.isGroup ? "Members" : "Person") {
                ForEach(chat.participants, id: \.userId) { participant in
                    memberRow(participant, chat: chat, permissions: permissions)
                }
                if chat.isGroup, permissions.canManage, chat.participants.count < ChatStore.maxGroupParticipants {
                    Button { adding = true } label: { Label("Add members", systemImage: "person.badge.plus") }
                        .accessibilityIdentifier("chatInfo.addMembers")
                }
            }

            Section("Messages") {
                NavigationLink {
                    MessagesListPage(chatId: chatId, starred: false) { dismiss(); onJump($0) }
                } label: { Label("Pinned messages", systemImage: "pin") }
                    .accessibilityIdentifier("chatInfo.pins")
                NavigationLink {
                    MessagesListPage(chatId: chatId, starred: true) { dismiss(); onJump($0) }
                } label: { Label("Starred messages", systemImage: "star") }
                    .accessibilityIdentifier("chatInfo.stars")
            }

            if chat.isGroup, permissions.canManage {
                invitesSection(chat)
            }

            if chat.isGroup {
                Section {
                    Button(role: .destructive) { confirm = .leave } label: { Label("Leave group", systemImage: "rectangle.portrait.and.arrow.right") }
                        .accessibilityIdentifier("chatInfo.leave")
                    if permissions.canManage {
                        Button(role: .destructive) { confirm = .delete } label: { Label("Delete group", systemImage: "trash") }
                            .accessibilityIdentifier("chatInfo.delete")
                    }
                }
            }
        }
        .accessibilityIdentifier("chatInfo.list")
        .disabled(working)
        .onChange(of: avatarItem) { _, item in Task { await uploadAvatar(item) } }
        .task(id: permissions.canManage) { if permissions.canManage, chat.isGroup { await loadInvites() } }
        .confirmationDialog(confirmTitle(chat), isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible, presenting: confirm) { action in
            switch action {
            case .leave:
                Button("Leave", role: .destructive) { run { try await env.chats.leave(chatId); close() } }
                    .accessibilityIdentifier("chatInfo.confirm")
            case .delete:
                Button("Delete", role: .destructive) { run { try await env.chats.delete(chatId); close() } }
                    .accessibilityIdentifier("chatInfo.confirm")
            case .remove(let participant):
                Button("Remove", role: .destructive) { run { try await env.chats.removeParticipant(chatId, participant.userId) } }
                    .accessibilityIdentifier("chatInfo.confirm")
            case .transfer(let participant):
                Button("Make owner") { run { try await env.chats.transferOwnership(chatId, to: participant.userId) } }
                    .accessibilityIdentifier("chatInfo.confirm")
            }
        }
    }

    private func memberRow(_ participant: ChatParticipant, chat: Chat, permissions: ChatPermissions) -> some View {
        let me = env.auth.user
        let isOwner = chat.ownerId == participant.userId
        let isSelf = participant.userId == me?.id
        let canChangeRole = permissions.canManageRoles && !isOwner && !isSelf
        let canTransfer = (permissions.canManageRoles || permissions.canClaimOwnership) && !isOwner && chat.isGroup
        let canRemove = permissions.canRemove(participant, in: chat, me: me)
        return HStack(spacing: 10) {
            Button {
                dismiss()
                env.router.push(.profile(participant.userId))
            } label: {
                HStack(spacing: 10) {
                    ParticipantAvatar(participant: participant, size: 36, showsPresence: true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(participant.shownName + (isSelf ? " (you)" : "")).foregroundStyle(.primary)
                        Text("@\(participant.username)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)
            Spacer()
            if chat.isGroup, isOwner || participant.role == .admin {
                Text(isOwner ? "Owner" : "Admin")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.accentColor.opacity(0.18), in: Capsule())
                    .accessibilityIdentifier("chatInfo.member.\(participant.userId).role")
            }
            if canChangeRole || canTransfer || canRemove {
                Menu {
                    if canChangeRole {
                        Button(participant.role == .admin ? "Remove admin" : "Make admin", systemImage: "shield") {
                            run { try await env.chats.setRole(chatId, participant.userId, admin: participant.role != .admin) }
                        }
                        .accessibilityIdentifier("chatInfo.member.role")
                    }
                    if canTransfer {
                        Button("Make owner", systemImage: "crown") { confirm = .transfer(participant) }
                            .accessibilityIdentifier("chatInfo.member.transfer")
                    }
                    if canRemove {
                        Button("Remove from group", systemImage: "person.badge.minus", role: .destructive) { confirm = .remove(participant) }
                            .accessibilityIdentifier("chatInfo.member.remove")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").font(.title3).padding(4)
                }
                .accessibilityLabel("Manage \(participant.shownName)")
                .accessibilityIdentifier("chatInfo.member.\(participant.userId).menu")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chatInfo.member.\(participant.userId)")
    }

    @ViewBuilder
    private func invitesSection(_ chat: Chat) -> some View {
        Section {
            if invites.isEmpty, invitesPhase == .idle || invitesPhase == .loading {
                ProgressView()
            } else if invites.isEmpty, case .failed(let message) = invitesPhase {
                ErrorBanner(message: message, retry: { Task { await loadInvites() } }, identifier: "chatInfo.invites.error")
            } else {
                ForEach(invites.filter { Self.isActive($0) }, id: \.id) { invite in
                    let link = inviteURL(invite.code)
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(invite.code).font(.body.monospaced()).accessibilityIdentifier("chatInfo.invite.\(invite.id).code")
                            Text(Self.describe(invite)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        ShareLink(item: link) { Image(systemName: "square.and.arrow.up") }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Share invite link")
                            .accessibilityIdentifier("chatInfo.invite.\(invite.id).share")
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("chatInfo.invite.\(invite.id)")
                    .swipeActions {
                        Button("Revoke", role: .destructive) {
                            run { try await env.chats.revokeInvite(chatId, invite.id); await loadInvites() }
                        }
                        .accessibilityIdentifier("chatInfo.invite.\(invite.id).revoke")
                    }
                    .contextMenu {
                        Button("Copy link", systemImage: "doc.on.doc") { UIPasteboard.general.url = link }
                        Button("Revoke", systemImage: "xmark.circle", role: .destructive) {
                            run { try await env.chats.revokeInvite(chatId, invite.id); await loadInvites() }
                        }
                    }
                }
            }
            Button {
                run { _ = try await env.chats.createInvite(chatId); await loadInvites() }
            } label: { Label("Create invite link", systemImage: "link.badge.plus") }
                .accessibilityIdentifier("chatInfo.invite.create")
        } header: {
            Text("Invite links")
        } footer: {
            Text("Anyone with an active link can join. Swipe to revoke one.")
        }
    }

    // MARK: helpers

    private func inviteURL(_ code: String) -> URL {
        // The same shape the web shares (`/chats/join/<code>`); the join
        // screen accepts the link or the bare code.
        env.config.apiBaseURL.appending(path: "chats/join/\(code)")
    }

    static func isActive(_ invite: ChatInvite, now: Date = Date()) -> Bool {
        if invite.revokedAt != nil { return false }
        if let expires = invite.expiresAt, TimeText.date(expires) < now { return false }
        if let max = invite.maxUses, invite.useCount >= max { return false }
        return true
    }

    static func describe(_ invite: ChatInvite) -> String {
        var parts: [String] = []
        if let expires = invite.expiresAt { parts.append("Expires \(TimeText.date(expires).formatted(date: .abbreviated, time: .shortened))") }
        else { parts.append("Never expires") }
        if let max = invite.maxUses { parts.append("\(invite.useCount)/\(max) used") }
        else if invite.useCount > 0 { parts.append("\(invite.useCount) joined") }
        return parts.joined(separator: " · ")
    }

    private func confirmTitle(_ chat: Chat) -> String {
        switch confirm {
        case .leave: "Leave \(chat.displayName(me: env.auth.user?.id))?"
        case .delete: "Delete this group for everyone?"
        case .remove(let p): "Remove \(p.shownName)?"
        case .transfer(let p): "Make \(p.shownName) the owner?"
        case nil: ""
        }
    }

    private func saveTitle() {
        let title = titleDraft.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        run { try await env.chats.rename(chatId, to: title); renaming = false }
    }

    private func loadInvites() async {
        if invites.isEmpty { invitesPhase = .loading }
        do {
            invites = try await env.chats.invites(chatId)
            invitesPhase = .loaded
        } catch {
            invitesPhase = .failed(APIError.from(error).message)
        }
    }

    private func uploadAvatar(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { return }
        let side = min(image.size.width, image.size.height, 1024)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        let square = renderer.image { _ in
            let scale = side / min(image.size.width, image.size.height)
            let drawn = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            image.draw(in: CGRect(x: (side - drawn.width) / 2, y: (side - drawn.height) / 2, width: drawn.width, height: drawn.height))
        }
        guard let jpeg = square.jpegData(compressionQuality: 0.85) else { return }
        let pixels = Int(side * square.scale)
        run {
            try await env.chats.uploadAvatar(chatId, file: .init(data: jpeg, filename: "group.jpg", mimeType: "image/jpeg"), cropSide: pixels)
        }
        avatarItem = nil
    }

    private func close() {
        dismiss()
        // Leaving or deleting closes the conversation underneath, too.
        let chatId = chatId
        env.router.setPath(env.router.path(for: env.router.selectedTab).filter {
            if case .chat(let id, _) = $0 { return id != chatId }
            return true
        }, for: env.router.selectedTab)
    }

    private func run(_ work: @escaping () async throws -> Void) {
        Task {
            working = true
            defer { working = false }
            do { try await work() } catch { errorMessage = APIError.from(error).message }
        }
    }
}

/// Pinned or starred messages, pushed inside the info sheet.
struct MessagesListPage: View {
    let chatId: Int
    let starred: Bool
    let onSelect: (Int) -> Void

    var body: some View {
        PinnedMessagesList(chatId: chatId, starred: starred, onSelect: onSelect)
    }
}

/// Adds people to a group by searching for them.
struct AddMembersView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let chatId: Int
    @State private var picker = UserPicker()
    @State private var selected: [User] = []
    @State private var pending = false
    @State private var errorMessage: String?

    var body: some View {
        let chat = env.chats.chat(chatId)
        let room = ChatStore.maxGroupParticipants - (chat?.participants.count ?? 0)
        NavigationStack {
            List {
                if let errorMessage { ErrorBanner(message: errorMessage, identifier: "addMembers.error").listRowBackground(Color.clear) }
                if !selected.isEmpty {
                    Section("Adding") {
                        ForEach(selected, id: \.id) { user in Text(user.shownName).accessibilityIdentifier("addMembers.selected.\(user.id)") }
                    }
                }
                Section {
                    TextField("Search people", text: $picker.query)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("addMembers.search")
                    ForEach(picker.results, id: \.id) { user in
                        Button {
                            if let index = selected.firstIndex(where: { $0.id == user.id }) { selected.remove(at: index) }
                            else if selected.count < room { selected.append(user) }
                        } label: {
                            HStack {
                                AvatarView(userId: user.id, size: 30)
                                Text(user.shownName).foregroundStyle(.primary)
                                Spacer()
                                if selected.contains(where: { $0.id == user.id }) { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                        .accessibilityIdentifier("addMembers.user.\(user.id)")
                        .task { env.users.store(user) }
                    }
                } footer: {
                    Text("Room for \(max(room, 0)) more.")
                }
            }
            .navigationTitle("Add members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if pending { ProgressView() } else {
                        Button("Add") { Task { await add() } }.disabled(selected.isEmpty).accessibilityIdentifier("addMembers.add")
                    }
                }
            }
            .task(id: picker.query) {
                await picker.search(api: env.api, excluding: Set(chat?.participants.map(\.userId) ?? []))
            }
        }
    }

    private func add() async {
        pending = true
        defer { pending = false }
        do {
            try await env.chats.addParticipants(chatId, selected.map(\.id))
            dismiss()
        } catch {
            errorMessage = APIError.from(error).message
        }
    }
}
