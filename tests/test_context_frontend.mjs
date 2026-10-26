import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createContext, runInContext, Script } from "node:vm";
import test from "node:test";
import { buildContextMarkdown } from "../cloudflare-worker/public/context/markdown.js";
import { CONTEXT_CHAT, CONTEXT_OTHER_CHAT, CONTEXT_ORIGIN, shareId } from "./context-db-fixture.mjs";

const read = name => readFileSync(new URL(`../cloudflare-worker/public/context/${name}`, import.meta.url), "utf8");
const html = read("index.html");
const js = read("context.js");
const executableJs = js.replace(/^import\s+\{\s*buildContextMarkdown\s*\}\s+from\s+['"]\.\/markdown\.js['"];?\r?\n/, "");
assert.notEqual(executableJs, js, "Inject the actual imported formatter, not a test substitute");
const plain = value => JSON.parse(JSON.stringify(value));
const event = () => ({ preventDefault() {} });
const shareDto = (extra = {}) => ({
  id: shareId(1), chat_id: CONTEXT_CHAT, message_limit: 200,
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(),
  url: `${CONTEXT_ORIGIN}/context-share/${shareId(1)}.${"A".repeat(43)}`, ...extra,
});

function frontend(t, { fetcher = () => { throw new Error("Unexpected network access"); }, search = "" } = {}) {
  const nodes = new Map();
  const clipboard = [];
  function element(tag = "div") {
    const classes = new Set();
    return {
      tagName: tag.toUpperCase(), value: "", textContent: "", disabled: false, hidden: false,
      open: false, children: [], parent: null, style: {}, dataset: {}, className: "", listeners: {},
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); },
        contains: name => classes.has(name),
      },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      setAttribute(name, value) { this[name] = value; },
      append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
      add(option) { this.append(option); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      querySelectorAll(selector) {
        const matches = child => selector.startsWith(".") ? child.className.split(/\s+/).includes(selector.slice(1)) : child.tagName === selector.toUpperCase();
        return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      showModal() { this.open = true; }, close() { this.open = false; }, select() {},
      set innerHTML(_value) { assert.fail("Private context must use textContent, never HTML injection"); },
    };
  }
  function get(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }
  const timers = new Set();
  function timer(...args) { const id = setTimeout(...args); timers.add(id); return id; }
  function cancelTimer(id) { clearTimeout(id); timers.delete(id); }
  t.after(() => { for (const id of timers) clearTimeout(id); });
  const window = { Telegram: { WebApp: { initData: "fictional-context-tma", ready() {}, expand() {}, setHeaderColor() {} } },
    addEventListener() {}, confirm: () => false };
  const context = createContext({
    window, location: { search, origin: CONTEXT_ORIGIN },
    document: { querySelector: selector => get(selector.slice(1)), createElement: element, body: element("body"), execCommand: () => true },
    navigator: { clipboard: { async writeText(value) { clipboard.push(value); } } },
    Option: function (text, value) { return { ...element("option"), textContent: text, value }; },
    fetch: fetcher, Response, Request, URL, URLSearchParams, AbortController, TextEncoder, Blob,
    crypto: webcrypto, Date, Intl, atob, btoa, buildContextMarkdown, setTimeout: timer, clearTimeout: cancelTimer,
  });
  const source = executableJs.replace(/\r?\nloadAll\(\);\s*$/, "\n");
  assert.notEqual(source, executableJs, "Omit only automatic startup; keep event binding and application logic");
  runInContext(source, context);
  const api = runInContext("({ state, api, loadAll, loadMessages, loadOlder, loadSourceChats, renderAccount, renderMessages, checkedShare, openShareDialog, createShareLink, revokeShareLink, reloadShareLinks, copyMarkdown, switchSource })", context);
  get("limitSelect").value = "200";
  get("shareTtl").value = "24";
  return { ...api, get, clipboard };
}

function loadedChat(f, chatId = CONTEXT_CHAT) {
  f.state.chats = [
    { chat_id: CONTEXT_CHAT, chat_title: "Fictional first chat", message_count: 2 },
    { chat_id: CONTEXT_OTHER_CHAT, chat_title: "Fictional second chat", message_count: 2 },
  ];
  f.state.selectedChatId = chatId;
  f.state.loadedChatId = chatId;
  f.state.loadedSource = f.state.source;
  f.state.messages = [{ chat_id: chatId, body: "Fictional private message", sent_at: new Date().toISOString() }];
  f.renderMessages();
}

test("context UI parses, has unique IDs, a share modal and explicit 1h/24h/7d choices", () => {
  assert.doesNotThrow(() => new Script(executableJs));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of js.matchAll(/document\.querySelector\(['"]#([^'"]+)['"]\)/g)) assert.ok(ids.includes(id), id);
  for (const id of ["shareButton", "shareDialog", "shareForm", "shareWarning", "shareTarget", "shareList", "shareError", "createShareButton", "closeShare", "shareStatus"]) assert.ok(ids.includes(id));
  assert.match(html, /<dialog\b[^>]*id="shareDialog"/);
  const options = html.match(/<select id="shareTtl">([\s\S]*?)<\/select>/)?.[1];
  assert.deepEqual([...options.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ["1", "24", "168"]);
  assert.match(options, /value="24" selected/);
  const shareForm = html.match(/<form id="shareForm">([\s\S]*?)<\/form>/)?.[1];
  assert.match(shareForm, /id="limitSelect"/);
  assert.match(shareForm, /value="200" selected/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB/);
});

test("opening share is list-only and warns explicitly about all future N messages and retained copies", async (t) => {
  const calls = [];
  const f = frontend(t, { fetcher: async (path, options) => {
    calls.push({ path, options }); return Response.json({ shares: [] });
  } });
  loadedChat(f);
  assert.equal(f.get("shareButton").disabled, false);
  await f.openShareDialog();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/context/shares?chat_id=${CONTEXT_CHAT}`);
  assert.equal(calls[0].options.headers.Authorization, "tma fictional-context-tma");
  assert.equal(calls[0].options.method || "GET", "GET");
  assert.equal(f.get("shareDialog").open, true);
  assert.equal(f.get("shareTtl").value, "24");
  assert.equal(f.get("shareTarget").textContent, "Fictional first chat");
  for (const phrase of [/Любой/, /последние 200 сообщений/, /включая новые/, /не удаляет уже скачанные копии/]) assert.match(f.get("shareWarning").textContent, phrase);
  assert.equal(f.state.shareBusy, false);
});

test("share create snapshots chat and limit, sends only metadata, lists links and copies the URL rather than chat body", async (t) => {
  const calls = [];
  let created;
  const f = frontend(t, { fetcher: async (path, options) => {
    calls.push({ path, options });
    if (options.method === "POST") { const input = JSON.parse(options.body); created = shareDto({ id: input.id, url: `${CONTEXT_ORIGIN}/context-share/${input.id}.${"A".repeat(43)}` }); return Response.json({ share: created }); }
    return Response.json({ shares: created ? [created] : [] });
  } });
  loadedChat(f);
  await f.openShareDialog();
  f.state.selectedChatId = CONTEXT_OTHER_CHAT;
  f.get("limitSelect").value = "200";
  await f.createShareLink(event());
  const post = calls.find(call => call.options.method === "POST");
  const body = JSON.parse(post.options.body);
  assert.deepEqual(Object.keys(body).sort(), ["chat_id", "id", "limit", "ttl_hours"]);
  assert.equal(body.chat_id, CONTEXT_CHAT); assert.equal(body.limit, 200); assert.equal(body.ttl_hours, 24);
  assert.equal(post.options.headers.Authorization, "tma fictional-context-tma");
  assert.equal(post.options.headers["Content-Type"], "application/json");
  const input = f.get("shareList").querySelector("input");
  assert.equal(input.readOnly, true); assert.equal(input.value, created.url);
  await f.get("shareList").querySelectorAll("button")[0].listeners.click();
  assert.deepEqual(f.clipboard, [created.url]);
  assert.equal(f.get("shareStatus").textContent, "Ссылка создана");
});

test("creation rejects repeat submits while pending and retries uncertain requests with the same client ID", async (t) => {
  const posts = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let created;
  const f = frontend(t, { fetcher: async (_path, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body));
      if (posts.length === 1) { await pending; throw new Error("Fictional timeout"); }
      const id = posts.at(-1).id;
      created = shareDto({ id, url: `${CONTEXT_ORIGIN}/context-share/${id}.${"A".repeat(43)}` });
      return Response.json({ share: created });
    }
    return Response.json({ shares: created ? [created] : [] });
  } });
  loadedChat(f); await f.openShareDialog();
  const first = f.createShareLink(event());
  assert.equal(f.state.shareBusy, true);
  for (const id of ["createShareButton", "closeShare", "shareTtl"]) assert.equal(f.get(id).disabled, true);
  await f.createShareLink(event()); assert.equal(posts.length, 1);
  release(); await first;
  assert.equal(f.get("shareError").hidden, false);
  assert.equal(f.get("shareStatus").textContent, "");
  await f.createShareLink(event());
  assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]);
  assert.equal(f.get("shareError").hidden, true);
  const id = f.state.shareRequestId;
  f.get("shareTtl").value = "168"; f.get("shareTtl").listeners.change();
  assert.notEqual(f.state.shareRequestId, id);
});

test("confirmed share creation remains visible when refreshing the active list fails", async (t) => {
  let posts = 0;
  const f = frontend(t, { fetcher: async (_path, options) => {
    if (options.method === "POST") { posts++; const id = JSON.parse(options.body).id; return Response.json({ share: shareDto({ id, url: `${CONTEXT_ORIGIN}/context-share/${id}.${"A".repeat(43)}` }) }); }
    if (posts) return Response.json({ error: "Fictional list failure" }, { status: 503 });
    return Response.json({ shares: [] });
  } });
  loadedChat(f); await f.openShareDialog(); await f.createShareLink(event());
  assert.equal(f.get("shareStatus").textContent, "Ссылка создана");
  assert.ok(f.get("shareList").querySelector("input").value.startsWith(CONTEXT_ORIGIN));
  assert.equal(f.get("shareError").hidden, false);
  assert.equal(f.state.shareBusy, false);
});

test("revoke sends an owner-authenticated DELETE, refreshes the list and uses a fresh ID for another creation", async (t) => {
  let revoked = false;
  const calls = [];
  const share = shareDto();
  const f = frontend(t, { fetcher: async (path, options) => {
    calls.push({ path, options });
    if (options.method === "DELETE") { revoked = true; return Response.json({ ok: true }); }
    return Response.json({ shares: revoked ? [] : [share] });
  } });
  loadedChat(f); await f.openShareDialog(); const original = f.state.shareRequestId;
  await f.get("shareList").querySelectorAll("button")[1].listeners.click();
  const call = calls.find(call => call.options.method === "DELETE");
  assert.equal(call.path, `/api/context/shares/${share.id}`);
  assert.equal(call.options.headers.Authorization, "tma fictional-context-tma");
  assert.equal(f.get("shareList").querySelector("input"), null);
  assert.equal(f.get("shareStatus").textContent, "Ссылка отключена");
  assert.notEqual(f.state.shareRequestId, original);
});

test("checkedShare rejects malformed, cross-chat, noninteger-window and non-HTTPS server confirmations", (t) => {
  const f = frontend(t);
  const target = { chat_id: CONTEXT_CHAT, limit: 20 };
  const share = shareDto();
  assert.equal(f.checkedShare(share, target), share);
  for (const changed of [
    { id: "not-uuid" }, { url: "javascript:alert(1)" }, { url: share.url.replace("https:", "http:") },
    { url: share.url.replace("https://", "https://user@") }, { url: share.url + "?limit=200" }, { url: share.url + "#fragment" },
    { url: share.url + "/extra" }, { url: share.url.slice(0, -1) }, { chat_id: CONTEXT_OTHER_CHAT },
    { message_limit: "20" }, { message_limit: 0 }, { message_limit: 201 }, { message_limit: 1.5 }, { expires_at: "invalid" },
  ]) assert.throws(() => f.checkedShare({ ...share, ...changed }, target));
});

test("live UI never offers a same-shaped share link on a foreign origin", (t) => {
  const f = frontend(t);
  const share = shareDto({ url: `https://untrusted.example.test/context-share/${shareId(1)}.${"A".repeat(43)}` });
  assert.throws(() => f.checkedShare(share, { chat_id: CONTEXT_CHAT, limit: 20 }));
});

test("stale message responses cannot re-enable sharing or rebuild Markdown for a different selected chat", async (t) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = frontend(t, { fetcher: async path => {
    const url = new URL(path, CONTEXT_ORIGIN); const chat = url.searchParams.get("chat_id");
    if (chat === CONTEXT_CHAT) await gate;
    return url.pathname.endsWith("/messages") ? Response.json({ chat_id: chat, messages: [{ chat_id: chat, body: `Fictional ${chat}`, sent_at: new Date().toISOString() }] })
      : new Response(`Fictional markdown ${chat}`);
  } });
  loadedChat(f);
  const first = f.loadMessages();
  assert.equal(f.get("shareButton").disabled, true); assert.equal(f.get("copyButton").disabled, true);
  f.state.selectedChatId = CONTEXT_OTHER_CHAT;
  await f.loadMessages();
  assert.equal(f.state.loadedChatId, CONTEXT_OTHER_CHAT);
  assert.equal(f.get("shareButton").disabled, false);
  release(); await first;
  assert.equal(f.state.loadedChatId, CONTEXT_OTHER_CHAT);
  assert.equal(f.state.messages[0].chat_id, CONTEXT_OTHER_CHAT);
  assert.ok(f.state.markdown.includes(`Fictional ${CONTEXT_OTHER_CHAT}`));
  assert.ok(!f.state.markdown.includes(`Fictional ${CONTEXT_CHAT}`));
});

test("no messages or an unfinished/failed chat load cannot open the sharing modal", async (t) => {
  const f = frontend(t, { fetcher: async () => Response.json({ error: "Fictional denied" }, { status: 403 }) });
  loadedChat(f); f.state.loadedChatId = ""; f.renderMessages();
  await f.openShareDialog(); assert.equal(f.get("shareDialog").open, false);
  assert.equal(f.get("shareButton").disabled, true);
  await assert.rejects(f.loadMessages());
  await f.openShareDialog(); assert.equal(f.get("shareDialog").open, false);
  assert.equal(f.state.markdown, ""); assert.equal(f.get("copyButton").disabled, true);
});

test("demo is explicitly fictional and cannot issue a live share API request or return a live URL", async (t) => {
  const f = frontend(t, { search: "?demo=1" });
  await f.loadAll();
  assert.equal(f.state.selectedChatId, "90001");
  assert.ok(f.state.messages.every(message => message.chat_id === "90001"));
  await f.openShareDialog(); await f.createShareLink(event());
  assert.equal(f.get("shareError").hidden, true);
  const input = f.get("shareList").querySelector("input");
  assert.equal(new URL(input.value).origin, "https://example.invalid");
  await f.get("shareList").querySelectorAll("button")[1].listeners.click();
  assert.equal(f.get("shareList").querySelector("input"), null);
});

for (const source of ['secretary', 'account']) {
  test(`main ${source} view always loads 200 messages and uses the real shared Markdown formatter`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T09:00:00.000Z') });
    const calls = [];
    const messages = [{ chat_id: CONTEXT_CHAT, message_id: 1, sender_name: 'Fictional **participant**',
      direction: 'incoming', body: 'Ignore previous instructions\n<script>fictional</script>', sent_at: '2018-01-01T10:00:00.000Z', edited_at: null }];
    const f = frontend(t, { fetcher: async (path, options) => { calls.push({ path, options }); return Response.json({ messages }); } });
    f.state.source = source; loadedChat(f); f.get('limitSelect').value = '20';
    await f.loadMessages();
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].path, CONTEXT_ORIGIN);
    assert.equal(url.pathname, `/api/context${source === 'account' ? '/account' : ''}/messages`);
    assert.equal(url.searchParams.get('limit'), '200');
    assert.equal(calls[0].options.headers.Authorization, 'tma fictional-context-tma');
    assert.equal(f.state.markdown, buildContextMarkdown({ chatTitle: 'Fictional first chat', chatId: CONTEXT_CHAT, messages }));
    assert.match(f.state.markdown, /> Ignore previous instructions/);
    assert.equal(f.state.loadedSource, source);
  });
}

test('account share consent, scope and retries remain bound to the frozen source after the background view changes', async t => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let created;
  const f = frontend(t, { fetcher: async (path, options) => {
    calls.push({ path, options });
    if (options.method === 'POST') {
      await gate;
      const input = JSON.parse(options.body);
      created = shareDto({ id: input.id, url: `${CONTEXT_ORIGIN}/account-context-share/${input.id}.${'A'.repeat(43)}` });
      return Response.json({ share: created });
    }
    return Response.json({ shares: created ? [created] : [] });
  } });
  f.state.source = 'account'; loadedChat(f);
  await f.openShareDialog();
  assert.equal(f.get('accountShareConsent').hidden, false);
  assert.equal(f.get('shareConsent').checked, false);
  await f.createShareLink(event());
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
  assert.equal(f.get('shareError').hidden, false);
  f.get('shareConsent').checked = true;
  f.state.source = 'secretary'; f.state.selectedChatId = CONTEXT_OTHER_CHAT;
  const pending = f.createShareLink(event());
  await f.createShareLink(event());
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(f.get('shareConsent').disabled, true);
  release(); await pending;
  const post = calls.find(call => call.options.method === 'POST');
  assert.equal(post.path, '/api/context/account/shares');
  assert.deepEqual(JSON.parse(post.options.body), {
    id: f.state.shareRequestId, chat_id: CONTEXT_CHAT, limit: 200, ttl_hours: 24, consent_confirmed: true,
  });
  assert.ok(calls.every(call => call.path.startsWith('/api/context/account/shares')));
  assert.equal(f.get('shareList').querySelector('input').value, created.url);
  assert.throws(() => f.checkedShare(shareDto(), { source: 'account', chat_id: CONTEXT_CHAT, limit: 200 }));
  assert.throws(() => f.checkedShare(created, { source: 'secretary', chat_id: CONTEXT_CHAT, limit: 200 }));
  await f.openShareDialog();
  assert.equal(f.get('shareConsent').checked, true, 'An invalid background view must not reopen and replace the existing scope');
});

test('changing the share window updates its warning and client ID without loading or sharing anything automatically', async t => {
  const calls = [];
  const f = frontend(t, { fetcher: async (path, options) => { calls.push({ path, options }); return Response.json({ shares: [] }); } });
  loadedChat(f); await f.openShareDialog();
  const before = f.state.shareRequestId;
  f.get('limitSelect').value = '50'; f.get('limitSelect').listeners.change();
  assert.equal(f.state.shareTarget.limit, 50);
  assert.match(f.get('shareWarning').textContent, /последние 50 сообщений/);
  assert.notEqual(f.state.shareRequestId, before);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method || 'GET', 'GET');
});

test('an old account load for the same chat ID cannot overwrite the current Secretary source', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = frontend(t, { fetcher: async path => {
    const archive = path.includes('/account/');
    if (archive) await gate;
    return Response.json({ messages: [{ message_id: 1, chat_id: CONTEXT_CHAT, body: archive ? 'Fictional stale archive' : 'Fictional current Secretary', sent_at: new Date().toISOString() }] });
  } });
  f.state.source = 'account'; loadedChat(f);
  const pending = f.loadMessages();
  f.state.source = 'secretary';
  await f.loadMessages();
  release(); await pending;
  assert.equal(f.state.loadedSource, 'secretary');
  assert.equal(f.state.messages[0].body, 'Fictional current Secretary');
  assert.ok(!f.state.markdown.includes('Fictional stale archive'));
  assert.equal(f.get('shareButton').disabled, false);
});

test('stale older-account pages cannot append after a source change or re-enable copying stale content', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = frontend(t, { fetcher: async path => {
    if (path.includes('before=')) { await gate; return Response.json({ messages: [{ message_id: 0, body: 'Fictional stale older page' }] }); }
    return Response.json({ messages: [{ message_id: 1, chat_id: CONTEXT_CHAT, body: 'Fictional Secretary after switch', sent_at: new Date().toISOString() }] });
  } });
  f.state.source = 'account'; loadedChat(f); f.state.nextCursor = 'fictional-cursor';
  const pending = f.loadOlder();
  f.state.source = 'secretary'; await f.loadMessages();
  release(); await pending;
  assert.deepEqual(f.state.messages.map(row => row.body), ['Fictional Secretary after switch']);
  assert.equal(f.state.loadedSource, 'secretary');
  assert.equal(f.get('olderButton').hidden, true);
  assert.ok(!f.state.markdown.includes('Fictional stale older page'));
});

test('account dialog pages append beyond 200 and stale searches cannot replace a newer result', async t => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = frontend(t, { fetcher: async path => {
    calls.push(path); const url = new URL(path, CONTEXT_ORIGIN);
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ message_id: 1, chat_id: url.searchParams.get('chat_id'), body: 'Fictional page message', sent_at: new Date().toISOString() }] });
    const search = url.searchParams.get('q');
    if (search === 'stale') { await gate; return Response.json({ chats: [{ chat_id: '999', chat_title: 'Fictional stale search' }] }); }
    if (search === 'новый') return Response.json({ chats: [{ chat_id: '850999', chat_title: 'Fictional fresh search' }] });
    const after = url.searchParams.get('after');
    return Response.json({ chats: Array.from({ length: after ? 5 : 200 }, (_, index) => ({
      chat_id: String(850000 + (after ? 200 : 0) + index), chat_title: `Fictional chat ${index}`, message_count: 1,
    })), next_chat_id: after ? null : '850199' });
  } });
  f.state.source = 'account'; await f.loadSourceChats();
  assert.equal(f.state.chats.length, 200);
  await f.loadSourceChats({ append: true });
  assert.equal(f.state.chats.length, 205); assert.equal(f.state.nextChatId, null);
  assert.ok(calls.some(path => path.includes('after=850199')));
  f.get('chatSearch').value = 'stale'; const pending = f.loadSourceChats();
  f.get('chatSearch').value = 'новый'; await f.loadSourceChats();
  release(); await pending;
  assert.equal(f.state.chats.length, 1); assert.equal(f.state.selectedChatId, '850999');
  assert.equal(f.state.loadedChatId, '850999');
});

test('unconfigured account status never advertises a connected archive or starts account reads', async t => {
  const calls = [];
  const f = frontend(t, { fetcher: async path => {
    calls.push(path);
    if (path.endsWith('/account/status')) return Response.json({ available: false, can_setup: true, enabled: false, status: 'setup_required' });
    if (path.endsWith('/chats')) return Response.json({ connected: false, chats: [] });
    assert.fail(`Unexpected account request: ${path}`);
  } });
  await f.loadAll();
  assert.equal(f.state.source, 'secretary');
  assert.equal(f.get('archiveSource').disabled, true);
  assert.equal(f.get('sourceSwitch').hidden, true);
  assert.equal(f.get('accountToggle').hidden, true);
  assert.equal(f.get('accountTitle').textContent, 'Архив аккаунта не подключён');
  assert.ok(!calls.some(path => path.includes('/account/chats') || path.includes('/account/messages')));
});

test('archive demo retains 2018 history and loads all 245 group messages without live network access', async t => {
  const f = frontend(t, { search: '?demo=1&archive=1' });
  await f.loadAll();
  assert.equal(f.state.source, 'account'); assert.equal(f.state.chats.length, 3);
  f.state.selectedChatId = '90002'; await f.loadMessages();
  assert.ok(f.state.messages.every(row => row.sent_at.startsWith('2018-')));
  f.state.selectedChatId = '90003'; await f.loadMessages();
  assert.equal(f.state.messages.length, 200); assert.ok(f.state.nextCursor);
  await f.loadOlder();
  assert.equal(f.state.messages.length, 245);
  assert.equal(new Set(f.state.messages.map(row => row.message_id)).size, 245);
  assert.deepEqual(plain(f.state.messages).map(row => row.message_id), Array.from({ length: 245 }, (_, index) => index + 1));
  assert.equal(f.state.nextCursor, null);
  await f.openShareDialog();
  assert.equal(f.get('shareConsent').checked, false);
  f.get('shareConsent').checked = true; await f.createShareLink(event());
  const url = new URL(f.get('shareList').querySelector('input').value);
  assert.equal(url.origin, 'https://example.invalid'); assert.ok(url.pathname.startsWith('/account-context-share/'));
});
