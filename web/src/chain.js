// Chain access: reads go through our /api/rpc proxy, writes through the visitor's injected wallet (EIP-6963).
import {
  createPublicClient, createWalletClient, custom, http, parseAbi, getAddress, isAddress, decodeEventLog,
  formatEther, parseEther, toHex,
} from 'viem';

export const C = window.MERCES;
export const chain = {
  id: C.chainId, name: C.chainName, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [`${location.origin}/api/rpc`] } },
  blockExplorers: { default: { name: 'Explorer', url: C.explorer } },
};
export const pub = createPublicClient({ chain, transport: http(`${location.origin}/api/rpc`, { batch: { wait: 16 } }) });
export const hubAddr = C.hub && isAddress(C.hub) ? getAddress(C.hub) : null;

export const hubAbi = parseAbi([
  'function vaultFor(string repo) view returns (address)',
  'function keyOf(string repo) pure returns (bytes32)',
  'function pendingOf(bytes32 key) view returns (uint256)',
  'function walletOf(bytes32 key) view returns (address)',
  'function paidOf(bytes32 key) view returns (uint256)',
  'function boundAt(bytes32 key) view returns (uint64)',
  'function claim(string repo,address wallet,uint64 issuedAt,uint64 deadline,bytes signature,address[] curves,bytes32[] poolIds) returns (uint256)',
  'function collect(string repo,address[] curves,bytes32[] poolIds) returns (uint256)',
  'error BadRepo()', 'error IsPaused()', 'error Expired()', 'error StaleAttestation()', 'error BadSignature()',
  'error NotClaimed()', 'error ZeroAddress()', 'error PayoutFailed()',
]);
const params = '(string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt)';
const ponsErrors = ['SlippageExceeded', 'CurveGraduated', 'LaunchEconomicsMismatch', 'PairTokenNotApproved', 'NativeValueMismatch',
  'UnexpectedNativeValue', 'LaunchFeeNotPaid', 'CreatorTaxTooHigh', 'NotWhitelisted', 'LaunchConfigDisabled'].map((e) => `error ${e}()`);
export const factoryAbi = parseAbi([
  `function launchToken(${params} params,uint256 launchConfigId,address pairToken) payable returns (address token,address curve)`,
  'function launchFee() view returns (uint256)',
  'function canLaunch(address account) view returns (bool)',
  'function launchConfigCount() view returns (uint256)',
  'function getLaunchConfig(uint256 id) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)',
  'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)',
  ...ponsErrors,
]);
export const routerAbi = parseAbi([
  `function launchAndBuy(${params} params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns (address token,address curve,uint256 tokensOut)`,
  ...ponsErrors,
]);

// ------------------------------------------------------------------ wallet
export const W = { account: null, provider: null, wallets: [], listeners: new Set() };
window.addEventListener('eip6963:announceProvider', (e) => {
  if (!W.wallets.some((w) => w.info.uuid === e.detail.info.uuid)) W.wallets.push(e.detail);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
const emit = () => W.listeners.forEach((f) => f(W.account));
export const onAccount = (f) => { W.listeners.add(f); return () => W.listeners.delete(f); };

export async function connect() {
  if (W.account) return W.account;
  const provider = W.wallets[0]?.provider || window.ethereum;
  if (!provider) throw new Error('No wallet found. Install a browser wallet such as MetaMask or Rabby.');
  const [a] = await provider.request({ method: 'eth_requestAccounts' });
  W.provider = provider;
  W.account = getAddress(a);
  provider.on?.('accountsChanged', (accs) => { W.account = accs[0] ? getAddress(accs[0]) : null; emit(); });
  emit();
  return W.account;
}

async function ensureChain() {
  const id = Number(await W.provider.request({ method: 'eth_chainId' }));
  if (id === C.chainId) return;
  try {
    await W.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(C.chainId) }] });
  } catch (e) {
    if (e.code !== 4902) throw e;
    await W.provider.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: toHex(C.chainId), chainName: C.chainName, nativeCurrency: chain.nativeCurrency,
        rpcUrls: ['https://robinhood-rpc.publicnode.com'], blockExplorerUrls: [C.explorer] }],
    });
  }
}

/// Simulates first (so reverts show a readable reason), then asks the wallet to sign.
export async function write(req) {
  await connect();
  await ensureChain();
  const wallet = createWalletClient({ chain, transport: custom(W.provider), account: W.account });
  const { request } = await pub.simulateContract({ ...req, account: W.account });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error('Transaction reverted');
  return { hash, receipt };
}

export function launchedFrom(receipt) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== C.pons.factory.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'TokenLaunched') return { token: getAddress(ev.args.token), curve: getAddress(ev.args.curve) };
    } catch { /* other event */ }
  }
  return null;
}

export function errText(e) {
  const n = e?.walk?.((x) => x?.data?.errorName)?.data?.errorName;
  const map = {
    BadSignature: 'The verifier signature does not match. Try again.', StaleAttestation: 'A newer claim already exists for this repo.',
    Expired: 'The signature expired. Press the button again.', IsPaused: 'New claims are paused right now.',
    NotClaimed: 'Nobody has claimed this repo yet.', PayoutFailed: 'Your wallet refused the ETH.',
    NotWhitelisted: 'Pons is not open to this wallet yet.', LaunchConfigDisabled: 'Pons closed this launch config. Reload the page.',
    LaunchEconomicsMismatch: 'Pons changed its launch settings. Reload the page.', CreatorTaxTooHigh: 'That tax is above the Pons limit.',
  };
  if (n) return map[n] || n;
  if (e?.code === 4001 || /rejected|denied/i.test(e?.message || '')) return 'You cancelled in the wallet.';
  return e?.shortMessage || e?.message || String(e);
}

export { formatEther, parseEther, getAddress, isAddress };
