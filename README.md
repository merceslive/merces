# Merces

**Payday for open source.** Launch a coin for any public GitHub repo on Robinhood Chain. Its creator fees fill that repo's vault, and only someone who can push to the repo can open it.

Live at **[merces.live](https://merces.live)** · X [@mercesdotlive](https://x.com/mercesdotlive) · Telegram [t.me/mercesdotlive](https://t.me/mercesdotlive) · bot [@merceslivebot](https://t.me/merceslivebot)

## How it works

1. **Name a repo.** Every public repo has a vault whose address is fixed by its lower-cased name (CREATE2), so it can receive fees before it exists.
2. **Launch on Pons.** A normal Pons V2 coin whose `creatorFeeRecipient` is the repo's vault, with buyback off so the vault can sweep its own curve. The launcher's wallet is never in the fee path.
3. **The maintainer claims.** Commit one line, `merces=0xYourWallet`, to `.merces` or `.github/merces` on the default branch. The verifier reads it through the GitHub API (at the head commit, uncached) and signs a short-lived EIP-712 attestation. `RepoHub.claim` binds the wallet, deploys the vault if needed, sweeps the curves, claims the Pons escrow and pays out, in one transaction. After that, `collect` is permissionless and only ever pays the bound wallet.

## Contracts (Robinhood Chain mainnet, 4663)

| | |
|---|---|
| RepoHub | [`0xdfB1Dc4ea18CFE83Cd47530D4b7b936d44cfdcB4`](https://robinhoodchain.blockscout.com/address/0xdfb1dc4ea18cfe83cd47530d4b7b936d44cfdcb4) (Sourcify exact match) |
| Pons fee escrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` |
| Pons meme hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |

Read any repo's vault yourself:

```bash
cast call 0xdfB1Dc4ea18CFE83Cd47530D4b7b936d44cfdcB4 "vaultFor(string)(address)" "neovim/neovim" \
  --rpc-url https://robinhood-rpc.publicnode.com
```

## Trust model, plainly

- **No cut.** The hub has no fee variable and no code path that pays anyone but a repo's bound wallet. Vaults have no owner and no arbitrary call.
- **The verifier key** decides which wallet a repo binds to. A verifier change is public and waits 3 days on chain. Attestations are bounded in time (issued at most 5 minutes ahead, valid at most 1 hour).
- **The owner** can pause new claims (payouts to bound wallets keep working) and propose a verifier change. It cannot move funds, and `renounceOwnership` is disabled.
- **Pons** can reassign a launch's fee recipient after its own 3-day timelock. Merces cannot remove that.
- **Not externally audited.** Internally reviewed; findings fixed before deploy.
- A coin for a repo is not an endorsement by its maintainers. Nothing here promises a return on any coin.

## Repository

| Folder | What |
|---|---|
| `contracts/` | `RepoHub.sol`, `RepoVault.sol` (Foundry). 19 unit tests + 1 mainnet-fork test against the real Pons V2 contracts |
| `server/` | Node + viem: GitHub verifier (`/api/attest`), coin registry, live trade tape (`/api/live`, every CurveBuy/CurveSell and the creator tax it sent to a repo), stats, RPC proxy, and the Telegram bot (`telegram.mjs`: /vault, /live, /stats, /watch, group feed, anti-clone) |
| `web/` | Vite + vanilla JS + three.js: the site at merces.live |

```bash
# contracts
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
forge test
FORK_RPC=https://robinhood.drpc.org forge test --match-contract PonsFork -vv

# server (needs HUB and a verifier key, see server/deploy/server.env.example)
cd server && npm install && node src/index.mjs

# web
cd web && npm install && npm run dev
```

## License

MIT
