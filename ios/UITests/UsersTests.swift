import XCTest

final class UsersTests: AppTestCase {
    /// More → People → search → the person's row.
    private func search(for query: String) {
        openFromMore("more.users")
        element("users.prompt")
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(query)
    }

    private func openProfile(of user: TestUser) {
        search(for: user.username)
        element("users.row.\(user.id)").tap()
        element("profile.screen")
        XCTAssertEqual(element("profile.username").label, "@\(user.username)")
    }

    func testSearchPeopleAndOpenAProfileWithTheirPosts() async throws {
        let me = try await api.makeUser("seeker")
        let other = try await api.makeUser("findme")
        try await api.setProfile(other, displayName: "Findable Person", bio: "I write posts.")
        let postId = try await api.createPost(other, "A post on my profile")
        launch(as: me)

        openFromMore("more.users")
        element("users.prompt")
        screenshot("20-users-prompt")
        let field = app.searchFields.firstMatch
        field.tap()
        // Two characters isn't enough for a non-admin: still the prompt.
        field.typeText(String(other.username.prefix(2)))
        XCTAssertTrue(element("users.prompt").exists)
        field.typeText(String(other.username.dropFirst(2)))
        let row = element("users.row.\(other.id)")
        XCTAssertTrue(row.label.contains("Findable Person"))
        screenshot("21-users-results")

        row.tap()
        XCTAssertEqual(element("profile.name").label, "Findable Person")
        XCTAssertEqual(element("profile.bio").label, "I write posts.")
        element("feed.post.\(postId)")
        XCTAssertTrue(element("profile.message").exists)
        XCTAssertFalse(app.descendants(matching: .any)["profile.delete"].exists, "admin controls shown to a non-admin")
        screenshot("22-profile-with-posts")
    }

    func testEditDisplayNameAndBioThenSeeThemOnTheProfile() async throws {
        let me = try await api.makeUser("editor")
        launch(as: me)
        openFromMore("more.settings")
        element("settings.profile").tap()
        let name = element("settings.profile.displayName")
        replaceText(in: name, with: "Edited Name")
        let bio = element("settings.profile.bio")
        bio.tap()
        bio.typeText("Bio from the iPhone")
        screenshot("23-edit-profile")
        element("settings.profile.save").tap()
        XCTAssertTrue(element("settings.profile.message").label.contains("Profile updated"))

        // Back out to More, which already shows the new name, then the profile.
        backToMoreRoot()
        XCTAssertTrue(app.staticTexts["Edited Name"].waitForExistence(timeout: 10))
        element("more.profile").tap()
        XCTAssertEqual(element("profile.name").label, "Edited Name")
        XCTAssertEqual(element("profile.bio").label, "Bio from the iPhone")
        XCTAssertTrue(element("profile.edit").exists)
        screenshot("24-own-profile")
    }

    func testSetAStatusAndSeeItOnTheProfile() async throws {
        let me = try await api.makeUser("statusy")
        launch(as: me)
        openFromMore("more.settings")
        element("settings.status").tap()
        let emoji = element("settings.status.emoji")
        emoji.tap()
        emoji.typeText("🎯")
        let text = element("settings.status.text")
        text.tap()
        text.typeText("Shipping the iOS app")
        element("settings.status.expiry").tap()
        app.buttons["1 hour"].firstMatch.tap()
        screenshot("25-status-editor")
        element("settings.status.save").tap()
        XCTAssertTrue(element("settings.status.message").label.contains("Status updated"))
        XCTAssertTrue(element("settings.status.current").label.contains("Shipping the iOS app"))

        backToMoreRoot()
        element("more.profile").tap()
        let status = element("profile.status")
        XCTAssertTrue(status.label.contains("🎯"))
        XCTAssertTrue(status.label.contains("Shipping the iOS app"))
        screenshot("26-profile-status")
    }

    func testAnotherUsersStatusShowsLive() async throws {
        let me = try await api.makeUser("watcher")
        let other = try await api.makeUser("busy")
        launch(as: me)
        openProfile(of: other)
        XCTAssertFalse(app.descendants(matching: .any)["profile.status"].exists)
        waitForRealtime()
        try await api.setStatus(other, emoji: "🌴", text: "On holiday")
        XCTAssertTrue(element("profile.status").label.contains("On holiday"))
        screenshot("27-live-status")
    }

    func testBlockFromTheProfileThenUnblockInSettings() async throws {
        let me = try await api.makeUser("blocker")
        let other = try await api.makeUser("annoying")
        launch(as: me)
        openProfile(of: other)
        element("profile.block").tap()
        element("profile.block.confirm").tap()
        element("profile.unblock")
        screenshot("28-blocked-profile")

        backToMoreRoot()
        element("more.settings").tap()
        element("settings.blocked").tap()
        XCTAssertTrue(element("blocked.row.\(other.id)").exists)
        screenshot("29-blocked-list")
        element("blocked.row.\(other.id).lift").tap()
        element("blocked.empty")
        XCTAssertFalse(app.descendants(matching: .any)["blocked.row.\(other.id)"].exists)
    }

    func testMuteThenUnmuteOnTheProfile() async throws {
        let me = try await api.makeUser("muter")
        let other = try await api.makeUser("loud")
        launch(as: me)
        openProfile(of: other)
        element("profile.mute").tap()
        element("profile.unmute").tap()
        element("profile.mute")
    }

    func testChangePasswordThenLogInWithTheNewOne() async throws {
        let me = try await api.makeUser("rotator")
        let newPassword = "brand-new-pass-1"
        launch(as: me)
        openFromMore("more.settings")
        element("settings.password").tap()
        let current = element("settings.password.current")
        current.tap()
        current.typeText(me.password)
        let new = element("settings.password.new")
        new.tap()
        new.typeText("short")
        XCTAssertFalse(element("settings.password.save").isEnabled)
        new.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + newPassword)
        let confirm = element("settings.password.confirm")
        confirm.tap()
        confirm.typeText(newPassword)
        element("settings.password.save").tap()
        XCTAssertTrue(element("settings.password.message").label.contains("Password changed"))
        screenshot("30-password-changed")

        // This device stays signed in with its fresh tokens…
        app.navigationBars.buttons.firstMatch.tap()
        element("settings.logout").tap()
        element("settings.logout.confirm").tap()
        element("auth.screen")
        // …and the new password works.
        app.textFields["auth.username"].tap()
        app.textFields["auth.username"].typeText(me.username)
        app.secureTextFields["auth.password"].tap()
        app.secureTextFields["auth.password"].typeText(newPassword)
        element("auth.submit").tap()
        element("main.tabs")
        dismissSavePasswordPrompt()
        // Signing out reset the stacks: More is at its root again.
        selectTab("More")
        XCTAssertEqual(element("more.username").label, "@\(me.username)")
    }

    func testThemeSwitchRecolorsTheApp() async throws {
        let me = try await api.makeUser("themer")
        // Without `-uiAppearance` so the in-app choice is what decides.
        app.launchArguments = ["-uiTesting", "-apiBaseURL", TestEnvironment.baseURL.absoluteString, "-uiTestSession", me.sessionJSON]
        app.launch()
        openFromMore("more.settings")
        let picker = element("settings.theme")
        picker.buttons["Dark"].tap()
        try await Task.sleep(for: .seconds(1))
        XCTAssertLessThan(screenBrightness(), 0.35, "dark theme didn't darken the screen")
        screenshot("31-theme-dark")
        picker.buttons["Light"].tap()
        try await Task.sleep(for: .seconds(1))
        XCTAssertGreaterThan(screenBrightness(), 0.65, "light theme didn't lighten the screen")
        screenshot("32-theme-light")
        picker.buttons["System"].tap()
    }

    func testAnUploadedAvatarRenders() async throws {
        let me = try await api.makeUser("viewer")
        let other = try await api.makeUser("pictured")
        try await api.uploadAvatar(other)
        launch(as: me)
        openProfile(of: other)
        let photo = element("profile.avatar.photo")
        let loaded = NSPredicate(format: "value == 'loaded'")
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: loaded, object: photo)], timeout: 10), .completed,
                       "avatar never loaded (\(photo.value ?? "nil"))")
        screenshot("33-uploaded-avatar")
    }

    func testDeleteAccount() async throws {
        let me = try await api.makeUser("leaver")
        launch(as: me)
        openFromMore("more.settings")
        element("settings.deleteAccount").tap()
        let password = element("settings.delete.password")
        password.tap()
        password.typeText(me.password)
        element("settings.delete.submit").tap()
        element("settings.delete.confirm").tap()
        element("auth.screen")
        try await api.request("POST", "/users/login", body: ["username": me.username, "password": me.password], expect: 401..<402)
    }
}

final class AdminUserControlsTests: AppTestCase {
    func testAnAdminCanPromoteAndDeleteAUser() async throws {
        let admin = try await api.makeAdmin("boss")
        let other = try await api.makeUser("member")
        launch(as: admin)
        // Admins can browse everyone: an empty search already lists people.
        openFromMore("more.users")
        XCTAssertFalse(app.descendants(matching: .any)["users.prompt"].waitForExistence(timeout: 3))
        let field = app.searchFields.firstMatch
        field.tap()
        field.typeText(other.username)
        element("users.row.\(other.id)").tap()

        element("profile.toggleRole").tap()
        element("profile.role")
        screenshot("34-admin-promoted")
        element("profile.toggleRole").tap()
        XCTAssertTrue(app.descendants(matching: .any)["profile.role"].waitForNonExistence(timeout: 10))

        element("profile.delete").tap()
        element("profile.delete.confirm").tap()
        element("users.list")
        XCTAssertTrue(app.descendants(matching: .any)["users.row.\(other.id)"].waitForNonExistence(timeout: 10))
        try await api.request("GET", "/users/\(other.id)", token: admin.accessToken, expect: 404..<405)
    }
}
