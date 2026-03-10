// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHyberACP {
    struct Job {
        address  client;
        address  provider;
        address  evaluator;
        address  token;
        uint128  budget;
        uint64   expiredAt;
        uint8    status;
        address  hook;
        string   description;
        bytes    result;
    }
    function getJob(uint256 jobId) external view returns (Job memory);
}

interface IAgentIdentity {
    function agentTokenId(address wallet) external view returns (uint256);
}

interface IAgentReputation {
    function submitFeedback(
        uint256           tokenId,
        int128            value,
        uint8             decimals,
        string[] calldata tags,
        string  calldata  evidenceUri
    ) external;
}

/// @title  HyberACPRepHook
/// @notice ERC-8183 × ERC-8004 integration hook.
///
///         Install this hook on HyberACP jobs created via research_bounty_create
///         to automatically write ERC-8004 reputation when the job resolves:
///
///           complete() → +CLAIM_REWARD  (provider successfully delivered)
///           reject()   → +REJECT_PENALTY (provider's submission was rejected)
///
///         Silently skips if the provider has no ERC-8004 identity token.
contract HyberACPRepHook {

    // ─── Selectors ────────────────────────────────────────────────────────────

    bytes4 internal constant COMPLETE_SEL = bytes4(keccak256("complete(uint256,bytes32)"));
    bytes4 internal constant REJECT_SEL   = bytes4(keccak256("reject(uint256,bytes32)"));

    // ─── Status constants (matches HyberACP) ─────────────────────────────────

    uint8 internal constant STATUS_COMPLETED = 3;
    uint8 internal constant STATUS_REJECTED  = 4;

    // ─── Reputation values (18 decimals) ─────────────────────────────────────

    /// @dev +0.01 per successful bounty claim
    int128 public constant CLAIM_REWARD   =  1e16;
    /// @dev -0.005 penalty for a rejected submission
    int128 public constant REJECT_PENALTY = -5e15;

    // ─── Immutables ───────────────────────────────────────────────────────────

    IHyberACP        public immutable acp;
    IAgentIdentity   public immutable identityRegistry;
    IAgentReputation public immutable reputationRegistry;

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _acp, address _identity, address _reputation) {
        acp                = IHyberACP(_acp);
        identityRegistry   = IAgentIdentity(_identity);
        reputationRegistry = IAgentReputation(_reputation);
    }

    // ─── IACPHook interface ───────────────────────────────────────────────────

    function beforeAction(uint256, bytes4, bytes calldata) external pure {}

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata) external {
        IHyberACP.Job memory job = acp.getJob(jobId);
        address provider = job.provider;
        if (provider == address(0)) return;

        // Look up provider's ERC-8004 identity token; skip if unregistered
        uint256 tokenId = identityRegistry.agentTokenId(provider);
        if (tokenId == 0) return;

        string memory evidenceUri = string.concat("acp:", _uint2str(jobId));

        if (selector == COMPLETE_SEL && job.status == STATUS_COMPLETED) {
            string[] memory tags = new string[](1);
            tags[0] = "bounty-claim";
            // Non-blocking: ignore reputation registry failures
            try reputationRegistry.submitFeedback(tokenId, CLAIM_REWARD, 18, tags, evidenceUri) {}
            catch {}
        } else if (selector == REJECT_SEL && job.status == STATUS_REJECTED) {
            string[] memory tags = new string[](1);
            tags[0] = "bounty-reject";
            try reputationRegistry.submitFeedback(tokenId, REJECT_PENALTY, 18, tags, evidenceUri) {}
            catch {}
        }
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _uint2str(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v;
        uint256 digits;
        while (tmp != 0) { digits++; tmp /= 10; }
        bytes memory buf = new bytes(digits);
        while (v != 0) { digits--; buf[digits] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(buf);
    }
}
