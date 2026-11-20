// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {RepoVault} from "./RepoVault.sol";
import {IPonsHook, IPonsFeeEscrow} from "./interfaces/IPons.sol";

/// @title RepoHub
/// @notice Pays the creator fees of coins launched for a GitHub repo to whoever controls that repo.
///         - Every repo has a vault address derived from its lower-cased name; Pons can credit it before it exists.
///         - A maintainer proves control by committing a proof file with their wallet to the default branch. The
///           off-chain verifier reads it and signs an EIP-712 attestation; `claim` binds the wallet, deploys the
///           vault if needed and pays out everything in it.
///         - After that, anyone may call `collect` to push new fees to the bound wallet.
///         - The hub takes no cut. There is no code path that pays anyone but a repo's bound wallet.
/// @dev Trust assumption: the verifier key. A verifier change is public and waits VERIFIER_DELAY before it applies.
contract RepoHub is Ownable2Step, ReentrancyGuardTransient, EIP712 {
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(bytes32 key,address wallet,uint64 issuedAt,uint64 deadline)");
    uint256 public constant VERIFIER_DELAY = 3 days;
    uint256 public constant MAX_OWNER_LENGTH = 39; // GitHub limits
    uint256 public constant MAX_NAME_LENGTH = 100;
    uint256 public constant MAX_CLOCK_SKEW = 5 minutes;
    uint256 public constant MAX_VALIDITY = 1 hours;

    bytes32 public immutable VAULT_CODEHASH;
    IPonsFeeEscrow public immutable escrow;
    IPonsHook public immutable hook;

    address public verifier;
    address public pendingVerifier;
    uint64 public pendingVerifierEta;
    bool public paused;

    mapping(bytes32 key => address) public walletOf;
    mapping(bytes32 key => uint64) public boundAt;
    mapping(bytes32 key => uint256) public paidOf;
    uint256 public totalPaid;
    uint256 public reposClaimed;

    event Bound(bytes32 indexed key, string repo, address indexed wallet, uint64 issuedAt);
    event VaultDeployed(bytes32 indexed key, address vault);
    event Paid(bytes32 indexed key, address indexed wallet, uint256 amount);
    event PaidToken(bytes32 indexed key, address indexed wallet, address indexed token, uint256 amount);
    event VerifierProposed(address verifier, uint64 eta);
    event VerifierChanged(address verifier);
    event PausedSet(bool paused);

    error BadRepo();
    error IsPaused();
    error Expired();
    error StaleAttestation();
    error BadSignature();
    error NotClaimed();
    error ZeroAddress();
    error TooEarly();
    error BadTimes();
    error NoRenounce();

    constructor(address owner_, address verifier_, IPonsFeeEscrow escrow_, IPonsHook hook_)
        Ownable(owner_)
        EIP712("RepoHub", "1")
    {
        if (verifier_ == address(0) || address(escrow_) == address(0) || address(hook_) == address(0)) {
            revert ZeroAddress();
        }
        verifier = verifier_;
        escrow = escrow_;
        hook = hook_;
        VAULT_CODEHASH = keccak256(type(RepoVault).creationCode);
    }

    // ---------------------------------------------------------------- views

    /// @notice Canonical key of a repo: keccak256 of "owner/name" lower-cased. Reverts on a malformed name.
    function keyOf(string calldata repo) public pure returns (bytes32) {
        return keccak256(_normalize(bytes(repo)));
    }

    function vaultFor(string calldata repo) external view returns (address) {
        return vaultOfKey(keyOf(repo));
    }

    function vaultOfKey(bytes32 key) public view returns (address) {
        return Create2.computeAddress(key, VAULT_CODEHASH);
    }

    /// @notice Native fees already sitting in the vault or credited to it in the Pons escrow.
    ///         Fees still inside a curve or hook (not yet swept) are not counted.
    function pendingOf(bytes32 key) external view returns (uint256) {
        address v = vaultOfKey(key);
        return v.balance + escrow.balanceOf(v);
    }

    function hashClaim(bytes32 key, address wallet, uint64 issuedAt, uint64 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, key, wallet, issuedAt, deadline)));
    }

    // ---------------------------------------------------------------- claim / collect

    /// @notice Binds `wallet` to `repo` with a fresh verifier attestation, then pays out everything in the vault.
    ///         A newer attestation (higher issuedAt) replaces an older binding, so a maintainer can move wallets
    ///         and a transferred repo follows its new owner.
    function claim(
        string calldata repo,
        address wallet,
        uint64 issuedAt,
        uint64 deadline,
        bytes calldata signature,
        address[] calldata curves,
        bytes32[] calldata poolIds
    ) external nonReentrant returns (uint256 paid) {
        if (paused) revert IsPaused();
        if (wallet == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert Expired();
        // Bounded attestation times: a future-dated issuedAt (bad clock or leaked key) could otherwise pin
        // boundAt forever and make every later, honest attestation stale.
        if (issuedAt > block.timestamp + MAX_CLOCK_SKEW || deadline < issuedAt || deadline - issuedAt > MAX_VALIDITY) {
            revert BadTimes();
        }
        bytes32 key = keyOf(repo);
        if (ECDSA.recover(hashClaim(key, wallet, issuedAt, deadline), signature) != verifier) revert BadSignature();

        if (issuedAt == boundAt[key] && walletOf[key] == wallet) {
            // Same attestation already used (e.g. someone submitted it first): nothing to bind, just pay.
        } else {
            if (issuedAt <= boundAt[key]) revert StaleAttestation();
            if (walletOf[key] == address(0)) reposClaimed += 1;
            walletOf[key] = wallet;
            boundAt[key] = issuedAt;
            emit Bound(key, repo, wallet, issuedAt);
        }

        paid = _pay(key, wallet, curves, poolIds);
    }

    /// @notice Permissionless: sweeps and pays new fees to a repo's bound wallet.
    function collect(string calldata repo, address[] calldata curves, bytes32[] calldata poolIds)
        external
        nonReentrant
        returns (uint256 paid)
    {
        bytes32 key = keyOf(repo);
        address wallet = walletOf[key];
        if (wallet == address(0)) revert NotClaimed();
        paid = _pay(key, wallet, curves, poolIds);
    }

    /// @notice Permissionless: forwards an ERC-20 fee balance (non-native launches) to the bound wallet.
    function collectToken(string calldata repo, address token) external nonReentrant returns (uint256 paid) {
        bytes32 key = keyOf(repo);
        address wallet = walletOf[key];
        if (wallet == address(0)) revert NotClaimed();
        paid = RepoVault(payable(_vault(key))).payToken(wallet, escrow, token);
        if (paid > 0) emit PaidToken(key, wallet, token, paid);
    }

    // ---------------------------------------------------------------- admin (cannot touch funds)

    function proposeVerifier(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingVerifier = next;
        pendingVerifierEta = uint64(block.timestamp + VERIFIER_DELAY);
        emit VerifierProposed(next, pendingVerifierEta);
    }

    function acceptVerifier() external onlyOwner {
        address next = pendingVerifier;
        if (next == address(0)) revert ZeroAddress();
        if (block.timestamp < pendingVerifierEta) revert TooEarly();
        verifier = next;
        pendingVerifier = address(0);
        pendingVerifierEta = 0;
        emit VerifierChanged(next);
    }

    /// @notice Disabled: without an owner a pause could never be lifted and the verifier never rotated.
    function renounceOwnership() public view override onlyOwner {
        revert NoRenounce();
    }

    /// @notice Pauses new bindings only. `collect` keeps paying wallets that are already bound.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    // ---------------------------------------------------------------- internals

    function _pay(bytes32 key, address wallet, address[] calldata curves, bytes32[] calldata poolIds)
        internal
        returns (uint256 paid)
    {
        paid = RepoVault(payable(_vault(key))).pay(payable(wallet), escrow, hook, curves, poolIds);
        if (paid > 0) {
            paidOf[key] += paid;
            totalPaid += paid;
            emit Paid(key, wallet, paid);
        }
    }

    function _vault(bytes32 key) internal returns (address v) {
        v = vaultOfKey(key);
        if (v.code.length == 0) {
            v = Create2.deploy(0, key, type(RepoVault).creationCode);
            emit VaultDeployed(key, v);
        }
    }

    /// Only names GitHub can actually hold, so no fee can be sent to a key nobody could ever claim.
    /// owner: 1-39 of [a-z0-9-], not starting or ending with "-".
    /// name:  1-100 of [a-z0-9._-], not "." or "..", not ending in ".git". Exactly one slash. Lower-cased.
    /// Mirrored by normRepo() in server/src/index.mjs and web/src/main.js.
    function _normalize(bytes memory r) internal pure returns (bytes memory out) {
        uint256 n = r.length;
        if (n < 3 || n > MAX_OWNER_LENGTH + 1 + MAX_NAME_LENGTH) revert BadRepo();
        out = new bytes(n);
        uint256 slash = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            bytes1 c = r[i];
            if (c >= "A" && c <= "Z") c = bytes1(uint8(c) + 32);
            bool alnum = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
            bool inName = slash != type(uint256).max;
            if (c == "/") {
                if (inName) revert BadRepo();
                slash = i;
            } else if (!alnum && c != "-" && !(inName && (c == "." || c == "_"))) {
                revert BadRepo();
            }
            out[i] = c;
        }
        if (slash == type(uint256).max || slash == 0 || slash > MAX_OWNER_LENGTH) revert BadRepo();
        uint256 nameLen = n - slash - 1;
        if (nameLen == 0 || nameLen > MAX_NAME_LENGTH) revert BadRepo();
        if (out[0] == "-" || out[slash - 1] == "-") revert BadRepo();
        if (nameLen == 1 && out[n - 1] == ".") revert BadRepo();
        if (nameLen == 2 && out[n - 2] == "." && out[n - 1] == ".") revert BadRepo();
        if (
            nameLen >= 4 && out[n - 4] == "." && out[n - 3] == "g" && out[n - 2] == "i" && out[n - 1] == "t"
        ) revert BadRepo();
    }
}
