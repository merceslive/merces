# Merces — Robinhood Chain mainnet (4663)

| what | value |
|---|---|
| RepoHub | `0xdfB1Dc4ea18CFE83Cd47530D4b7b936d44cfdcB4` |
| deploy tx | `0x9b007d71603810d903bf3573e976c78e0a2732ee127cc025c5f4b398a5975f24` (block 118911629, status 1) |
| verification | Sourcify **exact_match** (job 0f2ca39c-87f0-419a-bde1-88c4d7b9e79e) |
| explorer | https://robinhoodchain.blockscout.com/address/0xdfb1dc4ea18cfe83cd47530d4b7b936d44cfdcb4 |
| owner (pause new claims, propose verifier change with 3-day delay; cannot move funds) | deployer key `../.keys/mainnet-deployer.key` |
| verifier (signs claim attestations on merces.live) | `0xEb5b4e0e087035f6DfDee87C0b4088616679ec01`, key on us1 `/opt/merces/state/verifier.key` |
| Pons wiring (immutable) | fee escrow `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`, meme hook `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |
| VAULT_CODEHASH | `0x73bea718d3b8d7a53950f4c7fcb7fbc39a1a110ac6389a3478387db2c57be755` |

Tests before deploy: 19 unit + 1 mainnet-fork (real Pons V2: launch → trade → claim, maintainer paid tax + 70 % of base fee exactly). Independent review: 0 critical; 1 high + 2 medium + lows fixed before deploy.
