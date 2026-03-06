import Foundation
import WebKit
import AppKit

@MainActor
class BrowserModel: NSObject, ObservableObject {
    let webView: WKWebView

    @Published var displayURL  = ""
    @Published var pageTitle   = "HyberText"
    @Published var canGoBack    = false
    @Published var canGoForward = false
    @Published var isLoading    = false

    private let rpcURL: String

    init(rpcURL: String = ProcessInfo.processInfo.environment["BERACHAIN_RPC"]
                         ?? "https://rpc.berachain.com") {
        self.rpcURL = rpcURL

        let config = WKWebViewConfiguration()
        let handler = HyteSchemeHandler(
            fetcher: SiteFetcher(rpcURL: rpcURL)
        )
        config.setURLSchemeHandler(handler, forURLScheme: "bera")

        // Allow JS, local storage, etc. — sites may need these
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        self.webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    func navigate(to input: String) {
        var s = input.trimmingCharacters(in: .whitespaces)
        // Accept bare tx hash — use triple-slash (path-based) to avoid DNS 63-char label limit
        if s.hasPrefix("0x") && !s.contains("://") { s = "bera:///\(s)" }
        guard let url = URL(string: s) else { return }
        webView.load(URLRequest(url: url))
    }

    func showLanding() {
        webView.loadHTMLString(landingHTML, baseURL: nil)
    }
}

// ── WKNavigationDelegate ──────────────────────────────────────────────────────

extension BrowserModel: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation _: WKNavigation!) {
        isLoading = true
    }

    func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        isLoading    = false
        canGoBack    = webView.canGoBack
        canGoForward = webView.canGoForward
        let raw      = webView.url?.absoluteString ?? ""
        displayURL   = raw.hasPrefix("about:") ? "" : raw
        pageTitle    = webView.title?.isEmpty == false ? webView.title! : "HyberText"
    }

    func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        isLoading = false
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation _: WKNavigation!,
                 withError error: Error) {
        isLoading = false
        let msg = error.localizedDescription
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        webView.loadHTMLString(errorHTML(msg), baseURL: nil)
    }
}

// ── HTML templates ────────────────────────────────────────────────────────────

private let landingHTML = """
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f7; color: #1d1d1f;
      max-width: 560px; margin: 80px auto; padding: 0 24px;
    }
    h1 { font-size: 26px; font-weight: 700; margin: 0 0 6px; }
    .sub { color: #6e6e73; font-size: 15px; margin: 0 0 32px; }
    .card {
      background: white; border-radius: 12px; padding: 20px 24px;
      margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.07);
    }
    .card h2 { font-size: 14px; font-weight: 600; margin: 0 0 6px; color: #1d1d1f; }
    .card p  { font-size: 14px; color: #6e6e73; margin: 0; line-height: 1.55; }
    code {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 12px; background: #f0f0f5;
      padding: 1px 5px; border-radius: 4px; color: #1d1d1f;
    }
  </style>
</head>
<body>
  <h1>HyberText</h1>
  <p class="sub">Decentralised websites on Berachain.</p>

  <div class="card">
    <h2>Open a site</h2>
    <p>Paste a transaction hash or <code>bera://0x…</code> URL into the address bar and press Return.</p>
  </div>

  <div class="card">
    <h2>Publish a site</h2>
    <p>
      <code>hybertext publish ./index.html</code><br><br>
      The transaction hash that comes back is the permanent, immutable address of your site.
    </p>
  </div>

  <div class="card">
    <h2>How it works</h2>
    <p>
      Sites are stored as <strong>calldata</strong> in Berachain transactions.
      No IPFS. No pinning. No servers. Content lives on-chain forever.
    </p>
  </div>
</body>
</html>
"""

private func errorHTML(_ message: String) -> String {
    """
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8">
    <style>
      body { font-family: -apple-system, sans-serif; max-width: 500px;
             margin: 80px auto; padding: 0 24px; color: #1d1d1f; }
      h2   { color: #c0392b; font-size: 18px; }
      p    { color: #6e6e73; font-size: 14px; line-height: 1.5; }
    </style></head>
    <body>
      <h2>Failed to load site</h2>
      <p>\(message)</p>
    </body></html>
    """
}
