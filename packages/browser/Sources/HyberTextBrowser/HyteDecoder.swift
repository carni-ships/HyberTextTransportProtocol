import Foundation
import Compression

// ── HYTE format constants ─────────────────────────────────────────────────────

private let MAGIC: [UInt8] = [0x48, 0x59, 0x54, 0x45] // "HYTE"
private let HEADER_SIZE = 9

private enum Comp: UInt8 {
    case none   = 0
    case gzip   = 1
    case brotli = 2
}

private enum CType: UInt8 {
    case html     = 0
    case tar      = 1
    case manifest = 2
}

private struct ManifestJSON: Codable {
    let v: Int
    let compression:  Int
    let content_type: Int
    let chunks:       [String]
    let total_size:   Int
}

// ── ResolvedSite ──────────────────────────────────────────────────────────────

struct ResolvedSite {
    private let files: [String: Data] // normalised path → bytes

    init(files: [String: Data]) { self.files = files }

    /// Returns (data, mimeType) for the given request path.
    /// Falls back to a 404 page rather than throwing.
    func file(at path: String) -> (Data, String) {
        var p = path.hasPrefix("/") ? String(path.dropFirst()) : path
        if p.isEmpty { p = "index.html" }

        if let data = files[p]           { return (data, mimeType(for: p)) }

        // Directory index fallback: /about → about/index.html
        let idx = p.hasSuffix("/") ? "\(p)index.html" : "\(p)/index.html"
        if let data = files[idx]         { return (data, "text/html; charset=utf-8") }

        let html = "<html><body style='font-family:system-ui;padding:40px'>" +
                   "<h2>404 — Not Found</h2><p>\(p)</p></body></html>"
        return (Data(html.utf8), "text/html; charset=utf-8")
    }
}

// ── HyteDecoder ───────────────────────────────────────────────────────────────

enum HyteDecoder {
    static func decode(raw: Data, fetcher: SiteFetcher) async throws -> ResolvedSite {
        guard raw.count >= HEADER_SIZE,
              raw[0..<4].elementsEqual(MAGIC)
        else { throw HyteError.invalidMagic }

        let comp  = Comp(rawValue:  raw[5]) ?? .none
        let ctype = CType(rawValue: raw[6]) ?? .html
        var payload = raw.dropFirst(HEADER_SIZE)

        // ── Manifest: assemble from chunks ───────────────────────────────────
        if ctype == .manifest {
            let manifest = try JSONDecoder().decode(ManifestJSON.self, from: payload)

            // Fetch all chunks in parallel, then reassemble in order
            let ordered = try await withThrowingTaskGroup(of: (Int, Data).self) { group in
                for (i, hash) in manifest.chunks.enumerated() {
                    group.addTask { (i, try await fetcher.fetchTxInput(txHash: hash)) }
                }
                var pairs: [(Int, Data)] = []
                for try await pair in group { pairs.append(pair) }
                return pairs.sorted { $0.0 < $1.0 }.map(\.1)
            }

            payload = Data(ordered.joined())
            let dc  = Comp(rawValue:  UInt8(manifest.compression))  ?? .none
            let dt  = CType(rawValue: UInt8(manifest.content_type)) ?? .html
            return try buildSite(payload: decompress(payload, comp: dc), ctype: dt)
        }

        return try buildSite(payload: decompress(payload, comp: comp), ctype: ctype)
    }

    // ── Site builder ──────────────────────────────────────────────────────────

    private static func buildSite(payload: Data, ctype: CType) throws -> ResolvedSite {
        switch ctype {
        case .html:
            return ResolvedSite(files: ["index.html": payload])
        case .tar:
            let entries = TarExtractor.extract(from: payload)
            var files   = [String: Data]()
            for e in entries {
                let normalised = e.path.hasPrefix("./") ? String(e.path.dropFirst(2)) : e.path
                files[normalised] = e.data
            }
            return ResolvedSite(files: files)
        case .manifest:
            throw HyteError.invalidMagic // already resolved above
        }
    }

    // ── Decompression ─────────────────────────────────────────────────────────

    private static func decompress(_ data: Data, comp: Comp) throws -> Data {
        switch comp {
        case .none:   return data
        case .brotli: return try brotliDecompress(data)
        case .gzip:   return try gzipDecompress(data)
        }
    }

    /// Brotli via Apple's Compression framework.
    private static func brotliDecompress(_ data: Data) throws -> Data {
        // compression_decode_buffer needs an output size estimate upfront.
        // Try increasing multiples until it succeeds.
        for multiplier in [10, 50, 200] {
            let capacity = max(data.count * multiplier, 4096)
            var output   = Data(count: capacity)
            var written  = 0

            let ok = data.withUnsafeBytes { src in
                output.withUnsafeMutableBytes { dst -> Bool in
                    guard let s = src.baseAddress, let d = dst.baseAddress else { return false }
                    written = compression_decode_buffer(
                        d.assumingMemoryBound(to: UInt8.self), capacity,
                        s.assumingMemoryBound(to: UInt8.self), data.count,
                        nil, COMPRESSION_BROTLI
                    )
                    return written > 0
                }
            }
            if ok { return output.prefix(written) }
        }
        throw HyteError.unsupportedCompression(2)
    }

    /// Gzip: strip the 10+ byte gzip header, then decompress raw DEFLATE
    /// using COMPRESSION_ZLIB (raw deflate without zlib framing).
    ///
    /// Note: Apple's COMPRESSION_ZLIB is raw DEFLATE — perfect for the
    /// compressed block inside a gzip file once the gzip wrapper is removed.
    private static func gzipDecompress(_ data: Data) throws -> Data {
        guard data.count > 18, data[0] == 0x1f, data[1] == 0x8b
        else { throw HyteError.unsupportedCompression(1) }

        let flags = data[3]
        var off   = 10

        if flags & 0x04 != 0 {  // FEXTRA
            guard off + 2 <= data.count else { throw HyteError.unsupportedCompression(1) }
            let xlen = Int(data[off]) | (Int(data[off + 1]) << 8)
            off += 2 + xlen
        }
        if flags & 0x08 != 0 {  // FNAME (null-terminated)
            while off < data.count && data[off] != 0 { off += 1 }
            off += 1
        }
        if flags & 0x10 != 0 {  // FCOMMENT (null-terminated)
            while off < data.count && data[off] != 0 { off += 1 }
            off += 1
        }
        if flags & 0x02 != 0 { off += 2 }  // FHCRC

        guard off < data.count - 8 else { throw HyteError.unsupportedCompression(1) }
        let deflate = data[off ..< data.count - 8]

        for multiplier in [10, 50, 200] {
            let capacity = max(deflate.count * multiplier, 4096)
            var output   = Data(count: capacity)
            var written  = 0

            let ok = deflate.withUnsafeBytes { src in
                output.withUnsafeMutableBytes { dst -> Bool in
                    guard let s = src.baseAddress, let d = dst.baseAddress else { return false }
                    written = compression_decode_buffer(
                        d.assumingMemoryBound(to: UInt8.self), capacity,
                        s.assumingMemoryBound(to: UInt8.self), deflate.count,
                        nil, COMPRESSION_ZLIB
                    )
                    return written > 0
                }
            }
            if ok { return output.prefix(written) }
        }
        throw HyteError.unsupportedCompression(1)
    }
}

// ── MIME types ────────────────────────────────────────────────────────────────

func mimeType(for path: String) -> String {
    switch (path as NSString).pathExtension.lowercased() {
    case "html", "htm": return "text/html; charset=utf-8"
    case "css":         return "text/css"
    case "js", "mjs":  return "text/javascript"
    case "json":        return "application/json"
    case "png":         return "image/png"
    case "jpg", "jpeg": return "image/jpeg"
    case "gif":         return "image/gif"
    case "svg":         return "image/svg+xml"
    case "webp":        return "image/webp"
    case "ico":         return "image/x-icon"
    case "woff":        return "font/woff"
    case "woff2":       return "font/woff2"
    case "ttf":         return "font/ttf"
    case "mp4":         return "video/mp4"
    case "webm":        return "video/webm"
    case "txt":         return "text/plain; charset=utf-8"
    case "xml":         return "application/xml"
    case "pdf":         return "application/pdf"
    default:            return "application/octet-stream"
    }
}
