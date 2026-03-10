// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentIdentity {
    function ownerOf(uint256 tokenId) external view returns (address);
    function agentTokenId(address wallet) external view returns (uint256);
}

/// @title  HyberAgentReputation
/// @notice ERC-8004 Agent Reputation Registry.
///         Stores signed fixed-point feedback (int128, 18 decimals) per agent.
///         Any address can submit feedback; authors can revoke their own entries.
///         Aggregation via getScore() returns the sum of all non-revoked values.
contract HyberAgentReputation {

    // ─── Types ────────────────────────────────────────────────────────────────

    struct Feedback {
        address  from;          // submitter
        int128   value;         // signed fixed-point, 18 decimals
        uint8    decimals;      // always 18
        string[] tags;          // e.g. ["bounty-claim", "citation"]
        string   evidenceUri;   // txHash of the qualifying work, or IPFS CID
        uint256  createdAt;
        bool     revoked;
    }

    // ─── Storage ──────────────────────────────────────────────────────────────

    IAgentIdentity public immutable identityRegistry;

    /// @dev tokenId → feedback entries (append-only array; entries are soft-deleted via revoked flag)
    mapping(uint256 => Feedback[]) private _feedbacks;

    // ─── Events ───────────────────────────────────────────────────────────────

    event FeedbackSubmitted(uint256 indexed tokenId, address indexed from, int128 value, string[] tags);
    event FeedbackRevoked(uint256 indexed tokenId, uint256 feedbackIdx, address indexed by);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error UnknownAgent();
    error NotFeedbackAuthor();
    error IndexOutOfBounds();

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _identityRegistry) {
        identityRegistry = IAgentIdentity(_identityRegistry);
    }

    // ─── Write ────────────────────────────────────────────────────────────────

    /// @notice Submit feedback for an agent identified by tokenId.
    function submitFeedback(
        uint256           tokenId,
        int128            value,
        uint8             decimals,
        string[] calldata tags,
        string  calldata  evidenceUri
    ) external {
        // Validates agent exists — ownerOf reverts on invalid tokenId
        identityRegistry.ownerOf(tokenId);

        _feedbacks[tokenId].push(Feedback({
            from:        msg.sender,
            value:       value,
            decimals:    decimals,
            tags:        tags,
            evidenceUri: evidenceUri,
            createdAt:   block.timestamp,
            revoked:     false
        }));

        emit FeedbackSubmitted(tokenId, msg.sender, value, tags);
    }

    /// @notice Submit feedback identified by the agent's wallet address (convenience).
    function submitFeedbackByAddress(
        address           wallet,
        int128            value,
        uint8             decimals,
        string[] calldata tags,
        string  calldata  evidenceUri
    ) external {
        uint256 tokenId = identityRegistry.agentTokenId(wallet);
        if (tokenId == 0) revert UnknownAgent();

        _feedbacks[tokenId].push(Feedback({
            from:        msg.sender,
            value:       value,
            decimals:    decimals,
            tags:        tags,
            evidenceUri: evidenceUri,
            createdAt:   block.timestamp,
            revoked:     false
        }));

        emit FeedbackSubmitted(tokenId, msg.sender, value, tags);
    }

    /// @notice Revoke a feedback entry you submitted.
    function revokeFeedback(uint256 tokenId, uint256 feedbackIdx) external {
        if (feedbackIdx >= _feedbacks[tokenId].length) revert IndexOutOfBounds();
        Feedback storage fb = _feedbacks[tokenId][feedbackIdx];
        if (fb.from != msg.sender) revert NotFeedbackAuthor();
        fb.revoked = true;
        emit FeedbackRevoked(tokenId, feedbackIdx, msg.sender);
    }

    // ─── Read ─────────────────────────────────────────────────────────────────

    /// @notice Aggregate score: sum of all non-revoked feedback values.
    /// @return score  Sum of feedback values (18 decimals, signed).
    /// @return count  Number of non-revoked feedback entries contributing to score.
    function getScore(uint256 tokenId) external view returns (int256 score, uint256 count) {
        Feedback[] storage fbs = _feedbacks[tokenId];
        for (uint256 i = 0; i < fbs.length; i++) {
            if (!fbs[i].revoked) {
                score += int256(fbs[i].value);
                count++;
            }
        }
    }

    function getFeedbacks(uint256 tokenId) external view returns (Feedback[] memory) {
        return _feedbacks[tokenId];
    }

    function getFeedbackCount(uint256 tokenId) external view returns (uint256) {
        return _feedbacks[tokenId].length;
    }
}
