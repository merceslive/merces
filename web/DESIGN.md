# Merces · design

## Brief
- Subject: Merces (merces.live), a launchpad on Robinhood Chain that pays open source. A coin is launched for a public GitHub repo; its Pons creator fees fill that repo's vault; whoever can push to the repo claims with a `.merces` file.
- Audience: crypto traders on Pons (launchers) and open-source maintainers (claimers). Both arrive from X.
- Job: make "fees go to the repo, not the launcher" obvious in 3 seconds; get people to launch, maintainers to claim; show $WAGE schedule (21 Nov 2026 15:00 UTC) and, at T0, the CA.
- Constraints: English, UTC only, no return promises, no team wallets, real numbers only (empty states say so). The user asked for glassy, 3D, futuristic, and called the previous aurora + purple glass "very AI".

## Concepts
| | Idea | Anchor | Signature | O / F / Fe / P |
|---|---|---|---|---|
| A. Material: the glass vault | Every repo's vault is made of glass: you can see every wei inside, and it holds liquid mercury that rises as trades pour in | The vault really is transparent: a CREATE2 contract with no owner, readable by anyone; *Merces* shares its root with Mercury, god of wages and trade | a refractive glass vault full of sloshing chrome mercury; real fee events fall in as drops; scroll walks it through launch → fill → claim | 4 / 5 / 4 / 2 |
| B. Material: the commit graph | Fees travel along a repo's commit graph like current, from trade to maintainer | Git history | a 3D branch lattice with light pulses | 3 / 4 / 3 / 3 |
| C. Formal: payroll terminal | The whole site is one live payroll ledger | wages | rows printing in real time | 3 / 3 / 5 / 4 |

**Pick A.** It is the only one where glass is the argument, not the decoration: transparency is the trust model. Steal from C for the live section: an index ledger of real events.

## Concept card
```
Idea:        Every repo gets a glass vault. You can watch its wages rise, and only the repo can open it.
Metaphor:    a laboratory glass vessel holding liquid mercury (Merces ~ Mercury, wages and trade)
Signature:   the vault (three.js, transmission + dispersion glass, chrome mercury with a live surface):
             pointer tilts it and the mercury sloshes; real fee events drop in; the hero intro pours it from empty
             to the real level; on scroll it walks three chapters (name, pour, open). One fixed canvas for the whole site.
Emotion:     cold, precise, expensive; a lab at night
Motion verb: pour and settle (things fill from below with a short overshoot, then settle; nothing slides in from the side)
Screenshot:  the hero: the glass vault filling with mercury next to the huge wide "PAYDAY FOR OPEN SOURCE"
```

## System
- Palette (graphite lab; colour only comes from the glass's dispersion in GL):
  - ground `#07080A` (void), ground-2 `#0F1114`
  - ink `#EEF0EF`, muted `#8F969A` (6.8:1 on ground)
  - line `rgba(238,240,239,.12)`
  - accent: **mercury** = ink-white chrome; CTAs are mercury pills (ink fill, ground text). No hue accent in the UI.
  - curtain `#0F1114`
  - Why not the AI defaults: no purple-blue glow, no gradient text, no glass cards on everything. Glass appears in exactly two places: the GL vault and the readout panels that are literally "labels on the vault".
- Type: **Panchang** (fontshare, ultra-wide, architectural) for display + wordmark, uppercase, tracking −0.02em at mega size; **General Sans** (fontshare) for text and UI; **Space Mono** only for addresses and the `.merces` file. Numbers tabular.
- Grid: 12 columns, 24 px gutter, 4 vw side margin. Display type hangs on column 1; readouts align to column 8.
- Shape: radius 999 for pills (mercury drops), 4 px for panels. Nothing in between.
- Motion: one ease `cubic-bezier(.2,.8,.2,1)` ("settle"); reveals are clip-path from bottom (pour), 0.9 s for display, 0.5 s for UI, stagger 50 ms. Hover on primary targets: mercury floods the pill from the bottom and the label rolls up. One clock: gsap.ticker drives Lenis and the renderer.
- Idle: the mercury surface keeps moving (waves on the one clock); the vault turns slowly. Paused off-screen and under reduced motion (a still image of the vault is shown instead).

## Composition
```
HOME
┌ M E R C E S ─────────────── Explore Launch Claim Docs  [$WAGE · 21 Nov 15:00 UTC] [Connect] ┐
│ PAYDAY                                     ╭──glass vault──╮                                  │
│ FOR OPEN                                   │  ≈≈≈mercury≈≈ │  ┌readout: repo · level · status┐│
│ SOURCE.                                    ╰───────────────╯  └──────────────────────────────┘│
│ lede (col 1-5)          [Launch a coin][I maintain a repo]          github.com/[owner/repo] ⏎  │
│ ● $WAGE launches on Pons 21 November 2026, 15:00 UTC   1d 02h 14m 09s                          │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
LIVE (index ledger, full bleed rows: time · event · repo · amount)
NUMBERS (four huge numerals in a row, no boxes)
HOW (sticky stage: chapters left, vault right; 1 name · 2 pour · 3 open)
FILE (one giant monospace line: merces=0x…)
VAULTS (index list, hover row floods)
GLASS, NOT TRUST (flow line + contract addresses)
QUESTIONS (2 columns: question list / answer)
FOOTER (edge-to-edge MERCES wordmark, countdown, links)
```

## Genericness test
- A generic model would centre the hero over a blob and stack three cards: replaced by a four-corner frame with a real object and an index ledger.
- It would pick Inter + purple gradient: replaced by Panchang + monochrome chrome, colour only from refraction.
- It would fade everything up: replaced by the pour verb (clip from below + settle) and a single fixed vault that travels between sections.
