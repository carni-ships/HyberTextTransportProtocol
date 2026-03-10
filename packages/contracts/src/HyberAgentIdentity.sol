// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  HyberAgentIdentity
/// @notice ERC-8004 Agent Identity Registry.
///         Each registered agent receives an ERC-721 identity token.
///         Portable identifier format: eip155:{chainId}:{thisAddress}:{tokenId}
///
///         No OpenZeppelin dependency — self-contained, same style as HyberACP.sol.
contract HyberAgentIdentity {

    // ─── Types ────────────────────────────────────────────────────────────────

    struct AgentRegistration {
        string   name;         // unique human-readable name (max 64 chars)
        string   description;  // what this agent does
        string   mcpEndpoint;  // MCP server URL (primary service endpoint)
        string[] tags;         // capability tags, e.g. ["research", "gpt-training"]
        uint256  registeredAt;
        uint256  updatedAt;
    }

    // ─── ERC-721 minimal state ────────────────────────────────────────────────

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _approvals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // ─── Identity state ───────────────────────────────────────────────────────

    uint256 public totalSupply;

    mapping(uint256 => AgentRegistration) private _registrations;
    /// @dev wallet → tokenId (0 = unregistered)
    mapping(address => uint256) public agentTokenId;
    /// @dev keccak256(name) → registered (prevents duplicate names)
    mapping(bytes32 => bool) public nameTaken;

    // ─── ERC-721 metadata ─────────────────────────────────────────────────────

    string public constant name   = "HyberAgentIdentity";
    string public constant symbol = "HAGENT";

    // ─── Events ───────────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event AgentRegistered(uint256 indexed tokenId, address indexed owner, string name);
    event AgentUpdated(uint256 indexed tokenId);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error AlreadyRegistered();
    error NameTaken();
    error InvalidName();
    error NotOwner();
    error InvalidToken();
    error NotApproved();

    // ─── ERC-165 ──────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd  // ERC-721
            || id == 0x01ffc9a7; // ERC-165
    }

    // ─── ERC-721 view ─────────────────────────────────────────────────────────

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owners[tokenId];
        if (o == address(0)) revert InvalidToken();
        return o;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _approvals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    // ─── ERC-721 write ────────────────────────────────────────────────────────

    function approve(address to, uint256 tokenId) external {
        if (_owners[tokenId] != msg.sender) revert NotOwner();
        _approvals[tokenId] = to;
        emit Approval(msg.sender, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner != from) revert NotOwner();
        bool ok = (msg.sender == tokenOwner)
               || _operatorApprovals[tokenOwner][msg.sender]
               || _approvals[tokenId] == msg.sender;
        if (!ok) revert NotApproved();

        _balances[from]--;
        _balances[to]++;
        _owners[tokenId] = to;
        delete _approvals[tokenId];

        // Mirror wallet→tokenId mapping after transfer
        delete agentTokenId[from];
        agentTokenId[to] = tokenId;

        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external {
        transferFrom(from, to, tokenId);
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    /// @notice Register a new agent and mint an ERC-8004 identity token.
    /// @return tokenId  The newly minted token id (1-indexed).
    function register(
        string  calldata _name,
        string  calldata _description,
        string  calldata _mcpEndpoint,
        string[] calldata _tags
    ) external returns (uint256 tokenId) {
        if (agentTokenId[msg.sender] != 0) revert AlreadyRegistered();
        bytes32 nameHash = keccak256(bytes(_name));
        if (nameTaken[nameHash]) revert NameTaken();
        if (bytes(_name).length == 0 || bytes(_name).length > 64) revert InvalidName();

        unchecked { tokenId = ++totalSupply; }

        _owners[tokenId]  = msg.sender;
        _balances[msg.sender]++;
        agentTokenId[msg.sender] = tokenId;
        nameTaken[nameHash]      = true;

        _registrations[tokenId] = AgentRegistration({
            name:         _name,
            description:  _description,
            mcpEndpoint:  _mcpEndpoint,
            tags:         _tags,
            registeredAt: block.timestamp,
            updatedAt:    block.timestamp
        });

        emit Transfer(address(0), msg.sender, tokenId);
        emit AgentRegistered(tokenId, msg.sender, _name);
    }

    /// @notice Update MCP endpoint and capability tags (token owner only).
    function update(
        uint256 tokenId,
        string  calldata _mcpEndpoint,
        string[] calldata _tags
    ) external {
        if (_owners[tokenId] != msg.sender) revert NotOwner();
        _registrations[tokenId].mcpEndpoint = _mcpEndpoint;
        _registrations[tokenId].tags        = _tags;
        _registrations[tokenId].updatedAt   = block.timestamp;
        emit AgentUpdated(tokenId);
    }

    function getRegistration(uint256 tokenId) external view returns (AgentRegistration memory) {
        if (_owners[tokenId] == address(0)) revert InvalidToken();
        return _registrations[tokenId];
    }

    /// @notice ERC-8004 portable identifier string.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert InvalidToken();
        return string.concat(
            "eip155:", _uint2str(block.chainid),
            ":",       _addr2str(address(this)),
            ":",       _uint2str(tokenId)
        );
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _uint2str(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v;
        uint256 digits;
        while (tmp != 0) { digits++; tmp /= 10; }
        bytes memory buf = new bytes(digits);
        while (v != 0) { digits--; buf[digits] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(buf);
    }

    function _addr2str(address a) internal pure returns (string memory) {
        bytes memory b = abi.encodePacked(a);
        bytes memory hex_chars = "0123456789abcdef";
        bytes memory s = new bytes(42);
        s[0] = "0"; s[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            s[2 + i * 2]     = hex_chars[uint8(b[i]) >> 4];
            s[3 + i * 2]     = hex_chars[uint8(b[i]) & 0x0f];
        }
        return string(s);
    }
}
