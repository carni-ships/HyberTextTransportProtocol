import Foundation

struct TarEntry {
    let path: String
    let data: Data
}

enum TarExtractor {
    static func extract(from data: Data) -> [TarEntry] {
        var entries: [TarEntry] = []
        var offset = 0
        let blockSize = 512

        while offset + blockSize <= data.count {
            // End-of-archive marker: two consecutive zero blocks
            if data[offset ..< offset + blockSize].allSatisfy({ $0 == 0 }) { break }

            // ── Header fields ──────────────────────────────────────────────
            let name     = field(data, at: offset +   0, length: 100)
            let sizeOct  = field(data, at: offset + 124, length:  12)
            let typeFlag = data[offset + 156]
            let prefix   = field(data, at: offset + 345, length: 155) // UStar prefix

            let fileSize = Int(sizeOct.trimmingCharacters(in: .whitespaces), radix: 8) ?? 0
            let fullPath = prefix.isEmpty ? name : "\(prefix)/\(name)"

            offset += blockSize // advance past header

            // Regular file: type '0' or null byte
            if (typeFlag == UInt8(ascii: "0") || typeFlag == 0) && fileSize > 0 {
                if offset + fileSize <= data.count {
                    entries.append(TarEntry(
                        path: fullPath,
                        data: Data(data[offset ..< offset + fileSize])
                    ))
                }
            }

            // Advance past file data, padded to 512-byte boundary
            offset += ((fileSize + blockSize - 1) / blockSize) * blockSize
        }

        return entries
    }

    // Read a null-terminated ASCII/UTF-8 field from a fixed-width slot
    private static func field(_ data: Data, at start: Int, length: Int) -> String {
        let end   = min(start + length, data.count)
        let bytes = data[start ..< end].prefix(while: { $0 != 0 })
        return String(bytes: bytes, encoding: .utf8)
            ?? String(bytes: bytes, encoding: .isoLatin1)
            ?? ""
    }
}
