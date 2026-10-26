import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createContext, runInContext, Script } from "node:vm";
import test from "node:test";
import { CONTEXT_CHAT, CONTEXT_OTHER_CHAT, CONTEXT_ORIGIN, shareId } from "./context-db-fixture.mjs";

const read = name => readFileSync(new URL(`../cloudflare-worker/public/context/${name}`, import.meta.url), "utf8");
const html = read("index.html");
const js = read("context.js");
const plain = value => JSON.parse(JSON.stringify(value));
const event = () => ({ preventDefault() {} });
const shareDto = (extra = {}) => ({
  id: shareId(1), chat_id: CONTEXT_CHAT, message_limit: 20,
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
    crypto: webcrypto, Date, Intl, setTimeout: timer, clearTimeout: cancelTimer,
  });
  const source = js.replace(/\r?\nloadAll\(\);\s*$/, "\n");
  assert.notEqual(source, js, "Omit only automatic startup; keep event binding and application logic");
  runInContext(source, context);
  const api = runInContext("({ state, api, loadAll, loadMessages, renderMessages, checkedShare, openShareDialog, createShareLink, revokeShareLink, reloadShareLinks, copyMarkdown })", context);
  get("limitSelect").value = "20";
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
  f.state.messages = [{ chat_id: chatId, body: "Fictional private message", sent_at: new Date().toISOString() }];
  f.renderMessages();
}

test("context UI parses, has unique IDs, a share modal and explicit 1h/24h/7d choices", () => {
  assert.doesNotThrow(() => new Script(js));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of js.matchAll(/document\.querySelector\("#([^"]+)"\)/g)) assert.ok(ids.includes(id), id);
  for (const id of ["shareButton", "shareDialog", "shareForm", "shareWarning", "shareTarget", "shareList", "shareError", "createShareButton", "closeShare", "shareStatus"]) assert.ok(ids.includes(id));
  assert.match(html, /<dialog\b[^>]*id="shareDialog"/);
  const options = html.match(/<select id="shareTtl">([\s\S]*?)<\/select>/)?.[1];
  assert.deepEqual([...options.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ["1", "24", "168"]);
  assert.match(options, /value="24" selected/);
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
  for (const phrase of [/Любой/, /последние 20 сообщений/, /включая новые/, /не удаляет уже скачанные копии/]) assert.match(f.get("shareWarning").textContent, phrase);
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
  assert.equal(body.chat_id, CONTEXT_CHAT); assert.equal(body.limit, 20); assert.equal(body.ttl_hours, 24);
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

test("stale message and export responses cannot re-enable sharing for a different selected chat", async (t) => {
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
  assert.equal(f.state.markdown, `Fictional markdown ${CONTEXT_OTHER_CHAT}`);
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
