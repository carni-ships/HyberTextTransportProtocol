import Foundation

// ── SiteFetcher ───────────────────────────────────────────────────────────────
// Actor: serialises cache access; tx data is immutable so no expiry needed.

actor SiteFetcher {
    let rpcURL: String
    private var cache: [String: ResolvedSite] = [:]

    init(rpcURL: String) { self.rpcURL = rpcURL }

    func site(for txHash: String) async throws -> ResolvedSite {
        let key = txHash.lowercased()
        if let cached = cache[key] { return cached }
        let raw  = try await fetchTxInput(txHash: txHash)
        let site = try await HyteDecoder.decode(raw: raw, fetcher: self)
        cache[key] = site
        return site
    }

    /// Fetch raw calldata (tx.input) for a transaction hash.
    func fetchTxInput(txHash: String) async throws -> Data {
        let body: [String: Any] = [
            "jsonrpc": "2.0",
            "method":  "eth_getTransactionByHash",
            "params":  [txHash],
            "id":      1,
        ]

        var req = URLRequest(url: URL(string: rpcURL)!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody   = try JSONSerialization.data(withJSONObject: body)

        let (data, _) = try await URLSession.shared.data(for: req)
        let json      = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        guard let result = json?["result"] as? [String: Any],
              let inputHex = result["input"] as? String
        else { throw HyteError.txNotFound(txHash) }

        let hex = inputHex.hasPrefix("0x") ? String(inputHex.dropFirst(2)) : inputHex
        return Data(hexString: hex) ?? Data()
    }
}

// ── Hex → Data ────────────────────────────────────────────────────────────────

extension Data {
    init?(hexString hex: String) {
        let s = hex.lowercased()
        guard s.count % 2 == 0 else { return nil }
        var data = Data(capacity: s.count / 2)
        var idx  = s.startIndex
        while idx < s.endIndex {
            let next = s.index(idx, offsetBy: 2)
            guard let byte = UInt8(s[idx..<next], radix: 16) else { return nil }
            data.append(byte)
            idx = next
        }
        self = data
    }
}
