import PhotosUI
import SwiftUI

/// Display name, bio and avatar (`PUT /users/me`, `POST /users/me/avatar`).
struct EditProfileView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var draft = ProfileDraft()
    @State private var loaded = false
    @State private var loadError: String?
    @State private var saving = false
    @State private var message: (kind: FormMessage.Kind, text: String)?
    @State private var pickedPhoto: PhotosPickerItem?
    @State private var cropping: CropSource?
    @FocusState private var focused: Field?

    private enum Field { case name, bio }

    private var me: User? { env.auth.user.flatMap { env.users.user($0.id) ?? $0 } }
    private var hasUploadedAvatar: Bool { me?.avatarVariants != nil }
    private var hasAvatar: Bool { hasUploadedAvatar || me?.avatarUrl != nil }

    var body: some View {
        Form {
            if let message {
                FormMessage(kind: message.kind, text: message.text, identifier: "settings.profile.message")
            }
            Section("Photo") {
                HStack(spacing: 16) {
                    AvatarView(userId: me?.id, size: 72, identifier: "settings.avatar")
                    VStack(alignment: .leading, spacing: 10) {
                        let pickTitle = hasAvatar ? "Change photo" : "Upload photo"
                        PhotosPicker(selection: $pickedPhoto, matching: .images, photoLibrary: .shared()) {
                            Label(pickTitle, systemImage: "photo.badge.plus")
                        }
                        .accessibilityIdentifier("settings.avatar.pick")
                        if hasAvatar {
                            Button("Remove photo", systemImage: "trash", role: .destructive) { Task { await removePhoto() } }
                                .accessibilityIdentifier("settings.avatar.remove")
                        }
                    }
                    .buttonStyle(.borderless)
                    .disabled(saving)
                }
            }
            Section {
                LabeledContent("Username", value: "@\(me?.username ?? "")")
                TextField("Display name (optional)", text: $draft.displayName)
                    .focused($focused, equals: .name)
                    .textInputAutocapitalization(.words)
                    .onChange(of: draft.displayName) { _, value in
                        let clamped = value.clamped(toJSLength: UserLimits.maxDisplayName)
                        if clamped != value { draft.displayName = clamped }
                    }
                    .accessibilityLabel("Display name")
                    .accessibilityIdentifier("settings.profile.displayName")
            } header: {
                Text("Name")
            } footer: {
                Text("Shown instead of your username. Your username can't be changed.")
            }
            Section {
                TextField("A line or two about yourself (optional)", text: $draft.bio, axis: .vertical)
                    .lineLimit(3...6)
                    .focused($focused, equals: .bio)
                    .onChange(of: draft.bio) { _, value in
                        let clamped = value.clamped(toJSLength: UserLimits.maxBio)
                        if clamped != value { draft.bio = clamped }
                    }
                    .accessibilityLabel("Bio")
                    .accessibilityIdentifier("settings.profile.bio")
                    .disabled(!loaded)
            } header: {
                HStack {
                    Text("Bio")
                    Spacer()
                    Text("\(draft.bio.jsLength)/\(UserLimits.maxBio)").monospacedDigit()
                        .accessibilityLabel("\(draft.bio.jsLength) of \(UserLimits.maxBio) characters")
                }
            } footer: {
                if hasUploadedAvatar {
                    Text("Saving your name or bio also removes your uploaded photo — upload it again afterwards.")
                }
            }
            if let loadError {
                ErrorBanner(message: loadError, retry: { Task { await load() } }, identifier: "settings.profile.loadError")
            }
            Section {
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        if saving { ProgressView() }
                        Text(saving ? "Saving…" : "Save profile")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.primary)
                .disabled(saving || draft.problem != nil || !loaded)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .accessibilityIdentifier("settings.profile.save")
                if let problem = draft.problem { Text(problem).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("settings.profile.screen")
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focused = nil }
            }
        }
        .task { if !loaded { await load() } }
        .onChange(of: pickedPhoto) { _, item in
            guard let item else { return }
            pickedPhoto = nil
            Task { await prepareCrop(item) }
        }
        .sheet(item: $cropping) { source in
            AvatarCropView(image: source.image) { result in
                cropping = nil
                if let result { Task { await upload(result) } }
            }
        }
    }

    // MARK: actions

    private func load() async {
        guard let me = env.auth.user else { return }
        do {
            let profile = try await env.api.call { try await $0.users_getUser(path: .init(id: String(me.id))) }.ok.body.json
            env.users.store(profile)
            draft = ProfileDraft(displayName: profile.displayName ?? "", bio: profile.bio ?? "")
            loaded = true
            loadError = nil
        } catch {
            let error = APIError.from(error)
            if !error.isCancelled { loadError = error.message }
        }
    }

    private func save() async {
        guard let me else { return }
        focused = nil
        saving = true
        message = nil
        defer { saving = false }
        do {
            let request = draft.request(keepingAvatarUrl: me.avatarUrl, bioLoaded: loaded)
            let profile: UserProfile = try await env.api.sendJSON("PUT", path: "users/me", body: request)
            await env.updateSignedInUser(profile.asUser)
            draft = ProfileDraft(displayName: profile.displayName ?? "", bio: profile.bio ?? "")
            message = (.success, "Profile updated.")
        } catch {
            message = (.failure, APIError.from(error).message)
        }
    }

    private func removePhoto() async {
        guard let me else { return }
        saving = true
        message = nil
        defer { saving = false }
        do {
            // A full-replace save with no avatar URL clears the uploaded one too.
            let request = UpdateProfileRequest(displayName: me.displayName, avatarUrl: nil, bio: .keep)
            let profile: UserProfile = try await env.api.sendJSON("PUT", path: "users/me", body: request)
            await env.updateSignedInUser(profile.asUser)
            message = (.success, "Photo removed.")
        } catch {
            message = (.failure, APIError.from(error).message)
        }
    }

    private func prepareCrop(_ item: PhotosPickerItem) async {
        message = nil
        do {
            guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
                message = (.failure, "That file isn't an image this app can read.")
                return
            }
            let upright = AvatarImage.upright(image)
            let pixels = upright.pixelSize
            guard min(pixels.width, pixels.height) >= CGFloat(UserLimits.minAvatarSourcePx) else {
                message = (.failure, "Image is \(Int(pixels.width))×\(Int(pixels.height))px — avatars need at least \(UserLimits.minAvatarSourcePx)×\(UserLimits.minAvatarSourcePx)px.")
                return
            }
            cropping = CropSource(image: upright)
        } catch {
            message = (.failure, "Couldn't load that photo.")
        }
    }

    private func upload(_ result: AvatarCropView.Result) async {
        saving = true
        message = nil
        defer { saving = false }
        do {
            let user: User = try await env.api.upload(
                path: "users/me/avatar",
                file: .init(data: result.jpeg, filename: "avatar.jpg", mimeType: "image/jpeg"),
                fields: ["x": String(result.region.x), "y": String(result.region.y), "size": String(result.region.size)]
            )
            await env.updateSignedInUser(user)
            message = (.success, "Photo updated.")
        } catch {
            message = (.failure, APIError.from(error).message)
        }
    }
}

private struct CropSource: Identifiable {
    let id = UUID()
    let image: UIImage
}
