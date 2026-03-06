import WebKit
import Foundation

// ── Custom URL scheme handler for bera:// ────────────────────────────────────
//
// URL layout:  bera://{txhash}/{asset/path}
//   host  = transaction hash (lowercase hex, e.g. 0xabc123…)
//   path  = asset within a multi-file tar site (/ for root / index.html)

final class HyteSchemeHandler: NSObject, WKURLSchemeHandler {
    private let fetcher: SiteFetcher
    private var activeTasks = Set<ObjectIdentifier>()
    private let lock = NSLock()

    init(fetcher: SiteFetcher) {
        self.fetcher = fetcher
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        lock.lock(); activeTasks.insert(id); lock.unlock()

        Task { await handle(task: task, id: id) }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); activeTasks.remove(ObjectIdentifier(task)); lock.unlock()
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private func isActive(_ id: ObjectIdentifier) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return activeTasks.contains(id)
    }

    private func handle(task: WKURLSchemeTask, id: ObjectIdentifier) async {
        guard isActive(id),
              let url = task.request.url
        else {
            if isActive(id) { task.didFailWithError(HyteError.invalidURL) }
            return
        }

        // URL format: bera:///0x{txhash}/optional/asset/path
        // pathComponents = ["/", "0x{txhash}", "asset", "path"]
        let components = url.pathComponents
        guard components.count >= 2 else {
            task.didFailWithError(HyteError.invalidURL)
            return
        }
        let txHash    = components[1]
        let assetPath = components.count > 2
            ? "/" + components[2...].joined(separator: "/")
            : "/"

        do {
            let site            = try await fetcher.site(for: txHash)
            let (data, mime)    = site.file(at: assetPath)

            guard isActive(id) else { return }

            let response = HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type":  mime,
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "Access-Control-Allow-Origin": "*",
                ]
            )!
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        } catch {
            guard isActive(id) else { return }
            task.didFailWithError(error)
        }

        lock.lock(); activeTasks.remove(id); lock.unlock()
    }
}

// ── Error types ───────────────────────────────────────────────────────────────

enum HyteError: LocalizedError {
    case invalidURL
    case invalidMagic
    case txNotFound(String)
    case unsupportedCompression(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL:                     return "Invalid bera:// URL"
        case .invalidMagic:                   return "Not a HyberText site (bad magic bytes)"
        case .txNotFound(let h):              return "Transaction not found: \(h)"
        case .unsupportedCompression(let c):  return "Unsupported compression type \(c) — republish with brotli"
        }
    }
}
