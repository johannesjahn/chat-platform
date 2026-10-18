import ChatAPI
import CoreGraphics
import Foundation
import Synchronization
import Testing

@testable import ChatPlatform

private func json(_ value: some Encodable) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Suite struct RequestBodyTests {
    @Test func profileSaveSendsExplicitNullsTheServerRequires() throws {
        // `displayName`/`avatarUrl` are required-but-nullable: an omitted key is a 400.
        let body = try json(UpdateProfileRequest(displayName: nil, avatarUrl: nil, bio: .keep))
        #expect(body.keys.sorted() == ["avatarUrl", "displayName"])
        #expect(body["displayName"] is NSNull)
        #expect(body["avatarUrl"] is NSNull)
    }

    @Test func bioIsOmittedToKeepItAndNullToClearIt() throws {
        #expect(try json(UpdateProfileRequest(displayName: "Ada", avatarUrl: nil, bio: .keep))["bio"] == nil)
        #expect(try json(UpdateProfileRequest(displayName: "Ada", avatarUrl: nil, bio: .set(nil)))["bio"] is NSNull)
        #expect(try json(UpdateProfileRequest(displayName: "Ada", avatarUrl: nil, bio: .set("Hi")))["bio"] as? String == "Hi")
    }

    @Test func clearingAStatusSendsTwoNullsAndNoExpiry() throws {
        let body = try json(UpdateStatusRequest.clear)
        #expect(body.keys.sorted() == ["statusEmoji", "statusText"])
        #expect(body["statusText"] is NSNull)
        #expect(body["statusEmoji"] is NSNull)
    }

    @Test func theGeneratedBodyWouldDropTheNulls() throws {
        // Why `sendJSON` exists: the generated type omits nil keys.
        let generated = try json(Components.Schemas.UpdateProfileBody(displayName: nil, avatarUrl: nil))
        #expect(generated.isEmpty)
    }
}

@Suite struct DraftTests {
    @Test func statusDraftTrimsAndOnlySendsExpiryWithAStatus() {
        var draft = StatusDraft(emoji: " 🎯 ", text: "  In a meeting ", expiry: .hour1)
        #expect(draft.saveRequest == UpdateStatusRequest(statusText: "In a meeting", statusEmoji: "🎯", expiresInMinutes: 60))
        draft.expiry = .never
        #expect(draft.saveRequest?.expiresInMinutes == nil)
        draft = StatusDraft(emoji: "  ", text: "\n", expiry: .hours4)
        #expect(!draft.hasContent)
        #expect(draft.saveRequest == nil)
        #expect(StatusDraft(emoji: "", text: "Away").saveRequest?.statusEmoji == nil)
    }

    @Test func expiryOptionsMatchTheWeb() {
        #expect(StatusExpiry.allCases.map(\.minutes) == [nil, 30, 60, 240, 1440])
    }

    @Test func profileDraftTurnsBlanksIntoNull() {
        let draft = ProfileDraft(displayName: "  ", bio: " Hello ")
        #expect(draft.request(keepingAvatarUrl: "https://x/a.png", bioLoaded: true)
            == UpdateProfileRequest(displayName: nil, avatarUrl: "https://x/a.png", bio: .set("Hello")))
        #expect(ProfileDraft(displayName: "Ada", bio: "").request(keepingAvatarUrl: nil, bioLoaded: true).bio == .set(nil))
        #expect(draft.request(keepingAvatarUrl: nil, bioLoaded: false).bio == .keep)
    }

    @Test func profileDraftFlagsOverlongFields() {
        #expect(ProfileDraft(displayName: String(repeating: "a", count: 64)).problem == nil)
        #expect(ProfileDraft(displayName: String(repeating: "a", count: 65)).problem != nil)
        #expect(ProfileDraft(bio: String(repeating: "b", count: 161)).problem != nil)
    }

    @Test func passwordDraftNeedsLengthAndAMatch() {
        #expect(PasswordDraft(current: "old", new: "short", confirm: "").problem?.contains("8") == true)
        #expect(PasswordDraft(current: "old", new: "long-enough", confirm: "long-enougX").problem == "New passwords don't match.")
        #expect(PasswordDraft(current: "old", new: "long-enough", confirm: "long-enough").canSubmit)
        #expect(!PasswordDraft(current: "", new: "long-enough", confirm: "long-enough").canSubmit)
    }

    @Test func clampingCountsUTF16LikeTheServerAndKeepsEmojiWhole() {
        #expect("🎯".jsLength == 2)
        #expect("👍🏽".jsLength == 4)
        // 8 units: two 4-unit emoji fit, a third doesn't, and none is split.
        #expect("👍🏽👍🏽👍🏽".clamped(toJSLength: 8) == "👍🏽👍🏽")
        #expect("abc".clamped(toJSLength: 8) == "abc")
    }

    @Test func searchNeedsThreeCharactersUnlessAdmin() {
        #expect(!UserSearchPolicy.isReady(query: "ab", isAdmin: false))
        #expect(!UserSearchPolicy.isReady(query: "  ab  ", isAdmin: false))
        #expect(UserSearchPolicy.isReady(query: "ada", isAdmin: false))
        #expect(UserSearchPolicy.isReady(query: "", isAdmin: true))
    }
}

@Suite struct AvatarCropTests {
    @Test func startsCenteredOnTheShortSide() {
        let crop = AvatarCropGeometry(imageSize: CGSize(width: 1000, height: 500), viewport: 300)
        #expect(crop.cropRegion == .init(x: 250, y: 0, size: 500))
    }

    @Test func panningIsClampedToTheImage() {
        var crop = AvatarCropGeometry(imageSize: CGSize(width: 1000, height: 500), viewport: 300)
        // Drag the image far right: the viewport shows its left edge.
        crop.update(zoom: 1, offset: CGSize(width: 10_000, height: 50))
        #expect(crop.cropRegion == .init(x: 0, y: 0, size: 500))
        crop.update(zoom: 1, offset: CGSize(width: -10_000, height: 0))
        #expect(crop.cropRegion == .init(x: 500, y: 0, size: 500))
    }

    @Test func zoomingShrinksTheRegionAndIsCapped() {
        var crop = AvatarCropGeometry(imageSize: CGSize(width: 800, height: 800), viewport: 400)
        crop.update(zoom: 2, offset: .zero)
        #expect(crop.cropRegion == .init(x: 200, y: 200, size: 400))
        crop.update(zoom: 100, offset: .zero)
        #expect(crop.zoom == 4)
        crop.update(zoom: 0.1, offset: .zero)
        #expect(crop.zoom == 1)
    }

    @Test func rejectsSourcesBelowTheServerMinimum() {
        #expect(!AvatarCropGeometry(imageSize: CGSize(width: 255, height: 900), viewport: 300).isLargeEnough)
        #expect(AvatarCropGeometry(imageSize: CGSize(width: 256, height: 256), viewport: 300).isLargeEnough)
    }
}

private let searchUserJSON = #"{"id":7,"username":"ada","displayName":"Ada","avatarUrl":null,"avatarVariants":null,"role":"user","statusText":null,"statusEmoji":null,"statusExpiresAt":null}"#

@MainActor
@Suite struct UsersNetworkTests {
    private func makeAPI(_ backend: FakeBackend) -> APIClient {
        let urlSession = StubURLProtocol.session()
        let sessions = SessionManager(storage: InMemoryStorage(), refresher: URLSessionRefresher(baseURL: backend.baseURL, session: urlSession))
        return APIClient(baseURL: backend.baseURL, sessions: sessions, urlSession: urlSession)
    }

    @Test func aShortQueryNeverHitsTheServerForANonAdmin() async {
        let backend = FakeBackend { _ in .json("[]") }
        let api = makeAPI(backend)
        let model = UsersListModel(api: api, users: UserStore(api: api))
        model.query = "ad"
        await model.search(isAdmin: false)
        #expect(model.state == .needsQuery)
        #expect(backend.requests.isEmpty)
    }

    @Test func searchStoresUsersAndShowsTheirIds() async {
        let backend = FakeBackend { _ in .json("[\(searchUserJSON)]") }
        let api = makeAPI(backend)
        let users = UserStore(api: api)
        let model = UsersListModel(api: api, users: users)
        model.query = " ada "
        await model.search(isAdmin: false)
        #expect(model.state == .loaded([7]))
        #expect(model.resultsQuery == "ada")
        #expect(users.user(7)?.displayName == "Ada")
        #expect(backend.requests.first?.path == "/users/search")
        #expect(backend.requests.first?.query == "q=ada")
    }

    @Test func anAdminCanBrowseEveryoneWithAnEmptyQuery() async {
        let backend = FakeBackend { _ in .json("[\(searchUserJSON)]") }
        let api = makeAPI(backend)
        let model = UsersListModel(api: api, users: UserStore(api: api))
        await model.search(isAdmin: true)
        #expect(model.state == .loaded([7]))
        #expect(backend.count(path: "/users/search") == 1)
    }

    @Test func aFailedSearchShowsTheServersMessage() async {
        let backend = FakeBackend { _ in .json(#"{"_tag":"InvalidUserSearchRequest","message":"q must be at least 3 characters"}"#, status: 400) }
        let api = makeAPI(backend)
        let model = UsersListModel(api: api, users: UserStore(api: api))
        await model.search(isAdmin: true)
        #expect(model.state == .failed("q must be at least 3 characters"))
    }

    @Test func sendJSONPutsTheHandEncodedBody() async throws {
        let backend = FakeBackend { _ in .json(profileJSON) }
        let api = makeAPI(backend)
        let profile: UserProfile = try await api.sendJSON("PUT", path: "users/me", body: UpdateProfileRequest(displayName: "Ada", avatarUrl: nil))
        #expect(profile.username == "ada")
        let request = try #require(backend.requests.first)
        #expect(request.method == "PUT")
        #expect(request.path == "/users/me")
        let sent = try #require(try JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        #expect(sent["displayName"] as? String == "Ada")
        #expect(sent["avatarUrl"] is NSNull)
    }

    @Test func blockStoreTracksTheRelationshipAndAnnouncesChanges() async throws {
        let entry = #"{"user":\#(searchUserJSON),"type":"mute","createdAt":1000}"#
        let backend = FakeBackend { request in
            switch (request.method, request.path) {
            case ("GET", "/users/me/blocks"): .json("[\(entry)]")
            case ("PUT", "/users/7/block"): .json(#"{"user":\#(searchUserJSON),"type":"block","createdAt":2000}"#)
            case ("DELETE", "/users/7/block"): StubURLProtocol.Reply(status: 204)
            default: .json("{}", status: 404)
            }
        }
        let api = makeAPI(backend)
        let store = BlockStore(api: api, users: UserStore(api: api))
        let changes = Mutex(0)
        store.onChange = { changes.withLock { $0 += 1 } }
        await store.load(for: 1)
        #expect(store.type(of: 7) == .mute)
        try await store.set(.block, for: 7)
        #expect(store.type(of: 7) == .block)
        #expect(store.entries.count == 1)
        try await store.remove(7)
        #expect(store.type(of: 7) == nil)
        #expect(changes.withLock { $0 } == 2)
        // Another account's list starts empty rather than showing these.
        await store.load(for: 2)
        #expect(store.phase == .loaded)
    }

    @Test func themePersistsAndUITestsStartFromSystem() {
        let defaults = UserDefaults(suiteName: "theme-\(UUID().uuidString)")!
        let theme = ThemeStore(defaults: defaults)
        #expect(theme.preference == .system)
        theme.preference = .dark
        #expect(ThemeStore(defaults: defaults).preference == .dark)
        #expect(ThemeStore(defaults: defaults, reset: true).preference == .system)
        #expect(ThemePreference.dark.colorScheme == .dark)
        #expect(ThemePreference.system.colorScheme == nil)
    }
}
