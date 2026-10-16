import ChatAPI
import PhotosUI
import SwiftUI

/// Create a post (text or a photo) or edit a text post.
struct PostComposerView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let editing: Post?

    static let maxLength = 10_000

    @State private var text = ""
    @State private var picked: PhotosPickerItem?
    @State private var photo: UIImage?
    @State private var pending = false
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    ErrorBanner(message: errorMessage, identifier: "composer.error").listRowBackground(Color.clear)
                }
                Section {
                    TextEditor(text: $text)
                        .frame(minHeight: 140)
                        .focused($focused)
                        .accessibilityIdentifier("composer.text")
                        .overlay(alignment: .topLeading) { placeholder }
                } footer: {
                    Text("\(text.count)/\(Self.maxLength)").foregroundStyle(overLimit ? .red : .secondary)
                }
                if editing == nil {
                    Section {
                        if let photo {
                            Image(uiImage: photo).resizable().scaledToFit().frame(maxHeight: 240)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .accessibilityLabel("Selected photo")
                            Button("Remove photo", role: .destructive) { self.photo = nil; picked = nil }
                                .accessibilityIdentifier("composer.photo.remove")
                        }
                        PhotosPicker(selection: $picked, matching: .images) {
                            Label(photo == nil ? "Add photo" : "Change photo", systemImage: "photo")
                        }
                        .accessibilityIdentifier("composer.photo")
                    }
                }
            }
            .navigationTitle(editing == nil ? "New post" : "Edit post")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.accessibilityIdentifier("composer.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if pending { ProgressView() } else {
                        Button(editing == nil ? "Post" : "Save") { Task { await submit() } }
                            .disabled(!canSubmit)
                            .accessibilityIdentifier("composer.submit")
                    }
                }
            }
            .onChange(of: picked) { _, item in Task { await loadPhoto(item) } }
            .onAppear {
                if let editing, text.isEmpty { text = editing.content }
                focused = true
            }
            .interactiveDismissDisabled(pending)
        }
    }

    @ViewBuilder private var placeholder: some View {
        if text.isEmpty {
            Text(photo == nil ? "What's on your mind?" : "Add a caption (optional)")
                .foregroundStyle(.tertiary).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
        }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var overLimit: Bool { trimmed.count > Self.maxLength }
    private var canSubmit: Bool { !pending && !overLimit && (photo != nil || !trimmed.isEmpty) }

    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { return }
        photo = image
    }

    private func submit() async {
        pending = true
        errorMessage = nil
        defer { pending = false }
        do {
            if let editing {
                try await env.posts.update(editing.id, contentType: editing.contentType, content: trimmed)
            } else if let photo {
                let file = try Self.jpeg(photo)
                let attachment: Attachment = try await env.api.upload(path: "attachments", file: file)
                // An attachment post's content is the file's name (as on the web).
                _ = try await env.posts.create(contentType: .attachment, content: trimmed.isEmpty ? attachment.filename : trimmed, attachmentId: attachment.id)
            } else {
                _ = try await env.posts.create(contentType: .text, content: trimmed)
            }
            dismiss()
        } catch {
            errorMessage = APIError.from(error).message
        }
    }

    /// A JPEG no larger than 2048px on a side, under the server's size cap.
    static func jpeg(_ image: UIImage) throws -> APIClient.UploadFile {
        let longest = max(image.size.width, image.size.height)
        let scale = min(1, 2048 / max(longest, 1))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let data = resized.jpegData(compressionQuality: 0.85) else { throw APIError(kind: .unknown, tag: nil, message: "That photo couldn't be read.") }
        return APIClient.UploadFile(data: data, filename: "photo-\(Int(Date().timeIntervalSince1970)).jpg", mimeType: "image/jpeg")
    }
}
