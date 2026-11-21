// Merces server: GitHub verifier (signs claim attestations), coin registry, stats, RPC proxy.
// Zero framework: node:http + viem. Config comes from env (see deploy/server.env.example).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, http as httpTransport, getAddress, isAddress, keccak256, encodeAbiParameters,
  parseAbi, parseAbiItem,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startTelegram } from './telegram.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 8791);
const CHAIN_ID = Number(env.CHAIN_ID || 4663);
const RPC_URL = env.RPC_URL || 'https://robinhood-rpc.publicnode.com';
const STATE = path.resolve(env.STATE_DIR || path.join(here, '../../state'));
const WEB_DIST = env.WEB_DIST ? path.resolve(env.WEB_DIST) : null;
const HUB = env.HUB && isAddress(env.HUB) ? getAddress(env.HUB) : null;
const FACTORY = getAddress(env.FACTORY || '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e');
const HOOK = getAddress(env.HOOK || '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044');
const ESCROW = getAddress(env.ESCROW || '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e');
const START_BLOCK = BigInt(env.START_BLOCK || 0);
const PROOF_KEY = env.PROOF_KEY || 'merces';
const GH_TOKEN = env.GITHUB_TOKEN || '';

fs.mkdirSync(path.join(STATE, 'i'), { recursive: true });

function loadKey() {
  const raw = env.VERIFIER_KEY || (env.VERIFIER_KEY_FILE && fs.existsSync(env.VERIFIER_KEY_FILE)
    ? fs.readFileSync(env.VERIFIER_KEY_FILE, 'utf8').trim() : '');
  if (!raw) return null;
  return privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`);
}
const signer = loadKey();

const chain = {
  id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const client = createPublicClient({ chain, transport: httpTransport(RPC_URL, { batch: true, retryCount: 2 }) });

const hubAbi = parseAbi([
  'function vaultFor(string repo) view returns (address)',
  'function keyOf(string repo) pure returns (bytes32)',
  'function pendingOf(bytes32 key) view returns (uint256)',
  'function walletOf(bytes32 key) view returns (address)',
  'function boundAt(bytes32 key) view returns (uint64)',
  'function paidOf(bytes32 key) view returns (uint256)',
  'function totalPaid() view returns (uint256)',
  'function reposClaimed() view returns (uint256)',
]);
const factoryAbi = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  'function getLaunchFeePolicy(address token) view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps))',
]);
// Pons V2 bonding-curve trades (checked on a mainnet fork): buyer/seller and recipient indexed; tax = creator tax to the vault.
const curveBuyEvent = parseAbiItem('event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)');
const curveSellEvent = parseAbiItem('event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)');
const paidEvent = parseAbiItem('event Paid(bytes32 indexed key,address indexed wallet,uint256 amount)');
const launchedEvent = parseAbiItem('event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)');
const curveAbi = parseAbi([
  'function creatorTaxBalance() view returns (uint256)',
  'function quoteFeeBalance() view returns (uint256)',
  'function quoteReserve() view returns (uint256)',
]);
const erc20Abi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)']);

// ------------------------------------------------------------------ state
const COINS_FILE = path.join(STATE, 'coins.json');
const TOKEN_FILE = path.join(STATE, 'token.json');
let coins = readJson(COINS_FILE, []);
// Live feed: real things that happened (a coin launched, fees landed in a vault, a vault paid out). Newest first.
const EVENTS_FILE = path.join(STATE, 'events.json');
let events = readJson(EVENTS_FILE, []);
const lastWaiting = new Map();
// Live tape: every real buy and sell on a Merces coin's curve, newest first.
const TRADES_FILE = path.join(STATE, 'trades.json');
let trades = readJson(TRADES_FILE, []);
let tradeFrom = 0n;
let tradeChunk = 2000n;
const blockTimes = new Map();
async function blockTime(n) {
  if (blockTimes.has(n)) return blockTimes.get(n);
  const b = await client.getBlock({ blockNumber: n }).catch(() => null);
  const t = b ? Number(b.timestamp) * 1000 : Date.now();
  blockTimes.set(n, t);
  if (blockTimes.size > 500) blockTimes.delete(blockTimes.keys().next().value);
  return t;
}
async function liveScan() {
  if (!coins.length) return;
  const head = await client.getBlockNumber();
  // No Merces coin can trade before the hub existed: start at its deploy block (START_BLOCK), at most ~4000 blocks back.
  if (tradeFrom === 0n) { const back = head > 4000n ? head - 4000n : 0n; tradeFrom = START_BLOCK > back ? START_BLOCK : back; }
  const byCurve = new Map(coins.map((c) => [c.curve.toLowerCase(), c]));
  while (tradeFrom <= head) {
    const to = tradeFrom + tradeChunk - 1n < head ? tradeFrom + tradeChunk - 1n : head;
    let logs;
    try {
      logs = await client.getLogs({ address: coins.map((c) => c.curve), events: [curveBuyEvent, curveSellEvent], fromBlock: tradeFrom, toBlock: to });
    } catch (e) {
      if (tradeChunk > 50n) { tradeChunk /= 2n; return; }
      throw e;
    }
    if (tradeChunk < 2000n) tradeChunk *= 2n;
    for (const l of logs) {
      const id = `${l.transactionHash}:${l.logIndex}`;
      if (trades.some((t) => t.id === id)) continue;
      const c = byCurve.get(l.address.toLowerCase());
      if (!c) continue;
      const buy = l.eventName === 'CurveBuy';
      trades.unshift({
        id, at: await blockTime(l.blockNumber), side: buy ? 'buy' : 'sell', symbol: c.symbol, token: c.token, repo: c.repo,
        eth: String(buy ? l.args.quoteIn : l.args.quoteOut), tax: String(l.args.tax), fee: String(l.args.fee), tx: l.transactionHash,
      });
    }
    tradeFrom = to + 1n;
  }
  trades.sort((a, b) => b.at - a.at);
  trades = trades.slice(0, 400);
  writeJson(TRADES_FILE, trades);
}
function liveSummary() {
  const day = Date.now() - 864e5;
  const recent = trades.filter((t) => t.at >= day);
  let vol = 0n, tax = 0n;
  const perRepo = new Map();
  for (const t of recent) {
    vol += BigInt(t.eth); tax += BigInt(t.tax);
    perRepo.set(t.repo, (perRepo.get(t.repo) || 0n) + BigInt(t.tax));
  }
  return {
    trades: trades.slice(0, 60),
    day: {
      trades: recent.length, buys: recent.filter((t) => t.side === 'buy').length, volume: String(vol), toRepos: String(tax),
      repos: [...perRepo.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 8).map(([repo, wei]) => ({ repo, wei: String(wei) })),
    },
    updatedAt: Date.now(),
  };
}
async function liveLoop() {
  try { await liveScan(); } catch (e) { console.error('live', e.shortMessage || e.message); }
  setTimeout(liveLoop, 5000);
} // key -> last observed waiting wei, to detect new fees
function pushEvent(e) {
  if (e.id && events.some((x) => x.id === e.id)) return;
  events.unshift({ at: Date.now(), ...e });
  events = events.slice(0, 200);
  writeJson(EVENTS_FILE, events);
}
// What the verifier last signed per repo key: the GitHub repo id it belonged to and the commit it read.
const BINDINGS_FILE = path.join(STATE, 'bindings.json');
const bindings = readJson(BINDINGS_FILE, {});
let scanChunk = 2_000n;
let scanFrom = BigInt(readJson(path.join(STATE, 'scan.json'), { from: String(START_BLOCK) }).from);
const repoStats = new Map(); // key -> { pending, unswept, wallet, paid }
let stats = { coins: 0, repos: 0, waiting: '0', paid: '0', claimed: 0, updatedAt: 0 };

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJson(f, v) { const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); }

// ------------------------------------------------------------------ repo names
// Mirrors RepoHub._normalize: owner 1-39 [A-Za-z0-9-] not starting/ending "-", one slash,
// name 1-100 [A-Za-z0-9._-], not "." / "..", not ending ".git" (a trailing .git in a pasted URL is dropped first).
function normRepo(input) {
  const s = String(input || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = s.match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
  if (!m) return null;
  const [, owner, name] = m;
  if (owner.startsWith('-') || owner.endsWith('-')) return null;
  if (name === '.' || name === '..' || /\.git$/i.test(name)) return null;
  return s;
}
const repoKey = (repo) => keccak256(new TextEncoder().encode(repo.toLowerCase()));

// ------------------------------------------------------------------ GitHub
const ghCache = new Map();
async function gh(pathname, { ttl = 600_000 } = {}) {
  const hit = ghCache.get(pathname);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const r = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      accept: 'application/vnd.github+json', 'user-agent': 'merces-verifier',
      ...(GH_TOKEN ? { authorization: `Bearer ${GH_TOKEN}` } : {}),
    },
  });
  if (r.status === 404) { ghCache.set(pathname, { t: Date.now(), v: null }); return null; }
  if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? 'GitHub rate limit, try again in a minute' : `GitHub ${r.status}`);
  const v = await r.json();
  ghCache.set(pathname, { t: Date.now(), v });
  return v;
}
async function repoInfo(repo, fresh = false) {
  const j = await gh(`/repos/${repo}`, { ttl: fresh ? 0 : 600_000 });
  if (!j) return null;
  return {
    id: j.id, fullName: j.full_name, description: j.description || '', stars: j.stargazers_count, private: j.private,
    defaultBranch: j.default_branch, avatar: j.owner?.avatar_url || '', archived: j.archived, fork: j.fork,
  };
}
// Head commit of the default branch, uncached: the proof is read at this exact commit.
async function headCommit(fullName, branch) {
  const j = await gh(`/repos/${fullName}/commits/${encodeURIComponent(branch)}`, { ttl: 0 });
  if (!j?.sha) throw new Error('Could not read the default branch');
  return { sha: j.sha, date: Date.parse(j.commit?.committer?.date || 0) || 0 };
}
// Reads the proof file at a commit (no cache). Root `.merces` or `.github/merces`. Line: merces=0x...
async function readProof(fullName, ref) {
  for (const p of [`.${PROOF_KEY}`, `.github/${PROOF_KEY}`]) {
    const j = await gh(`/repos/${fullName}/contents/${p}?ref=${encodeURIComponent(ref)}`, { ttl: 0 });
    if (!j || j.type !== 'file' || !j.content) continue;
    const text = Buffer.from(j.content, 'base64').toString('utf8');
    const m = text.match(new RegExp(`^\\s*${PROOF_KEY}\\s*=\\s*(0x[0-9a-fA-F]{40})\\s*$`, 'm'));
    return { path: p, wallet: m ? getAddress(m[1]) : null };
  }
  return null;
}

// ------------------------------------------------------------------ chain reads
const poolIdOf = (token, poolFee, tickSpacing) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  ['0x0000000000000000000000000000000000000000', token, poolFee, tickSpacing, HOOK],
));

// Only the curves and pools that can hold fees, capped: every sweep needs ~0.6-0.9M gas, so a repo spammed with
// empty coins must not push a claim past the block gas limit. Unknown balances (not refreshed yet) count as worth sweeping.
const MAX_CURVES = 12, MAX_POOLS = 8;
function sweepTargets(key) {
  const list = coins.filter((c) => c.key === key);
  const curves = list.filter((c) => !c.phase && (c.unswept === undefined || BigInt(c.unswept) > 0n))
    .sort((a, b) => (BigInt(b.unswept || 1) > BigInt(a.unswept || 1) ? 1 : -1)).slice(0, MAX_CURVES).map((c) => c.curve);
  const poolIds = list.filter((c) => c.phase > 0).slice(0, MAX_POOLS).map((c) => c.poolId);
  return { curves, poolIds };
}

async function launchInfo(token) {
  const t = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'getLaunchedToken', args: [token] });
  return t.exists ? t : null;
}

async function vaultFor(repo) {
  return client.readContract({ address: HUB, abi: hubAbi, functionName: 'vaultFor', args: [repo] });
}

async function addCoin({ token, repo, txHash, launcher }) {
  token = getAddress(token);
  const known = coins.find((c) => c.token === token);
  if (known) {
    if (known.key !== repoKey(repo)) throw new Error('This coin does not pay that repo');
    return known;
  }
  const info = await launchInfo(token);
  if (!info) throw new Error('Not a Pons launch');
  const vault = await vaultFor(repo);
  if (getAddress(info.creatorFeeRecipient) !== getAddress(vault)) throw new Error('This coin does not pay that repo');
  const [name, symbol] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }).catch(() => ''),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => ''),
  ]);
  const meta = readJson(path.join(STATE, 'meta', `${token}.json`), {});
  const coin = {
    token, curve: getAddress(info.curve), repo, key: repoKey(repo), vault: getAddress(vault), name, symbol,
    logo: meta.logo || '', taxBps: Number(info.creatorTaxBps), poolId: poolIdOf(token, info.poolFee, info.tickSpacing),
    launcher: launcher && isAddress(launcher) ? getAddress(launcher) : getAddress(info.deployer),
    txHash: txHash || null, createdAt: Date.now(),
  };
  coins.unshift(coin);
  writeJson(COINS_FILE, coins);
  pushEvent({ id: `launch:${token}`, type: 'launch', repo, symbol, token, tx: coin.txHash });
  return coin;
}

// Picks up coins launched for an already-known repo without going through our launch page.
async function scan() {
  if (!HUB || !coins.length) return;
  const head = await client.getBlockNumber();
  if (scanFrom === 0n) scanFrom = head - 20_000n;
  const byVault = new Map(coins.map((c) => [c.vault, c.repo]));
  while (scanFrom < head) {
    const to = scanFrom + scanChunk - 1n < head ? scanFrom + scanChunk - 1n : head;
    let logs;
    try {
      logs = await client.getLogs({ address: FACTORY, event: launchedEvent, fromBlock: scanFrom, toBlock: to });
    } catch (e) {
      // RPCs cap getLogs ranges differently: halve the window and retry on the next loop.
      if (scanChunk > 50n) { scanChunk /= 2n; return; }
      throw e;
    }
    const paid = await client.getLogs({ address: HUB, event: paidEvent, fromBlock: scanFrom, toBlock: to }).catch(() => []);
    for (const l of paid) {
      const c = coins.find((x) => x.key === l.args.key);
      pushEvent({ id: `paid:${l.transactionHash}:${l.logIndex}`, type: 'paid', repo: c ? c.repo : null, amount: String(l.args.amount), tx: l.transactionHash });
    }
    for (const l of logs) {
      const token = getAddress(l.args.token);
      if (coins.some((c) => c.token === token)) continue;
      const info = await launchInfo(token).catch(() => null);
      const repo = info && byVault.get(getAddress(info.creatorFeeRecipient));
      if (repo) await addCoin({ token, repo, txHash: l.transactionHash }).catch(() => {});
    }
    scanFrom = to + 1n;
    if (scanChunk < 5_000n) scanChunk *= 2n;
    writeJson(path.join(STATE, 'scan.json'), { from: String(scanFrom) });
  }
}

async function refresh() {
  if (!HUB) return;
  const keys = [...new Set(coins.map((c) => c.key))];
  let waiting = 0n;
  for (const key of keys) {
    const repoCoins = coins.filter((c) => c.key === key);
    const [pending, wallet, paid] = await Promise.all([
      client.readContract({ address: HUB, abi: hubAbi, functionName: 'pendingOf', args: [key] }),
      client.readContract({ address: HUB, abi: hubAbi, functionName: 'walletOf', args: [key] }),
      client.readContract({ address: HUB, abi: hubAbi, functionName: 'paidOf', args: [key] }),
    ]);
    let unswept = 0n;
    for (const c of repoCoins) {
      const [tax, fee, policy, info] = await Promise.all([
        client.readContract({ address: c.curve, abi: curveAbi, functionName: 'creatorTaxBalance' }).catch(() => 0n),
        client.readContract({ address: c.curve, abi: curveAbi, functionName: 'quoteFeeBalance' }).catch(() => 0n),
        client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'getLaunchFeePolicy', args: [c.token] }).catch(() => null),
        launchInfo(c.token).catch(() => null),
      ]);
      if (info) c.phase = Number(info.phase);
      const share = policy ? BigInt(policy.protocolFeeShareBps) : 3000n;
      c.unswept = String(tax + (fee * (10_000n - share)) / 10_000n);
      unswept += BigInt(c.unswept);
    }
    const s = { pending: String(pending), unswept: String(unswept), wallet: /^0x0+$/.test(wallet) ? null : wallet, paid: String(paid) };
    repoStats.set(key, s);
    const now = pending + unswept;
    const before = lastWaiting.get(key);
    if (before !== undefined && now > before) {
      pushEvent({ type: 'fees', repo: repoCoins[0].repo, amount: String(now - before) });
    }
    lastWaiting.set(key, now);
    waiting += now;
  }
  const [totalPaid, claimed] = await Promise.all([
    client.readContract({ address: HUB, abi: hubAbi, functionName: 'totalPaid' }),
    client.readContract({ address: HUB, abi: hubAbi, functionName: 'reposClaimed' }),
  ]);
  stats = { coins: coins.length, repos: keys.length, waiting: String(waiting), paid: String(totalPaid), claimed: Number(claimed), updatedAt: Date.now() };
}

async function loop() {
  try { await scan(); } catch (e) { console.error('scan', e.shortMessage || e.message); }
  try { await refresh(); } catch (e) { console.error('refresh', e.shortMessage || e.message); }
  setTimeout(loop, 30_000);
}

// ------------------------------------------------------------------ http helpers
const hits = new Map();
function limited(req, bucket, max, windowMs) {
  const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress);
  const k = `${bucket}:${ip}`;
  const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(k, arr);
  return arr.length > max;
}
function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': isBuf ? 'application/octet-stream' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}
function readBody(req, max = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const publicCoin = (c) => ({ ...c, stats: repoStats.get(c.key) || null });

const RPC_ALLOWED = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getBalance', 'eth_getCode', 'eth_estimateGas', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_getTransactionCount', 'net_version',
]);

const IMG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// ------------------------------------------------------------------ routes
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/health') return send(res, 200, { ok: true, hub: HUB, signer: signer?.address || null, coins: coins.length });
  if (p === '/api/token') return send(res, 200, readJson(TOKEN_FILE, { ca: null }));
  if (p === '/api/stats') return send(res, 200, stats);
  if (p === '/api/events') return send(res, 200, events.slice(0, 40));
  if (p === '/api/live') return send(res, 200, liveSummary());

  if (p === '/api/coins' && req.method === 'GET') {
    const repo = url.searchParams.get('repo');
    const list = repo ? coins.filter((c) => c.key === repoKey(repo)) : coins;
    return send(res, 200, list.slice(0, 200).map(publicCoin));
  }

  if (p === '/api/vaults') {
    const byKey = new Map();
    for (const c of coins) {
      const v = byKey.get(c.key) || { repo: c.repo, key: c.key, vault: c.vault, coins: 0, stats: repoStats.get(c.key) || null };
      v.coins += 1; byKey.set(c.key, v);
    }
    const list = [...byKey.values()].sort((a, b) => {
      const w = (x) => BigInt(x.stats?.pending || 0) + BigInt(x.stats?.unswept || 0);
      return w(b) > w(a) ? 1 : w(b) < w(a) ? -1 : 0;
    });
    return send(res, 200, list.slice(0, 50));
  }

  if (p === '/api/repo') {
    const repo = normRepo(url.searchParams.get('repo'));
    if (!repo) return send(res, 400, { error: 'Use owner/repo' });
    if (limited(req, 'repo', 40, 60_000)) return send(res, 429, { error: 'Slow down a little' });
    const info = await repoInfo(repo);
    if (!info) return send(res, 404, { error: 'Repo not found on GitHub' });
    if (info.private) return send(res, 400, { error: 'Private repos are not supported' });
    const key = repoKey(repo);
    const list = coins.filter((c) => c.key === key);
    let vault = null;
    if (HUB) {
      // The vault as the chain sees it right now (used by the site lookup and the Telegram bot).
      const [address, pending, paid, wallet] = await Promise.all([
        client.readContract({ address: HUB, abi: hubAbi, functionName: 'vaultFor', args: [repo] }),
        client.readContract({ address: HUB, abi: hubAbi, functionName: 'pendingOf', args: [key] }),
        client.readContract({ address: HUB, abi: hubAbi, functionName: 'paidOf', args: [key] }),
        client.readContract({ address: HUB, abi: hubAbi, functionName: 'walletOf', args: [key] }),
      ]).catch(() => [null, 0n, 0n, null]);
      vault = address ? { address, pending: String(pending), paid: String(paid), claimed: !!wallet && !/^0x0+$/.test(wallet) } : null;
    }
    return send(res, 200, { ...info, repo, key, vault, coins: list.map((c) => ({ token: c.token, curve: c.curve, poolId: c.poolId, symbol: c.symbol })), sweep: sweepTargets(key), stats: repoStats.get(key) || null });
  }

  if (p === '/api/attest' && req.method === 'POST') {
    if (!signer || !HUB) return send(res, 503, { error: 'Verifier is not configured' });
    if (limited(req, 'attest', 8, 60_000)) return send(res, 429, { error: 'Too many tries, wait a minute' });
    const body = JSON.parse((await readBody(req, 4096)).toString() || '{}');
    const repo = normRepo(body.repo);
    if (!repo || !isAddress(body.wallet || '')) return send(res, 400, { error: 'Need repo and wallet' });
    const wallet = getAddress(body.wallet);
    const info = await repoInfo(repo, true);
    if (!info) return send(res, 404, { error: 'Repo not found on GitHub' });
    if (info.private) return send(res, 400, { error: 'Private repos are not supported' });
    const key = repoKey(repo);
    const prev = bindings[key];
    // A renamed or transferred repo keeps working through GitHub's redirect, but the name stays pinned to the
    // GitHub repo id it was first claimed with: a new repo created later under a freed name cannot take it.
    if (prev && prev.repoId !== info.id) {
      return send(res, 409, { error: 'This name now points to a different GitHub repo than the one that first claimed it. Contact us to review.' });
    }
    const head = await headCommit(info.fullName, info.defaultBranch);
    if (prev && head.date < prev.commitDate) return send(res, 409, { error: 'GitHub served an older commit than the last claim. Try again in a minute.' });
    const proof = await readProof(info.fullName, head.sha);
    if (!proof) return send(res, 404, { error: `No .${PROOF_KEY} file on ${info.defaultBranch} yet. GitHub can take a minute to serve a new file.` });
    if (!proof.wallet) return send(res, 422, { error: `Found ${proof.path}, but no line like ${PROOF_KEY}=0x… in it` });
    if (proof.wallet !== wallet) return send(res, 403, { error: `${proof.path} names ${proof.wallet}, not your connected wallet` });
    const issuedAt = Math.floor(Date.now() / 1000);
    const deadline = issuedAt + 15 * 60;
    const signature = await signer.signTypedData({
      domain: { name: 'RepoHub', version: '1', chainId: CHAIN_ID, verifyingContract: HUB },
      types: { Claim: [{ name: 'key', type: 'bytes32' }, { name: 'wallet', type: 'address' }, { name: 'issuedAt', type: 'uint64' }, { name: 'deadline', type: 'uint64' }] },
      primaryType: 'Claim',
      message: { key, wallet, issuedAt: BigInt(issuedAt), deadline: BigInt(deadline) },
    });
    bindings[key] = { repoId: info.id, wallet, sha: head.sha, commitDate: head.date, issuedAt };
    writeJson(BINDINGS_FILE, bindings);
    const { curves, poolIds } = sweepTargets(key);
    return send(res, 200, {
      repo, resolvedTo: info.fullName, wallet, issuedAt, deadline, signature, proofPath: proof.path, branch: info.defaultBranch,
      curves, poolIds,
    });
  }

  if (p === '/api/coins' && req.method === 'POST') {
    if (!HUB) return send(res, 503, { error: 'Hub not configured' });
    if (limited(req, 'coin', 20, 60_000)) return send(res, 429, { error: 'Slow down a little' });
    const body = JSON.parse((await readBody(req, 4096)).toString() || '{}');
    const repo = normRepo(body.repo);
    if (!repo || !isAddress(body.token || '')) return send(res, 400, { error: 'Need token and repo' });
    try {
      const coin = await addCoin({ token: body.token, repo, txHash: body.txHash, launcher: body.launcher });
      refresh().catch(() => {});
      return send(res, 200, publicCoin(coin));
    } catch (e) { return send(res, 400, { error: e.shortMessage || e.message }); }
  }

  // Logo upload: stored by content hash, served from /i/<hash>.<ext>, referenced by the Pons logo field.
  if (p === '/api/image' && req.method === 'POST') {
    if (limited(req, 'img', 10, 60_000)) return send(res, 429, { error: 'Slow down a little' });
    const type = String(req.headers['content-type'] || '').split(';')[0];
    const ext = IMG_TYPES[type];
    if (!ext) return send(res, 415, { error: 'PNG, JPG, WEBP or GIF' });
    const buf = await readBody(req, 350 * 1024).catch(() => null);
    if (!buf) return send(res, 413, { error: 'Up to 350 KB' });
    const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`;
    fs.writeFileSync(path.join(STATE, 'i', name), buf);
    return send(res, 200, { path: `/i/${name}` });
  }
  if (p === '/api/meta' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 4096)).toString() || '{}');
    if (!isAddress(body.token || '') || !/^\/i\/[0-9a-f]{32}\.(png|jpg|webp|gif)$/.test(body.logo || '')) return send(res, 400, { error: 'bad meta' });
    fs.mkdirSync(path.join(STATE, 'meta'), { recursive: true });
    writeJson(path.join(STATE, 'meta', `${getAddress(body.token)}.json`), { logo: body.logo });
    const c = coins.find((x) => x.token === getAddress(body.token));
    if (c && !c.logo) { c.logo = body.logo; writeJson(COINS_FILE, coins); }
    return send(res, 200, { ok: true });
  }
  if (p.startsWith('/i/')) {
    const name = path.basename(p);
    const f = path.join(STATE, 'i', name);
    if (!/^[0-9a-f]{32}\.(png|jpg|webp|gif)$/.test(name) || !fs.existsSync(f)) return send(res, 404, { error: 'not found' });
    const ext = name.split('.').pop();
    return send(res, 200, fs.readFileSync(f), { 'content-type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'cache-control': 'public, max-age=31536000, immutable' });
  }

  if (p === '/api/rpc' && req.method === 'POST') {
    if (limited(req, 'rpc', 600, 60_000)) return send(res, 429, { error: 'rate limited' });
    const body = JSON.parse((await readBody(req, 256 * 1024)).toString() || 'null');
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.length > 50 || calls.some((c) => !c || !RPC_ALLOWED.has(c.method))) return send(res, 400, { error: 'method not allowed' });
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return send(res, r.status, Buffer.from(await r.arrayBuffer()), { 'content-type': 'application/json' });
  }

  // Local dev convenience: serve the built site (nginx does this in production).
  if (WEB_DIST && req.method === 'GET') {
    const f = path.join(WEB_DIST, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (f.startsWith(WEB_DIST) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml', woff2: 'font/woff2', ico: 'image/x-icon', json: 'application/json' };
      return send(res, 200, fs.readFileSync(f), { 'content-type': types[f.split('.').pop()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    }
    // SPA fallback like nginx try_files: unknown paths get the app shell (its 404 view has an <h1> and a way back).
    if (!p.startsWith('/api/') && !path.extname(p)) {
      return send(res, 404, fs.readFileSync(path.join(WEB_DIST, 'index.html')), { 'content-type': 'text/html' });
    }
  }
  return send(res, 404, { error: 'not found' });
}

http.createServer((req, res) => {
  route(req, res).catch((e) => { console.error(req.url, e); if (!res.headersSent) send(res, 500, { error: e.shortMessage || e.message || 'error' }); });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`merces server :${PORT} hub=${HUB} signer=${signer?.address || 'none'} rpc=${RPC_URL}`);
  loop();
  liveLoop();
  if (env.TELEGRAM_BOT_TOKEN) {
    startTelegram({
      token: env.TELEGRAM_BOT_TOKEN, groupId: env.TELEGRAM_GROUP_ID || '', api: `http://127.0.0.1:${PORT}`,
      stateDir: STATE, site: env.PUBLIC_URL || 'https://merces.live', hub: HUB, explorer: 'https://robinhoodchain.blockscout.com',
      welcome: env.TELEGRAM_WELCOME === 'on', launchUtc: env.LAUNCH_UTC || '2026-11-21T15:00:00Z',
    });
  }
});
