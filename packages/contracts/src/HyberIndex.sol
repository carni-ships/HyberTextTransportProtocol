// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HyberIndex
/// @notice Public indexing registry for HyberText sites published on Berachain.
///         Anyone who publishes a site as calldata can optionally call publish()
///         to announce it. The event log is the index — no other storage needed.
contract HyberIndex {
    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when a publisher announces a site.
    /// @param publisher  The address that called publish().
    /// @param txHash     The transaction hash in which the site calldata lives.
    /// @param contentType  Caller-defined content type tag (used by indexers to filter).
    /// @param timestamp  Block timestamp at the time of publication.
    event Published(
        address indexed publisher,
        bytes32 indexed txHash,
        uint8 contentType,
        uint64 timestamp
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroTxHash();

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    /// @dev Tracks how many times each address has called publish().
    mapping(address => uint256) private _publicationCount;

    // -------------------------------------------------------------------------
    // External functions
    // -------------------------------------------------------------------------

    /// @notice Announce a published HyberText site.
    /// @param txHash      The transaction hash that contains the site calldata.
    /// @param contentType Caller-defined tag describing the content type.
    function publish(bytes32 txHash, uint8 contentType) external {
        if (txHash == bytes32(0)) revert ZeroTxHash();
        _publicationCount[msg.sender]++;
        emit Published(msg.sender, txHash, contentType, uint64(block.timestamp));
    }

    /// @notice Returns how many times an address has published.
    /// @param publisher The address to query.
    /// @return count    The total number of publish() calls made by that address.
    function getPublicationCount(address publisher) external view returns (uint256 count) {
        return _publicationCount[publisher];
    }
}
