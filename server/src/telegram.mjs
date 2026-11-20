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

export function startTelegram({ token, groupId, api, stateDir, site, hub, explorer }) {
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
  const help = () => [
    '<b>Merces Live</b>: payday for open source, live from Robinhood Chain.',
    '',
    '/vault owner/repo · what a repo\'s vault holds',
    '/live · the latest trades and what they paid repos',
    '/stats · totals across Merces',
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
    const text = msg.text || '';
    const m = text.match(/^\/([a-z]+)(?:@\w+)?\s*(.*)$/is);
    if (m) {
      const [, cmd, arg] = m;
      const chat = msg.chat.id;
      const run = {
        start: () => say(chat, help()), help: () => say(chat, help()), vault: () => cmdVault(chat, arg), live: () => cmdLive(chat),
        stats: () => cmdStats(chat), ca: () => cmdCa(chat), verify: () => cmdVerify(chat),
        watch: () => cmdWatch(chat, arg, isPrivate, true), unwatch: () => cmdWatch(chat, arg, isPrivate, false),
      }[cmd.toLowerCase()];
      if (run) return run().catch((e) => say(chat, `Could not do that right now: ${esc(e.message)}`).catch(() => {}));
      return;
    }
    if (!isPrivate) await guard(msg).catch((e) => console.error('tg guard', e.message));
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
  })();
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
