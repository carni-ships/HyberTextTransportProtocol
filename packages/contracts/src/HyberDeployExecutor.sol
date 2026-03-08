// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HyberDeployExecutor
/// @notice EIP-7702 delegation target for HyberText publishers.
///
/// Usage:
///   1. Deploy this contract once (address is shared by all publishers).
///   2. Main wallet signs a 7702 authorization pointing to this contract.
///   3. Main wallet sends a self-tx with the authorization + setDeployKey(ciKeyAddress).
///   4. From CI: deploy key calls mainWallet.publishToIndex(...) —
///      HyberIndex sees msg.sender = mainWallet, preserving publisher identity.
///
/// Security model:
///   - Only the EOA itself (msg.sender == address(this)) can set/revoke the deploy key.
///   - The deploy key can ONLY call publishToIndex — it cannot move funds or change settings.
///   - Revoke: send setDeployKey(address(0)) or revokeDeployKey() from main wallet.

interface IHyberIndex {
    function publish(bytes32 txHash, uint8 contentType) external;
}

contract HyberDeployExecutor {
    // ---------------------------------------------------------------------------
    // Namespaced storage (EIP-7201 pattern)
    // Each EOA using 7702 gets its own isolated storage — the slot is the same
    // for all, but the EOA's own storage context is used.
    // ---------------------------------------------------------------------------

    // keccak256("hybertext.deployKey.v1")
    bytes32 private constant DEPLOY_KEY_SLOT = keccak256("hybertext.deployKey.v1");

    // ---------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------

    event DeployKeySet(address indexed key);
    event DeployKeyRevoked();

    // ---------------------------------------------------------------------------
    // Storage accessors
    // ---------------------------------------------------------------------------

    function deployKey() public view returns (address key) {
        bytes32 slot = DEPLOY_KEY_SLOT;
        assembly { key := sload(slot) }
    }

    // ---------------------------------------------------------------------------
    // Owner-only (self-tx) functions
    // These must be called by sending a transaction FROM the EOA TO itself.
    // In EIP-7702, msg.sender == address(this) when the EOA calls itself.
    // ---------------------------------------------------------------------------

    /// @notice Authorize a deploy key. Must be called via self-tx by the main wallet.
    /// @param key The address (e.g. a CI wallet) that may call publishToIndex.
    function setDeployKey(address key) external {
        require(msg.sender == address(this), "Only self");
        bytes32 slot = DEPLOY_KEY_SLOT;
        assembly { sstore(slot, key) }
        emit DeployKeySet(key);
    }

    /// @notice Remove the authorized deploy key.
    function revokeDeployKey() external {
        require(msg.sender == address(this), "Only self");
        bytes32 slot = DEPLOY_KEY_SLOT;
        assembly { sstore(slot, 0) }
        emit DeployKeyRevoked();
    }

    // ---------------------------------------------------------------------------
    // Deploy-key-callable functions
    // ---------------------------------------------------------------------------

    /// @notice Announce a published site to HyberIndex under the main wallet's identity.
    ///         Only callable by the authorized deploy key.
    ///         HyberIndex.Published event will show msg.sender = main wallet address.
    /// @param txHash       The tx hash where the site calldata was published.
    /// @param contentType  HYTE content type (2=MANIFEST, 8=ENCRYPTED, etc.)
    /// @param indexAddress HyberIndex contract address.
    function publishToIndex(
        bytes32 txHash,
        uint8   contentType,
        address indexAddress
    ) external {
        require(msg.sender == deployKey(), "Not authorized deploy key");
        IHyberIndex(indexAddress).publish(txHash, contentType);
    }

    /// @notice Batch-announce multiple sites in one transaction.
    function batchPublishToIndex(
        bytes32[] calldata txHashes,
        uint8[]   calldata contentTypes,
        address            indexAddress
    ) external {
        require(msg.sender == deployKey(), "Not authorized deploy key");
        require(txHashes.length == contentTypes.length, "Length mismatch");
        IHyberIndex index = IHyberIndex(indexAddress);
        for (uint256 i = 0; i < txHashes.length; i++) {
            index.publish(txHashes[i], contentTypes[i]);
        }
    }
}
