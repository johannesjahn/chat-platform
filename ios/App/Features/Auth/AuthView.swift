import SwiftUI

/// Log in / register. Mirrors the web forms: the same copy, and the same
/// client-side floors for username and password (src/Api.ts).
struct AuthView: View {
    enum Mode { case login, register }

    static let minUsernameLength = 3
    static let minPasswordLength = 8
    /// Autofill's strong-password sheet would swallow the UI tests' typing.
    private static let uiTesting = LaunchOptions.resolve().uiTesting

    let auth: AuthModel
    let server: ServerStatusModel
    let baseURL: URL

    @State private var mode: Mode = .login
    @State private var username = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var error: String?
    @State private var pending = false
    @FocusState private var focus: Field?
    private enum Field { case username, password }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    BrandMark(size: 64)
                    Text(mode == .login ? "Welcome back" : "Create your account")
                        .font(.title.bold()).accessibilityIdentifier("auth.title")
                    Text(mode == .login ? "Log in to continue to Chat Platform." : "Pick a username and password to get started.")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .padding(.top, 32)

                if server.state == .unreachable {
                    ErrorBanner(
                        message: "Can't reach \(baseURL.host() ?? baseURL.absoluteString). Check your connection.",
                        retry: { Task { await server.check() } },
                        identifier: "auth.serverBanner"
                    )
                }
                if let error {
                    ErrorBanner(message: error, identifier: "auth.error")
                }

                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Username").font(.subheadline.weight(.medium))
                        TextField("Username", text: $username)
                            .textContentType(Self.uiTesting ? nil : .username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.next)
                            .focused($focus, equals: .username)
                            .onSubmit { focus = .password }
                            .fieldStyle()
                            .accessibilityIdentifier("auth.username")
                        if mode == .register {
                            Text(usernameHint).font(.footnote)
                                .foregroundStyle(usernameInvalid ? Color.red : Color.secondary)
                                .accessibilityIdentifier("auth.username.hint")
                        }
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Password").font(.subheadline.weight(.medium))
                        HStack {
                            Group {
                                if showPassword {
                                    TextField("Password", text: $password)
                                } else {
                                    SecureField("Password", text: $password)
                                }
                            }
                            .textContentType(Self.uiTesting ? nil : (mode == .register ? .newPassword : .password))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.go)
                            .focused($focus, equals: .password)
                            .onSubmit { Task { await submit() } }
                            .accessibilityIdentifier("auth.password")
                            Button {
                                showPassword.toggle()
                            } label: {
                                Image(systemName: showPassword ? "eye.slash" : "eye")
                            }
                            .accessibilityLabel(showPassword ? "Hide password" : "Show password")
                            .accessibilityIdentifier("auth.password.toggle")
                        }
                        .fieldStyle()
                        if mode == .register {
                            Text("At least \(Self.minPasswordLength) characters.").font(.footnote)
                                .foregroundStyle(passwordTooShort ? Color.red : Color.secondary)
                        }
                    }
                    Button {
                        Task { await submit() }
                    } label: {
                        Group {
                            if pending { ProgressView() } else { Text(mode == .login ? "Log in" : "Register") }
                        }
                        .frame(maxWidth: .infinity, minHeight: 28)
                    }
                    .buttonStyle(.primary)
                    .controlSize(.large)
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("auth.submit")
                }

                Button {
                    mode = mode == .login ? .register : .login
                    error = nil
                } label: {
                    Text(mode == .login ? "No account yet? **Register**" : "Already have an account? **Log in**")
                        .font(.subheadline)
                }
                .accessibilityIdentifier("auth.switchMode")

                if let version = server.version {
                    Text("v\(version)").font(.footnote).foregroundStyle(.tertiary)
                        .accessibilityIdentifier("auth.version")
                }
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("auth.screen")
    }

    // MARK: validation

    private var usernameTooShort: Bool { !username.isEmpty && username.count < Self.minUsernameLength }
    private var usernameBadChars: Bool {
        // src/Api.ts USERNAME_PATTERN: letters, digits, "_", "." and "-", not ending in "." or "-".
        !username.isEmpty && username.wholeMatch(of: /[A-Za-z0-9_.-]*[A-Za-z0-9_]/) == nil
    }
    private var usernameInvalid: Bool { usernameTooShort || usernameBadChars }
    private var passwordTooShort: Bool { !password.isEmpty && password.count < Self.minPasswordLength }

    private var usernameHint: String {
        if usernameBadChars { return "Username may only use letters, digits, \"_\", \".\" and \"-\", and can't end in \".\" or \"-\"." }
        if usernameTooShort { return "Username must be at least \(Self.minUsernameLength) characters." }
        return "At least \(Self.minUsernameLength) characters: letters, digits, \"_\", \".\" and \"-\"."
    }

    private var canSubmit: Bool {
        guard !pending, !username.isEmpty, !password.isEmpty else { return false }
        if mode == .register { return !usernameInvalid && !passwordTooShort }
        return true
    }

    private func submit() async {
        guard canSubmit else { return }
        focus = nil
        error = nil
        pending = true
        defer { pending = false }
        do {
            switch mode {
            case .login: try await auth.login(username: username, password: password)
            case .register: try await auth.register(username: username, password: password)
            }
        } catch {
            self.error = APIError.from(error).message
        }
    }
}

private extension View {
    func fieldStyle() -> some View {
        padding(12)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}
