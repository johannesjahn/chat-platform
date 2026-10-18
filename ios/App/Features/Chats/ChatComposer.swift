import ChatAPI
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The bar under a conversation: reply/edit context, a picked attachment,
/// the text field, an attach menu and Send. It nudges `POST /chats/{id}/typing`
/// while you type (at most every 2.5s — under the 4s the indicator lives).
struct ChatComposer: View {
    @Environment(AppEnvironment.self) private var env
    let chatId: Int
    @Binding var draft: String
    @Binding var replyTo: Message?
    @Binding var editing: Message?
    var focused: FocusState<Bool>.Binding
    let onSend: (_ text: String, _ file: APIClient.UploadFile?) -> Void

    static let typingThrottle: TimeInterval = 2.5

    @State private var lastTypingSent = Date.distantPast
    @State private var showingPhotos = false
    @State private var showingFiles = false
    @State private var photoItem: PhotosPickerItem?
    @State private var file: APIClient.UploadFile?
    @State private var filePreview: UIImage?
    @State private var attachError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let context = contextLine {
                HStack(spacing: 8) {
                    Image(systemName: editing != nil ? "pencil" : "arrowshape.turn.up.left").foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(context.title).font(.caption.weight(.semibold))
                        Text(context.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Button { cancelContext() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(editing != nil ? "Cancel editing" : "Cancel reply")
                        .accessibilityIdentifier("chat.composer.cancel")
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat.composer.context")
            }
            if let file {
                HStack(spacing: 8) {
                    if let filePreview {
                        Image(uiImage: filePreview).resizable().scaledToFill().frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 8))
                            .accessibilityHidden(true)
                    } else {
                        Image(systemName: "doc.fill").font(.title2).foregroundStyle(.secondary)
                    }
                    Text(file.filename).font(.footnote).lineLimit(1)
                    Spacer()
                    Button { self.file = nil; filePreview = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove attachment")
                        .accessibilityIdentifier("chat.composer.attachment.remove")
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat.composer.attachment")
            }
            if let attachError {
                Text(attachError).font(.caption).foregroundStyle(.red)
            }
            HStack(alignment: .bottom, spacing: 8) {
                if editing == nil {
                    Menu {
                        Button("Photo", systemImage: "photo") { showingPhotos = true }
                            .accessibilityIdentifier("chat.composer.attach.photo")
                        Button("File", systemImage: "doc") { showingFiles = true }
                            .accessibilityIdentifier("chat.composer.attach.file")
                    } label: {
                        Image(systemName: "plus.circle.fill").font(.system(size: 30)).foregroundStyle(Color.accentColor)
                    }
                    .accessibilityLabel("Attach")
                    .accessibilityIdentifier("chat.composer.attach")
                }
                TextField(file == nil ? "Message" : "Add a caption", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused(focused)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                    .accessibilityIdentifier("chat.composer.field")
                Button(action: send) {
                    Image(systemName: editing != nil ? "checkmark.circle.fill" : "arrow.up.circle.fill").font(.system(size: 32))
                }
                .disabled(!canSend)
                .accessibilityLabel(editing != nil ? "Save edit" : "Send")
                .accessibilityIdentifier("chat.composer.send")
            }
            if trimmed.count > ChatStore.maxMessageLength - 200 {
                Text("\(trimmed.count)/\(ChatStore.maxMessageLength)").font(.caption2)
                    .foregroundStyle(trimmed.count > ChatStore.maxMessageLength ? .red : .secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
        .onChange(of: draft) { _, text in noteTyping(text) }
        .photosPicker(isPresented: $showingPhotos, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in Task { await loadPhoto(item) } }
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.item]) { result in loadFile(result) }
    }

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSend: Bool {
        guard trimmed.count <= ChatStore.maxMessageLength else { return false }
        if editing != nil { return !trimmed.isEmpty }
        return !trimmed.isEmpty || file != nil
    }

    private var contextLine: (title: String, detail: String)? {
        if let editing { return ("Editing message", editing.preview) }
        if let replyTo {
            let name = env.chats.chat(chatId)?.participant(replyTo.senderId)?.shownName ?? "message"
            return ("Replying to \(name)", replyTo.preview)
        }
        return nil
    }

    private func cancelContext() {
        if editing != nil { draft = "" }
        editing = nil
        replyTo = nil
    }

    private func send() {
        guard canSend else { return }
        onSend(trimmed, file)
        file = nil
        filePreview = nil
        photoItem = nil
        attachError = nil
    }

    private func noteTyping(_ text: String) {
        guard editing == nil, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              Date().timeIntervalSince(lastTypingSent) >= Self.typingThrottle
        else { return }
        lastTypingSent = Date()
        let api = env.api, chatId = chatId
        Task { _ = try? await api.call { try await $0.chats_sendTyping(path: .init(id: String(chatId))) } }
    }

    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data),
              let upload = try? PostComposerView.jpeg(image)
        else { attachError = "That photo couldn't be read."; return }
        file = upload
        filePreview = image
        attachError = nil
    }

    private func loadFile(_ result: Result<URL, any Error>) {
        guard case .success(let url) = result else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { attachError = "That file couldn't be read."; return }
        let type = UTType(filenameExtension: url.pathExtension)
        file = APIClient.UploadFile(data: data, filename: url.lastPathComponent, mimeType: type?.preferredMIMEType ?? "application/octet-stream")
        filePreview = type?.conforms(to: .image) == true ? UIImage(data: data) : nil
        attachError = nil
    }
}
