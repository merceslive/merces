import './style.css';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { createVault } from './vault.js';
import {
  C, pub, hubAddr, hubAbi, factoryAbi, routerAbi, W, connect, onAccount, write, launchedFrom, errText,
  formatEther, parseEther, getAddress, isAddress,
} from './chain.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const KEY = C.proofKey;
const exp = (kind, a) => `${C.explorer}/${kind}/${a}`;
const ponsUrl = (t) => C.pons.tokenUrl.replace('{token}', t);
const ghAvatar = (repo) => `https://github.com/${repo.split('/')[0]}.png?size=64`;
let token = { ca: null };
// Public launch schedule (rule 11-11: ticker and time are public from day one; only the CA waits for T0).
const LAUNCH = C.launchUtc ? Date.parse(C.launchUtc) : NaN;
const fmtUtc = (o) => new Date(LAUNCH).toLocaleString('en-GB', { ...o, timeZone: 'UTC' });
const hhmm = () => fmtUtc({ hour: '2-digit', minute: '2-digit', hour12: false });
const launchShort = () => `${fmtUtc({ day: 'numeric', month: 'short' })} ${hhmm()} UTC`;
const launchLong = () => `${fmtUtc({ day: 'numeric', month: 'long', year: 'numeric' })}, ${hhmm()} UTC`;
function countdown() {
  const ms = LAUNCH - Date.now();
  if (!(ms > 0)) return 'any moment now';
  const t = Math.floor(ms / 1000), d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d ? `${d}d ` : ''}${pad(h)}h ${pad(m)}m ${pad(sec)}s`;
}

function eth(wei, dp = 4) {
  const n = Number(formatEther(BigInt(wei || 0)));
  if (n > 0 && n < 10 ** -dp) return `<${(10 ** -dp).toFixed(dp)} ETH`;
  return `${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })} ETH`;
}
// Mirrors RepoHub._normalize and the server's normRepo.
function normRepo(input) {
  const s = String(input || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = s.match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
  if (!m) return null;
  const [, owner, name] = m;
  if (owner.startsWith('-') || owner.endsWith('-') || name === '.' || name === '..' || /\.git$/i.test(name)) return null;
  return s;
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200);
}
document.addEventListener('click', (e) => {
  const sc = e.target.closest('[data-scroll]');
  if (sc) { const t = document.querySelector(sc.dataset.scroll); if (t) { if (lenis) lenis.scrollTo(t, { offset: 0 }); else t.scrollIntoView(); } return; }
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => toast(b.dataset.copyLabel || 'Copied'));
});
const noHub = `<div class="notice">The hub contract is not deployed yet. This page goes live as soon as it is.</div>`;

async function chainRepo(repo) {
  if (!hubAddr) return null;
  const key = await pub.readContract({ address: hubAddr, abi: hubAbi, functionName: 'keyOf', args: [repo] });
  const [vault, wallet, pending, paid] = await Promise.all([
    pub.readContract({ address: hubAddr, abi: hubAbi, functionName: 'vaultFor', args: [repo] }),
    pub.readContract({ address: hubAddr, abi: hubAbi, functionName: 'walletOf', args: [key] }),
    pub.readContract({ address: hubAddr, abi: hubAbi, functionName: 'pendingOf', args: [key] }),
    pub.readContract({ address: hubAddr, abi: hubAbi, functionName: 'paidOf', args: [key] }),
  ]);
  return { key, vault, wallet: wallet === ZERO ? null : wallet, pending, paid };
}

// ------------------------------------------------------------------ motion: one clock (gsap.ticker) for Lenis, ScrollTrigger and the vault
gsap.registerPlugin(ScrollTrigger);
document.documentElement.classList.add('js');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let lenis = null;
if (!reduce) {
  lenis = new Lenis({ lerp: 0.12 });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}
let vault = reduce ? null : createVault($('#gl'), {
  onSlow: () => { vault?.destroy(); vault = null; document.documentElement.classList.add('no-gl'); },
  onReady: () => document.documentElement.classList.add('gl-on'),
});
if (!vault) document.documentElement.classList.add('no-gl');
const top = $('.top');
ScrollTrigger.create({
  start: 0, end: 'max',
  onUpdate: (self) => {
    const y = self.scroll();
    top.classList.toggle('solid', y > 40);
    top.classList.toggle('away', self.direction === 1 && y > 260 && !top.contains(document.activeElement));
  },
});
// Level of the vault from wei waiting: log scale, a film at zero so the mercury always reads.
const levelOf = (wei) => {
  const e = Number(formatEther(BigInt(wei || 0)));
  return e > 0 ? 0.1 + 0.8 * Math.min(1, Math.log10(1 + e * 50) / Math.log10(1 + 500)) : 0.03;
};

// ------------------------------------------------------------------ header
function header() {
  const menu = $('#buy-menu');
  menu.innerHTML = token.ca
    ? `<a href="${ponsUrl(token.ca)}" target="_blank" rel="noopener">Buy on Pons</a>
       <a href="${C.dexscreener.replace('{token}', token.ca)}" target="_blank" rel="noopener">Chart on DexScreener</a>
       <div class="buy-ca"><span class="mono">${short(token.ca)}</span><button type="button" data-copy="${token.ca}" data-copy-label="Contract address copied">Copy CA</button></div>
       <p>Only trust the CA posted here, on our X and in our Telegram.</p>`
    : `<p><b>$${C.ticker}</b> launches on Pons${Number.isFinite(LAUNCH) ? ` on <b>${launchLong()}</b>` : ''}.</p>
       <p>The contract address appears here at launch. Until then, anything claiming to be $${C.ticker} is not.</p>
       <a href="#/token">What $${C.ticker} is</a>`;
  $('#connect').innerHTML = `<span data-roll>${W.account ? short(W.account) : 'Connect'}</span>`;
  $('#connect').setAttribute('aria-label', W.account ? `Connected wallet ${W.account}` : 'Connect wallet');
  $('#x-link').href = C.x; $('#foot-x').href = C.x;
  if (C.telegram) $('#tg-link').href = C.telegram;
  if (C.github) { $('#gh-link').href = C.github; $('#gh-link').hidden = false; }
  if (hubAddr) { $('#foot-hub').href = exp('address', hubAddr); $('#foot-hub').target = '_blank'; $('#foot-hub').rel = 'noopener'; }
  const chip = $('#ca-chip');
  if (chip) chip.outerHTML = caChip();
}
const caChip = () => `<div class="ca-chip" id="ca-chip"><span class="tk">$${C.ticker}</span>${token.ca
  ? `<span class="mono">${short(token.ca)}</span><button type="button" data-copy="${token.ca}" data-copy-label="Contract address copied">Copy</button>`
  : `<span>CA at ${Number.isFinite(LAUNCH) ? launchShort() : 'launch'}</span><button type="button" disabled aria-disabled="true">Copy</button>`}</div>`;
const buyBtn = $('#buy'), buyMenu = $('#buy-menu');
const setBuy = (open) => { buyMenu.hidden = !open; buyBtn.setAttribute('aria-expanded', String(open)); };
buyBtn.addEventListener('click', (e) => { e.stopPropagation(); setBuy(buyMenu.hidden); });
document.addEventListener('click', (e) => { if (!buyMenu.hidden && !buyMenu.contains(e.target)) setBuy(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !buyMenu.hidden) { setBuy(false); buyBtn.focus(); } });
$('#connect').addEventListener('click', () => connect().then(header).catch((e) => toast(errText(e))));
onAccount(() => header());

// ------------------------------------------------------------------ live events (real on-chain happenings only)
let events = [];
let seenAt = 0;
const ago = (ms) => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
function eventRow(e) {
  const what = e.type === 'launch' ? `$${esc(e.symbol)} launched for` : e.type === 'fees' ? 'Fees landed in the vault of' : 'Vault paid its maintainer:';
  const amt = e.type === 'launch' ? '' : e.type === 'fees' ? `+${eth(e.amount)}` : eth(e.amount);
  const repo = e.repo ? `<a href="#/r/${esc(e.repo)}">${esc(e.repo)}</a>` : 'a repo';
  return `<li><time datetime="${new Date(e.at).toISOString()}">${ago(e.at)}</time><span class="what">${what}</span><span class="repo">${repo}</span><span class="amt">${amt}</span></li>`;
}
function paintLive() {
  const el = $('#live');
  if (!el) return;
  el.innerHTML = events.length
    ? events.slice(0, 8).map(eventRow).join('')
    : `<li class="none">Nothing on the ledger yet. The first launch writes the first line.</li>`;
}
async function pollEvents() {
  const list = await api('/api/events').catch(() => null);
  if (list) {
    const fresh = list.filter((e) => e.at > seenAt && (e.type === 'fees' || e.type === 'launch'));
    if (seenAt && vault) fresh.slice(0, 6).forEach((_, i) => gsap.delayedCall(i * 0.35, () => vault.drop()));
    seenAt = Math.max(seenAt, ...list.map((e) => e.at), Date.now() - 1);
    events = list;
    paintLive();
  }
  gsap.delayedCall(15, pollEvents);
}

// ------------------------------------------------------------------ home
const FAQ = [
  ['Who gets the fees?', `Whoever can push to the repo's default branch. They prove it with a <code>.${KEY}</code> file and claim. The person who launched the coin gets nothing from the creator fees.`],
  ['What if nobody ever claims?', 'The fees stay in the vault. There is no deadline, and nobody else can take them, Merces included.'],
  ['How does a maintainer claim?', `Commit one line, <code>${KEY}=0xYourWallet</code>, to <code>.${KEY}</code> or <code>.github/${KEY}</code> on the default branch, connect that wallet here and press claim. One transaction checks the signature, opens the vault and pays out everything in it.`],
  ['Which repos work?', 'Any public GitHub repo. Private repos are refused, because nobody outside could check the proof file.'],
  ['What does it cost?', 'Launchers pay the Pons launch fee and gas. Merces adds no fee and takes no cut; the hub contract has no code path that pays Merces.'],
  ['The repo was renamed or moved. Now what?', 'GitHub redirects the old name, so whoever controls the repo today can claim the old name’s vault. A newer claim replaces an older one, so a maintainer can also switch wallets.'],
  ['Does a coin mean the maintainers approve of it?', 'No. Anyone can launch a coin for any public repo. A coin is a way to pay the maintainers, not their endorsement.'],
];
const SAMPLE = ['neovim/neovim', 'ollama/ollama', 'rust-lang/rust', 'vercel/next.js', 'bitcoin/bitcoin'];

function home(ctx) {
  const sample = SAMPLE[Math.floor(Date.now() / 3.6e6) % SAMPLE.length];
  const showLaunch = Number.isFinite(LAUNCH) && !token.ca;
  app.innerHTML = `
  <section class="hero" aria-labelledby="hero-title">
    <h1 class="display" id="hero-title"><span class="l" data-pour>Payday</span><span class="l" data-pour>for open</span><span class="l" data-pour>source.</span></h1>
    <p class="lede" data-pour>Launch a coin for any public GitHub repo. Its creator fees fill that repo's glass vault, and only someone who can push to the repo can open it.</p>
    <div class="cta row" data-pour>
      <a class="pill" href="#/launch"><span data-roll>Launch a coin</span></a>
      <button class="pill pill-ghost" type="button" data-scroll=".how"><span data-roll>How it works</span></button>
      ${caChip()}
    </div>
    <aside class="lookup readout" aria-label="Look up a repo's vault" data-pour>
      <header><span>Vault of</span><span id="env-status"></span></header>
      <dl id="env-dl"><dt>Repo</dt><dd>${esc(sample)}</dd></dl>
      <div class="level"><span class="muted">Waiting for its maintainers</span><b id="env-total">–</b></div>
      <form id="env-form">
        <div class="prefix" style="flex:1"><span>github.com/</span><input class="input" id="env-repo" value="${esc(sample)}" aria-label="Repo, as owner/name" autocomplete="off" spellcheck="false"/></div>
        <button class="pill pill-sm" type="submit"><span data-roll>Look up</span></button>
      </form>
      <div class="links"><a id="env-launch" href="#/launch">Launch a coin for it</a><a id="env-repo-link" href="#/r/${esc(sample)}">Open its page</a></div>
    </aside>
    ${showLaunch ? `<p class="launch-line" data-pour><span><span class="live-dot" aria-hidden="true"></span>$${C.ticker} launches on Pons on <b>${launchLong()}</b></span><span class="cd" id="cd" aria-label="Time until launch">${countdown()}</span></p>` : ''}
  </section>

  <section class="band" aria-labelledby="live-title">
    <div class="band-head"><h2 class="h2" id="live-title" data-pour><span class="live-dot" aria-hidden="true"></span>Live</h2><p data-pour>Every launch, every fee that lands in a vault and every payout, read from Robinhood Chain as it happens. <a href="#/live">Open the live tape</a></p></div>
    <ol class="ledger-live" id="live" aria-live="polite"><li class="none">Reading the chain…</li></ol>
  </section>

  <section class="band" aria-label="Totals">
    <div class="numbers" data-pour>
      <div><b id="s-coins">0</b><span>coins launched for repos</span></div>
      <div><b id="s-repos">0</b><span>repos with a vault</span></div>
      <div><b id="s-wait">0</b><span>ETH waiting in vaults</span></div>
      <div><b id="s-paid">0</b><span>ETH paid to maintainers</span></div>
    </div>
  </section>

  <section class="how" aria-labelledby="how-title">
    <h2 class="sr" id="how-title">How a vault fills and opens</h2>
    <div class="how-pin">
      <div class="how-text">
        <div class="chapter on" data-ch="0"><span class="n">1 / 3</span><h3>Name a repo</h3><p>Paste any public repo. Its vault address is fixed by its name, so it can be paid before anyone has heard of Merces.</p></div>
        <div class="chapter" data-ch="1"><span class="n">2 / 3</span><h3>Every trade pours in</h3><p>The coin launches on Pons with the vault as its creator fee recipient. Each buy and sell adds to it. The launcher's wallet is never in the path.</p></div>
        <div class="chapter" data-ch="2"><span class="n">3 / 3</span><h3>Push access opens it</h3><p>A maintainer commits one line with their wallet. One transaction checks it, opens the vault and pays out everything inside.</p></div>
      </div>
      <div class="how-meter" aria-hidden="true"><i class="on"></i><i></i><i></i></div>
      <p class="how-note">Illustration. Each repo's real level is on its page.</p>
    </div>
  </section>

  <section class="band" aria-labelledby="proof-title">
    <div class="band-head"><h2 class="h2" id="proof-title" data-pour>One line opens it</h2><p data-pour>The proof lives where only the maintainers can write: the default branch.</p></div>
    <div class="proof">
      <p class="file-line" data-pour><span class="k">${KEY}=</span>0xYourWallet</p>
      <p data-pour>Put it in <code>.${KEY}</code> at the root or in <code>.github/${KEY}</code>. A newer file moves the payout to a new wallet; a renamed repo keeps its vault through GitHub's redirect.</p>
      <div class="where" data-pour><a class="pill pill-ghost" href="#/claim"><span data-roll>Claim for my repo</span></a></div>
    </div>
  </section>

  <section class="band" aria-labelledby="vaults-title">
    <div class="band-head"><h2 class="h2" id="vaults-title" data-pour>Fullest vaults</h2><p data-pour>Repos with the most ETH waiting for their maintainers. <a href="#/explore">See every vault</a></p></div>
    <div id="vaults"></div>
  </section>

  <section class="band" aria-labelledby="coins-title">
    <div class="band-head"><h2 class="h2" id="coins-title" data-pour>New coins</h2><p data-pour>The latest launches and the repos they pay.</p></div>
    <div id="coins"></div>
  </section>

  <section class="band" aria-labelledby="glass-title">
    <div class="band-head"><h2 class="h2" id="glass-title" data-pour>Glass, not trust</h2><p data-pour>Fees never touch a Merces wallet. Anyone can read every vault, and a vault can only pay the wallet its repo named. <a href="#/verify">Check it yourself</a></p></div>
    <div class="flowline" data-pour>
      <div><b>A trade</b><p>Creator tax plus the creator share of the Pons fee.</p></div>
      <div><b>Pons escrow</b><p>Credits the repo's vault address.</p></div>
      <div><b>The vault</b><p>One contract per repo, with no owner and no other exit.</p></div>
      <div><b>The maintainer</b><p>The wallet in the repo's <code>.${KEY}</code> file.</p></div>
    </div>
    <div class="contracts">
      <div data-pour><b>Hub</b><p class="addr">${hubAddr ? `<a href="${exp('address', hubAddr)}" target="_blank" rel="noopener">${hubAddr}</a>` : 'Deployed before launch'}</p><p>Derives vault addresses, checks claims and pays out. Holds nothing.</p></div>
      <div data-pour><b>Pons fee escrow</b><p class="addr"><a href="${exp('address', C.pons.escrow)}" target="_blank" rel="noopener">${C.pons.escrow}</a></p><p>Where Pons credits each vault.</p></div>
      <div data-pour><b>Merces cut</b><p class="addr">0</p><p>There is no fee variable and no path that pays anyone but a repo's wallet.</p></div>
    </div>
  </section>

  <section class="band faq" aria-labelledby="faq-title">
    <h2 class="h2" id="faq-title" data-pour>Questions</h2>
    <div>${FAQ.map(([q, a]) => `<details><summary>${q}</summary><div>${a}</div></details>`).join('')}</div>
  </section>

  <section class="band final" aria-labelledby="final-title">
    <h2 class="h2" id="final-title" data-pour>Every repo has a payday.</h2>
    <div class="row" data-pour><a class="pill" href="#/launch"><span data-roll>Launch a coin</span></a><a class="pill pill-ghost" href="#/claim"><span data-roll>I maintain a repo</span></a></div>
  </section>`;

  // Hero lookup: the vault on screen is the looked-up repo's vault.
  const lookup = async (raw) => {
    const n = normRepo(raw);
    if (!n) return toast('Use owner/name, for example neovim/neovim');
    $('#env-launch').href = `#/launch?repo=${encodeURIComponent(n)}`;
    $('#env-repo-link').href = `#/r/${n}`;
    $('#env-dl').innerHTML = `<dt>Repo</dt><dd>${esc(n)}</dd>`;
    $('#env-total').textContent = '…';
    try {
      const [meta, c] = await Promise.all([api(`/api/repo?repo=${encodeURIComponent(n)}`).catch(() => null), chainRepo(n)]);
      const unswept = BigInt(meta?.stats?.unswept || 0);
      const total = c ? c.pending + unswept : unswept;
      $('#env-dl').innerHTML = `<dt>Repo</dt><dd>${esc(n)}</dd>
        <dt>Vault</dt><dd class="addr">${c ? short(c.vault) : 'at hub deploy'}</dd>
        <dt>Coins</dt><dd>${meta?.coins?.length ?? 0}</dd>
        <dt>Paid out</dt><dd>${c ? eth(c.paid) : eth(0)}</dd>`;
      $('#env-total').textContent = eth(total);
      $('#env-status').innerHTML = c?.wallet ? '<span class="tag on">Claimed</span>' : '<span class="tag">Unclaimed</span>';
      vault?.level(levelOf(total));
    } catch (e) { $('#env-total').textContent = '–'; toast(errText(e)); }
  };
  $('#env-form').addEventListener('submit', (e) => { e.preventDefault(); lookup($('#env-repo').value); });
  lookup(sample);
  paintLive();
  loadStats();
  loadVaults($('#vaults'), 6);
  loadCoins($('#coins'), 8);

  if ($('#cd')) {
    const tickCd = () => { const el = $('#cd'); if (el) el.textContent = countdown(); };
    gsap.ticker.add(tickCd);
    ctx.add(() => () => gsap.ticker.remove(tickCd));
  }

  // The vault's walk: hero -> parked while reading -> stage for the chapters -> parked.
  if (vault) {
    ctx.add(() => {
      vault.pose('hero');
      ScrollTrigger.create({ trigger: '.hero', start: 'top top', end: 'bottom 35%', onLeave: () => { vault.pose('park'); document.documentElement.classList.add('gl-dim'); }, onEnterBack: () => { vault.pose('hero'); document.documentElement.classList.remove('gl-dim'); } });
      let lastDrop = 0;
      ScrollTrigger.create({
        trigger: '.how', start: 'top top', end: 'bottom bottom',
        onEnter: () => { vault.pose('stage'); document.documentElement.classList.remove('gl-dim'); }, onEnterBack: () => { vault.pose('stage'); document.documentElement.classList.remove('gl-dim'); },
        onLeave: () => { vault.pose('park'); document.documentElement.classList.add('gl-dim'); }, onLeaveBack: () => { vault.pose('park'); document.documentElement.classList.add('gl-dim'); },
        onUpdate: (self) => {
          const p = self.progress;
          vault.stage(p);
          const ch = Math.min(2, Math.floor(p * 3));
          document.querySelectorAll('.chapter').forEach((el) => el.classList.toggle('on', +el.dataset.ch === ch));
          document.querySelectorAll('.how-meter i').forEach((el, i) => el.classList.toggle('on', i <= ch));
          const now = performance.now();
          if (p > 0.36 && p < 0.64 && now - lastDrop > 220) { lastDrop = now; vault.drop(); }
        },
      });
    });
  }
}

async function loadStats() {
  const s = await api('/api/stats').catch(() => null);
  if (!s || !$('#s-coins')) return;
  const n = (wei) => { const v = Number(formatEther(BigInt(wei || 0))); return v === 0 ? '0' : v.toFixed(4); };
  $('#s-coins').textContent = s.coins; $('#s-repos').textContent = s.repos;
  $('#s-wait').textContent = n(s.waiting); $('#s-paid').textContent = n(s.paid);
}

async function loadVaults(el, n = 50) {
  const list = await api('/api/vaults').catch(() => []);
  if (!list.length) { el.innerHTML = `<div class="empty">No vault holds fees yet. The first coin launched for a repo starts filling its vault. <a href="#/launch">Launch one</a></div>`; return; }
  el.innerHTML = `<ul class="index" data-pour><li><div class="head"><span>Repo</span><span class="r opt">Coins</span><span class="r opt">Paid</span><span class="r">Waiting</span></div></li>
    ${list.slice(0, n).map((v) => `<li><a href="#/r/${esc(v.repo)}"><span class="nm"><img class="avatar" src="${ghAvatar(v.repo)}" alt="" loading="lazy" width="34" height="34"/>${esc(v.repo)} ${v.stats?.wallet ? '<span class="tag">Claimed</span>' : ''}</span>
      <span class="r opt muted">${v.coins}</span><span class="r opt muted">${eth(v.stats?.paid || 0)}</span><span class="r">${eth(BigInt(v.stats?.pending || 0) + BigInt(v.stats?.unswept || 0))}</span></a></li>`).join('')}</ul>`;
  reveal(el);
}

async function loadCoins(el, n = 200, repo = null) {
  const list = await api(`/api/coins${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`).catch(() => []);
  if (!list.length) { el.innerHTML = `<div class="empty">No coins yet. Launch the first one for a repo you rely on. <a href="#/launch${repo ? `?repo=${encodeURIComponent(repo)}` : ''}">Launch a coin</a></div>`; return; }
  el.innerHTML = `<ul class="index" data-pour><li><div class="head"><span>Coin</span><span class="opt">Pays</span><span class="r opt">Creator tax</span><span class="r">On Pons</span></div></li>
    ${list.slice(0, n).map((c) => `<li><a href="${ponsUrl(c.token)}" target="_blank" rel="noopener"><span class="nm"><img class="avatar" src="${esc(c.logo || ghAvatar(c.repo))}" alt="" loading="lazy" width="34" height="34"/>$${esc(c.symbol)} <span class="muted">${esc(c.name)}</span></span>
      <span class="opt muted">${esc(c.repo)}</span><span class="r opt muted">${(c.taxBps / 100).toFixed(2)}%</span><span class="r">Trade</span></a></li>`).join('')}</ul>`;
  reveal(el);
}

// ------------------------------------------------------------------ explore
function explore() {
  app.innerHTML = `<section class="page">
    <div class="page-head"><h1 data-pour>Explore</h1><p data-pour>Every vault on Merces and every coin filling one.</p></div>
    <section aria-labelledby="ex-v"><h2 id="ex-v" data-pour>Vaults</h2><div id="vaults" style="margin-top:18px"></div></section>
    <section aria-labelledby="ex-c"><h2 id="ex-c" data-pour>Coins</h2><div id="coins" style="margin-top:18px"></div></section>
  </section>`;
  loadVaults($('#vaults'));
  loadCoins($('#coins'));
}

// ------------------------------------------------------------------ repo page
async function repoPage(repo) {
  const n = normRepo(repo);
  if (!n) { app.innerHTML = `<section class="page"><div class="wrap"><div class="notice err">That is not a repo name.</div></div></section>`; return; }
  app.innerHTML = `<section class="page"><div class="wrap">
    <div class="page-head"><div class="coin" style="gap:14px"><img class="avatar" style="width:56px;height:56px" src="${ghAvatar(n)}" alt=""/><div><h1 style="font-size:40px;margin:0">${esc(n)}</h1><p id="r-desc" style="margin:4px 0 0"></p></div></div></div>
    <div class="flow"><div>
      <h2>Coins paying this repo</h2><div id="coins"><div class="empty">Loading…</div></div>
    </div>
    <aside class="side"><div class="step"><div class="step-head"><h2>Vault</h2><span id="r-stamp" style="margin-left:auto"></span></div>
      <dl class="kv" id="r-kv"><dt>Loading</dt><dd>…</dd></dl>
      <div class="row" style="margin-top:16px"><a class="btn btn-sm" href="#/launch?repo=${encodeURIComponent(n)}">Launch for it</a><a class="btn btn-sm btn-ghost" href="#/claim?repo=${encodeURIComponent(n)}">Claim</a></div>
      <button class="btn btn-sm btn-ghost" id="r-collect" type="button" style="margin-top:10px;width:100%" hidden>Push new fees to the maintainer</button>
      <ul class="log" id="r-log"></ul>
    </div></aside></div>
  </div></section>`;
  loadCoins($('#coins'), 200, n);
  try {
    const [meta, c] = await Promise.all([api(`/api/repo?repo=${encodeURIComponent(n)}`), chainRepo(n)]);
    $('#r-desc').innerHTML = `${esc(meta.description)} <a href="https://github.com/${esc(meta.fullName)}" target="_blank" rel="noopener">GitHub ↗</a>`;
    if (!c) { $('#r-kv').innerHTML = `<dt>Hub</dt><dd>not deployed</dd>`; return; }
    const unswept = BigInt(meta.stats?.unswept || 0);
    $('#r-stamp').innerHTML = c.wallet ? '<span class="stamped">Claimed</span>' : '<span class="stamped warn">Unclaimed</span>';
    $('#r-kv').innerHTML = `<dt>Address</dt><dd><a href="${exp('address', c.vault)}" target="_blank" rel="noopener">${short(c.vault)}</a></dd>
      <dt>Waiting</dt><dd class="big">${eth(c.pending + unswept)}</dd><dt>Paid out</dt><dd>${eth(c.paid)}</dd>
      <dt>Pays</dt><dd>${c.wallet ? `<a href="${exp('address', c.wallet)}" target="_blank" rel="noopener">${short(c.wallet)}</a>` : 'nobody yet'}</dd>`;
    if (c.wallet) {
      const b = $('#r-collect'); b.hidden = false;
      b.onclick = async () => {
        b.disabled = true;
        try {
          const { hash } = await write({ address: hubAddr, abi: hubAbi, functionName: 'collect', args: [n, meta.sweep.curves, meta.sweep.poolIds] });
          $('#r-log').insertAdjacentHTML('beforeend', `<li class="ok">Sent. <a href="${exp('tx', hash)}" target="_blank" rel="noopener">tx ↗</a></li>`);
          setTimeout(() => repoPage(n), 1500);
        } catch (e) { $('#r-log').insertAdjacentHTML('beforeend', `<li class="err">${esc(errText(e))}</li>`); } finally { b.disabled = false; }
      };
    }
  } catch (e) { $('#r-kv').innerHTML = `<dt>Error</dt><dd>${esc(errText(e))}</dd>`; }
}

// ------------------------------------------------------------------ launch
async function pickConfig() {
  const want = BigInt(C.pons.launchConfigId || 0);
  const count = await pub.readContract({ address: C.pons.factory, abi: factoryAbi, functionName: 'launchConfigCount' });
  const open = [];
  for (let i = 0n; i < count; i++) {
    const cfg = await pub.readContract({ address: C.pons.factory, abi: factoryAbi, functionName: 'getLaunchConfig', args: [i] });
    if (cfg.enabled) open.push(i);
  }
  if (!open.length) throw new Error('Pons has no launch config open right now.');
  return open.includes(want) ? want : open[open.length - 1];
}

function launch(params) {
  const pre = normRepo(params.get('repo') || '') || '';
  const s = { repo: null, vault: null, logo: '', taxBps: 0, fee: null, maxTax: 1000 };
  app.innerHTML = `<section class="page"><div class="wrap">
    <div class="page-head"><h1>Launch a coin</h1><p>Pick a repo, describe the coin, launch it on Pons. The repo's vault earns the creator fees from the first trade.</p></div>
    ${hubAddr ? '' : noHub}
    <div class="flow"><form id="lf" novalidate>
      <div class="step"><div class="step-head"><b>1</b><h2>Repo to pay</h2><span class="done" id="d1" hidden>✓</span></div>
        <div class="row" style="flex-wrap:nowrap"><div class="prefix" style="flex:1"><span>github.com/</span><input class="input mono" id="l-repo" placeholder="owner/repo" value="${esc(pre)}" autocomplete="off" spellcheck="false" aria-label="Repo"/></div><button class="btn btn-ghost" type="button" id="l-check">Check</button></div>
        <div id="l-repo-info" style="margin-top:12px"></div></div>
      <div class="step"><div class="step-head"><b>2</b><h2>Your coin</h2></div>
        <label class="drop" for="l-img"><img id="l-img-prev" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"/><span><b>Coin image</b><br/><span class="muted small">PNG, JPG, WEBP or GIF, up to 350 KB</span></span></label>
        <input type="file" id="l-img" accept="image/png,image/jpeg,image/webp,image/gif" hidden/>
        <div class="grid2"><div><label class="lbl" for="l-name">Name</label><input class="input" id="l-name" maxlength="32" required/></div>
          <div><label class="lbl" for="l-sym">Ticker</label><div class="prefix"><span>$</span><input class="input mono" id="l-sym" maxlength="10" required/></div></div></div>
        <label class="lbl" for="l-desc">Description</label><textarea class="input" id="l-desc" rows="3" maxlength="500"></textarea>
        <div class="grid2"><div><label class="lbl" for="l-x">X <span class="faint">(optional)</span></label><input class="input" id="l-x" placeholder="https://x.com/…"/></div>
          <div><label class="lbl" for="l-tg">Telegram <span class="faint">(optional)</span></label><input class="input" id="l-tg" placeholder="https://t.me/…"/></div></div>
        <label class="lbl" for="l-web">Website</label><input class="input" id="l-web" placeholder="defaults to the repo on GitHub"/>
        <label class="lbl">Extra creator tax</label>
        <div class="row"><div class="seg" id="l-tax">${[0, 1, 2, 3].map((t) => `<button type="button" data-t="${t * 100}" class="${t === 0 ? 'on' : ''}">${t}%</button>`).join('')}<button type="button" data-t="custom">Custom</button></div>
          <input class="input mono" id="l-tax-c" style="width:110px" type="number" min="0" max="10" step="0.1" placeholder="%" hidden/></div>
        <p class="hint">Charged on every buy and sell, on top of the Pons fee. All of it goes to the repo.</p>
        <label class="lbl" for="l-buy">Dev buy <span class="faint">(optional)</span></label><div class="prefix"><input class="input mono" id="l-buy" type="number" min="0" step="0.001" placeholder="0"/><span style="padding-right:12px">ETH</span></div>
        <p class="hint">Bought for you in the launch transaction.</p></div>
      <div class="step"><div class="step-head"><b>3</b><h2>Launch</h2></div>
        <button class="btn" type="submit" id="l-go" style="width:100%">Launch on Pons</button><ul class="log" id="l-log"></ul></div>
    </form>
    <aside class="side"><div class="step"><div class="step-head"><h2>Summary</h2></div><dl class="kv" id="l-sum"></dl></div></aside></div>
  </div></section>`;

  const sum = () => {
    const buy = Number($('#l-buy').value || 0);
    $('#l-sum').innerHTML = `<dt>Pays</dt><dd>${s.repo ? esc(s.repo) : '<span class="faint">pick a repo</span>'}</dd>
      <dt>Vault</dt><dd>${s.vault ? short(s.vault) : '–'}</dd><dt>Extra tax</dt><dd>${(s.taxBps / 100).toFixed(2)}%</dd>
      <dt>Dev buy</dt><dd>${buy.toFixed(4)} ETH</dd><dt>Pons fee</dt><dd>${s.fee != null ? eth(s.fee) : '…'}</dd>
      <dt>Total</dt><dd class="big">${s.fee != null ? eth(s.fee + parseEther(String(buy || 0))) : '…'}</dd>`;
  };
  const log = (m, c = '') => $('#l-log').insertAdjacentHTML('beforeend', `<li class="${c}">${m}</li>`);

  const check = async () => {
    const n = normRepo($('#l-repo').value);
    const info = $('#l-repo-info');
    s.repo = null; s.vault = null; $('#d1').hidden = true;
    if (!n) { info.innerHTML = `<div class="notice err">Use owner/repo, for example neovim/neovim.</div>`; sum(); return; }
    info.innerHTML = '<p class="muted">Checking…</p>';
    try {
      const meta = await api(`/api/repo?repo=${encodeURIComponent(n)}`);
      const c = await chainRepo(n);
      s.repo = n; s.vault = c?.vault || null; $('#d1').hidden = false;
      info.innerHTML = `<div class="notice ok"><div class="coin"><img class="avatar" src="${esc(meta.avatar)}" alt=""/><div><b>${esc(meta.fullName)}</b> · ★ ${meta.stars.toLocaleString('en-US')}<br/><span class="small">${esc(meta.description || 'No description')}</span></div></div>
        <p class="small" style="margin:10px 0 0">Vault <span class="mono">${c ? c.vault : 'pending hub deploy'}</span>${c?.wallet ? ' · already claimed' : ''}</p></div>`;
      if (!$('#l-desc').value) $('#l-desc').value = `Creator fees from this coin pay the maintainers of github.com/${meta.fullName} through Merces.`;
      if (!$('#l-web').value) $('#l-web').placeholder = `https://github.com/${meta.fullName}`;
    } catch (e) { info.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
    sum();
  };
  $('#l-check').onclick = check;
  $('#l-repo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } });
  if (pre) check();

  $('#l-img').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > C.maxImageBytes) { toast('Image is over 350 KB'); return; }
    $('#l-img-prev').src = URL.createObjectURL(f);
    try { s.logo = (await api('/api/image', { method: 'POST', headers: { 'content-type': f.type }, body: f })).path; toast('Image uploaded'); } catch (err) { toast(err.message); }
  };
  $('#l-tax').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    [...$('#l-tax').children].forEach((x) => x.classList.toggle('on', x === b));
    const custom = b.dataset.t === 'custom';
    $('#l-tax-c').hidden = !custom;
    s.taxBps = custom ? Math.round(Number($('#l-tax-c').value || 0) * 100) : Number(b.dataset.t);
    sum();
  };
  $('#l-tax-c').oninput = () => { s.taxBps = Math.round(Number($('#l-tax-c').value || 0) * 100); sum(); };
  $('#l-buy').oninput = sum;

  pub.readContract({ address: C.pons.factory, abi: factoryAbi, functionName: 'launchFee' }).then((f) => { s.fee = f; sum(); }).catch(() => {});
  pub.readContract({ address: C.pons.factory, abi: factoryAbi, functionName: 'maxCreatorTaxBps' }).then((m) => { s.maxTax = Number(m); $('#l-tax-c').max = s.maxTax / 100; }).catch(() => {});
  sum();

  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    $('#l-log').innerHTML = '';
    const name = $('#l-name').value.trim(); const symbol = $('#l-sym').value.trim().replace(/^\$/, '').toUpperCase();
    if (!hubAddr) return log('The hub contract is not deployed yet.', 'err');
    if (!s.repo || !s.vault) return log('Check a repo first.', 'err');
    if (!name || !/^[A-Z0-9]{1,10}$/.test(symbol)) return log('Add a name and a ticker (letters and digits, up to 10).', 'err');
    if (s.taxBps < 0 || s.taxBps > s.maxTax) return log(`Extra tax must be between 0 and ${s.maxTax / 100}%.`, 'err');
    const buy = parseEther(String(Number($('#l-buy').value || 0)));
    const btn = $('#l-go'); btn.disabled = true;
    try {
      const account = await connect();
      if (!(await pub.readContract({ address: C.pons.factory, abi: factoryAbi, functionName: 'canLaunch', args: [account] }))) throw new Error('Pons is not open to this wallet yet.');
      log('Reading Pons launch settings…');
      const cfg = await pickConfig();
      const [econ, fee] = await Promise.all([
        pub.readContract({ address: C.pons.factory, abi: factoryAbi, functionName: 'previewLaunchEconomics', args: [cfg, ZERO] }),
        pub.readContract({ address: C.pons.factory, abi: factoryAbi, functionName: 'launchFee' }),
      ]);
      const salt = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      const p = {
        name, symbol, logo: s.logo ? `${location.origin}${s.logo}` : '', description: $('#l-desc').value.trim(),
        socials: { twitter: $('#l-x').value.trim(), telegram: $('#l-tg').value.trim(), discord: '', website: $('#l-web').value.trim() || `https://github.com/${s.repo}`, farcaster: '' },
        creatorFeeRecipient: s.vault, creatorTaxBps: s.taxBps, buybackEnabled: false, expectedEconomics: econ, salt,
      };
      log('Confirm in your wallet…');
      const { hash, receipt } = buy > 0n
        ? await write({ address: C.pons.router, abi: routerAbi, functionName: 'launchAndBuy', args: [p, cfg, ZERO, buy, 0n, account, []], value: fee + buy })
        : await write({ address: C.pons.factory, abi: factoryAbi, functionName: 'launchToken', args: [p, cfg, ZERO], value: fee });
      const out = launchedFrom(receipt);
      if (!out) throw new Error('Launched, but the token address was not in the receipt. Check the transaction.');
      if (s.logo) await post('/api/meta', { token: out.token, logo: s.logo }).catch(() => {});
      await post('/api/coins', { token: out.token, repo: s.repo, txHash: hash, launcher: account }).catch(() => {});
      log(`Live: $${esc(symbol)} pays ${esc(s.repo)}.`, 'ok');
      log(`<a href="${ponsUrl(out.token)}" target="_blank" rel="noopener">Open on Pons ↗</a> · <a href="${exp('tx', hash)}" target="_blank" rel="noopener">Transaction ↗</a> · <button class="btn btn-sm btn-ghost" type="button" data-copy="${out.token}" data-copy-label="Contract address copied">Copy CA</button>`, 'ok');
    } catch (err) { log(esc(errText(err)), 'err'); } finally { btn.disabled = false; }
  };
}

// ------------------------------------------------------------------ claim
function claim(params) {
  const pre = normRepo(params.get('repo') || '') || '';
  const s = { repo: null, meta: null, chain: null };
  app.innerHTML = `<section class="page"><div class="wrap">
    <div class="page-head"><h1>Open your vault</h1><p>If you can push to a repo's default branch, its vault pays you. It never expires.</p></div>
    ${hubAddr ? '' : noHub}
    <div class="flow"><div>
      <div class="step"><div class="step-head"><b>1</b><h2>Find the repo</h2><span class="done" id="c1" hidden>✓</span></div>
        <form class="row" id="c-form" style="flex-wrap:nowrap"><div class="prefix" style="flex:1"><span>github.com/</span><input class="input mono" id="c-repo" placeholder="owner/repo" value="${esc(pre)}" autocomplete="off" spellcheck="false" aria-label="Repo"/></div><button class="btn" type="submit">Check</button></form>
        <div id="c-info" style="margin-top:12px"></div></div>
      <div class="step"><div class="step-head"><b>2</b><h2>Connect the payout wallet</h2><span class="done" id="c2" hidden>✓</span></div><div id="c-wallet"></div></div>
      <div class="step"><div class="step-head"><b>3</b><h2>Commit the proof file</h2></div>
        <div class="file"><div class="file-tab"><span>.${KEY}</span><span id="c-branch">default branch</span></div><pre><span class="k">${KEY}</span>=<span id="c-file-w">0xYourWallet</span></pre></div>
        <div class="row" style="margin-top:12px"><button class="btn btn-ghost btn-sm" type="button" id="c-copy">Copy the line</button><a class="btn btn-ghost btn-sm" id="c-create" href="#" target="_blank" rel="noopener">Create it on GitHub</a></div>
        <p class="hint">Put it in the repo root or in <span class="mono">.github/${KEY}</span>, on the default branch. GitHub can take a minute to serve a new file.</p></div>
      <div class="step"><div class="step-head"><b>4</b><h2>Get paid</h2></div>
        <button class="btn" type="button" id="c-go" style="width:100%">Verify and claim</button><ul class="log" id="c-log"></ul></div>
    </div>
    <aside class="side"><div class="step"><div class="step-head"><h2>Vault</h2></div><dl class="kv" id="c-sum"><dt>Repo</dt><dd class="faint">–</dd></dl></div></aside></div>
  </div></section>`;
  const log = (m, c = '') => $('#c-log').insertAdjacentHTML('beforeend', `<li class="${c}">${m}</li>`);
  const line = () => `${KEY}=${W.account || '0xYourWallet'}`;
  const paint = () => {
    $('#c-wallet').innerHTML = W.account
      ? `<p class="notice ok" style="margin:0">Connected <span class="mono">${W.account}</span></p>`
      : `<button class="btn btn-ghost" type="button" id="c-conn">Connect wallet</button>`;
    $('#c2').hidden = !W.account;
    $('#c-conn')?.addEventListener('click', () => connect().catch((e) => toast(errText(e))));
    $('#c-file-w').textContent = W.account || '0xYourWallet';
    $('#c-copy').dataset.copy = line(); $('#c-copy').dataset.copyLabel = 'Line copied';
    const branch = s.meta?.defaultBranch || 'main';
    $('#c-branch').textContent = s.meta ? branch : 'default branch';
    $('#c-create').href = s.repo ? `https://github.com/${s.repo}/new/${encodeURIComponent(branch)}?filename=.${KEY}&value=${encodeURIComponent(`${line()}\n`)}` : '#';
  };
  const check = async () => {
    const n = normRepo($('#c-repo').value);
    $('#c1').hidden = true; s.repo = null;
    if (!n) { $('#c-info').innerHTML = `<div class="notice err">Use owner/repo.</div>`; return; }
    $('#c-info').innerHTML = '<p class="muted">Checking…</p>';
    try {
      s.meta = await api(`/api/repo?repo=${encodeURIComponent(n)}`);
      s.chain = await chainRepo(n);
      s.repo = n; $('#c1').hidden = false;
      const unswept = BigInt(s.meta.stats?.unswept || 0);
      $('#c-info').innerHTML = `<div class="notice"><b>${esc(s.meta.fullName)}</b> · default branch <span class="mono">${esc(s.meta.defaultBranch)}</span>${s.meta.fullName.toLowerCase() !== n.toLowerCase() ? `<br/><span class="small">GitHub redirects this name to ${esc(s.meta.fullName)}. The proof file is read from there.</span>` : ''}</div>`;
      $('#c-sum').innerHTML = s.chain ? `<dt>Repo</dt><dd>${esc(n)}</dd><dt>Address</dt><dd>${short(s.chain.vault)}</dd>
        <dt>Waiting</dt><dd class="big">${eth(s.chain.pending + unswept)}</dd><dt>Paid out</dt><dd>${eth(s.chain.paid)}</dd>
        <dt>Pays</dt><dd>${s.chain.wallet ? short(s.chain.wallet) : 'nobody yet'}</dd>` : `<dt>Hub</dt><dd>not deployed</dd>`;
    } catch (e) { $('#c-info').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
    paint();
  };
  $('#c-form').onsubmit = (e) => { e.preventDefault(); check(); };
  if (pre) check();
  paint();
  const off = onAccount(() => { if (!document.body.contains($('#c-wallet'))) return off(); paint(); });
  $('#c-go').onclick = async () => {
    $('#c-log').innerHTML = '';
    if (!hubAddr) return log('The hub contract is not deployed yet.', 'err');
    if (!s.repo) return log('Check the repo first.', 'err');
    const b = $('#c-go'); b.disabled = true;
    try {
      const wallet = await connect(); paint();
      log(`Reading .${KEY} on GitHub…`);
      const a = await post('/api/attest', { repo: s.repo, wallet });
      log(`Found ${esc(a.proofPath)} on ${esc(a.branch)} naming your wallet.`, 'ok');
      log('Confirm in your wallet…');
      const { hash } = await write({ address: hubAddr, abi: hubAbi, functionName: 'claim', args: [a.repo, a.wallet, BigInt(a.issuedAt), BigInt(a.deadline), a.signature, a.curves, a.poolIds] });
      log(`Claimed. Everything in the vault went to your wallet. <a href="${exp('tx', hash)}" target="_blank" rel="noopener">tx ↗</a>`, 'ok');
      setTimeout(check, 1500);
    } catch (e) { log(esc(errText(e)), 'err'); } finally { b.disabled = false; }
  };
}

// ------------------------------------------------------------------ docs, token
function docs() {
  app.innerHTML = `<section class="page"><div class="wrap prose">
    <div class="page-head"><h1>Docs</h1><p>Short and complete. If something here does not match the contracts, the contracts win.</p></div>
    <h2>Launching</h2>
    <p>Enter a public repo, fill in the coin, press launch. Merces calls the Pons factory (or the Pons launch-and-buy router when you add a dev buy) with <code>creatorFeeRecipient</code> set to the repo's vault and <code>buybackEnabled</code> off, so the vault can sweep its own fees. You pay the Pons launch fee and gas.</p>
    <h2>Claiming</h2>
    <ol><li>Commit <code>${KEY}=0xYourWallet</code> to <code>.${KEY}</code> or <code>.github/${KEY}</code> on the default branch.</li>
    <li>Connect that wallet on the Claim page and press <b>Verify and claim</b>.</li>
    <li>The Merces verifier reads the file through the GitHub API and signs a short-lived attestation (repo, wallet, time). The hub checks the signature, binds the wallet, deploys the vault if it does not exist yet, sweeps the coin curves, claims the Pons escrow and pays you, all in one transaction.</li></ol>
    <p>After that, anyone can press <b>Push new fees</b> on the repo page. The ETH only ever goes to the bound wallet.</p>
    <h2>Contracts</h2>
    <p><b>RepoHub</b>: ${hubAddr ? `<a href="${exp('address', hubAddr)}" target="_blank" rel="noopener" class="mono">${hubAddr}</a>` : 'not deployed yet'}. One <b>RepoVault</b> per repo at a CREATE2 address derived from the lower-cased repo name. Pons fee escrow: <span class="mono">${C.pons.escrow}</span>.</p>
    <h2>Limits and trust</h2>
    <ul>
      <li><b>The verifier key</b> is the main trust point: it decides which wallet a repo binds to. A change of verifier is public and waits 3 days on chain before it applies.</li>
      <li>The owner can pause <i>new</i> claims. A pause does not stop payouts to wallets that are already bound, and no admin function can move fees.</li>
      <li>Pons itself can reassign a launch's fee recipient after a 3-day public timelock. That is a Pons rule Merces cannot remove.</li>
      <li>After graduation, fees taken in the coin itself are converted by the Pons operator before they reach the escrow, so they may arrive later than curve fees.</li>
      <li>Repo names are matched case-insensitively. A renamed repo keeps working through GitHub's redirect; if someone later creates a new repo at the old name, they control the old name's vault.</li>
      <li><b>Not audited.</b> The contracts are tested (unit tests plus an end-to-end test against the real Pons contracts on a mainnet fork) and reviewed internally, but they have not had an external audit.</li>
    </ul>
  </div></section>`;
}

function tokenPage() {
  app.innerHTML = `<section class="page"><div class="wrap prose">
    <div class="page-head"><h1>$${C.ticker}</h1><p>The coin of Merces itself.</p></div>
    <div class="step"><dl class="kv"><dt>Ticker</dt><dd>$${C.ticker}</dd><dt>Chain</dt><dd>${C.chainName}</dd>${Number.isFinite(LAUNCH) ? `<dt>Launch</dt><dd>${launchLong()}</dd>` : ''}
      <dt>Contract</dt><dd>${token.ca ? `<a href="${exp('token', token.ca)}" target="_blank" rel="noopener">${token.ca}</a>` : 'posted here at launch'}</dd></dl>
      ${token.ca ? `<div class="row" style="margin-top:14px"><a class="btn" href="${ponsUrl(token.ca)}" target="_blank" rel="noopener">Buy on Pons</a><button class="btn btn-ghost" type="button" data-copy="${token.ca}" data-copy-label="Contract address copied">Copy CA</button></div>` : ''}
    </div>
    <p>$${C.ticker} is launched on Pons like any coin made here. Merces works the same with or without it: the launchpad, the vaults and the claims are open to everyone and do not require holding anything.</p>
    <p><b>No promise of returns.</b> Holding $${C.ticker} does not give you a share of any repo's fees or of anything else. Only trust the contract address posted on this site and on <a href="${C.x}" target="_blank" rel="noopener">our X account</a>.</p>
  </div></section>`;
}


// ------------------------------------------------------------------ verify, community, roadmap (PANDUAN §5b)
function verifyPage() {
  const hub = hubAddr ? `<a class="addr" href="${exp('address', hubAddr)}" target="_blank" rel="noopener">${hubAddr}</a>` : '<span class="muted">Deployed and verified on Blockscout before launch. This page fills in then.</span>';
  app.innerHTML = `<section class="page"><div class="prose">
    <div class="page-head"><h1 data-pour>Check it yourself</h1><p data-pour>Every claim on this site can be checked without trusting us. Here is how.</p></div>
    <h2 data-pour>1 · The contracts</h2>
    <ul>
      <li><b>RepoHub</b>: ${hub}</li>
      <li><b>Pons fee escrow</b>: <a class="addr" href="${exp('address', C.pons.escrow)}" target="_blank" rel="noopener">${C.pons.escrow}</a></li>
      <li><b>Pons launch factory</b>: <a class="addr" href="${exp('address', C.pons.factory)}" target="_blank" rel="noopener">${C.pons.factory}</a></li>
    </ul>
    <h2 data-pour>2 · Read any repo's vault from the chain</h2>
    <div class="file"><div class="file-tab"><span>terminal</span><span>Foundry cast</span></div><pre>cast call ${hubAddr || '&lt;RepoHub&gt;'} "vaultFor(string)(address)" "neovim/neovim" \\
  --rpc-url https://robinhood-rpc.publicnode.com</pre></div>
    <p>The address it returns is the one every coin for that repo pays. Compare it with the creator fee recipient of any coin on its Pons page.</p>
    <h2 data-pour>3 · Every number on this site has a public endpoint</h2>
    <ul>
      <li><a href="/api/stats" target="_blank" rel="noopener">/api/stats</a>: coins, repos, ETH waiting, ETH paid</li>
      <li><a href="/api/events" target="_blank" rel="noopener">/api/events</a>: the live ledger</li>
      <li><a href="/api/vaults" target="_blank" rel="noopener">/api/vaults</a> and <a href="/api/coins" target="_blank" rel="noopener">/api/coins</a>: every vault and coin</li>
      <li><a href="/proof.json" target="_blank" rel="noopener">/proof.json</a>: contracts, chain and test results in one file</li>
    </ul>
    <h2 data-pour>4 · How it was tested</h2>
    <p>19 unit tests cover claims, replays, bad signatures, expired and future-dated attestations, repo-name rules, pausing, the three-day verifier change, refused payouts and ERC-20 fees. One end-to-end test runs against the real Pons contracts on a fork of Robinhood Chain mainnet: it launches a coin whose fee recipient is a vault that does not exist yet, trades it, then claims, and checks that the maintainer receives exactly the creator tax plus the creator share of the Pons fee.</p>
    <h2 data-pour>What this page does not say</h2>
    <ul>
      <li>The contracts have <b>not had an external audit</b>. They had an internal review, and its findings were fixed before deploy.</li>
      <li>The verifier key decides which wallet a repo binds to. A change of verifier waits three days on chain.</li>
      <li>Pons can reassign a coin's fee recipient after its own three-day timelock. Merces cannot remove that.</li>
      <li>A coin for a repo is not an endorsement by its maintainers.</li>
      <li>Nothing here promises a return on any coin, including $${C.ticker}.</li>
    </ul>
  </div></section>`;
}

function communityPage() {
  app.innerHTML = `<section class="page"><div class="prose">
    <div class="page-head"><h1 data-pour>Community</h1><p data-pour>The only official places, and the only contract address.</p></div>
    <ul>
      <li>Website: <a href="${C.publicUrl}">${C.publicUrl.replace('https://', '')}</a></li>
      <li>X: <a href="${C.x}" target="_blank" rel="noopener">${C.x.replace('https://x.com/', '@')}</a></li>
      ${C.telegram ? `<li>Telegram: <a href="${C.telegram}" target="_blank" rel="noopener">${C.telegram.replace('https://', '')}</a></li>` : ''}
    </ul>
    <h2 data-pour>The $${C.ticker} contract address</h2>
    <div class="row" data-pour>${caChip()}</div>
    <p>It is posted here, on our X account and in our Telegram at launch, nowhere else. A different address is a copy.</p>
    <h2 data-pour>We never</h2>
    <ul>
      <li>send you a message first;</li>
      <li>ask for a seed phrase, a private key or a signature outside this site;</li>
      <li>run giveaways, airdrops or "support" chats.</li>
    </ul>
  </div></section>`;
}

function roadmapPage() {
  app.innerHTML = `<section class="page"><div class="prose">
    <div class="page-head"><h1 data-pour>Roadmap</h1><p data-pour>What runs today, and the one thing being built next. No dates.</p></div>
    <h2 data-pour>Live</h2>
    <ul>
      <li>Launch a Pons coin for any public GitHub repo, with an optional dev buy and extra creator tax.</li>
      <li>A vault per repo at an address fixed by its name, paid before it exists.</li>
      <li>Claim with a <code>.${KEY}</code> file and one transaction; anyone can push later fees to the bound wallet.</li>
      <li>The live ledger, vault lookups and public JSON endpoints.</li>
    </ul>
    <h2 data-pour>Next</h2>
    <ul><li><b>Planned:</b> move the verifier from one key to a two-of-three signer set.</li></ul>
  </div></section>`;
}


// ------------------------------------------------------------------ /live: the real-time tape (why the domain is .live)
function livePage(ctx) {
  app.innerHTML = `<section class="page live-page">
    <div class="page-head"><h1 data-pour><span class="live-dot" aria-hidden="true"></span>Live</h1>
      <p data-pour>Every buy and sell on a Merces coin, and what it paid the repo behind it. Read from Robinhood Chain every five seconds.</p></div>
    <div class="live-top" data-pour>
      <div class="live-big"><b id="lv-repos">0</b><span>ETH sent to open source in the last 24 hours</span></div>
      <div><b id="lv-trades">0</b><span>trades</span></div>
      <div><b id="lv-vol">0</b><span>ETH traded</span></div>
    </div>
    <div class="live-grid">
      <section aria-labelledby="tape-t"><h2 id="tape-t" data-pour>Tape</h2><ol class="tape" id="tape" aria-live="polite"><li class="none">Reading the chain…</li></ol></section>
      <section aria-labelledby="rec-t"><h2 id="rec-t" data-pour>Repos paid today</h2><ol class="paid" id="paid"></ol>
        <p class="hint">Creator tax lands in each repo's vault the moment a trade settles on the curve. The creator share of the Pons base fee follows when the curve is swept.</p></section>
    </div>
  </section>`;
  const n4 = (wei) => { const v = Number(formatEther(BigInt(wei || 0))); return v === 0 ? '0' : v < 0.0001 ? '<0.0001' : v.toFixed(4); };
  let alive = true, lastTop = null;
  const seen = new Set();
  ctx.add(() => () => { alive = false; });
  const paint = (d) => {
    $('#lv-repos').textContent = n4(d.day.toRepos);
    $('#lv-trades').textContent = d.day.trades;
    $('#lv-vol').textContent = n4(d.day.volume);
    vault?.level(levelOf(d.day.toRepos));
    $('#tape').innerHTML = d.trades.length
      ? d.trades.slice(0, 30).map((t) => `<li class="${t.side}${seen.size && !seen.has(t.id) ? ' new' : ''}"><time datetime="${new Date(t.at).toISOString()}">${ago(t.at)}</time>
          <span class="side">${t.side === 'buy' ? 'Buy' : 'Sell'}</span><a class="sym" href="${ponsUrl(t.token)}" target="_blank" rel="noopener">$${esc(t.symbol)}</a>
          <span class="eth">${n4(t.eth)} ETH</span><a class="to" href="#/r/${esc(t.repo)}">+${n4(t.tax)} to ${esc(t.repo)}</a></li>`).join('')
      : `<li class="none">No trades yet. The tape starts with the first buy of a Merces coin${Number.isFinite(LAUNCH) && Date.now() < LAUNCH ? `, and $${C.ticker} launches ${launchLong()}` : ''}.</li>`;
    const max = d.day.repos.reduce((m, r) => (BigInt(r.wei) > m ? BigInt(r.wei) : m), 1n);
    $('#paid').innerHTML = d.day.repos.length
      ? d.day.repos.map((r) => `<li><a href="#/r/${esc(r.repo)}"><span>${esc(r.repo)}</span><b>${n4(r.wei)} ETH</b></a><i style="--w:${Number((BigInt(r.wei) * 1000n) / max) / 10}%"></i></li>`).join('')
      : '<li class="none">No repo has been paid in the last 24 hours.</li>';
    if (lastTop && d.trades[0] && d.trades[0].id !== lastTop && vault) {
      const fresh = d.trades.findIndex((t) => t.id === lastTop);
      for (let i = 0; i < Math.min(6, fresh < 0 ? 1 : fresh); i++) gsap.delayedCall(i * 0.3, () => vault?.drop());
    }
    lastTop = d.trades[0]?.id || lastTop || '-';
    d.trades.forEach((t) => seen.add(t.id));
    if (!seen.size) seen.add('-');
  };
  const poll = async () => {
    if (!alive) return;
    const d = await api('/api/live').catch(() => null);
    if (d && alive) paint(d);
    if (alive) gsap.delayedCall(5, poll);
  };
  poll();
}

// ------------------------------------------------------------------ 404
function lost() {
  app.innerHTML = `<section class="lost">
    <h1 class="display" data-pour>Empty vault.</h1>
    <p data-pour>Nothing lives at this address. Every repo has a vault, but this page is not one of them.</p>
    <div class="row" data-pour><a class="pill" href="#/"><span data-roll>Back to Merces</span></a><a class="pill pill-ghost" href="#/explore"><span data-roll>Explore vaults</span></a></div>
  </section>`;
}

// ------------------------------------------------------------------ reveals + router with a pour transition
function reveal(root = app) {
  const els = [...root.querySelectorAll('[data-pour]:not(.in)')];
  if (reduce) { els.forEach((e) => e.classList.add('in')); return; }
  // Whatever is already on screen pours in now: a batch only evaluates after the first scroll,
  // and a visitor who never scrolls must still see the hero.
  const vh = innerHeight;
  const now = els.filter((e) => e.getBoundingClientRect().top < vh * 0.96);
  now.forEach((e, i) => gsap.delayedCall(0.08 + i * 0.06, () => e.classList.add('in')));
  gsap.delayedCall(0.2, () => ScrollTrigger.refresh());
  ScrollTrigger.batch(els.filter((e) => !now.includes(e)), {
    start: 'top 94%', once: true,
    onEnter: (batch) => batch.forEach((e, i) => gsap.delayedCall(i * 0.05, () => e.classList.add('in'))),
  });
}

const TITLES = {
  '': 'Merces · Payday for open source', explore: 'Explore vaults · Merces', launch: 'Launch a coin for a repo · Merces',
  claim: 'Claim your repo’s vault · Merces', docs: 'Docs · Merces', token: `$${C.ticker} · Merces`,
};
let ctx = null;
let first = true;
function render() {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = h.split('?');
  const params = new URLSearchParams(q);
  const seg = p.split('/')[0];
  ctx?.revert();
  ctx = gsap.context(() => {});
  document.documentElement.classList.remove('gl-dim');
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === seg && p !== '';
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const known = ['', 'home', 'explore', 'launch', 'claim', 'docs', 'token', 'verify', 'community', 'roadmap', 'live'].includes(seg) || seg === 'r';
  document.documentElement.classList.toggle('inner', !(p === '' || p === 'home' || p === 'live'));
  document.title = seg === 'r' ? `${decodeURIComponent(p.slice(2))} vault · Merces` : TITLES[seg] || (known ? TITLES[''] : 'Empty vault · Merces');
  if (p === '' || p === 'home') home(ctx);
  else if (p === 'explore') explore();
  else if (p === 'launch') launch(params);
  else if (p === 'claim') claim(params);
  else if (p === 'docs') docs();
  else if (p === 'token') tokenPage();
  else if (p === 'verify') verifyPage();
  else if (p === 'live') livePage(ctx);
  else if (p === 'community') communityPage();
  else if (p === 'roadmap') roadmapPage();
  else if (p.startsWith('r/')) repoPage(decodeURIComponent(p.slice(2)));
  else lost();
  if (vault && !(p === '' || p === 'home')) vault.pose(p === 'live' ? 'stage' : 'aside');
  if (lenis) lenis.scrollTo(0, { immediate: true }); else window.scrollTo(0, 0);
  ScrollTrigger.refresh();
  reveal();
}
function route() {
  if (first || reduce) { first = false; render(); return; }
  app.classList.add('leaving');
  gsap.delayedCall(0.36, () => {
    render();
    gsap.delayedCall(0.02, () => app.classList.remove('leaving'));
    app.focus({ preventScroll: true });
  });
}
window.addEventListener('hashchange', route);
api('/api/token').then((t) => { token = t; header(); }).catch(() => {});
header();
route();
pollEvents();
