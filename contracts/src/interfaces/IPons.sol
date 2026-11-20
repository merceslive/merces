// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Minimal slices of the Pons V2 contracts on Robinhood Chain (verified on Sourcify, chain 4663).

interface IPonsCurve {
    /// Callable by the fee sweep operator or by the launch's creator fee recipient (when buyback is off).
    function sweepFees(uint256 minBuybackTokensOut) external;
}

interface IPonsHook {
    /// After graduation. Callable by the operator or the pool's creator recipient.
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;
}

interface IPonsFeeEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
    /// Pays msg.sender its whole native balance.
    function claim() external returns (uint256);
    function claimToken(address token) external returns (uint256);
}
