// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  HyberRegistry
/// @notice Maps human-readable names to HyberText transaction hashes.
///         Content is immutable on-chain; this registry provides mutable pointers
///         so sites can be republished without changing their public name.
contract HyberRegistry {
    struct Record {
        bytes32 txHash;    // Berachain tx hash where the site lives
        address owner;
        uint64  updatedAt; // block.timestamp of last update
    }

    /// @dev keccak256(name) => Record
    mapping(bytes32 => Record) private _records;

    event Registered(string indexed name, bytes32 txHash, address indexed owner);
    event Updated(string indexed name, bytes32 txHash, address indexed owner);
    event Transferred(string indexed name, address indexed from, address indexed to);

    error AlreadyRegistered(string name);
    error NotOwner(string name);
    error EmptyName();
    error ZeroHash();

    // -------------------------------------------------------------------------
    // Write
    // -------------------------------------------------------------------------

    /// @notice Register a new name pointing to a site tx hash.
    ///         Names are first-come-first-served; ownership can be transferred.
    function register(string calldata name, bytes32 txHash) external {
        if (bytes(name).length == 0) revert EmptyName();
        if (txHash == bytes32(0)) revert ZeroHash();
        bytes32 key = keccak256(bytes(name));
        if (_records[key].owner != address(0)) revert AlreadyRegistered(name);

        _records[key] = Record({
            txHash: txHash,
            owner: msg.sender,
            updatedAt: uint64(block.timestamp)
        });
        emit Registered(name, txHash, msg.sender);
    }

    /// @notice Update the tx hash for an existing name (after republishing the site).
    function update(string calldata name, bytes32 txHash) external {
        if (txHash == bytes32(0)) revert ZeroHash();
        bytes32 key = keccak256(bytes(name));
        Record storage r = _records[key];
        if (r.owner != msg.sender) revert NotOwner(name);
        r.txHash = txHash;
        r.updatedAt = uint64(block.timestamp);
        emit Updated(name, txHash, msg.sender);
    }

    /// @notice Transfer ownership of a name to a new address.
    function transfer(string calldata name, address newOwner) external {
        bytes32 key = keccak256(bytes(name));
        Record storage r = _records[key];
        if (r.owner != msg.sender) revert NotOwner(name);
        emit Transferred(name, msg.sender, newOwner);
        r.owner = newOwner;
    }

    // -------------------------------------------------------------------------
    // Read
    // -------------------------------------------------------------------------

    /// @notice Resolve a name to its current tx hash.
    function resolve(string calldata name) external view returns (bytes32) {
        return _records[keccak256(bytes(name))].txHash;
    }

    /// @notice Get the full record for a name.
    function getRecord(string calldata name) external view returns (Record memory) {
        return _records[keccak256(bytes(name))];
    }
}
