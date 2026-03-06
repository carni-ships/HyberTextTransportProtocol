import SwiftUI
import AppKit

@main
struct HyberTextBrowserApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .windowStyle(.titleBar)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands {
            CommandGroup(replacing: .newItem) {}

            // Explicitly route Edit shortcuts through the responder chain.
            // Without this, WKWebView intercepts Cmd+C/V/X even when the
            // address bar TextField has focus.
            CommandGroup(replacing: .pasteboard) {
                Button("Cut")        { NSApp.sendAction(#selector(NSText.cut(_:)),       to: nil, from: nil) }
                    .keyboardShortcut("x")
                Button("Copy")       { NSApp.sendAction(#selector(NSText.copy(_:)),      to: nil, from: nil) }
                    .keyboardShortcut("c")
                Button("Paste")      { NSApp.sendAction(#selector(NSText.paste(_:)),     to: nil, from: nil) }
                    .keyboardShortcut("v")
                Button("Select All") { NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: nil) }
                    .keyboardShortcut("a")
            }
        }
    }
}
