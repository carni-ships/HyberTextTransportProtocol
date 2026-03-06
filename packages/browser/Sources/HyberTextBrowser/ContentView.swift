import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var model = BrowserModel()
    @State private var addressInput = ""
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // ── Toolbar ──────────────────────────────────────────────────────
            HStack(spacing: 6) {
                Button { model.webView.goBack() } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.borderless)
                .disabled(!model.canGoBack)
                .keyboardShortcut("[", modifiers: .command)

                Button { model.webView.goForward() } label: {
                    Image(systemName: "chevron.right")
                }
                .buttonStyle(.borderless)
                .disabled(!model.canGoForward)
                .keyboardShortcut("]", modifiers: .command)

                TextField("bera://0x… or paste tx hash", text: $addressInput)
                    .textFieldStyle(.roundedBorder)
                    .focused($addressFocused)
                    .onSubmit {
                        model.navigate(to: addressInput)
                        addressFocused = false
                    }
                    // Sync address bar when navigation happens externally
                    .onChange(of: model.displayURL) { newValue in
                        if !addressFocused { addressInput = newValue }
                    }

                Button {
                    model.navigate(to: addressInput)
                    addressFocused = false
                } label: {
                    Text("Go")
                        .fontWeight(.medium)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(addressInput.trimmingCharacters(in: .whitespaces).isEmpty)

                if model.isLoading {
                    ProgressView().scaleEffect(0.6).frame(width: 22)
                } else {
                    Button { model.webView.reload() } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("r", modifiers: .command)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.bar)

            Divider()

            WebView(webView: model.webView)
        }
        .frame(minWidth: 900, minHeight: 620)
        .navigationTitle(model.pageTitle)
        .onAppear { model.showLanding() }
        // Cmd+L focuses address bar
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("FocusAddressBar"))) { _ in
            addressFocused = true
            addressInput = model.displayURL
        }
    }
}

// ── WKWebView bridge ──────────────────────────────────────────────────────────

struct WebView: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
