// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  HyberACP
/// @notice ERC-8183 Agentic Commerce Protocol — escrowed job execution between
///         a client, provider, and evaluator with optional ERC-20 payment.
///
///         No OpenZeppelin dependency — follows the same self-contained style
///         as HyberDB.sol.
///
///         State machine:
///           Open → Funded → Submitted → Completed (terminal)
///                                     → Rejected  (terminal)
///           Open/Funded → Expired (terminal, after claimRefund when expiredAt reached)
contract HyberACP {

    // ─── Types ────────────────────────────────────────────────────────────────

    /// @dev uint8 status constants — kept as constants rather than an enum so
    ///      they can be used directly in the Job struct without casting.
    uint8 internal constant STATUS_OPEN      = 0;
    uint8 internal constant STATUS_FUNDED    = 1;
    uint8 internal constant STATUS_SUBMITTED = 2;
    uint8 internal constant STATUS_COMPLETED = 3;
    uint8 internal constant STATUS_REJECTED  = 4;
    uint8 internal constant STATUS_EXPIRED   = 5;

    struct Job {
        address  client;
        address  provider;    // address(0) = unset (open for any provider)
        address  evaluator;   // immutable after createJob
        address  token;       // ERC-20 payment token
        uint128  budget;      // token units; 0 = unpaid / informational job
        uint64   expiredAt;   // unix timestamp; 0 = no expiry
        uint8    status;
        address  hook;        // IACPHook — called around each state transition
        string   description; // inline or "hyte:0x{txhash}" reference
        bytes    result;      // provider submission (URL, txHash bytes, etc.)
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    mapping(uint256 => Job) private _jobs;
    uint256 private _jobCount;

    /// @notice Platform fee in basis points (e.g. 250 = 2.5%).  Max 1000 (10%).
    uint16  public feeBps;
    address public feeRecipient;
    address public owner;

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(uint16 _feeBps, address _feeRecipient) {
        if (_feeBps > 1000) revert FeeTooHigh();
        feeBps       = _feeBps;
        feeRecipient = _feeRecipient == address(0) ? msg.sender : _feeRecipient;
        owner        = msg.sender;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed evaluator, address provider);
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint128 budget);
    event JobFunded(uint256 indexed jobId, address indexed client, uint128 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes result);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint128 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint128 amount);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error NotClient(uint256 jobId);
    error NotProvider(uint256 jobId);
    error NotEvaluator(uint256 jobId);
    error InvalidStatus(uint256 jobId, uint8 current, uint8 required);
    error NotExpired(uint256 jobId);
    error TransferFailed();
    error InvalidJob(uint256 jobId);
    error FeeTooHigh();
    error ZeroEvaluator();
    error ProviderAlreadySet(uint256 jobId);
    error NotOwner();

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier jobExists(uint256 jobId) {
        if (jobId == 0 || jobId > _jobCount) revert InvalidJob(jobId);
        _;
    }

    modifier onlyStatus(uint256 jobId, uint8 required) {
        uint8 cur = _jobs[jobId].status;
        if (cur != required) revert InvalidStatus(jobId, cur, required);
        _;
    }

    // ─── Core functions ───────────────────────────────────────────────────────

    /// @notice Create a new job.
    /// @param  provider    Provider address; zero = open (any provider may claim via setProvider).
    /// @param  evaluator   Evaluator address; zero = defaults to msg.sender (client).
    /// @param  token       ERC-20 token for payment; zero = no payment.
    /// @param  budget      Token amount; 0 = unpaid job.
    /// @param  expiredAt   Unix timestamp after which client may claimRefund; 0 = no expiry.
    /// @param  description Human-readable spec or "hyte:0x{txhash}" reference.
    /// @param  hook        IACPHook contract; zero = no hooks.
    /// @return jobId       1-indexed job identifier.
    function createJob(
        address  provider,
        address  evaluator,
        address  token,
        uint128  budget,
        uint64   expiredAt,
        string   calldata description,
        address  hook
    ) external returns (uint256 jobId) {
        address _evaluator = evaluator == address(0) ? msg.sender : evaluator;

        jobId = ++_jobCount;
        _jobs[jobId] = Job({
            client:      msg.sender,
            provider:    provider,
            evaluator:   _evaluator,
            token:       token,
            budget:      budget,
            expiredAt:   expiredAt,
            status:      STATUS_OPEN,
            hook:        hook,
            description: description,
            result:      ""
        });

        _callHook(hook, jobId, this.createJob.selector, "");

        emit JobCreated(jobId, msg.sender, _evaluator, provider);
    }

    /// @notice Set or claim the provider role.  Client-only when provider is unset.
    function setProvider(uint256 jobId, address provider)
        external
        jobExists(jobId)
        onlyStatus(jobId, STATUS_OPEN)
    {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client)   revert NotClient(jobId);
        if (job.provider != address(0)) revert ProviderAlreadySet(jobId);

        job.provider = provider;
        _callHook(job.hook, jobId, this.setProvider.selector, abi.encode(provider));

        emit ProviderSet(jobId, provider);
    }

    /// @notice Update the budget before the job is funded.  Client-only.
    function setBudget(uint256 jobId, uint128 newBudget)
        external
        jobExists(jobId)
        onlyStatus(jobId, STATUS_OPEN)
    {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert NotClient(jobId);

        job.budget = newBudget;
        _callHook(job.hook, jobId, this.setBudget.selector, abi.encode(newBudget));

        emit BudgetSet(jobId, newBudget);
    }

    /// @notice Lock the budget into escrow.  Client-only.
    ///         Caller must have approved this contract for at least `budget` tokens.
    function fund(uint256 jobId)
        external
        jobExists(jobId)
        onlyStatus(jobId, STATUS_OPEN)
    {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert NotClient(jobId);

        _callHook(job.hook, jobId, this.fund.selector, "");

        if (job.budget > 0 && job.token != address(0)) {
            bool ok = IERC20Minimal(job.token).transferFrom(msg.sender, address(this), job.budget);
            if (!ok) revert TransferFailed();
        }

        job.status = STATUS_FUNDED;
        _callHookAfter(job.hook, jobId, this.fund.selector, "");

        emit JobFunded(jobId, msg.sender, job.budget);
    }

    /// @notice Provider submits the deliverable.  Provider-only.  Job must be Funded.
    function submit(uint256 jobId, bytes calldata result)
        external
        jobExists(jobId)
        onlyStatus(jobId, STATUS_FUNDED)
    {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.provider) revert NotProvider(jobId);

        _callHook(job.hook, jobId, this.submit.selector, result);

        job.result = result;
        job.status = STATUS_SUBMITTED;

        _callHookAfter(job.hook, jobId, this.submit.selector, result);

        emit JobSubmitted(jobId, msg.sender, result);
    }

    /// @notice Evaluator marks job complete and releases funds to provider.
    /// @param  reason  Optional bytes32 attestation (e.g. hash of evidence).
    function complete(uint256 jobId, bytes32 reason)
        external
        jobExists(jobId)
        onlyStatus(jobId, STATUS_SUBMITTED)
    {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.evaluator) revert NotEvaluator(jobId);

        _callHook(job.hook, jobId, this.complete.selector, abi.encode(reason));

        job.status = STATUS_COMPLETED;

        uint128 fee    = feeBps > 0 ? uint128(uint256(job.budget) * feeBps / 10_000) : 0;
        uint128 payout = job.budget - fee;

        if (job.budget > 0 && job.token != address(0)) {
            if (payout > 0) {
                bool ok = IERC20Minimal(job.token).transfer(job.provider, payout);
                if (!ok) revert TransferFailed();
            }
            if (fee > 0) {
                bool ok2 = IERC20Minimal(job.token).transfer(feeRecipient, fee);
                if (!ok2) revert TransferFailed();
            }
        }

        _callHookAfter(job.hook, jobId, this.complete.selector, abi.encode(reason));

        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, payout);
    }

    /// @notice Evaluator (or client when Open) rejects the job and refunds escrow.
    /// @param  reason  Optional bytes32 reason code.
    function reject(uint256 jobId, bytes32 reason)
        external
        jobExists(jobId)
    {
        Job storage job = _jobs[jobId];
        uint8 cur = job.status;

        // Client may reject when Open (no escrow to return).
        // Evaluator may reject when Funded or Submitted.
        bool clientOpen     = (cur == STATUS_OPEN      && msg.sender == job.client);
        bool evalFundedSub  = ((cur == STATUS_FUNDED || cur == STATUS_SUBMITTED) && msg.sender == job.evaluator);
        if (!clientOpen && !evalFundedSub) revert NotEvaluator(jobId);

        _callHook(job.hook, jobId, this.reject.selector, abi.encode(reason));

        job.status = STATUS_REJECTED;

        // Refund escrow if job was funded.
        if (cur != STATUS_OPEN && job.budget > 0 && job.token != address(0)) {
            bool ok = IERC20Minimal(job.token).transfer(job.client, job.budget);
            if (!ok) revert TransferFailed();
        }

        _callHookAfter(job.hook, jobId, this.reject.selector, abi.encode(reason));

        emit JobRejected(jobId, msg.sender, reason);
        if (cur != STATUS_OPEN && job.budget > 0 && job.token != address(0)) {
            emit Refunded(jobId, job.client, job.budget);
        }
    }

    /// @notice Permissionless refund after expiry.  Works from Funded or Submitted states.
    ///         No hook — guarantees recovery path cannot be blocked by a misbehaving hook.
    function claimRefund(uint256 jobId)
        external
        jobExists(jobId)
    {
        Job storage job = _jobs[jobId];
        uint8 cur = job.status;

        if (cur != STATUS_FUNDED && cur != STATUS_SUBMITTED) {
            revert InvalidStatus(jobId, cur, STATUS_FUNDED);
        }
        if (job.expiredAt == 0 || block.timestamp < job.expiredAt) revert NotExpired(jobId);

        job.status = STATUS_EXPIRED;

        if (job.budget > 0 && job.token != address(0)) {
            bool ok = IERC20Minimal(job.token).transfer(job.client, job.budget);
            if (!ok) revert TransferFailed();
        }

        emit JobExpired(jobId);
        emit Refunded(jobId, job.client, job.budget);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Update fee parameters.  Owner-only.
    function setFee(uint16 _feeBps, address _feeRecipient) external {
        if (msg.sender != owner) revert NotOwner();
        if (_feeBps > 1000) revert FeeTooHigh();
        feeBps       = _feeBps;
        feeRecipient = _feeRecipient;
    }

    /// @notice Transfer contract ownership.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        owner = newOwner;
    }

    // ─── View ─────────────────────────────────────────────────────────────────

    function getJob(uint256 jobId) external view jobExists(jobId) returns (Job memory) {
        return _jobs[jobId];
    }

    function jobCount() external view returns (uint256) {
        return _jobCount;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _callHook(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook == address(0)) return;
        try IACPHook(hook).beforeAction(jobId, selector, data) { } catch { }
    }

    function _callHookAfter(address hook, uint256 jobId, bytes4 selector, bytes memory data) internal {
        if (hook == address(0)) return;
        try IACPHook(hook).afterAction(jobId, selector, data) { } catch { }
    }
}

// ─── ERC-8183 Hook interface ──────────────────────────────────────────────────

interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

// ─── Minimal ERC-20 interface (no OZ dependency) ─────────────────────────────

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}
