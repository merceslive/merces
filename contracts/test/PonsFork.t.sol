// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RepoHub} from "../src/RepoHub.sol";
import {IPonsHook, IPonsFeeEscrow} from "../src/interfaces/IPons.sol";

struct Socials {
    string twitter;
    string telegram;
    string discord;
    string website;
    string farcaster;
}

struct TokenParams {
    string name;
    string symbol;
    string logo;
    string description;
    Socials socials;
    address creatorFeeRecipient;
    uint16 creatorTaxBps;
    bool buybackEnabled;
    bytes32 expectedEconomics;
    bytes32 salt;
}

interface IFactory {
    function launchFee() external view returns (uint256);
    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);
}

interface ICurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
    function creatorTaxBalance() external view returns (uint256);
    function quoteFeeBalance() external view returns (uint256);
    function deployer() external view returns (address);
}

/// End-to-end against the REAL Pons V2 contracts on a Robinhood Chain mainnet fork:
/// launch a coin whose creator fee recipient is a repo vault that does not exist yet, trade it,
/// then claim with a verifier signature and check the maintainer received the fees.
///   FORK_RPC=https://robinhood-rpc.publicnode.com forge test --match-contract PonsFork -vv
contract PonsForkTest is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    function test_feesReachMaintainerThroughUndeployedVault() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        uint256 vpk = 0xA11CE;
        RepoHub hub = new RepoHub(address(this), vm.addr(vpk), IPonsFeeEscrow(ESCROW), IPonsHook(HOOK));
        string memory repo = "ollama/ollama";
        address vault = hub.vaultFor(repo);
        assertEq(vault.code.length, 0, "vault not deployed yet");

        TokenParams memory p;
        p.name = "Merces Fork Test";
        p.symbol = "MFT";
        p.creatorFeeRecipient = vault;
        p.creatorTaxBps = 200;
        p.buybackEnabled = false;
        p.salt = keccak256(abi.encode(block.timestamp, vault));
        uint256 fee = IFactory(FACTORY).launchFee();
        vm.deal(address(this), 100 ether);
        (address token, address curve) = IFactory(FACTORY).launchToken{value: fee}(p, 0, address(0));
        assertEq(ICurve(curve).deployer(), vault, "curve pays the vault");

        skip(60);
        address trader = makeAddr("trader");
        vm.deal(trader, 10 ether);
        vm.startPrank(trader);
        uint256 out = ICurve(curve).buy{value: 1 ether}(1 ether, 0, trader);
        IERC20(token).approve(curve, out / 2);
        ICurve(curve).sell(out / 2, 0, trader);
        vm.stopPrank();
        uint256 tax = ICurve(curve).creatorTaxBalance();
        uint256 baseFee = ICurve(curve).quoteFeeBalance();
        emit log_named_uint("creator tax on curve", tax);
        emit log_named_uint("base fee on curve", baseFee);

        address maint = makeAddr("maintainer");
        bytes32 key = hub.keyOf(repo);
        uint64 issuedAt = uint64(block.timestamp);
        uint64 deadline = uint64(block.timestamp + 600);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(vpk, hub.hashClaim(key, maint, issuedAt, deadline));
        address[] memory curves = new address[](1);
        curves[0] = curve;
        uint256 paid = hub.claim(repo, maint, issuedAt, deadline, abi.encodePacked(r, s, v), curves, new bytes32[](0));
        emit log_named_uint("paid to maintainer", paid);

        uint256 expected = tax + baseFee - (baseFee * 3000) / 10_000; // tax + creator share of the base fee
        assertEq(paid, expected, "tax + 70% of base fee");
        assertEq(maint.balance, paid);
        assertEq(ICurve(curve).creatorTaxBalance(), 0);
        assertEq(vault.balance, 0);
    }
}
