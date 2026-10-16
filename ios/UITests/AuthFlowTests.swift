import XCTest

final class AuthFlowTests: AppTestCase {
    func testRegisterThenLogoutThenLogin() async throws {
        let username = "reg_\(UUID().uuidString.prefix(8).lowercased())"
        let password = "correct-horse-1"
        launch()

        element("auth.screen")
        screenshot("01-login")
        element("auth.switchMode").tap()
        XCTAssertEqual(element("auth.title").label, "Create your account")
        app.textFields["auth.username"].tap()
        app.textFields["auth.username"].typeText(username)
        app.secureTextFields["auth.password"].tap()
        app.secureTextFields["auth.password"].typeText(password)
        screenshot("02-register-filled")
        element("auth.submit").tap()

        // Registered and signed in: the tab shell with the Feed tab selected.
        element("main.tabs")
        dismissSavePasswordPrompt()
        XCTAssertTrue(app.tabBars.buttons["Feed"].exists)
        screenshot("03-signed-in")

        selectTab("More")
        XCTAssertEqual(element("more.username").label, "@\(username)")
        screenshot("04-more")
        element("more.logout").tap()
        element("more.logout.confirm").tap()
        element("auth.screen")
        screenshot("05-signed-out")

        // And back in with the credentials just created.
        app.textFields["auth.username"].tap()
        app.textFields["auth.username"].typeText(username)
        app.secureTextFields["auth.password"].tap()
        app.secureTextFields["auth.password"].typeText(password)
        element("auth.submit").tap()
        element("main.tabs")
    }

    func testWrongPasswordShowsTheServersMessage() async throws {
        let user = try await api.makeUser("wrongpw")
        launch()
        app.textFields["auth.username"].tap()
        app.textFields["auth.username"].typeText(user.username)
        app.secureTextFields["auth.password"].tap()
        app.secureTextFields["auth.password"].typeText("definitely-not-it")
        element("auth.submit").tap()
        XCTAssertFalse(element("auth.error").label.isEmpty)
        screenshot("wrong-password")
        XCTAssertFalse(app.otherElements["main.tabs"].exists)
    }

    func testSessionSurvivesARelaunch() async throws {
        let user = try await api.makeUser("persist")
        launch(as: user)
        element("main.tabs")
        // A second launch *without* injecting anything must read the Keychain…
        // except `-uiTesting` wipes it, so drop that flag for this one.
        app.terminate()
        app.launchArguments = ["-apiBaseURL", TestEnvironment.baseURL.absoluteString]
        app.launch()
        element("main.tabs")
        selectTab("More")
        XCTAssertEqual(element("more.username").label, "@\(user.username)")
    }

    func testRegisterRejectsAShortPasswordBeforeTheServerDoes() async throws {
        launch()
        element("auth.switchMode").tap()
        app.textFields["auth.username"].tap()
        app.textFields["auth.username"].typeText("someone_valid")
        app.secureTextFields["auth.password"].tap()
        app.secureTextFields["auth.password"].typeText("short")
        XCTAssertFalse(element("auth.submit").isEnabled)
    }
}
