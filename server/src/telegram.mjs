// @merceslivebot: the live side of merces.live in Telegram.
// - Commands (DM and group): /vault owner/repo, /live, /stats, /ca, /verify, /watch and /unwatch (DM alerts per repo).
// - Group feed: posts every Merces coin launch, fees landing in a vault, and payouts; posts and pins the $WAGE CA at T0.
// - Anti-clone: in the group, a non-admin message with a 0x address that is not the official CA, the hub or a Merces coin
//   is deleted with a short notice.
// Reads only the server's own public API, so everything it says is what the site shows.
import fs from 'node:fs';
import path from 'node:path';

const ADDR_RE = /0x[a-fA-F0-9]{40}/g;
const REPO_RE = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/?$/;

export function startTelegram({ token, groupId, api, stateDir, site, hub, explorer, welcome = false, launchUtc = '' }) {
  const T = `https://api.telegram.org/bot${token}`;
  const FILE = path.join(stateDir, 'telegram.json');
  const st = Object.assign({ offset: 0, seenAt: 0, watch: {}, caPosted: null, lastFeePost: {} }, readJson(FILE));
  const save = () => { const t = `${FILE}.tmp`; fs.writeFileSync(t, JSON.stringify(st)); fs.renameSync(t, FILE); };
  let groupChatId = groupId || null;
  let me = null;

  const tg = async (method, body) => {
    const r = await fetch(`${T}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
    return j.result;
  };
  const get = async (p) => { const r = await fetch(`${api}${p}`); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); };
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const eth = (wei) => { const v = Number(BigInt(wei || 0)) / 1e18; return v === 0 ? '0' : v < 0.0001 ? '&lt;0.0001' : v.toFixed(4); };
  const say = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  const repoLink = (repo) => `<a href="${site}/#/r/${esc(repo)}">${esc(repo)}</a>`;

  // ------------------------------------------------------------------ commands
  async function cmdVault(chat, arg) {
    const m = (arg || '').trim().match(REPO_RE);
    if (!m) return say(chat, 'Send a repo like this: <code>/vault neovim/neovim</code>');
    const r = await get(`/api/repo?repo=${encodeURIComponent(m[1])}`).catch((e) => ({ error: e.message }));
    if (r.error) return say(chat, esc(r.error));
    const v = r.vault;
    const waiting = v ? BigInt(v.pending) + BigInt(r.stats?.unswept || 0) : 0n;
    return say(chat, [
      `<b>Vault of ${repoLink(r.repo)}</b>`,
      v ? `Address: <code>${v.address}</code>` : 'Address: at hub deploy',
      `Waiting for its maintainers: <b>${eth(waiting)} ETH</b>`,
      `Paid out: ${eth(v?.paid)} ETH`,
      `Coins paying it: ${r.coins.length}`,
      `Status: ${v?.claimed ? 'claimed, new fees go to the bound wallet' : 'unclaimed'}`,
      '',
      `<a href="${site}/#/launch?repo=${encodeURIComponent(r.repo)}">Launch a coin for it</a> · <a href="${site}/#/claim?repo=${encodeURIComponent(r.repo)}">Claim it</a>`,
    ].join('\n'));
  }
  async function cmdLive(chat) {
    const d = await get('/api/live');
    const rows = d.trades.slice(0, 8).map((t) => `${t.side === 'buy' ? 'Buy ' : 'Sell'} $${esc(t.symbol)} ${eth(t.eth)} ETH → +${eth(t.tax)} to ${repoLink(t.repo)}`);
    return say(chat, [
      `<b>Live, last 24 h</b>: ${eth(d.day.toRepos)} ETH sent to open source · ${d.day.trades} trades · ${eth(d.day.volume)} ETH traded`,
      '', rows.length ? rows.join('\n') : 'No trades yet. The tape starts with the first buy of a Merces coin.',
      '', `<a href="${site}/#/live">Open the live tape</a>`,
    ].join('\n'));
  }
  async function cmdStats(chat) {
    const s = await get('/api/stats');
    return say(chat, `<b>Merces</b>\nCoins launched: ${s.coins}\nRepos with a vault: ${s.repos}\nETH waiting in vaults: ${eth(s.waiting)}\nETH paid to maintainers: ${eth(s.paid)}\nRepos claimed: ${s.claimed}`);
  }
  async function cmdCa(chat) {
    const t = await get('/api/token');
    if (t.ca) return say(chat, `<b>$WAGE</b> official contract address:\n<code>${t.ca}</code>\n\nBuy on Pons: https://www.ponsfamily.com/launchpad/${t.ca}\nOnly trust the CA posted here, on ${site.replace('https://', '')} and on X.`);
    return say(chat, `<b>$WAGE</b> launches on Pons on 21 November 2026, 15:00 UTC.\nThe contract address is posted here, on ${site.replace('https://', '')} and on X at launch. Until then, anything claiming to be $WAGE is not.`);
  }
  const cmdVerify = (chat) => say(chat, [
    '<b>Check it yourself</b>',
    hub ? `Hub: <a href="${explorer}/address/${hub}">${hub}</a> (Sourcify verified)` : 'Hub: deployed before launch',
    'Fees never touch a Merces wallet. Each vault has no owner and can only pay the wallet its repo named. Merces takes no cut.',
    `Every number has a public endpoint: ${site}/api/stats · ${site}/api/live · ${site}/proof.json`,
    `More: ${site}/#/verify`,
  ].join('\n'));
  async function cmdWatch(chat, arg, isPrivate, on) {
    if (!isPrivate) return say(chat, `Alerts are personal: send <code>/${on ? 'watch' : 'unwatch'} owner/repo</code> to me in a private chat.`);
    const m = (arg || '').trim().match(REPO_RE);
    if (!m) return say(chat, `Send a repo like this: <code>/${on ? 'watch' : 'unwatch'} neovim/neovim</code>`);
    const k = m[1].toLowerCase();
    const list = new Set(st.watch[k] || []);
    if (on) list.add(chat); else list.delete(chat);
    st.watch[k] = [...list]; if (!st.watch[k].length) delete st.watch[k];
    save();
    return say(chat, on ? `Watching ${repoLink(m[1])}. You get a message when fees land in its vault, a coin launches for it, or it pays out.` : `Stopped watching ${esc(m[1])}.`);
  }
  async function cmdTop(chat) {
    const list = await get('/api/vaults');
    if (!list.length) return say(chat, 'No vault holds fees yet. The first coin launched for a repo starts filling its vault.');
    return say(chat, ['<b>Fullest vaults</b>', ...list.slice(0, 8).map((v, i) => `${i + 1}. ${repoLink(v.repo)}: ${eth(BigInt(v.stats?.pending || 0) + BigInt(v.stats?.unswept || 0))} ETH waiting${v.stats?.wallet ? ' · claimed' : ''}`)].join('\n'));
  }
  async function cmdNew(chat) {
    const list = await get('/api/coins');
    if (!list.length) return say(chat, `No coins yet. Launch the first one for a repo you rely on: ${site}/#/launch`);
    return say(chat, ['<b>New coins</b>', ...list.slice(0, 8).map((c) => `$${esc(c.symbol)} pays ${repoLink(c.repo)} · <a href="https://www.ponsfamily.com/launchpad/${c.token}">Pons</a>`)].join('\n'));
  }
  const repoArg = (arg) => (arg || '').trim().match(REPO_RE)?.[1];
  const cmdLaunch = (chat, arg) => { const r = repoArg(arg); return say(chat, r ? `Launch a coin that pays ${repoLink(r)}: ${site}/#/launch?repo=${encodeURIComponent(r)}` : `Launch a coin for any public repo: ${site}/#/launch`); };
  const cmdClaim = (chat, arg) => { const r = repoArg(arg); return say(chat, r ? `Maintainer of ${repoLink(r)}? Open its vault here: ${site}/#/claim?repo=${encodeURIComponent(r)}` : `Maintain a repo? Commit <code>merces=0xYourWallet</code> to <code>.merces</code> on the default branch, then claim: ${site}/#/claim`); };
  const help = () => [
    '<b>Merces Live</b>: payday for open source, live from Robinhood Chain.',
    '',
    'Type any <code>owner/repo</code> (or a GitHub link) to see its vault.',
    '/vault owner/repo · what a repo\'s vault holds',
    '/live · the latest trades and what they paid repos',
    '/stats · totals across Merces',
    '/top · fullest vaults · /new · newest coins',
    '/launch owner/repo · /claim owner/repo · links straight to the site',
    '/watch owner/repo · private alerts for a repo (/unwatch to stop)',
    '/ca · the official $WAGE contract address',
    '/verify · how to check everything on chain',
    '',
    `${site}`,
  ].join('\n');

  // ------------------------------------------------------------------ anti-clone guard in the group
  async function guard(msg) {
    const text = `${msg.text || ''} ${msg.caption || ''}`;
    const found = [...new Set((text.match(ADDR_RE) || []).map((a) => a.toLowerCase()))];
    if (!found.length) return;
    const t = await get('/api/token').catch(() => ({}));
    const coins = await get('/api/coins').catch(() => []);
    const ok = new Set([t.ca, hub, ...coins.map((c) => c.token), ...coins.map((c) => c.vault)].filter(Boolean).map((a) => a.toLowerCase()));
    if (found.every((a) => ok.has(a))) return;
    const member = await tg('getChatMember', { chat_id: msg.chat.id, user_id: msg.from.id }).catch(() => null);
    if (member && ['creator', 'administrator'].includes(member.status)) return;
    await tg('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
    const note = await say(msg.chat.id, `Removed a message with an address that is not an official Merces contract. The only $WAGE CA is the one I post here and on ${site.replace('https://', '')}.`).catch(() => null);
    if (note) setTimeout(() => tg('deleteMessage', { chat_id: msg.chat.id, message_id: note.message_id }).catch(() => {}), 60_000);
  }

  // ------------------------------------------------------------------ updates loop
  async function handle(u) {
    const msg = u.message;
    if (!msg || !msg.chat) return;
    const isPrivate = msg.chat.type === 'private';
    if (!isPrivate && !groupChatId && msg.chat.username?.toLowerCase() === 'mercesdotlive') groupChatId = msg.chat.id;
    if (!isPrivate && (msg.new_chat_members || msg.left_chat_member)) {
      // Keep the group clean: join/leave notices go, and (once switched on) a short welcome that removes itself.
      await tg('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
      if (welcome && msg.new_chat_members?.some((u) => !u.is_bot)) {
        const names = msg.new_chat_members.filter((u) => !u.is_bot).map((u) => esc(u.first_name)).join(', ');
        const w = await say(msg.chat.id, `Welcome, ${names}. Merces pays open source: coins for GitHub repos, fees to their vaults. Type any owner/repo to see its vault, or /live. The only $WAGE CA is the one I post here.`).catch(() => null);
        if (w) setTimeout(() => tg('deleteMessage', { chat_id: msg.chat.id, message_id: w.message_id }).catch(() => {}), 120_000);
      }
      return;
    }
    const text = msg.text || '';
    const m = text.match(/^\/([a-z]+)(?:@\w+)?\s*(.*)$/is);
    if (m) {
      const [, cmd, arg] = m;
      const chat = msg.chat.id;
      const run = {
        start: () => say(chat, help()), help: () => say(chat, help()), vault: () => cmdVault(chat, arg), live: () => cmdLive(chat),
        stats: () => cmdStats(chat), ca: () => cmdCa(chat), verify: () => cmdVerify(chat),
        top: () => cmdTop(chat), new: () => cmdNew(chat), launch: () => cmdLaunch(chat, arg), claim: () => cmdClaim(chat, arg),
        watch: () => cmdWatch(chat, arg, isPrivate, true), unwatch: () => cmdWatch(chat, arg, isPrivate, false),
      }[cmd.toLowerCase()];
      if (run) return run().catch((e) => say(chat, `Could not do that right now: ${esc(e.message)}`).catch(() => {}));
      return;
    }
    if (!isPrivate) await guard(msg).catch((e) => console.error('tg guard', e.message));
    await autoReply(msg, isPrivate).catch((e) => console.error('tg auto', e.message));
  }

  // ------------------------------------------------------------------ auto replies: name a repo -> its vault; common questions
  const lastAuto = {};
  const FAQ = [
    { k: 'ca', re: /\b(ca|contract( address)?|token address)\b|\bwhat'?s the (ca|address)\b/i, run: (c) => cmdCa(c) },
    { k: 'when', re: /\b(when|what time)\b.*\b(launch|live|start|wage)\b|\blaunch time\b|\bwen\b/i,
      run: (c) => say(c, `<b>$WAGE</b> launches on Pons on 21 November 2026, 15:00 UTC (<a href="https://www.timeanddate.com/worldclock/fixedtime.html?iso=20261121T1500">your time</a>). The CA is posted here by me at that minute.`) },
    { k: 'what', re: /\b(what is|what's|how does|how do(es)?) (merces|this|it) (work|do)?\b|\bhow (it|this|merces) works?\b/i,
      run: (c) => say(c, `Merces pays open source. Launch a coin for any public GitHub repo on ${site.replace('https://', '')}; its creator fees go to that repo's vault, not to the launcher. Only someone with push access to the repo can open it. Type a repo here, like <code>neovim/neovim</code>, to see its vault.`) },
    { k: 'claim', re: /\b(how (do i|to|can i) claim|maintainer|my repo|own a repo|open (the|my) vault)\b/i, run: (c) => cmdClaim(c, '') },
    { k: 'safe', re: /\b(rug|scam|safe|audit(ed)?|trust)\b/i,
      run: (c) => say(c, `No cut and no owner on the vaults: fees can only go to the wallet a repo names in its own <code>.merces</code> file. The hub is Sourcify verified and a verifier change waits 3 days on chain. It is not externally audited. Check it yourself: ${site}/#/verify`) },
  ];
  async function autoReply(msg, isPrivate) {
    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/') || msg.from?.is_bot) return;
    const chat = msg.chat.id;
    // A message that is only a repo (owner/repo or a github.com link) gets that repo's vault: the group's "name a repo".
    const repo = text.match(REPO_RE);
    if (repo && /\//.test(text) && text.split(/\s+/).length === 1) {
      const key = `${chat}:repo:${repo[1].toLowerCase()}`;
      if (Date.now() - (lastAuto[key] || 0) < 60_000) return;
      lastAuto[key] = Date.now();
      return cmdVault(chat, repo[1]);
    }
    if (text.length > 200) return;
    const hit = FAQ.find((f) => f.re.test(text));
    if (!hit) return;
    const key = `${chat}:${hit.k}`;
    if (!isPrivate && Date.now() - (lastAuto[key] || 0) < 3 * 60_000) return; // once per topic per 3 min in the group
    lastAuto[key] = Date.now();
    return hit.run(chat, msg.message_id);
  }

  // ------------------------------------------------------------------ countdown to $WAGE in the group (only while the CA is not out)
  const LAUNCH = Date.parse(launchUtc || '2026-11-21T15:00:00Z');
  const MARKS = [[360, '6 hours'], [180, '3 hours'], [60, '1 hour'], [30, '30 minutes'], [10, '10 minutes']];
  async function countdown() {
    try {
      if (!groupChatId || !LAUNCH) return;
      st.countdown = st.countdown || [];
      const left = (LAUNCH - Date.now()) / 60_000;
      for (const [min, label] of MARKS) {
        if (st.countdown.includes(min) || left > min || left < min - 5) continue;
        const t = await get('/api/token').catch(() => ({}));
        if (t.ca) return;
        await say(groupChatId, `<b>$WAGE in ${label}</b> · Pons · 15:00 UTC.\nThe CA comes from me, here, at that minute. Anything earlier is not $WAGE.\nMeanwhile: type any <code>owner/repo</code> to see what its vault holds, or open ${site}/#/live`);
        st.countdown.push(min); save();
      }
    } catch (e) { console.error('tg countdown', e.message); }
    finally { setTimeout(countdown, 60_000); }
  }
  async function poll() {
    try {
      const ups = await tg('getUpdates', { offset: st.offset, timeout: 25, allowed_updates: ['message'] });
      for (const u of ups) { st.offset = u.update_id + 1; await handle(u).catch((e) => console.error('tg', e.message)); }
      if (ups.length) save();
    } catch (e) { console.error('tg poll', e.message); await new Promise((r) => setTimeout(r, 5000)); }
    setImmediate(poll);
  }

  // ------------------------------------------------------------------ group feed + personal alerts from the event log
  async function feed() {
    try {
      const evs = await get('/api/events');
      const fresh = evs.filter((e) => e.at > st.seenAt).reverse();
      if (!st.seenAt) st.seenAt = Math.max(Date.now(), ...evs.map((e) => e.at)); // never replay history on first start
      for (const e of st.seenAt && fresh.length ? fresh : []) {
        st.seenAt = Math.max(st.seenAt, e.at);
        let text = null;
        if (e.type === 'launch') text = `<b>New coin</b>: $${esc(e.symbol)} launched for ${repoLink(e.repo)}. Its creator fees fill that repo's vault.\nhttps://www.ponsfamily.com/launchpad/${e.token}`;
        if (e.type === 'paid') text = `<b>Payday</b>: the vault of ${e.repo ? repoLink(e.repo) : 'a repo'} paid <b>${eth(e.amount)} ETH</b> to its maintainer.${e.tx ? `\n${explorer}/tx/${e.tx}` : ''}`;
        if (e.type === 'fees') {
          const last = st.lastFeePost[e.repo] || 0;
          if (Date.now() - last > 5 * 60_000) { text = `+${eth(e.amount)} ETH landed in the vault of ${repoLink(e.repo)}.`; st.lastFeePost[e.repo] = Date.now(); }
        }
        if (text && groupChatId) await say(groupChatId, text).catch((err) => console.error('tg feed', err.message));
        for (const chat of (e.repo && st.watch[e.repo.toLowerCase()]) || []) {
          const personal = e.type === 'fees' ? `+${eth(e.amount)} ETH landed in the vault of ${repoLink(e.repo)}.` : text;
          if (personal) await say(chat, personal).catch(() => {});
        }
      }
      // T0: post and pin the official CA once.
      const t = await get('/api/token');
      if (t.ca && st.caPosted !== t.ca && groupChatId) {
        const sent = await say(groupChatId, `<b>$WAGE is live.</b>\nOfficial contract address:\n<code>${t.ca}</code>\n\nBuy on Pons: https://www.ponsfamily.com/launchpad/${t.ca}\nOnly trust this CA, ${site.replace('https://', '')} and our X.`);
        await tg('pinChatMessage', { chat_id: groupChatId, message_id: sent.message_id, disable_notification: false }).catch(() => {});
        st.caPosted = t.ca;
      }
      save();
    } catch (e) { console.error('tg feed', e.message); }
    setTimeout(feed, 10_000);
  }

  (async () => {
    me = await tg('getMe', {}).catch((e) => { console.error('telegram disabled:', e.message); return null; });
    if (!me) return;
    if (!groupChatId) groupChatId = (await tg('getChat', { chat_id: '@mercesdotlive' }).catch(() => null))?.id || null;
    console.log(`telegram @${me.username} group=${groupChatId}`);
    poll();
    feed();
    countdown();
  })();
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
