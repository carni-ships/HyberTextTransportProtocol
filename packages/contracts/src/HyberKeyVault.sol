// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  HyberKeyVault
/// @notice On-chain registry of ECDH-wrapped Content Encryption Keys (CEKs) for
///         HyberText encrypted sites.
///
///         Publishers encrypt their site AES-256-GCM key using the Worker's static
///         X25519 public key (ECDH + HKDF-SHA256 + AES-256-GCM wrapping).
///         The 92-byte wrappedKey blob is stored here so the Worker can unwrap it
///         on demand after verifying payment.
///
///         Payment flow (Berachain-native, compatible with x402 conventions):
///           1. Client requests site → Worker returns 402 with payment details
///           2. Client sends BERA tx to beneficiary with siteTxHash as calldata
///           3. Client retries with X-Payment-Tx + X-Payment-Payer headers
///           4. Worker verifies tx on-chain, calls grantAccess(), issues session
///           5. Worker unwraps CEK, decrypts, serves content
///
///         Key expiry is enforced via keyDuration on grantAccess grants.
///         A keyDuration of 0 grants permanent access after payment.
contract HyberKeyVault {

    // ─── Types ───────────────────────────────────────────────────────────────

    struct VaultRecord {
        address publisher;     // who registered the vault
        uint256 priceWei;      // BERA access price (wei)
        uint64  keyDuration;   // seconds an access grant lasts (0 = permanent)
        uint64  createdAt;     // block.timestamp at registration
        bool    active;        // false = new grants rejected (existing grants unaffected)
        bytes   wrappedKey;    // 92-byte blob: [ephPub(32)][wrapIV(12)][wrappedCEK(32)][tag(16)]
    }

    struct AccessGrant {
        uint64  grantedAt;     // block.timestamp of grant
        uint64  expiresAt;     // grantedAt + keyDuration; 0 = permanent
        bytes32 paymentTxHash; // prevents replay
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    mapping(bytes32 => VaultRecord)                          private _vaults;
    mapping(bytes32 => mapping(address => AccessGrant))      private _grants;
    mapping(bytes32 => bool)                                  private _usedPayments;

    // ─── Events ──────────────────────────────────────────────────────────────

    event VaultRegistered(
        bytes32 indexed siteTxHash,
        address indexed publisher,
        uint256         priceWei,
        uint64          keyDuration
    );
    event VaultUpdated(bytes32 indexed siteTxHash, uint256 priceWei, uint64 keyDuration);
    event VaultToggled(bytes32 indexed siteTxHash, bool active);
    event AccessGranted(
        bytes32 indexed siteTxHash,
        address indexed payer,
        bytes32 indexed paymentTxHash,
        uint64          expiresAt
    );

    // ─── Errors ──────────────────────────────────────────────────────────────

    error AlreadyRegistered(bytes32 siteTxHash);
    error NotPublisher(bytes32 siteTxHash);
    error VaultNotFound(bytes32 siteTxHash);
    error VaultInactive(bytes32 siteTxHash);
    error PaymentAlreadyUsed(bytes32 paymentTxHash);
    error InvalidWrappedKeyLength(uint256 got); // must be exactly 92
    error ZeroTxHash();

    // ─── Write: publisher ────────────────────────────────────────────────────

    /// @notice Register a new encrypted site vault.
    /// @param siteTxHash  Berachain tx hash of the ENCRYPTED HYTE transaction.
    /// @param wrappedKey  92-byte blob: [ephPub(32)][wrapIV(12)][wrappedCEK(32)][tag(16)].
    /// @param priceWei    BERA access price (0 = free — Worker still enforces payment skipping).
    /// @param keyDuration Seconds an access grant lasts. 0 = permanent access.
    function register(
        bytes32        siteTxHash,
        bytes calldata wrappedKey,
        uint256        priceWei,
        uint64         keyDuration
    ) external {
        if (siteTxHash == bytes32(0)) revert ZeroTxHash();
        if (_vaults[siteTxHash].createdAt != 0) revert AlreadyRegistered(siteTxHash);
        if (wrappedKey.length != 92) revert InvalidWrappedKeyLength(wrappedKey.length);

        _vaults[siteTxHash] = VaultRecord({
            publisher:   msg.sender,
            priceWei:    priceWei,
            keyDuration: keyDuration,
            createdAt:   uint64(block.timestamp),
            active:      true,
            wrappedKey:  wrappedKey
        });

        emit VaultRegistered(siteTxHash, msg.sender, priceWei, keyDuration);
    }

    /// @notice Update price or duration. Publisher only.
    function update(bytes32 siteTxHash, uint256 newPriceWei, uint64 newKeyDuration) external {
        if (_vaults[siteTxHash].publisher != msg.sender) revert NotPublisher(siteTxHash);
        _vaults[siteTxHash].priceWei    = newPriceWei;
        _vaults[siteTxHash].keyDuration = newKeyDuration;
        emit VaultUpdated(siteTxHash, newPriceWei, newKeyDuration);
    }

    /// @notice Deactivate (no new grants) or reactivate a vault. Publisher only.
    function setActive(bytes32 siteTxHash, bool active) external {
        if (_vaults[siteTxHash].publisher != msg.sender) revert NotPublisher(siteTxHash);
        _vaults[siteTxHash].active = active;
        emit VaultToggled(siteTxHash, active);
    }

    // ─── Write: grant (callable by Worker EOA or any address) ────────────────

    /// @notice Record a verified access grant after payment has been confirmed off-chain.
    ///         The Worker verifies the payment tx before calling this; this function's
    ///         role is replay prevention and grant timestamping.
    /// @param siteTxHash     The site being accessed.
    /// @param payer          Ethereum address that sent the payment tx.
    /// @param paymentTxHash  Berachain tx hash of the BERA payment (used-once).
    function grantAccess(
        bytes32 siteTxHash,
        address payer,
        bytes32 paymentTxHash
    ) external {
        if (_vaults[siteTxHash].createdAt == 0) revert VaultNotFound(siteTxHash);
        if (!_vaults[siteTxHash].active)        revert VaultInactive(siteTxHash);
        if (_usedPayments[paymentTxHash])        revert PaymentAlreadyUsed(paymentTxHash);

        _usedPayments[paymentTxHash] = true;

        uint64 keyDuration = _vaults[siteTxHash].keyDuration;
        uint64 grantedAt   = uint64(block.timestamp);
        uint64 expiresAt   = keyDuration == 0 ? 0 : grantedAt + keyDuration;

        _grants[siteTxHash][payer] = AccessGrant({
            grantedAt:     grantedAt,
            expiresAt:     expiresAt,
            paymentTxHash: paymentTxHash
        });

        emit AccessGranted(siteTxHash, payer, paymentTxHash, expiresAt);
    }

    // ─── Read ────────────────────────────────────────────────────────────────

    function getVault(bytes32 siteTxHash) external view returns (VaultRecord memory) {
        return _vaults[siteTxHash];
    }

    function getGrant(bytes32 siteTxHash, address payer) external view returns (AccessGrant memory) {
        return _grants[siteTxHash][payer];
    }

    /// @notice True if payer currently has a valid (non-expired) access grant.
    function hasAccess(bytes32 siteTxHash, address payer) external view returns (bool) {
        AccessGrant storage g = _grants[siteTxHash][payer];
        if (g.grantedAt == 0) return false;
        return g.expiresAt == 0 || block.timestamp <= g.expiresAt;
    }

    function isPaymentUsed(bytes32 paymentTxHash) external view returns (bool) {
        return _usedPayments[paymentTxHash];
    }
}
