// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPonsCurve, IPonsHook, IPonsFeeEscrow} from "./interfaces/IPons.sol";

/// @title RepoVault
/// @notice One vault per GitHub repo, deployed by the hub with CREATE2 at an address derived from the repo name.
///         It is the Pons creator fee recipient for every coin launched for that repo. It has no owner and no
///         arbitrary call: the only way value leaves it is `pay`, called by the hub, to the wallet the hub names.
contract RepoVault {
    using SafeERC20 for IERC20;

    address public immutable hub;

    /// Gas forwarded to each best-effort external step. Before each step the vault checks that it still has this
    /// much (plus headroom) and reverts otherwise: a wallet's gas estimate would otherwise settle on a limit where
    /// the step runs out of gas inside try/catch, and the payout "succeeds" with nothing paid.
    uint256 internal constant SWEEP_GAS = 600_000;
    uint256 internal constant POOL_GAS = 900_000;
    uint256 internal constant CLAIM_GAS = 200_000;
    uint256 internal constant HEADROOM = 60_000;

    error NotHub();
    error PayoutFailed();
    error LowGas();

    constructor() {
        hub = msg.sender;
    }

    /// Accepts ETH from the Pons fee escrow, rescue pushes and top-ups. Kept cheap so a 2300-gas send still lands.
    receive() external payable {}

    /// @notice Sweeps the given Pons curves / graduated pools into the escrow, claims the escrow and pays `to`.
    /// @dev Every sweep is best-effort: a curve that is not ours, already graduated or holding nothing must not
    ///      block the payout of everything else. The hub guards against re-entry.
    function pay(address payable to, IPonsFeeEscrow escrow, IPonsHook hook, address[] calldata curves, bytes32[] calldata poolIds)
        external
        returns (uint256 amount)
    {
        if (msg.sender != hub) revert NotHub();
        for (uint256 i; i < curves.length; ++i) {
            _need(SWEEP_GAS);
            try IPonsCurve(curves[i]).sweepFees{gas: SWEEP_GAS}(0) {} catch {}
        }
        for (uint256 i; i < poolIds.length; ++i) {
            _need(POOL_GAS);
            try hook.sweepPoolFees{gas: POOL_GAS}(poolIds[i], 0, 0) {} catch {}
        }
        if (escrow.balanceOf(address(this)) > 0) {
            _need(CLAIM_GAS);
            try escrow.claim{gas: CLAIM_GAS}() {} catch {}
        }
        amount = address(this).balance;
        if (amount > 0) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert PayoutFailed();
        }
    }

    /// @notice Claims an ERC-20 the escrow holds for this vault (e.g. a WETH-paired launch) and forwards all of it.
    function payToken(address to, IPonsFeeEscrow escrow, address token) external returns (uint256 amount) {
        if (msg.sender != hub) revert NotHub();
        if (escrow.balanceOfToken(address(this), token) > 0) {
            _need(CLAIM_GAS);
            try escrow.claimToken{gas: CLAIM_GAS}(token) {} catch {}
        }
        amount = IERC20(token).balanceOf(address(this));
        if (amount > 0) IERC20(token).safeTransfer(to, amount);
    }

    function _need(uint256 forwarded) private view {
        // 64/64 of what we forward must be available after the 1/64 the EVM keeps back.
        if (gasleft() < forwarded + forwarded / 63 + HEADROOM) revert LowGas();
    }
}
