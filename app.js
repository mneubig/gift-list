"use strict";

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (n) => "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const newId = () => "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || newId();
const saved = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const toB64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromB64 = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
const APP_URL = location.origin + location.pathname.replace(/index\.html$/, "");

// ---------- state ----------
const cfg = {
  token: saved.get("gl_token") || "",
  owner: saved.get("gl_owner") || "mneubig",
  repo: saved.get("gl_repo") || "gift-list-data",
};
let data = JSON.parse(saved.get("gl_cache") || "null") || { people: [], items: [] };
let view = saved.get("gl_view") || "people";
let pasteOpen = null;
let giveOpen = null;
let pollTimer = null;

// Age lists hold go-to gifts for kids of an age. Their ideas are items with `age` set instead of `person`.
const DEFAULT_AGES = [{ id: "baby", label: "Baby" }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: String(n), label: `Age ${n}` }))];
const ageRank = (a) => (a.id === "baby" ? -1 : isNaN(+a.id) ? 1000 : +a.id);
const ages = () => [...(data.ages || DEFAULT_AGES)].sort((a, b) => ageRank(a) - ageRank(b));
const ageLabel = (id) => ages().find((a) => a.id === id)?.label;
const isAgeIdea = (i) => Boolean(i.age && ageLabel(i.age));

// Groups sort and color-code people. Colors are mid-tones that read on both light and dark backgrounds.
const COLORS = { red: "#d64545", orange: "#e08a2c", gold: "#c9a227", green: "#3f9a63", teal: "#2a9d9a", blue: "#3b7dd8", purple: "#8a5cc7", pink: "#d0559a", gray: "#8a8f98" };
const DEFAULT_GROUPS = [{ id: "family", label: "Family", color: "red" }, { id: "friends", label: "Friends", color: "blue" }, { id: "teachers", label: "Teachers", color: "gold" }];
let groupFilter = saved.get("gl_group") || "";
const groups = () => data.groups || DEFAULT_GROUPS;
const groupOf = (p) => groups().find((g) => g.id === p?.group);
const colorOf = (p) => COLORS[groupOf(p)?.color] || "transparent";
const groupOptions = (sel) => `<option value="">No group</option>` + groups().map((g) => `<option value="${esc(g.id)}"${g.id === sel ? " selected" : ""}>${esc(g.label)}</option>`).join("");

const personName = (id) => data.people.find((p) => p.id === id)?.name;
const isInbox = (i) => !isAgeIdea(i) && (!i.person || !personName(i.person));
const byId = (d, id) => d.items.find((i) => i.id === id);
// Ideas waiting on the GitHub Action. Ones older than 15 minutes are treated as done so a failed run never spins forever.
const recent = (i) => Date.now() - new Date(i.created || 0) < 15 * 60e3;
const isFiling = (i) => i.filing && recent(i);
const isSearching = (i) => i.link?.state === "searching" && (!i.link.since || Date.now() - i.link.since < 15 * 60e3);
const noLink = () => ({ state: "none", hits: [], i: 0, rejected: [] });
// Ideas you've ranked come first in your order; unranked ones follow, oldest first
const ranked = (items) => [...items].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || String(a.created || "").localeCompare(String(b.created || "")));

// Joint gifts: `person` is who it was first for, `also` lists anyone else it's shared with.
// It's one gift on every one of their cards; `ranks` keeps its place on each card.
const forPeople = (i) => [i.person, ...(i.also || [])].filter((id, n, a) => id && personName(id) && a.indexOf(id) === n);
const rankFor = (i, pid) => i.ranks?.[pid] ?? (pid === i.person ? i.rank : undefined);
const rankedFor = (items, pid) => [...items].sort((a, b) => (rankFor(a, pid) ?? Infinity) - (rankFor(b, pid) ?? Infinity) || String(a.created || "").localeCompare(String(b.created || "")));
const namesOf = (ids) => ids.map(personName).join(" + ");
const dotsOf = (ids) => ids.map((id) => `<span class="dot" style="--c:${colorOf(data.people.find((p) => p.id === id))}"></span>`).join("");
// Removing someone keeps joint gifts with whoever else they're for; solo gifts go to the inbox
function dropPerson(x, id) {
  x.people = x.people.filter((p) => p.id !== id);
  x.items.forEach((i) => {
    if (i.also) i.also = i.also.filter((y) => y !== id);
    if (i.person === id) i.person = i.also?.shift() || null;
    if (i.also && !i.also.length) delete i.also;
    if (i.ranks) delete i.ranks[id];
  });
}

// "Who or what is it for" picker values: p:<person id> or a:<age id>
function forOptions(withInbox) {
  const people = data.people.map((p) => `<option value="p:${p.id}">${esc(p.name)}</option>`).join("");
  const ageOpts = ages().map((a) => `<option value="a:${a.id}">${esc(a.label)}</option>`).join("");
  return (withInbox ? `<option value="">Inbox</option>` : "") +
    (people ? `<optgroup label="People">${people}</optgroup>` : "") +
    `<optgroup label="Age lists">${ageOpts}</optgroup>`;
}
function assignTo(it, value) {
  const [kind, id] = value ? [value.slice(0, 1), value.slice(2)] : [];
  it.person = kind === "p" ? id : null;
  it.age = kind === "a" ? id : null;
  if (it.age) it.status = "idea";
  if (!it.person) delete it.also;
  else if (it.also) it.also = it.also.filter((y) => y !== it.person);
}
const forValue = (it) => (isAgeIdea(it) ? "a:" + it.age : it.person && personName(it.person) ? "p:" + it.person : "");

// ---------- GitHub ----------
const gh = (path, opts) => api(`/repos/${cfg.owner}/${cfg.repo}${path}`, opts);
async function api(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub said ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function setSync(text, state) {
  const el = $("sync");
  el.title = text;
  el.setAttribute("aria-label", text);
  el.className = "sync " + (state || "");
}
// Tapping the dot explains it, and retries or opens Settings when something's wrong
$("sync").onclick = () => {
  if (!cfg.token) { toast("Your list is only on this device. Connect GitHub to back it up."); view = "settings"; render(); return; }
  if (isDirty()) { toast("Some changes aren't backed up yet. Trying again…"); load(); return; }
  toast($("sync").title === "Synced" ? "Everything is backed up" : $("sync").title);
};

// "1" while this device has changes GitHub doesn't have yet. Unset means a copy from before this
// flag existed, so anything in it is treated as not backed up.
const isDirty = () => (saved.get("gl_dirty") ?? (data.people.length || data.items.length ? "1" : "0")) === "1";
const setDirty = (on) => saved.set("gl_dirty", on ? "1" : "0");

// Folds this device's copy into GitHub's: anything only here is added, and this device's version
// wins for anything in both. Safe to run twice.
function mergeInto(x, local) {
  const defaults = { people: [], items: [], groups: DEFAULT_GROUPS, ages: DEFAULT_AGES, wish: [] };
  if (local.wishShare && !x.wishShare) x.wishShare = structuredClone(local.wishShare);
  for (const key of Object.keys(defaults)) {
    if (!local[key]) continue;
    x[key] ||= structuredClone(defaults[key]);
    for (const e of local[key]) {
      const at = x[key].findIndex((y) => y.id === e.id);
      if (at < 0) x[key].push(structuredClone(e));
      else x[key][at] = structuredClone(e);
    }
  }
}

async function load() {
  clearTimeout(pollTimer);
  if (!cfg.token) { setSync("Not backed up", "err"); render(); return; }
  setSync("Syncing…", "busy");
  try {
    const file = await gh("/contents/data.json");
    if (isDirty()) {
      // Never replace unsaved local changes with GitHub's copy: merge them in and save
      const local = data;
      data = JSON.parse(fromB64(file.content));
      await commit("Back up changes from this device", (x) => mergeInto(x, local));
    } else {
      data = JSON.parse(fromB64(file.content));
      saved.set("gl_cache", JSON.stringify(data));
      setSync("Synced", "ok");
    }
  } catch (e) {
    setSync(e.status === 401 ? "Token rejected. Check Settings." : e.status === 404 ? "Repo not found. Check Settings." : "Offline. Showing last sync.", "err");
  }
  renderSoon();
  // Keep checking while ideas are being filed or links are being searched
  if (data.items.some((i) => isFiling(i) || isSearching(i))) pollTimer = setTimeout(load, 6000);
}

// Applies a change locally right away, then to the latest data.json on GitHub (retrying if it changed underneath)
let saveQueue = Promise.resolve();
function commit(message, mutate) {
  mutate(data);
  saved.set("gl_cache", JSON.stringify(data));
  setDirty(true);
  render();
  if (!cfg.token) return saveQueue;
  saveQueue = saveQueue.then(async () => {
    setSync("Saving…", "busy");
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const file = await gh("/contents/data.json");
        const fresh = JSON.parse(fromB64(file.content));
        mutate(fresh);
        await gh("/contents/data.json", {
          method: "PUT",
          body: JSON.stringify({ message, sha: file.sha, content: toB64(JSON.stringify(fresh, null, 2) + "\n") }),
        });
        data = fresh;
        saved.set("gl_cache", JSON.stringify(data));
        setDirty(false);
        setSync("Synced", "ok");
        renderSoon();
        return;
      } catch (e) {
        if (e.status !== 409 && e.status !== 422) {
          const why = e.status === 401 ? "the token was rejected" : e.status === 403 || e.status === 404 ? "the token can't write to the data repo (check its Contents permission)" : "GitHub couldn't be reached";
          setSync("Not backed up", "err");
          toast(`Saved on this device only: ${why}. It'll back up on the next sync.`);
          renderSoon();
          return;
        }
      }
    }
    setSync("Not backed up", "err");
    toast("Saved on this device only. It'll back up on the next sync.");
  });
  return saveQueue;
}

// Starts the GitHub Action for one item: "file" tidies a new idea (who it's for, store, link), "search" finds product links.
// Runs after the save reaches GitHub so the Action can see the item; if that fails, the spinner is cleared instead.
function runAction(id, mode, saving) {
  const undo = (x) => {
    const it = byId(x, id);
    if (!it) return;
    if (mode === "file") it.filing = false;
    else if (it.link?.state === "searching") it.link.state = it.link.hits?.length ? "pending" : "notfound";
  };
  saving.then(async () => {
    if (!cfg.token || isDirty()) { commit("Stop waiting", undo); return; }
    try {
      await gh("/actions/workflows/process.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: "main", inputs: { item_id: id, mode } }) });
      clearTimeout(pollTimer);
      pollTimer = setTimeout(load, 6000);
    } catch (e) {
      commit("Stop waiting", undo);
      toast(e.status === 403 ? "The token can't start searches. Give it Actions: Read and write." : `Couldn't start it (${e.message})`);
    }
  });
}

// Adds an idea right away; the Action fills in the details in the background
// smart: send it to the Action to tidy up and find links (spoken ideas and shared pages). Typed ideas are kept as typed.
function addIdea(text, { person = null, age = null, source = "typed", url = null, title = null, smart = false } = {}) {
  const id = newId();
  const item = {
    id, person, age, what: (title || text).replace(/\s+/g, " ").slice(0, 100), note: "", status: "idea", price: null,
    source, raw: text, created: new Date().toISOString(), filing: smart && Boolean(cfg.token),
    link: url ? { state: "ok", url, store: host(url), hits: [], i: 0, rejected: [] } : noLink(),
  };
  const saving = commit("Add idea", (x) => { if (!byId(x, id)) x.items.push(structuredClone(item)); });
  if (smart && cfg.token) runAction(id, "file", saving);
  return id;
}

// Looks for product links, at one store when given, otherwise anywhere
function findLinks(id, store) {
  const saving = commit("Find links", (x) => {
    const it = byId(x, id);
    if (!it) return;
    const L = it.link || noLink();
    it.link = { ...L, state: "searching", since: Date.now(), store: store === undefined ? L.store : store || null };
  });
  if (!cfg.token) { toast("Connect GitHub in Settings to search for links"); return; }
  runAction(id, "search", saving);
}

// ---------- rendering ----------
function stats() {
  const xmas = new Date(new Date().getFullYear(), 11, 25);
  const days = Math.ceil((xmas - new Date()) / 864e5);
  $("countdown").textContent = days > 0 ? `${days} days until Dec 25` : "Happy holidays";
  const bought = data.items.filter((i) => i.status !== "idea" && !isAgeIdea(i));
  $("spent").textContent = money(bought.reduce((a, i) => a + (Number(i.price) || 0), 0));
  const covered = new Set(bought.flatMap(forPeople));
  $("todo").textContent = `${data.people.filter((p) => !covered.has(p.id)).length} of ${data.people.length}`;
  $("links").textContent = data.items.filter((i) => ["pending", "notfound"].includes(i.link?.state)).length;
  const inboxN = data.items.filter(isInbox).length;
  $("inboxCount").textContent = inboxN;
  $("inboxCount").hidden = !inboxN;
}

function linkBox(i) {
  const L = i.link;
  if (!L || L.state === "none" || L.state === "ok") return "";
  const where = L.store ? `at ${esc(L.store)}` : "online";
  if (L.state === "searching") {
    if (!isSearching(i)) return "";
    return `<div class="found"><div class="row"><span class="spinner"></span><span class="searching">Looking for links ${where}…</span></div></div>`;
  }
  const hit = L.state === "pending" ? L.hits?.[L.i] : null;
  const paste = pasteOpen === i.id
    ? `<div class="row"><input id="paste-${i.id}" type="url" placeholder="Paste a product link" aria-label="Product link"><button class="btn" data-pastesave="${i.id}">Save link</button></div>`
    : "";
  const body = hit
    ? `<div class="lbl">Is this the right link?</div><div class="hit"><a href="${esc(hit.url)}" target="_blank" rel="noopener">${esc(hit.title)}</a>
       <span class="meta">${esc(host(hit.url))}${hit.price != null ? " · " + money(hit.price) : ""} · ${L.i + 1} of ${L.hits.length}</span></div>`
    : `<div class="lbl">No link yet</div><div class="meta">Couldn't find it ${where}.${L.error ? " " + esc(L.error) : ""}</div>`;
  const buttons = hit
    ? `<button class="btn" data-use="${i.id}">Use this</button><button class="btn ghost" data-more="${i.id}">Keep searching</button>`
    : `<button class="btn ghost" data-more="${i.id}">Search again</button>`;
  const close = `<button class="xbtn close" data-nolink="${i.id}" aria-label="Close. You can find a link later." title="Close">×</button>`;
  return `<div class="found">${close}${body}<div class="row">${buttons}<button class="btn ghost" data-paste="${i.id}">Paste my own</button></div>${paste}</div>`;
}

function itemRow(i, showWho, sortable, cardFor) {
  const bits = [];
  if (showWho) {
    const ids = forPeople(i);
    bits.push(ids.length ? dotsOf(ids) + esc(namesOf(ids)) : "Inbox");
  }
  if (cardFor) {
    const others = forPeople(i).filter((id) => id !== cardFor);
    if (others.length) bits.push(`<span class="tag">with ${esc(namesOf(others))}</span>`);
  }
  if (i.link?.state === "ok" && i.link.url) bits.push(`<a href="${esc(i.link.url)}" target="_blank" rel="noopener">${esc(host(i.link.url))} ↗</a>`);
  if (i.status === "wrapped") bits.push("<span class='tag'>wrapped</span>");
  if (i.note) bits.push(esc(i.note));
  if (isFiling(i)) bits.push(`<span class="filing"><span class="spinner sm"></span>Filling in details…</span>`);
  else if (!i.link || i.link.state === "none") bits.push(`<button class="linkbtn" data-find="${i.id}">Find a link</button>`);
  const age = isAgeIdea(i);
  const done = i.status !== "idea";
  const check = age
    ? "<span></span>"
    : `<button class="check" data-buy="${i.id}" aria-pressed="${done}" aria-label="${done ? "Bought. Tap to undo" : "Mark as bought"}" title="${done ? "Bought" : "Mark as bought"}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg></button>`;
  const grip = sortable ? gripBtn(i) : "";
  return `<li class="item${sortable ? " sortable" : ""}${done && !age ? " done" : ""}" data-id="${i.id}">
    ${grip}${check}
    <div class="what"><button class="name" data-edit="${i.id}" title="Edit">${esc(i.what)}</button>${i.santa ? `<span class="santa" role="img" aria-label="From Santa" title="From Santa">🎅</span>` : ""}${i.stocking ? `<span class="santa" role="img" aria-label="Stocking stuffer" title="Stocking stuffer">${STOCKING}</span>` : ""}${bits.length ? `<small>${bits.join(" · ")}</small>` : ""}</div>
    <span class="price num">${i.price != null && i.price !== "" ? money(i.price) : ""}</span>
    <div class="acts">${age ? `<button class="chip give" data-give="${i.id}" title="Add to someone's list">Give</button>` : ""}<button class="xbtn" data-edit="${i.id}" aria-label="Edit ${esc(i.what)}" title="Edit, add a link, or delete">${PENCIL}</button></div>
    ${age && giveOpen === i.id ? giveBox(i) : ""}${linkBox(i)}</li>`;
}
const gripBtn = (i) => `<button class="grip" data-grip="${i.id}" aria-label="Move ${esc(i.what)}. Drag, or use the up and down arrow keys." title="Drag to reorder"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></button>`;

// A row on your own wish list: no bought check, no link search
function wishRow(w, sortable) {
  const bits = [];
  if (w.url) bits.push(`<a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(host(w.url))} ↗</a>`);
  if (w.note) bits.push(esc(w.note));
  return `<li class="item${sortable ? " sortable" : ""}" data-id="${w.id}">
    ${sortable ? gripBtn(w) : ""}<span></span>
    <div class="what"><button class="name" data-wishedit="${w.id}" title="Edit">${esc(w.what)}</button>${bits.length ? `<small>${bits.join(" · ")}</small>` : ""}</div>
    <span class="price num">${w.price != null && w.price !== "" ? money(w.price) : ""}</span>
    <div class="acts"><button class="xbtn" data-wishedit="${w.id}" aria-label="Edit ${esc(w.what)}" title="Edit or delete">${PENCIL}</button></div></li>`;
}
const STOCKING = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 6.5h8v7.2c0 .7-.3 1.4-.8 1.9l-3.6 3.6c-1.2 1.2-2.8 1.8-4.5 1.8H5.8C4.2 21 3 19.8 3 18.2c0-1.1.6-2.1 1.6-2.6L8 13.6z" fill="#d64545"/><rect x="7" y="2.5" width="10" height="4.5" rx="1.2" fill="#fff" stroke="#c9ced3" stroke-width=".8"/><path d="M3.9 16.6c1 .1 1.8.9 1.9 1.9M3.4 19.4" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" opacity=".85"/></svg>`;
const PENCIL = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>`;

function giveBox(i) {
  if (!data.people.length) return `<div class="found"><div class="meta">Add people on the People tab first.</div></div>`;
  const opts = data.people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  return `<div class="found"><div class="lbl">Add to this year's list</div>
    <div class="row"><select id="give-${i.id}" aria-label="Who is it for">${opts}</select><button class="btn" data-givesave="${i.id}">Add</button></div></div>`;
}

// Redraws from syncing wait while you're typing in a box on the page, then catch up once you leave it
const typingInView = () => { const a = document.activeElement; return Boolean(a && $("view").contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
let renderWaiting = false;
function renderSoon() {
  if (typingInView()) { renderWaiting = true; return; }
  render();
}
// The delay lets a tap on a button (like Add) finish before the page is rebuilt
document.addEventListener("focusout", () => setTimeout(() => { if (renderWaiting && !typingInView()) render(); }, 400));

function render() {
  // Don't rebuild the page under a finger mid-drag; it redraws when the drag ends
  if (drag) { drag.rerender = true; return; }
  renderWaiting = false;
  // If the page has to be rebuilt anyway, put back the box being typed in, its text and cursor
  const a = document.activeElement;
  const keep = a && a.id && $("view").contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)
    ? { id: a.id, value: a.value, start: a.selectionStart, end: a.selectionEnd } : null;
  // A focused drag handle keeps focus too, so arrow keys can keep moving the same row or card
  const grip = a?.matches?.(".grip") && $("view").contains(a) ? (a.dataset.pgrip ? `[data-pgrip="${a.dataset.pgrip}"]` : `[data-grip="${a.dataset.grip}"]`) : null;
  try { draw(); } finally {
    if (grip) $("view").querySelector(grip)?.focus();
    const el = keep && $(keep.id);
    if (el) { el.value = keep.value; el.focus(); try { el.setSelectionRange(keep.start, keep.end); } catch {} }
  }
}

function draw() {
  stats();
  saved.set("gl_view", view);
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.view === view));
  const v = $("view");

  if (view === "people") {
    const card = (p, movable) => {
      const its = data.items.filter((i) => forPeople(i).includes(p.id));
      const bought = its.filter((i) => i.status !== "idea");
      const spent = bought.reduce((a, i) => a + (Number(i.price) || 0), 0);
      const summary = !its.length ? "" : `${bought.length} of ${its.length} bought${spent ? " · " + money(spent) : ""}`;
      const grip = movable ? `<button class="grip pgrip" data-pgrip="${p.id}" aria-label="Move ${esc(p.name)}'s card. Drag, or use the arrow keys." title="Drag to move this card"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></button>` : "";
      return `<article class="panel person" data-id="${p.id}" style="--c:${colorOf(p)}"><div class="phead">${grip}<h3>${esc(p.name)}</h3><span class="budget num">${summary}</span>
        <button class="xbtn" data-editperson="${p.id}" aria-label="Edit ${esc(p.name)}" title="Edit name, group and notes">${PENCIL}</button></div>
        <ul class="items" data-person="${p.id}">${rankedFor(its, p.id).map((i) => itemRow(i, false, its.length > 1, p.id)).join("") || "<li class='empty'>No ideas yet</li>"}</ul>
        <button class="btn ghost addidea" data-addfor="${p.id}">+ Add idea</button></article>`;
    };
    // One section per group, then anyone without a group
    const sections = [...groups(), { id: "", label: "No group", color: "" }]
      .filter((g) => !groupFilter || g.id === groupFilter)
      .map((g) => {
        const ps = data.people.filter((p) => (groupOf(p)?.id || "") === g.id);
        if (!ps.length) return "";
        return `<section class="group"><h2 class="ghead"><span class="dot" style="--c:${COLORS[g.color] || "var(--muted)"}"></span>${esc(g.label)} <span class="meta">${ps.length}</span></h2>
          <div class="grid" data-cards="1">${ps.map((p) => card(p, ps.length > 1)).join("")}</div></section>`;
      }).join("");
    const filters = data.people.length
      ? `<div class="filters">${[{ id: "", label: "Everyone" }, ...groups()].map((g) => `<button class="filter" data-group="${esc(g.id)}" aria-pressed="${g.id === groupFilter}">${g.color ? `<span class="dot" style="--c:${COLORS[g.color]}"></span>` : ""}${esc(g.label)}</button>`).join("")}</div>`
      : "";
    const add = `<form class="row addperson" id="addPerson"><input id="newPerson" placeholder="Add someone" aria-label="Name"><select id="newPersonGroup" aria-label="Group">${groupOptions(groupFilter)}</select><button class="btn">Add</button></form>`;
    const intro = !data.people.length && !data.items.length
      ? `<div class="panel"><h2>Start your list</h2><p>Add someone above, then tap <b>+ Add idea</b> on their card.</p></div>`
      : "";
    v.innerHTML = intro + add + filters + (sections || (groupFilter ? `<p class="empty">No one in this group yet.</p>` : ""));
  } else if (view === "ages") {
    const cards = ages().map((a) => {
      const its = data.items.filter((i) => i.age === a.id);
      return `<article class="panel"><div class="phead"><h3>${esc(a.label)}</h3><span class="budget num">${its.length} idea${its.length === 1 ? "" : "s"}</span></div>
        <ul class="items">${ranked(its).map((i) => itemRow(i, false, its.length > 1)).join("") || "<li class='empty'>No go-to gifts yet</li>"}</ul>
        <form class="row addAgeIdea" data-age="${esc(a.id)}" style="margin-top:8px"><input id="ageadd-${esc(a.id)}" placeholder="Add a gift" aria-label="Add a gift for ${esc(a.label)}"><button class="btn ghost">Add</button></form></article>`;
    }).join("");
    const add = `<form class="panel" id="addAge"><h3>Add an age</h3><div class="row" style="margin-top:8px"><input id="newAge" placeholder="7, or a label like Teen" aria-label="Age"><button class="btn">Add</button></div></form>`;
    const intro = `<p class="meta" style="margin:0 0 12px">Your go-to gifts for each age, kept year to year. Tap <b>Give</b> to add one to someone's list.</p>`;
    v.innerHTML = intro + `<div class="grid">${cards}${add}</div>`;
  } else if (view === "inbox") {
    const opts = forOptions(false);
    const items = data.items.filter(isInbox).map((i) => `<div class="panel">
      <ul class="items">${itemRow(i)}</ul>
      ${i.raw && i.raw !== i.what ? `<p class="meta" style="margin:6px 0 8px">You said: “${esc(i.raw)}”</p>` : ""}
      <div class="row"><select id="file-${i.id}" aria-label="Who is it for">${opts}</select><button class="btn" data-file="${i.id}">File it</button>
      <button class="btn danger" data-drop="${i.id}">Delete</button></div></div>`).join("");
    v.innerHTML = items || `<p class="empty">Inbox is clear. Ideas that don't name anyone and pages you share land here.</p>`;
  } else if (view === "shop") {
    const gifts = data.items.filter((i) => !isAgeIdea(i) && !isInbox(i));
    const todo = gifts.filter((i) => i.status === "idea");
    // Bought gifts listed under each person, so it's clear who already has something
    // Joint gifts get their own heading (like "Kimi + Enzo") so each is listed once
    const byWho = new Map();
    for (const i of gifts.filter((g) => g.status !== "idea")) {
      const ids = forPeople(i);
      const key = ids.join("+");
      if (!byWho.has(key)) byWho.set(key, { ids, its: [] });
      byWho.get(key).its.push(i);
    }
    const first = (ids) => Math.min(...ids.map((id) => data.people.findIndex((p) => p.id === id)));
    const boughtBy = [...byWho.values()].sort((a, b) => first(a.ids) - first(b.ids) || a.ids.length - b.ids.length);
    const total = boughtBy.reduce((a, g) => a + g.its.length, 0);
    v.innerHTML = `<div class="panel"><div class="phead"><h3>Still to buy</h3><span class="budget num">${todo.length} idea${todo.length === 1 ? "" : "s"}</span></div>
      <ul class="items">${todo.map((i) => itemRow(i, true)).join("") || "<li class='empty'>Everything is bought.</li>"}</ul></div>
      <div class="panel"><div class="phead"><h3>Already bought</h3><span class="budget num">${total} gift${total === 1 ? "" : "s"}</span></div>
      ${boughtBy.map(({ ids, its }) => `<h4 class="who">${dotsOf(ids)}${esc(namesOf(ids))}</h4><ul class="items">${its.map((i) => itemRow(i)).join("")}</ul>`).join("") || "<p class='empty'>Nothing bought yet. Tap the circle next to a gift to mark it bought.</p>"}</div>`;
  } else if (view === "wish") {
    const list = ranked(data.wish || []);
    const share = data.wishShare || {};
    const link = share.gist ? WISH_URL + share.gist : "";
    const add = `<form class="panel" id="addWish"><h3>Add something you'd like</h3><div class="row" style="margin-top:8px">
      <input id="newWish" placeholder="Wool socks, size M" aria-label="What you'd like"><input id="newWishLink" inputmode="url" autocomplete="off" placeholder="Link (optional)" aria-label="Link"><button class="btn">Add</button></div></form>`;
    const items = `<div class="panel"><div class="phead"><h3>My wish list</h3><span class="budget num">${list.length} thing${list.length === 1 ? "" : "s"}</span></div>
      <ul class="items" data-kind="wish">${list.map((w) => wishRow(w, list.length > 1)).join("") || "<li class='empty'>Nothing yet. Add what you'd like above.</li>"}</ul></div>`;
    const shareBox = `<div class="panel"><h2>Share it</h2>
      <p>People with the link see only this list, in this order. Nothing else from your Gift List.</p>
      <label class="field">Title on the shared page<input id="wishTitle" value="${esc(share.title || "My wish list")}"></label>
      ${link
        ? `<div class="row" style="margin-top:10px"><input id="wishLink" readonly value="${esc(link)}" aria-label="Share link"><button class="btn" data-wishcopy="1">Copy link</button>${navigator.share ? `<button class="btn ghost" data-wishshare="1">Share</button>` : ""}</div>
          <p class="meta" style="margin-top:8px">${esc(wishStatus || "The shared page updates on its own when you change your list.")} <a href="${esc(link)}" target="_blank" rel="noopener">Preview</a> · <button class="linkbtn" data-wishstop="1">Stop sharing</button></p>`
        : `<div class="row" style="margin-top:10px"><button class="btn" data-wishmake="1">Make a share link</button></div>${wishStatus ? `<p class="meta" style="margin-top:8px">${esc(wishStatus)}</p>` : ""}`}
    </div>`;
    v.innerHTML = add + items + shareBox;
  } else {
    const mark = `javascript:void(open('${APP_URL}?title='+encodeURIComponent(document.title)+'&url='+encodeURIComponent(location.href)))`;
    v.innerHTML = `
      <form class="panel settings" id="connect">
        <h2>GitHub connection</h2>
        <p>Your list is saved in a private GitHub repo. Each device needs the access token once.</p>
        <label class="field">Access token<input id="cfgToken" type="password" autocomplete="off" value="${esc(cfg.token)}" placeholder="github_pat_…"></label>
        <div class="two">
          <label class="field">GitHub username<input id="cfgOwner" value="${esc(cfg.owner)}"></label>
          <label class="field">Data repo<input id="cfgRepo" value="${esc(cfg.repo)}"></label>
        </div>
        <div class="row"><button class="btn">Save and connect</button><span class="meta" id="connectMsg"></span></div>
      </form>
      <div class="panel settings">
        <h2>People</h2>
        ${data.people.map((p) => `<div class="row"><span style="flex:1"><span class="dot" style="--c:${colorOf(p)}"></span>${esc(p.name)}</span><select data-persongroup="${p.id}" aria-label="Group for ${esc(p.name)}">${groupOptions(p.group)}</select><button class="btn danger" data-unperson="${p.id}">Remove</button></div>`).join("") || "<p>No one yet. Add people on the People tab, or just name them when you add an idea.</p>"}
      </div>
      <div class="panel settings">
        <h2>Groups</h2>
        <p>Tap a color dot to change it.</p>
        ${groups().map((g) => `<div class="row"><button class="swatch" data-gcolor="${esc(g.id)}" style="--c:${COLORS[g.color] || COLORS.gray}" aria-label="Change color for ${esc(g.label)}"></button><span style="flex:1">${esc(g.label)}</span><button class="btn danger" data-ungroup="${esc(g.id)}">Remove</button></div>`).join("")}
        <form class="row" id="addGroup"><input id="newGroup" placeholder="New group, like Neighbors" aria-label="New group"><button class="btn">Add</button></form>
      </div>
      <div class="panel settings">
        <h2>Age lists</h2>
        ${ages().map((a) => `<div class="row"><span style="flex:1">${esc(a.label)}</span><button class="btn danger" data-unage="${esc(a.id)}">Remove</button></div>`).join("")}
      </div>
      <div class="panel settings">
        <h2>Send pages from your computer</h2>
        <p>Drag this button to your bookmarks bar. On any product page, click it to add that page to your inbox.</p>
        <div><a class="bookmarklet" href="${esc(mark)}">Add to Gift List</a></div>
      </div>
      <div class="panel settings">
        <h2>On your Android phone</h2>
        <p>Open this page in Chrome, tap the menu, then <b>Add to Home screen</b> and choose <b>Install</b>.</p>
        <p>Long-press the Gift List icon and drag <b>Voice idea</b> to your home screen for a one-tap mic button.</p>
        <p>In Amazon or any app, tap <b>Share</b> and pick <b>Gift List</b> to send a product straight to your inbox.</p>
      </div>
      <div class="panel settings">
        <h2>Backup</h2>
        <p>Once you're connected, every change is saved to your private <b>${esc(cfg.repo)}</b> repo on GitHub. Every device you connect sees the same list, and app updates never touch it. GitHub keeps every past version${cfg.token ? ` in the <a href="https://github.com/${esc(cfg.owner)}/${esc(cfg.repo)}/commits/main/data.json" target="_blank" rel="noopener">history</a>` : ""}.</p>
        <div class="row"><button class="btn ghost" data-export="1">Download a copy</button><label class="btn ghost">Restore from a copy<input type="file" id="importFile" accept="application/json,.json" hidden></label></div>
        <p class="meta">Restoring adds what's in the file to your list. It doesn't delete anything.</p>
      </div>`;
  }
  if (!cfg.token) setSync("Not backed up", "err");
}

// ---------- events ----------
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-view],[data-buy],[data-find],[data-file],[data-drop],[data-use],[data-more],[data-paste],[data-pastesave],[data-edit],[data-unperson],[data-give],[data-givesave],[data-unage],[data-group],[data-gcolor],[data-ungroup],[data-addfor],[data-export],[data-editperson],[data-wishedit],[data-wishmake],[data-wishcopy],[data-wishshare],[data-wishstop],[data-nolink]");
  if (!t) return;
  const d = t.dataset;
  if (d.view) { view = d.view; render(); }
  else if (d.export) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `gift-list-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  else if (d.group !== undefined) { groupFilter = d.group; saved.set("gl_group", groupFilter); render(); }
  else if (d.gcolor) {
    const keys = Object.keys(COLORS);
    commit("Change group color", (x) => {
      x.groups ||= structuredClone(DEFAULT_GROUPS);
      const g = x.groups.find((y) => y.id === d.gcolor);
      if (g) g.color = keys[(keys.indexOf(g.color) + 1) % keys.length];
    });
  } else if (d.ungroup) {
    commit("Remove group", (x) => {
      x.groups = (x.groups || DEFAULT_GROUPS).filter((g) => g.id !== d.ungroup);
      x.people.forEach((p) => { if (p.group === d.ungroup) p.group = null; });
    });
    if (groupFilter === d.ungroup) { groupFilter = ""; saved.set("gl_group", ""); }
  }
  else if (d.find) findLinks(d.find);
  else if (d.buy) {
    const nowBought = byId(data, d.buy)?.status === "idea";
    commit(nowBought ? "Mark bought" : "Mark not bought", (x) => {
      const it = byId(x, d.buy);
      if (it) it.status = nowBought ? "bought" : "idea";
    });
  } else if (d.use) {
    commit("Confirm link", (x) => {
      const it = byId(x, d.use);
      const hit = it?.link?.hits?.[it.link.i];
      if (!hit) return;
      it.link = { ...it.link, state: "ok", url: hit.url };
      if ((it.price == null || it.price === "") && hit.price != null) it.price = hit.price;
    });
    toast("Link saved");
  } else if (d.more) {
    const it = byId(data, d.more);
    const L = it?.link;
    if (L?.state === "pending" && L.i + 1 < L.hits.length) {
      commit("Next link", (x) => {
        const y = byId(x, d.more);
        if (y?.link) { y.link.rejected = [...(y.link.rejected || []), y.link.hits[y.link.i].url]; y.link.i++; }
      });
    } else findLinks(d.more);
  } else if (d.paste) {
    pasteOpen = pasteOpen === d.paste ? null : d.paste;
    render();
    $("paste-" + d.paste)?.focus();
  } else if (d.pastesave) {
    const input = $("paste-" + d.pastesave);
    const url = input.value.trim();
    if (!/^https?:\/\/\S+\.\S+/.test(url)) { input.focus(); toast("Paste a full link that starts with https://"); return; }
    pasteOpen = null;
    commit("Add link", (x) => {
      const it = byId(x, d.pastesave);
      if (it) it.link = { ...(it.link || {}), state: "ok", url, store: host(url) };
    });
    toast("Link saved");
  } else if (d.file) {
    const to = $("file-" + d.file).value;
    commit("File idea", (x) => { const it = byId(x, d.file); if (it) assignTo(it, to); });
    toast("Filed under " + (personName(to.slice(2)) || ageLabel(to.slice(2))));
  } else if (d.give) {
    giveOpen = giveOpen === d.give ? null : d.give;
    render();
  } else if (d.givesave) {
    const person = $("give-" + d.givesave).value;
    giveOpen = null;
    // Copies the idea onto the person's list; the age list keeps its own copy for next time
    commit("Give age idea", (x) => {
      const src = byId(x, d.givesave);
      if (src) x.items.push({ ...structuredClone(src), id: newId(), person, age: null, status: "idea", rank: undefined, created: new Date().toISOString() });
    });
    toast("Added to " + personName(person) + "'s list");
  } else if (d.unage) {
    const n = data.items.filter((i) => i.age === d.unage).length;
    if (n && !confirm(`Remove ${ageLabel(d.unage)}? Its ${n} idea${n > 1 ? "s" : ""} will move to the inbox.`)) return;
    commit("Remove age list", (x) => {
      x.ages = (x.ages || DEFAULT_AGES).filter((a) => a.id !== d.unage);
      x.items.forEach((i) => { if (i.age === d.unage) i.age = null; });
    });
  } else if (d.drop) {
    commit("Delete idea", (x) => { x.items = x.items.filter((i) => i.id !== d.drop); });
  } else if (d.edit) openEdit(d.edit);
  else if (d.addfor) openCapture(false, d.addfor);
  else if (d.wishedit) openWish(d.wishedit);
  else if (d.nolink) {
    // Closes the suggestions; the gift goes back to showing "Find a link", and these links won't be suggested again
    if (pasteOpen === d.nolink) pasteOpen = null;
    commit("Dismiss links", (x) => {
      const it = byId(x, d.nolink);
      if (!it?.link) return;
      const seen = (it.link.hits || []).map((h) => h.url);
      it.link = { ...noLink(), store: it.link.store, rejected: [...new Set([...(it.link.rejected || []), ...seen])] };
    });
  }
  else if (d.wishmake) makeWishLink();
  else if (d.wishstop) stopWishLink();
  else if (d.wishcopy) {
    const url = $("wishLink").value;
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(() => toast("Link copied"))
      .catch(() => { $("wishLink").select(); toast("Press Ctrl+C to copy"); });
  } else if (d.wishshare) {
    navigator.share({ title: data.wishShare?.title || "My wish list", url: $("wishLink").value }).catch(() => {});
  }
  else if (d.editperson) openPerson(d.editperson);
  else if (d.unperson) {
    const n = data.items.filter((i) => i.person === d.unperson && !forPeople(i).some((y) => y !== d.unperson)).length;
    if (!confirm(`Remove ${personName(d.unperson)}?${n ? ` Their ${n} idea${n > 1 ? "s" : ""} will move to the inbox.` : ""}`)) return;
    commit("Remove person", (x) => {
      dropPerson(x, d.unperson);
    });
    toast("Removed. Their ideas moved to the inbox.");
  }
});

document.addEventListener("submit", async (e) => {
  if (e.target.classList.contains("addAgeIdea")) {
    e.preventDefault();
    const input = e.target.querySelector("input");
    const what = input.value.trim();
    const age = e.target.dataset.age;
    if (!what) return;
    input.value = "";
    if (!data.ages) commit("Save age lists", (x) => { x.ages ||= structuredClone(DEFAULT_AGES); });
    addIdea(what, { age });
  } else if (e.target.id === "addWish") {
    e.preventDefault();
    const what = $("newWish").value.trim();
    if (!what) { $("newWish").focus(); return; }
    const w = { id: newId(), what, url: fixUrl($("newWishLink").value), price: null, note: "", created: new Date().toISOString() };
    $("newWish").value = "";
    $("newWishLink").value = "";
    commit("Add to wish list", (x) => { x.wish ||= []; if (!x.wish.some((y) => y.id === w.id)) x.wish.push(w); });
    publishSoon();
  } else if (e.target.id === "addAge") {
    e.preventDefault();
    const text = $("newAge").value.trim();
    if (!text) return;
    $("newAge").value = "";
    const id = /^\d+$/.test(text) ? text : slug(text);
    const label = /^\d+$/.test(text) ? `Age ${text}` : text;
    if (ageLabel(id)) { toast(`${label} is already there`); return; }
    commit(`Add ${label}`, (x) => {
      x.ages ||= structuredClone(DEFAULT_AGES);
      if (!x.ages.some((a) => a.id === id)) x.ages.push({ id, label });
    });
  } else if (e.target.id === "addPerson") {
    e.preventDefault();
    const name = $("newPerson").value.trim();
    if (!name) return;
    if (data.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) { toast(`${name} is already on the list`); return; }
    const group = $("newPersonGroup").value || null;
    $("newPerson").value = "";
    commit(`Add ${name}`, (x) => {
      if (!x.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) x.people.push({ id: slug(name), name, group });
    });
  } else if (e.target.id === "addGroup") {
    e.preventDefault();
    const label = $("newGroup").value.trim();
    const id = slug(label);
    if (!label) return;
    $("newGroup").value = "";
    if (groups().some((g) => g.id === id)) { toast(`${label} is already a group`); return; }
    // Next color not yet used by another group
    const used = groups().map((g) => g.color);
    const color = Object.keys(COLORS).find((k) => !used.includes(k)) || "gray";
    commit(`Add group ${label}`, (x) => {
      x.groups ||= structuredClone(DEFAULT_GROUPS);
      if (!x.groups.some((g) => g.id === id)) x.groups.push({ id, label, color });
    });
  } else if (e.target.id === "connect") {
    e.preventDefault();
    cfg.token = $("cfgToken").value.trim();
    cfg.owner = $("cfgOwner").value.trim();
    cfg.repo = $("cfgRepo").value.trim();
    saved.set("gl_token", cfg.token);
    saved.set("gl_owner", cfg.owner);
    saved.set("gl_repo", cfg.repo);
    $("connectMsg").textContent = "Connecting…";
    try {
      await gh("/contents/data.json");
      toast("Connected to GitHub");
      view = "people";
      load();
    } catch (err) {
      $("connectMsg").textContent = err.status === 401 ? "That token was rejected." : err.status === 404 ? `Couldn't find ${cfg.owner}/${cfg.repo}, or the token can't see it.` : "Couldn't reach GitHub.";
    }
  }
});

// ---------- capture sheet ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let autoSaveTimer = null;
let captureFor = null; // person id when opened from a person's card
let spoke = false; // true once the mic has heard something this time

function openCapture(listenNow, personId = null) {
  captureFor = personId;
  spoke = false;
  const name = personName(personId);
  $("captureTitle").textContent = name ? `Gift idea for ${name}` : "New gift idea";
  $("captureScrim").hidden = false;
  $("memoText").value = "";
  $("micHint").textContent = name ? "Type the gift, or tap the mic to say it. Say a store and a link is found for you." : "Typed ideas go to your inbox. Tap the mic to say who it's for and it's filed for you.";
  $("memoText").placeholder = name ? "Linen apron from Anthropologie" : "Leo wants the Lego orchid set from Target";
  if (listenNow) listen(true);
  else setTimeout(() => $("memoText").focus(), 50);
}
function closeCapture() {
  $("captureScrim").hidden = true;
  clearTimeout(autoSaveTimer);
  if (rec) rec.abort();
}
function listen(autoSave) {
  clearTimeout(autoSaveTimer);
  if (!SR) {
    $("micHint").textContent = "This browser can't listen. Type it, or use your keyboard's mic.";
    $("memoText").focus();
    return;
  }
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  const before = $("memoText").value.trim();
  rec.onresult = (ev) => {
    const said = [...ev.results].map((r) => r[0].transcript).join("");
    spoke = true;
    $("memoText").value = (before ? before + " " : "") + said;
  };
  rec.onerror = (ev) => {
    $("micHint").textContent = ev.error === "not-allowed" ? "The microphone is blocked. Allow it in Chrome's site settings." : "Didn't catch that. Tap the mic to try again.";
  };
  rec.onend = () => {
    rec = null;
    $("micBtn").classList.remove("live");
    if (autoSave && $("memoText").value.trim()) {
      $("micHint").textContent = "Saving in 2 seconds. Tap the text to edit instead.";
      autoSaveTimer = setTimeout(() => $("captureForm").requestSubmit(), 2000);
    } else if ($("micHint").textContent === "Listening…") {
      $("micHint").textContent = "Tap the mic to add more.";
    }
  };
  rec.start();
  $("micBtn").classList.add("live");
  $("micHint").textContent = "Listening…";
}

$("fab").onclick = () => openCapture(false);
$("micBtn").onclick = () => listen(false);
$("memoText").addEventListener("focus", () => clearTimeout(autoSaveTimer));
$("captureCancel").onclick = closeCapture;
$("captureScrim").addEventListener("click", (e) => { if (e.target.id === "captureScrim") closeCapture(); });
$("captureForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("memoText").value.trim();
  if (!text) { $("memoText").focus(); return; }
  const person = captureFor;
  closeCapture();
  addIdea(text, { person, source: spoke ? "voice" : "typed", smart: spoke });
  toast(person ? `Added for ${personName(person)}` : spoke ? "Added. Working out who it's for…" : "Added to your inbox");
});

// ---------- edit sheet ----------
let editing = null;
function openEdit(id) {
  const it = byId(data, id);
  if (!it) return;
  editing = id;
  $("editWhat").value = it.what;
  $("editPerson").innerHTML = forOptions(true);
  $("editPerson").value = forValue(it);
  fillAlso(it.also || []);
  syncStatusField();
  $("editPrice").value = it.price ?? "";
  $("editStatus").value = it.status;
  $("editLink").value = it.link?.state === "ok" ? it.link.url || "" : "";
  $("editStore").value = it.link?.store && it.link.state !== "ok" ? it.link.store : "";
  $("editNote").value = it.note || "";
  $("editSanta").checked = Boolean(it.santa);
  $("editStocking").checked = Boolean(it.stocking);
  $("editCopyTo").innerHTML = forOptions(false);
  $(`editCopyTo`).querySelector(`option[value="${forValue(it)}"]`)?.remove();
  syncOpenLink();
  $("editScrim").hidden = false;
}
function syncOpenLink() {
  const url = $("editLink").value.trim();
  $("editOpen").hidden = !/^https?:\/\//.test(url);
  $("editOpen").href = url;
}
$("editLink").addEventListener("input", syncOpenLink);
// Copies the gift, as currently shown in the panel, onto another person's list (or an age list) as a new idea
$("editCopy").onclick = () => {
  const src = byId(data, editing);
  const to = $("editCopyTo").value;
  if (!src || !to) return;
  const copy = { ...structuredClone(src), id: newId(), what: $("editWhat").value.trim() || src.what, note: $("editNote").value.trim(), status: "idea", filing: false, rank: undefined, ranks: undefined, also: undefined, created: new Date().toISOString() };
  if (copy.link?.state === "searching") copy.link = noLink();
  assignTo(copy, to);
  commit("Copy idea", (x) => { if (!byId(x, copy.id)) x.items.push(structuredClone(copy)); });
  toast(`Copied to ${personName(to.slice(2)) || ageLabel(to.slice(2))}`);
};

// Saves what's in the panel, then starts a link search for it
$("editFind").onclick = () => {
  const id = editing;
  const store = $("editStore").value.trim();
  $("editForm").requestSubmit();
  findLinks(id, store);
  toast(store ? `Looking at ${store}…` : "Looking online…");
};
const closeEdit = () => { $("editScrim").hidden = true; editing = null; };
// Age-list ideas are never bought themselves, so they have no status
function syncStatusField() { $("editStatusField").hidden = $("editPerson").value.startsWith("a:"); }
$("editPerson").onchange = () => { syncStatusField(); fillAlso(alsoChecked()); };
// "Also for" checkboxes make it a joint gift; they only apply when it's for a person
const alsoChecked = () => [...$("editAlso").querySelectorAll("input:checked")].map((c) => c.value);
function fillAlso(checked) {
  const v = $("editPerson").value;
  const primary = v.startsWith("p:") ? v.slice(2) : null;
  $("editAlsoField").hidden = !primary || data.people.length < 2;
  $("editAlso").innerHTML = data.people.filter((p) => p.id !== primary)
    .map((p) => `<label class="tick sm"><input type="checkbox" value="${p.id}"${checked.includes(p.id) ? " checked" : ""}> ${esc(p.name)}</label>`).join("");
}
$("editCancel").onclick = closeEdit;
$("editScrim").addEventListener("click", (e) => { if (e.target.id === "editScrim") closeEdit(); });
$("editDelete").onclick = () => {
  const id = editing;
  if (!confirm(`Delete "${byId(data, id)?.what}"?`)) return;
  closeEdit();
  commit("Delete idea", (x) => { x.items = x.items.filter((i) => i.id !== id); });
  toast("Deleted");
};
$("editForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = editing;
  const priceText = $("editPrice").value.replace(/[$,\s]/g, "");
  const fields = {
    what: $("editWhat").value.trim(),
    price: priceText === "" || isNaN(+priceText) ? null : +priceText,
    status: $("editStatus").value,
    note: $("editNote").value.trim(),
    santa: $("editSanta").checked,
    stocking: $("editStocking").checked,
  };
  const to = $("editPerson").value;
  const also = $("editAlsoField").hidden ? [] : alsoChecked();
  let url = $("editLink").value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  closeEdit();
  commit("Edit idea", (x) => {
    const it = byId(x, id);
    if (!it) return;
    Object.assign(it, fields);
    it.also = also;
    assignTo(it, to);
    if (!it.also?.length) delete it.also;
    const had = it.link?.state === "ok" ? it.link.url : "";
    if (url && url !== had) it.link = { ...(it.link || {}), state: "ok", url, store: host(url) };
    else if (!url && had) it.link = { ...noLink(), rejected: it.link.rejected || [] };
  });
});

// ---------- reordering ----------
// Saves the order of a list's rows as each idea's rank
function saveOrder(list) {
  const ids = [...list.querySelectorAll(":scope > .item[data-id]")].map((li) => li.dataset.id);
  const pid = list.dataset.person;
  const wish = list.dataset.kind === "wish";
  commit("Reorder ideas", (x) => ids.forEach((id, rank) => { const it = wish ? x.wish?.find((w) => w.id === id) : byId(x, id);
    if (!it) return;
    if (pid) it.ranks = { ...(it.ranks || {}), [pid]: rank };
    if (!pid || pid === it.person) it.rank = rank;
  }));
  if (wish) publishSoon();
}

// Saves the order of a group's cards as the order of the people list; people in other groups keep their places
function savePeopleOrder(grid) {
  const ids = [...grid.querySelectorAll(":scope > .person[data-id]")].map((c) => c.dataset.id);
  commit("Reorder people", (x) => {
    const slots = x.people.map((p, n) => (ids.includes(p.id) ? n : -1)).filter((n) => n >= 0);
    const moved = ids.map((id) => x.people.find((p) => p.id === id)).filter(Boolean);
    slots.forEach((slot, k) => { x.people[slot] = moved[k]; });
  });
}

// Drag by the grip with a finger or mouse; the row moves live as you pass other rows
let drag = null;
document.addEventListener("pointerdown", (e) => {
  const grip = e.target.closest(".grip");
  if (!grip || e.button > 0) return;
  e.preventDefault();
  const li = grip.closest(".item, .person");
  const card = li.classList.contains("person");
  drag = { li, card, sel: card ? ":scope > .person[data-id]" : ":scope > .item[data-id]", list: li.parentElement, before: li.nextElementSibling, pointer: e.pointerId };
  grip.setPointerCapture?.(e.pointerId);
  li.classList.add("dragging");
});
document.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointer) return;
  e.preventDefault();
  const rows = [...drag.list.querySelectorAll(drag.sel)].filter((r) => r !== drag.li);
  const next = drag.card
    ? rows.find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top || (e.clientY < b.bottom && e.clientX < b.left + b.width / 2); })
    : rows.find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
  if (next !== drag.li.nextElementSibling) drag.list.insertBefore(drag.li, next || null);
});
function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.pointer)) return;
  const { li, list, before, rerender, card } = drag;
  li.classList.remove("dragging");
  drag = null;
  if (li.nextElementSibling !== before) (card ? savePeopleOrder : saveOrder)(list);
  else if (rerender) render();
}
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);
// Keyboard: arrow keys on a focused grip move the row one place
document.addEventListener("keydown", (e) => {
  const grip = e.target.closest?.(".grip");
  if (!grip) return;
  const li = grip.closest(".item, .person");
  const card = li.classList.contains("person");
  // Cards sit in a grid, so left/right move them too
  const up = e.key === "ArrowUp" || (card && e.key === "ArrowLeft");
  const down = e.key === "ArrowDown" || (card && e.key === "ArrowRight");
  if (!up && !down) return;
  e.preventDefault();
  const sib = up ? li.previousElementSibling : li.nextElementSibling?.nextElementSibling ?? null;
  if (up && !sib) return;
  if (down && !li.nextElementSibling) return;
  const id = li.dataset.id;
  li.parentElement.insertBefore(li, sib);
  (card ? savePeopleOrder : saveOrder)(li.parentElement);
  $("view").querySelector(`.grip[data-${card ? "pgrip" : "grip"}="${id}"]`)?.focus();
});

// ---------- person panel ----------
let editingPerson = null;
function openPerson(id) {
  const p = data.people.find((x) => x.id === id);
  if (!p) return;
  editingPerson = id;
  $("personTitle").textContent = p.name;
  $("personName").value = p.name;
  $("personGroup").innerHTML = groupOptions(groupOf(p)?.id);
  $("personNotes").value = p.notes || "";
  $("personScrim").hidden = false;
}
const closePerson = () => { $("personScrim").hidden = true; editingPerson = null; };
$("personCancel").onclick = closePerson;
$("personScrim").addEventListener("click", (e) => { if (e.target.id === "personScrim") closePerson(); });
$("personDelete").onclick = () => {
  const id = editingPerson;
  const n = data.items.filter((i) => i.person === id && !forPeople(i).some((y) => y !== id)).length;
  if (!confirm(`Remove ${personName(id)}?${n ? ` Their ${n} idea${n > 1 ? "s" : ""} will move to the inbox.` : ""}`)) return;
  closePerson();
  commit("Remove person", (x) => {
    dropPerson(x, id);
  });
  toast("Removed. Their ideas moved to the inbox.");
};
$("personForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = editingPerson;
  const name = $("personName").value.trim();
  if (data.people.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) { toast(`${name} is already on the list`); return; }
  const fields = { name, group: $("personGroup").value || null, notes: $("personNotes").value.trim() };
  closePerson();
  commit(`Edit ${name}`, (x) => { const p = x.people.find((y) => y.id === id); if (p) Object.assign(p, fields); });
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "importFile") {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const copy = JSON.parse(await file.text());
      if (!Array.isArray(copy.people) || !Array.isArray(copy.items)) throw new Error();
      commit("Restore from a copy", (x) => mergeInto(x, copy));
      toast(`Restored ${copy.people.length} people and ${copy.items.length} ideas`);
    } catch {
      toast("That file isn't a Gift List copy");
    }
    return;
  }
  if (e.target.id === "wishTitle") {
    const title = e.target.value.trim() || "My wish list";
    commit("Rename wish list", (x) => { x.wishShare = { ...(x.wishShare || {}), title }; });
    publishSoon();
    return;
  }
  const id = e.target.dataset?.persongroup;
  if (!id) return;
  const group = e.target.value || null;
  commit("Change group", (x) => { const p = x.people.find((y) => y.id === id); if (p) p.group = group; });
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("captureScrim").hidden) closeCapture();
  if (!$("editScrim").hidden) closeEdit();
  if (!$("personScrim").hidden) closePerson();
  if (!$("wishScrim").hidden) closeWish();
});

// ---------- wish list ----------
// Your own list, shared through a secret GitHub gist that the separate wish.html page reads.
// The gist only ever holds this list, so people with the link can't see anything else.
const WISH_URL = APP_URL + "wish.html?g=";
const fixUrl = (u) => { u = u.trim(); return !u ? null : /^https?:\/\//i.test(u) ? u : "https://" + u; };
const GIST_HELP = "Your GitHub token needs Gists access. On GitHub go to Settings, Developer settings, Fine-grained tokens, open your token, and under Account permissions set Gists to Read and write. Then try again.";
let wishStatus = "";
const wishFile = (d) => JSON.stringify({
  title: d.wishShare?.title || "My wish list",
  updated: new Date().toISOString(),
  items: ranked(d.wish || []).map((w) => ({ what: w.what, url: w.url || null, price: w.price ?? null, note: w.note || "" })),
}, null, 2);

async function makeWishLink() {
  if (!cfg.token) { toast("Connect GitHub in Settings first"); return; }
  const title = $("wishTitle")?.value.trim() || "My wish list";
  wishStatus = "Making your link…";
  render();
  try {
    const g = await api("/gists", { method: "POST", body: JSON.stringify({ description: "Wish list", public: false, files: { "wishlist.json": { content: wishFile({ ...data, wishShare: { title } }) } } }) });
    wishStatus = "";
    commit("Share wish list", (x) => { x.wishShare = { ...(x.wishShare || {}), title, gist: g.id }; });
    toast("Your share link is ready");
  } catch (e) {
    wishStatus = e.status === 401 || e.status === 403 || e.status === 404 ? GIST_HELP : "Couldn't reach GitHub. Try again in a moment.";
    renderSoon();
  }
}

async function stopWishLink() {
  const gist = data.wishShare?.gist;
  if (!gist || !confirm("Stop sharing? The link will stop working for everyone you sent it to.")) return;
  try { await api(`/gists/${gist}`, { method: "DELETE" }); } catch (e) {
    if (e.status !== 404) { toast(e.status === 403 ? GIST_HELP : "Couldn't reach GitHub. Try again in a moment."); return; }
  }
  wishStatus = "";
  commit("Stop sharing wish list", (x) => { if (x.wishShare) delete x.wishShare.gist; });
  toast("Sharing stopped");
}

// Pushes the list to the shared page a moment after the last change, once it's saved
let pubTimer = null;
function publishSoon() {
  if (!data.wishShare?.gist || !cfg.token) return;
  clearTimeout(pubTimer);
  pubTimer = setTimeout(async () => {
    await saveQueue;
    const gist = data.wishShare?.gist;
    if (!gist) return;
    try {
      await api(`/gists/${gist}`, { method: "PATCH", body: JSON.stringify({ files: { "wishlist.json": { content: wishFile(data) } } }) });
      wishStatus = "";
    } catch (e) {
      wishStatus = e.status === 403 || e.status === 404 ? "The shared page didn't update. " + GIST_HELP : "The shared page didn't update. It'll try again on your next change.";
      toast("Your shared wish list didn't update");
    }
    if (view === "wish") renderSoon();
  }, 1200);
}

let editingWish = null;
function openWish(id) {
  const w = data.wish?.find((y) => y.id === id);
  if (!w) return;
  editingWish = id;
  $("wishWhat").value = w.what;
  $("wishUrl").value = w.url || "";
  $("wishPrice").value = w.price ?? "";
  $("wishNote").value = w.note || "";
  $("wishScrim").hidden = false;
}
const closeWish = () => { $("wishScrim").hidden = true; editingWish = null; };
$("wishCancel").onclick = closeWish;
$("wishScrim").addEventListener("click", (e) => { if (e.target.id === "wishScrim") closeWish(); });
$("wishDelete").onclick = () => {
  const id = editingWish;
  if (!confirm(`Delete "${data.wish?.find((w) => w.id === id)?.what}"?`)) return;
  closeWish();
  commit("Delete from wish list", (x) => { x.wish = (x.wish || []).filter((w) => w.id !== id); });
  publishSoon();
};
$("wishForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = editingWish;
  const priceText = $("wishPrice").value.replace(/[$,\s]/g, "");
  const fields = {
    what: $("wishWhat").value.trim(),
    url: fixUrl($("wishUrl").value),
    price: priceText === "" || isNaN(+priceText) ? null : +priceText,
    note: $("wishNote").value.trim(),
  };
  closeWish();
  commit("Edit wish list", (x) => { const w = x.wish?.find((y) => y.id === id); if (w) Object.assign(w, fields); });
  publishSoon();
});

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

// ---------- start ----------
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// Arrivals from the Android share sheet, the desktop bookmark, or the home screen mic shortcut
const params = new URLSearchParams(location.search);
const sharedTitle = params.get("title"), sharedText = params.get("text"), sharedUrl = params.get("url");
const voiceShortcut = params.has("voice");
const isShare = Boolean(sharedTitle || sharedText || sharedUrl);
if (isShare || voiceShortcut) history.replaceState(null, "", location.pathname);
if (isShare) view = "inbox";
render();
load();
if (isShare) {
  const parts = [sharedTitle, sharedText];
  if (sharedUrl && !(sharedText || "").includes(sharedUrl)) parts.push(sharedUrl);
  const raw = parts.filter(Boolean).join("\n");
  const url = sharedUrl || raw.match(/https?:\/\/\S+/)?.[0] || null;
  addIdea(raw, { source: "shared", smart: true, url, title: sharedTitle || (sharedText || "").replace(url || "", "").trim() || host(url || "") });
  toast("Added to your inbox");
} else if (voiceShortcut) {
  openCapture(true);
}
