// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  HyberDB
/// @notice Mutable pointer store for HyberText databases with inline ERC-721
///         namespace ownership (no OpenZeppelin dependency).
///
///         Token ID for a namespace named `name`:
///             uint256(keccak256(bytes(name)))
///
///         Tokens are minted on create() and never burned.
///         transferFrom / safeTransferFrom transfer both the ERC-721 token AND
///         the _ns[key].owner field atomically, and update roles accordingly.
///
///         MUD-inspired additions (v2):
///           - NamespaceCreated event distinct from first Committed
///           - CommitData event with caller-supplied index hint
///           - Optional per-namespace hook called before every commit
///           - batchCommit() for atomic multi-namespace writes
contract HyberDB {

    // ─── Types ───────────────────────────────────────────────────────────────

    enum Role { NONE, READER, WRITER, OWNER }

    struct Namespace {
        bytes32 head;       // txHash of latest DB patch or snapshot
        address owner;
        bytes32 schema;     // txHash of JSON Schema (zero = no schema)
        uint64  updatedAt;  // block.timestamp of last commit
        address hook;       // optional: IHyberHook called before every commit (zero = none)
                            // packed with updatedAt → no extra storage slot
    }

    /// @notice Input type for batchCommit().
    struct CommitCall {
        string  name;
        bytes32 newHead;
    }

    // ─── Storage — HyberDB ───────────────────────────────────────────────────

    /// @dev keccak256(name) → Namespace
    mapping(bytes32 => Namespace) private _ns;

    /// @dev keccak256(name) → address → Role
    mapping(bytes32 => mapping(address => Role)) private _roles;

    /// @dev keccak256(abi.encodePacked(nsKey, user)) → nonce (EIP-712 replay protection)
    mapping(bytes32 => uint256) private _nonces;

    // ─── Storage — ERC-721 ───────────────────────────────────────────────────

    /// @dev tokenId → approved spender
    mapping(uint256 => address) private _tokenApprovals;

    /// @dev owner → operator → isApproved
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    /// @dev owner → number of namespaces owned
    mapping(address => uint256) private _balances;

    // ─── EIP-712 ─────────────────────────────────────────────────────────────

    bytes32 public constant COMMIT_TYPEHASH =
        keccak256("Commit(string ns,bytes32 newHead,uint256 nonce)");

    bytes32 public immutable DOMAIN_SEPARATOR;

    // ─── ERC-721 constants ───────────────────────────────────────────────────

    bytes4 private constant _ERC721_RECEIVED          = 0x150b7a02;
    bytes4 private constant _INTERFACE_ERC165          = 0x01ffc9a7;
    bytes4 private constant _INTERFACE_ERC721          = 0x80ac58cd;
    bytes4 private constant _INTERFACE_ERC721_METADATA = 0x5b5e139f;

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("HyberDB"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ─── Events — HyberDB ────────────────────────────────────────────────────

    /// @notice Emitted once when a namespace is first created.
    ///         Indexers use this to distinguish creation from subsequent updates.
    event NamespaceCreated(string indexed name, address indexed owner);

    /// @notice Emitted on every commit (creation or update).
    event Committed(string indexed name, bytes32 head, address indexed committer);

    /// @notice Emitted alongside Committed when the caller supplies a non-empty
    ///         index hint (e.g. compact op summary for off-chain indexers).
    ///         Inspired by MUD Store splice events: lets indexers maintain a key
    ///         inventory without fetching full calldata for every commit.
    event CommitData(string indexed name, bytes32 head, bytes hint);

    event RoleGranted(string indexed name, address indexed user, Role role);
    event SchemaSet(string indexed name, bytes32 schemaHash);
    event HookSet(string indexed name, address hook);

    // ─── Events — ERC-721 (EIP-721) ──────────────────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error AlreadyExists(string name);
    error Unauthorized(string name);
    error HeadMismatch(string name);
    error InvalidNonce();
    error InvalidSignature();
    error EmptyName();

    error ERC721_ZeroAddress();
    error ERC721_NotOwnerOrApproved();
    error ERC721_TokenDoesNotExist();
    error ERC721_NotERC721Receiver();
    error ERC721_ApproveToCaller();

    // ─── ERC-165 ─────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return
            interfaceId == _INTERFACE_ERC165 ||
            interfaceId == _INTERFACE_ERC721 ||
            interfaceId == _INTERFACE_ERC721_METADATA;
    }

    // ─── ERC-721 view ────────────────────────────────────────────────────────

    /// @notice Returns the number of namespaces owned by `owner`.
    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ERC721_ZeroAddress();
        return _balances[owner];
    }

    /// @notice Returns the current owner of the namespace token `tokenId`.
    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _ns[bytes32(tokenId)].owner;
        if (owner == address(0)) revert ERC721_TokenDoesNotExist();
        return owner;
    }

    /// @notice Returns the address approved to transfer `tokenId`, or zero.
    function getApproved(uint256 tokenId) public view returns (address) {
        if (_ns[bytes32(tokenId)].owner == address(0)) revert ERC721_TokenDoesNotExist();
        return _tokenApprovals[tokenId];
    }

    /// @notice Returns whether `operator` is approved to manage all of `owner`'s tokens.
    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    // ─── ERC-721 approvals ───────────────────────────────────────────────────

    /// @notice Approve `to` to transfer the token `tokenId`.
    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (to == owner) revert ERC721_ApproveToCaller();
        if (msg.sender != owner && !isApprovedForAll(owner, msg.sender)) {
            revert ERC721_NotOwnerOrApproved();
        }
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    /// @notice Grant or revoke `operator`'s ability to manage all caller's tokens.
    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) revert ERC721_ApproveToCaller();
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    // ─── ERC-721 transfers ───────────────────────────────────────────────────

    /// @notice Transfer namespace ownership (token + _ns.owner) from `from` to `to`.
    function transferFrom(address from, address to, uint256 tokenId) public {
        if (to == address(0)) revert ERC721_ZeroAddress();
        address owner = ownerOf(tokenId); // reverts if token doesn't exist
        if (from != owner) revert ERC721_NotOwnerOrApproved();
        if (
            msg.sender != owner &&
            msg.sender != _tokenApprovals[tokenId] &&
            !isApprovedForAll(owner, msg.sender)
        ) {
            revert ERC721_NotOwnerOrApproved();
        }
        _transferToken(from, to, tokenId);
    }

    /// @notice Safe transfer — calls onERC721Received if `to` is a contract.
    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    /// @notice Safe transfer with additional `data` payload.
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        _checkOnERC721Received(from, to, tokenId, data);
    }

    // ─── Write: namespace creation ───────────────────────────────────────────

    /// @notice Create a new namespace. First-come-first-served.
    /// @param  name        Human-readable namespace (e.g. "my-app/users")
    /// @param  initialHead txHash of the genesis DB patch or snapshot (zero ok)
    function create(string calldata name, bytes32 initialHead) external {
        if (bytes(name).length == 0) revert EmptyName();
        bytes32 key = keccak256(bytes(name));
        if (_ns[key].owner != address(0)) revert AlreadyExists(name);

        _ns[key] = Namespace({
            head:      initialHead,
            owner:     msg.sender,
            schema:    bytes32(0),
            updatedAt: uint64(block.timestamp),
            hook:      address(0)
        });
        _roles[key][msg.sender] = Role.OWNER;
        _balances[msg.sender]++;

        // Mint ERC-721 token (from zero address per EIP-721 spec).
        emit Transfer(address(0), msg.sender, uint256(key));

        // NamespaceCreated is distinct from Committed so indexers can
        // distinguish creation from updates without special-casing head comparisons.
        emit NamespaceCreated(name, msg.sender);
        emit Committed(name, initialHead, msg.sender);
    }

    // ─── Write: committing a new head ────────────────────────────────────────

    /// @notice Advance the head pointer. Caller must be WRITER or OWNER.
    function commit(string calldata name, bytes32 newHead) external {
        bytes32 key = keccak256(bytes(name));
        if (_roles[key][msg.sender] < Role.WRITER) revert Unauthorized(name);
        _commitInternal(key, name, newHead, msg.sender, "");
    }

    /// @notice Advance the head pointer with an index hint for off-chain indexers.
    ///         `hint` is opaque bytes emitted in CommitData — use it to encode a
    ///         compact op summary (e.g. JSON array of changed keys) so indexers
    ///         don't need to fetch full calldata for routine queries.
    function commit(string calldata name, bytes32 newHead, bytes calldata hint) external {
        bytes32 key = keccak256(bytes(name));
        if (_roles[key][msg.sender] < Role.WRITER) revert Unauthorized(name);
        _commitInternal(key, name, newHead, msg.sender, bytes(hint));
    }

    /// @notice Commit with optimistic concurrency: reverts if current head != expectedHead.
    function commitCAS(
        string calldata name,
        bytes32 newHead,
        bytes32 expectedHead
    ) external {
        bytes32 key = keccak256(bytes(name));
        if (_roles[key][msg.sender] < Role.WRITER) revert Unauthorized(name);
        if (_ns[key].head != expectedHead) revert HeadMismatch(name);
        _commitInternal(key, name, newHead, msg.sender, "");
    }

    /// @notice Gasless commit: relayer submits user's EIP-712 signature.
    function commitSigned(
        string calldata name,
        bytes32 newHead,
        address signer,
        uint256 nonce,
        bytes calldata sig
    ) external {
        bytes32 key = keccak256(bytes(name));
        if (_roles[key][signer] < Role.WRITER) revert Unauthorized(name);

        bytes32 nonceKey = keccak256(abi.encodePacked(key, signer));
        if (_nonces[nonceKey] != nonce) revert InvalidNonce();
        _nonces[nonceKey]++;

        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            DOMAIN_SEPARATOR,
            keccak256(abi.encode(
                COMMIT_TYPEHASH,
                keccak256(bytes(name)),
                newHead,
                nonce
            ))
        ));

        if (sig.length != 65) revert InvalidSignature();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := mload(add(sig.offset, 32))
            s := mload(add(sig.offset, 64))
            v := byte(0, mload(add(sig.offset, 96)))
        }
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();

        _commitInternal(key, name, newHead, signer, "");
    }

    /// @notice Atomically commit multiple namespaces in a single transaction.
    ///         All callers must have at least WRITER role on every namespace.
    ///         Reverts entirely if any single commit fails.
    function batchCommit(CommitCall[] calldata calls) external {
        for (uint256 i; i < calls.length; ++i) {
            bytes32 key = keccak256(bytes(calls[i].name));
            if (_roles[key][msg.sender] < Role.WRITER) revert Unauthorized(calls[i].name);
            _commitInternal(key, calls[i].name, calls[i].newHead, msg.sender, "");
        }
    }

    // ─── Write: access control ───────────────────────────────────────────────

    /// @notice Grant a role to an address. Caller must be OWNER of the namespace.
    function grantRole(string calldata name, address user, Role role) external {
        bytes32 key = keccak256(bytes(name));
        if (_roles[key][msg.sender] != Role.OWNER) revert Unauthorized(name);
        _roles[key][user] = role;
        emit RoleGranted(name, user, role);
    }

    /// @notice Attach a JSON Schema (stored as HYTE calldata) to a namespace.
    function setSchema(string calldata name, bytes32 schemaHash) external {
        bytes32 key = keccak256(bytes(name));
        if (_roles[key][msg.sender] < Role.OWNER) revert Unauthorized(name);
        _ns[key].schema = schemaHash;
        emit SchemaSet(name, schemaHash);
    }

    /// @notice Register a hook contract called before every commit on this namespace.
    ///         The hook may revert to reject invalid patches (e.g. schema validation).
    ///         Pass address(0) to disable.  Caller must be OWNER.
    function setHook(string calldata name, address hook) external {
        bytes32 key = keccak256(bytes(name));
        if (_roles[key][msg.sender] != Role.OWNER) revert Unauthorized(name);
        _ns[key].hook = hook;
        emit HookSet(name, hook);
    }

    // ─── Read ────────────────────────────────────────────────────────────────

    function getNamespace(string calldata name) external view returns (Namespace memory) {
        return _ns[keccak256(bytes(name))];
    }

    function getRole(string calldata name, address user) external view returns (Role) {
        return _roles[keccak256(bytes(name))][user];
    }

    function getNonce(string calldata name, address user) external view returns (uint256) {
        bytes32 key = keccak256(bytes(name));
        return _nonces[keccak256(abi.encodePacked(key, user))];
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _commitInternal(
        bytes32        key,
        string calldata name,
        bytes32        newHead,
        address        committer,
        bytes memory   hint
    ) internal {
        // Call hook if registered — hook may revert to reject the commit.
        address hook = _ns[key].hook;
        if (hook != address(0)) {
            IHyberHook(hook).beforeCommit(key, newHead);
        }

        _ns[key].head      = newHead;
        _ns[key].updatedAt = uint64(block.timestamp);

        emit Committed(name, newHead, committer);

        // Emit rich index event only when the caller supplies a hint.
        // This keeps basic commits cheap while giving indexers structured data
        // when available (analogous to MUD Store splice events).
        if (hint.length > 0) {
            emit CommitData(name, newHead, hint);
        }
    }

    /// @dev Executes the actual token + ownership transfer.
    ///      Clears the per-token approval, adjusts balances, syncs _ns.owner,
    ///      strips the old owner's Role.OWNER and grants it to the new owner.
    function _transferToken(address from, address to, uint256 tokenId) internal {
        bytes32 key = bytes32(tokenId);

        // Clear single-token approval.
        delete _tokenApprovals[tokenId];

        // Update ERC-721 balances.
        _balances[from]--;
        _balances[to]++;

        // Sync namespace owner so HyberDB and ERC-721 state stay consistent.
        _ns[key].owner = to;

        // Transfer the OWNER role: revoke from old owner, grant to new owner.
        // Other roles (READER / WRITER) granted to third parties are intentionally
        // preserved; the new owner can revoke them via grantRole if desired.
        _roles[key][from] = Role.NONE;
        _roles[key][to]   = Role.OWNER;

        emit Transfer(from, to, tokenId);
    }

    /// @dev If `to` is a contract, verify it implements IERC721Receiver correctly.
    function _checkOnERC721Received(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) internal {
        if (to.code.length == 0) return; // EOA — no callback needed
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 retval) {
            if (retval != _ERC721_RECEIVED) revert ERC721_NotERC721Receiver();
        } catch {
            revert ERC721_NotERC721Receiver();
        }
    }
}

// ─── Hook interface ───────────────────────────────────────────────────────────

/// @notice Implement this interface and register via setHook() to add per-namespace
///         validation or side-effects on every commit.
interface IHyberHook {
    /// @notice Called before the head pointer is updated.
    ///         Revert to reject the commit (e.g. schema validation failure).
    /// @param nsKey    keccak256(bytes(name)) — the namespace storage key
    /// @param newHead  Proposed new head txHash
    function beforeCommit(bytes32 nsKey, bytes32 newHead) external;
}

// ─── Minimal receiver interface (no OZ dependency) ───────────────────────────

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}
