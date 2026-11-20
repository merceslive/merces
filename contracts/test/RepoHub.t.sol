// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RepoHub} from "../src/RepoHub.sol";
import {RepoVault} from "../src/RepoVault.sol";
import {IPonsHook, IPonsFeeEscrow} from "../src/interfaces/IPons.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockEscrow {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public balanceOfToken;

    function credit(address to) external payable {
        balanceOf[to] += msg.value;
    }

    function creditToken(address to, address token, uint256 amt) external {
        ERC20(token).transferFrom(msg.sender, address(this), amt);
        balanceOfToken[to][token] += amt;
    }

    function claim() external returns (uint256 a) {
        a = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok, "TransferFailed");
    }

    function claimToken(address token) external returns (uint256 a) {
        a = balanceOfToken[msg.sender][token];
        balanceOfToken[msg.sender][token] = 0;
        ERC20(token).transfer(msg.sender, a);
    }
}

/// Holds fees until the creator recipient sweeps them into the escrow (like PonsV2BondingCurve).
contract MockCurve {
    MockEscrow public escrow;
    address public recipient;

    constructor(MockEscrow e, address r) payable {
        escrow = e;
        recipient = r;
    }

    function sweepFees(uint256) external {
        require(msg.sender == recipient, "not creator");
        escrow.credit{value: address(this).balance}(recipient);
    }
}

contract RevertingThing {
    fallback() external payable {
        revert("nope");
    }
}

contract Tok is ERC20 {
    constructor() ERC20("T", "T") {
        _mint(msg.sender, 1e24);
    }
}

contract RepoHubTest is Test {
    RepoHub hub;
    MockEscrow escrow;
    address hookAddr;
    uint256 verifierPk = 0xA11CE;
    address verifier;
    address owner = address(0xB0B);
    address maint = address(0xCAFE);
    string constant REPO = "Torvalds/Linux";

    function setUp() public {
        verifier = vm.addr(verifierPk);
        escrow = new MockEscrow();
        hookAddr = address(new RevertingThing());
        hub = new RepoHub(owner, verifier, IPonsFeeEscrow(address(escrow)), IPonsHook(hookAddr));
        vm.warp(1000); // attestation times in these tests sit within MAX_VALIDITY of now
    }

    function _sig(bytes32 key, address wallet, uint64 issuedAt, uint64 deadline, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hub.hashClaim(key, wallet, issuedAt, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _claim(address wallet, uint64 issuedAt) internal returns (uint256) {
        bytes32 key = hub.keyOf(REPO);
        uint64 dl = uint64(block.timestamp + 600);
        return hub.claim(REPO, wallet, issuedAt, dl, _sig(key, wallet, issuedAt, dl, verifierPk), new address[](0), new bytes32[](0));
    }

    function _claimExpect(address wallet, uint64 issuedAt, bytes4 err) internal {
        bytes32 key = hub.keyOf(REPO);
        uint64 dl = uint64(block.timestamp + 600);
        bytes memory sig = _sig(key, wallet, issuedAt, dl, verifierPk);
        vm.expectRevert(err);
        hub.claim(REPO, wallet, issuedAt, dl, sig, new address[](0), new bytes32[](0));
    }

    function test_keyIsCaseInsensitive() public view {
        assertEq(hub.keyOf("torvalds/linux"), hub.keyOf("TORVALDS/LINUX"));
        assertEq(hub.vaultFor("torvalds/linux"), hub.vaultFor(REPO));
    }

    function test_badRepoNames() public {
        string[13] memory bad = [
            "nolash", "/x", "a/", "a/b/c", "a b/c", "ow.ner/repo", "a/.", "a/..", "a/x.git", "-a/x", "a-/x",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x", "a/b c"
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(RepoHub.BadRepo.selector);
            hub.keyOf(bad[i]);
        }
        hub.keyOf("ollama/ollama");
        hub.keyOf("my-org/repo.name_v2");
        hub.keyOf("a/.github");
        hub.keyOf("a-b/x.gitignore");
    }

    function test_vaultReceivesBeforeDeploy_thenClaimPaysAll() public {
        address vault = hub.vaultFor(REPO);
        assertEq(vault.code.length, 0);
        escrow.credit{value: 1 ether}(vault); // fees credited before the vault exists
        vm.deal(vault, 0.5 ether); // and a direct push
        assertEq(hub.pendingOf(hub.keyOf(REPO)), 1.5 ether);

        uint256 paid = _claim(maint, 1);
        assertEq(paid, 1.5 ether);
        assertEq(maint.balance, 1.5 ether);
        assertGt(vault.code.length, 0);
        assertEq(hub.walletOf(hub.keyOf(REPO)), maint);
        assertEq(hub.totalPaid(), 1.5 ether);
        assertEq(hub.reposClaimed(), 1);
    }

    function test_collectSweepsCurveAndIsPermissionless() public {
        _claim(maint, 1);
        address vault = hub.vaultFor(REPO);
        MockCurve curve = new MockCurve{value: 2 ether}(escrow, vault);
        address[] memory curves = new address[](1);
        curves[0] = address(curve);
        bytes32[] memory pools = new bytes32[](1); // hook reverts: must not block the payout
        vm.prank(address(0xD00D));
        uint256 paid = hub.collect(REPO, curves, pools);
        assertEq(paid, 2 ether);
        assertEq(maint.balance, 2 ether);
    }

    function test_collectBeforeClaimReverts() public {
        vm.expectRevert(RepoHub.NotClaimed.selector);
        hub.collect(REPO, new address[](0), new bytes32[](0));
    }

    function test_wrongSignerRejected() public {
        bytes32 key = hub.keyOf(REPO);
        uint64 dl = uint64(block.timestamp + 600);
        bytes memory sig = _sig(key, maint, 1, dl, 0xBAD);
        vm.expectRevert(RepoHub.BadSignature.selector);
        hub.claim(REPO, maint, 1, dl, sig, new address[](0), new bytes32[](0));
    }

    function test_signatureBoundToWallet() public {
        bytes32 key = hub.keyOf(REPO);
        uint64 dl = uint64(block.timestamp + 600);
        bytes memory sig = _sig(key, maint, 1, dl, verifierPk);
        vm.expectRevert(RepoHub.BadSignature.selector);
        hub.claim(REPO, address(0xE111), 1, dl, sig, new address[](0), new bytes32[](0));
    }

    function test_replayAndStaleRejected_newerRebinds() public {
        _claim(maint, 5);
        // The same attestation again (e.g. someone front-ran the maintainer) just pays, it does not revert.
        vm.deal(hub.vaultFor(REPO), 1 ether);
        assertEq(_claim(maint, 5), 1 ether);
        _claimExpect(address(0x1234), 5, RepoHub.StaleAttestation.selector);
        _claimExpect(address(0x1234), 4, RepoHub.StaleAttestation.selector);
        _claim(address(0x1234), 6);
        assertEq(hub.walletOf(hub.keyOf(REPO)), address(0x1234));
        assertEq(hub.reposClaimed(), 1);
    }

    function test_expired() public {
        bytes32 key = hub.keyOf(REPO);
        uint64 dl = uint64(block.timestamp - 1);
        bytes memory sig = _sig(key, maint, 1, dl, verifierPk);
        vm.expectRevert(RepoHub.Expired.selector);
        hub.claim(REPO, maint, 1, dl, sig, new address[](0), new bytes32[](0));
    }

    function test_pauseBlocksClaimNotCollect() public {
        _claim(maint, 1);
        vm.prank(owner);
        hub.setPaused(true);
        _claimExpect(maint, 2, RepoHub.IsPaused.selector);
        vm.deal(hub.vaultFor(REPO), 1 ether);
        hub.collect(REPO, new address[](0), new bytes32[](0));
        assertEq(maint.balance, 1 ether);
    }

    function test_verifierChangeWaitsThreeDays() public {
        address next = address(0x7777);
        vm.startPrank(owner);
        hub.proposeVerifier(next);
        vm.expectRevert(RepoHub.TooEarly.selector);
        hub.acceptVerifier();
        vm.warp(block.timestamp + 3 days);
        hub.acceptVerifier();
        vm.stopPrank();
        assertEq(hub.verifier(), next);
    }

    function test_onlyOwnerAdmin() public {
        vm.expectRevert();
        hub.setPaused(true);
        vm.expectRevert();
        hub.proposeVerifier(address(1));
    }

    function test_vaultOnlyHub() public {
        _claim(maint, 1);
        RepoVault v = RepoVault(payable(hub.vaultFor(REPO)));
        vm.deal(address(v), 1 ether);
        vm.expectRevert(RepoVault.NotHub.selector);
        v.pay(payable(address(this)), IPonsFeeEscrow(address(escrow)), IPonsHook(hookAddr), new address[](0), new bytes32[](0));
    }

    function test_revertingWalletDoesNotLoseFunds() public {
        address bad = address(new RevertingThing());
        bytes32 key = hub.keyOf(REPO);
        vm.deal(hub.vaultFor(REPO), 1 ether);
        uint64 dl = uint64(block.timestamp + 600);
        bytes memory sig = _sig(key, bad, 1, dl, verifierPk);
        vm.expectRevert(RepoVault.PayoutFailed.selector);
        hub.claim(REPO, bad, 1, dl, sig, new address[](0), new bytes32[](0));
        assertEq(hub.vaultFor(REPO).balance, 1 ether);
    }

    function test_collectToken() public {
        _claim(maint, 1);
        Tok t = new Tok();
        t.approve(address(escrow), 5e18);
        escrow.creditToken(hub.vaultFor(REPO), address(t), 5e18);
        uint256 paid = hub.collectToken(REPO, address(t));
        assertEq(paid, 5e18);
        assertEq(t.balanceOf(maint), 5e18);
    }

    function test_tightGasRevertsInsteadOfPayingZero() public {
        address vault = hub.vaultFor(REPO);
        escrow.credit{value: 1 ether}(vault);
        bytes32 key = hub.keyOf(REPO);
        uint64 dl = uint64(block.timestamp + 600);
        bytes memory sig = _sig(key, maint, 1, dl, verifierPk);
        // Enough to bind and deploy the vault, not enough to also forward CLAIM_GAS to the escrow.
        (bool ok,) = address(hub).call{gas: 520_000}(
            abi.encodeCall(RepoHub.claim, (REPO, maint, 1, dl, sig, new address[](0), new bytes32[](0)))
        );
        assertFalse(ok, "must not succeed with nothing paid");
        assertEq(hub.walletOf(key), address(0));
        assertEq(maint.balance, 0);
        // With normal gas the same call pays everything.
        hub.claim(REPO, maint, 1, dl, sig, new address[](0), new bytes32[](0));
        assertEq(maint.balance, 1 ether);
    }

    function test_futureOrLongLivedAttestationRejected() public {
        bytes32 key = hub.keyOf(REPO);
        uint64 far = uint64(block.timestamp + 1 days);
        bytes memory sig = _sig(key, maint, far, far + 600, verifierPk);
        vm.expectRevert(RepoHub.BadTimes.selector);
        hub.claim(REPO, maint, far, far + 600, sig, new address[](0), new bytes32[](0));
        uint64 ia = uint64(block.timestamp);
        sig = _sig(key, maint, ia, ia + 2 hours, verifierPk);
        vm.expectRevert(RepoHub.BadTimes.selector);
        hub.claim(REPO, maint, ia, ia + 2 hours, sig, new address[](0), new bytes32[](0));
    }

    function test_cannotRenounce() public {
        vm.prank(owner);
        vm.expectRevert(RepoHub.NoRenounce.selector);
        hub.renounceOwnership();
        assertEq(hub.owner(), owner);
    }

    function testFuzz_vaultAddressMatchesDeploy(uint64 issuedAt) public {
        issuedAt = uint64(bound(issuedAt, 1, block.timestamp));
        address predicted = hub.vaultFor(REPO);
        _claim(maint, issuedAt);
        assertGt(predicted.code.length, 0);
    }
}
