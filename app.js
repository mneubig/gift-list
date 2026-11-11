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
let pending = []; // open GitHub issues = ideas still being filed
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
}
const forValue = (it) => (isAgeIdea(it) ? "a:" + it.age : it.person && personName(it.person) ? "p:" + it.person : "");

// ---------- GitHub ----------
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
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
  el.textContent = text;
  el.className = "sync " + (state || "");
}

async function load() {
  clearTimeout(pollTimer);
  if (!cfg.token) { setSync("Not connected", "err"); render(); return; }
  setSync("Syncing…", "busy");
  try {
    const [file, issues] = await Promise.all([gh("/contents/data.json"), gh("/issues?state=open&per_page=50")]);
    data = JSON.parse(fromB64(file.content));
    pending = issues.filter((i) => !i.pull_request);
    saved.set("gl_cache", JSON.stringify(data));
    setSync("Synced", "ok");
  } catch (e) {
    setSync(e.status === 401 ? "Token rejected. Check Settings." : e.status === 404 ? "Repo not found. Check Settings." : "Offline. Showing last sync.", "err");
  }
  render();
  // Keep checking while ideas are being filed or links are being searched
  if (pending.length || data.items.some((i) => i.link?.state === "searching")) pollTimer = setTimeout(load, 8000);
}

// Applies a change locally right away, then to the latest data.json on GitHub (retrying if it changed underneath)
let saveQueue = Promise.resolve();
function commit(message, mutate) {
  mutate(data);
  saved.set("gl_cache", JSON.stringify(data));
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
        setSync("Synced", "ok");
        render();
        return;
      } catch (e) {
        if (e.status !== 409 && e.status !== 422) break;
      }
    }
    setSync("Not saved. Check your connection.", "err");
    toast("Couldn't save that change to GitHub. Reload to see what was saved.");
  });
  return saveQueue;
}

async function sendIdea(kind, body) {
  if (!cfg.token) {
    toast("Connect to GitHub in Settings first");
    view = "settings";
    render();
    return false;
  }
  try {
    const title = `[${kind}] ${body.replace(/\s+/g, " ").slice(0, 60)}`;
    const issue = await gh("/issues", { method: "POST", body: JSON.stringify({ title, body }) });
    pending.unshift(issue);
    render();
    clearTimeout(pollTimer);
    pollTimer = setTimeout(load, 8000);
    return true;
  } catch (e) {
    toast(`Couldn't send it (${e.message}). Your text is still here.`);
    return false;
  }
}

function searchAgain(id) {
  commit("Search again", (d) => {
    const it = byId(d, id);
    if (it?.link) it.link.state = "searching";
  });
  gh("/actions/workflows/process.yml/dispatches", {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { item_id: id } }),
  })
    .then(() => { clearTimeout(pollTimer); pollTimer = setTimeout(load, 15000); })
    .catch((e) => toast(`Couldn't start the search (${e.message})`));
}

// ---------- rendering ----------
function stats() {
  const xmas = new Date(new Date().getFullYear(), 11, 25);
  const days = Math.ceil((xmas - new Date()) / 864e5);
  $("countdown").textContent = days > 0 ? `${days} days until Dec 25` : "Happy holidays";
  const bought = data.items.filter((i) => i.status !== "idea" && !isAgeIdea(i));
  $("spent").textContent = money(bought.reduce((a, i) => a + (Number(i.price) || 0), 0));
  const covered = new Set(bought.map((i) => i.person));
  $("todo").textContent = `${data.people.filter((p) => !covered.has(p.id)).length} of ${data.people.length}`;
  $("links").textContent = data.items.filter((i) => ["pending", "notfound"].includes(i.link?.state)).length;
  const inboxN = data.items.filter(isInbox).length + pending.length;
  $("inboxCount").textContent = inboxN;
  $("inboxCount").hidden = !inboxN;
}

function linkBox(i) {
  const L = i.link;
  if (!L || L.state === "none" || L.state === "ok") return "";
  const storeName = esc(L.store || "the store");
  if (L.state === "searching") {
    return `<div class="found"><div class="row"><span class="spinner"></span><span class="searching">Looking for more at ${storeName}…</span></div></div>`;
  }
  const hit = L.state === "pending" ? L.hits?.[L.i] : null;
  const paste = pasteOpen === i.id
    ? `<div class="row"><input id="paste-${i.id}" type="url" placeholder="Paste a product link" aria-label="Product link"><button class="btn" data-pastesave="${i.id}">Save link</button></div>`
    : "";
  const body = hit
    ? `<div class="lbl">Is this the right link?</div><div class="hit"><a href="${esc(hit.url)}" target="_blank" rel="noopener">${esc(hit.title)}</a>
       <span class="meta">${esc(host(hit.url))}${hit.price != null ? " · " + money(hit.price) : ""} · ${L.i + 1} of ${L.hits.length}</span></div>`
    : `<div class="lbl">No link yet</div><div class="meta">Couldn't find it at ${storeName}.${L.error ? " " + esc(L.error) : ""}</div>`;
  const buttons = hit
    ? `<button class="btn" data-use="${i.id}">Use this</button><button class="btn ghost" data-more="${i.id}">Keep searching</button>`
    : `<button class="btn ghost" data-more="${i.id}">Search again</button>`;
  return `<div class="found">${body}<div class="row">${buttons}<button class="btn ghost" data-paste="${i.id}">Paste my own</button></div>${paste}</div>`;
}

function itemRow(i, showWho) {
  const bits = [];
  if (showWho) {
    const p = data.people.find((x) => x.id === i.person);
    bits.push(p ? `<span class="dot" style="--c:${colorOf(p)}"></span>${esc(p.name)}` : "Inbox");
  }
  if (i.link?.state === "ok" && i.link.url) bits.push(`<a href="${esc(i.link.url)}" target="_blank" rel="noopener">${esc(host(i.link.url))} ↗</a>`);
  if (i.note) bits.push(esc(i.note));
  if (i.source === "voice") bits.push("<span class='tag'>voice</span>");
  if (i.source === "shared") bits.push("<span class='tag'>shared</span>");
  const age = isAgeIdea(i);
  const chip = age
    ? `<button class="chip give" data-give="${i.id}" title="Add to someone's list">Give</button>`
    : `<button class="chip ${i.status}" data-cycle="${i.id}" title="Tap to change status">${i.status}</button>`;
  return `<li class="item">
    <div class="what"><button class="name" data-edit="${i.id}" title="Edit">${esc(i.what)}</button>${bits.length ? `<small>${bits.join(" · ")}</small>` : ""}</div>
    <span class="price num">${i.price != null && i.price !== "" ? money(i.price) : ""}</span>
    ${chip}
    ${age && giveOpen === i.id ? giveBox(i) : ""}${linkBox(i)}</li>`;
}

function giveBox(i) {
  if (!data.people.length) return `<div class="found"><div class="meta">Add people on the People tab first.</div></div>`;
  const opts = data.people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  return `<div class="found"><div class="lbl">Add to this year's list</div>
    <div class="row"><select id="give-${i.id}" aria-label="Who is it for">${opts}</select><button class="btn" data-givesave="${i.id}">Add</button></div></div>`;
}

function pendingRows() {
  return pending.map((p) => `<div class="pending"><span class="spinner"></span><span>Filing <q>${esc((p.body || p.title).split("\n")[0].slice(0, 120))}</q></span></div>`).join("");
}

function render() {
  stats();
  saved.set("gl_view", view);
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.view === view));
  const v = $("view");

  if (view === "people") {
    const banner = pending.length ? `<div class="pending"><span class="spinner"></span><span>Filing ${pending.length} new idea${pending.length > 1 ? "s" : ""}…</span></div>` : "";
    const card = (p) => {
      const its = data.items.filter((i) => i.person === p.id);
      const spent = its.filter((i) => i.status !== "idea").reduce((a, i) => a + (Number(i.price) || 0), 0);
      return `<article class="panel person" style="--c:${colorOf(p)}"><div class="phead"><h3>${esc(p.name)}</h3><span class="budget num">${spent ? money(spent) + " spent" : its.some((i) => i.status !== "idea") ? "Bought" : "Nothing bought yet"}</span></div>
        <ul class="items">${its.map((i) => itemRow(i)).join("") || "<li class='empty'>No ideas yet</li>"}</ul></article>`;
    };
    // One section per group, then anyone without a group
    const sections = [...groups(), { id: "", label: "No group", color: "" }]
      .filter((g) => !groupFilter || g.id === groupFilter)
      .map((g) => {
        const ps = data.people.filter((p) => (groupOf(p)?.id || "") === g.id);
        if (!ps.length) return "";
        return `<section class="group"><h2 class="ghead"><span class="dot" style="--c:${COLORS[g.color] || "var(--muted)"}"></span>${esc(g.label)} <span class="meta">${ps.length}</span></h2>
          <div class="grid">${ps.map(card).join("")}</div></section>`;
      }).join("");
    const filters = data.people.length
      ? `<div class="filters">${[{ id: "", label: "Everyone" }, ...groups()].map((g) => `<button class="filter" data-group="${esc(g.id)}" aria-pressed="${g.id === groupFilter}">${g.color ? `<span class="dot" style="--c:${COLORS[g.color]}"></span>` : ""}${esc(g.label)}</button>`).join("")}</div>`
      : "";
    const add = `<form class="panel" id="addPerson"><h3>Add someone</h3><div class="row" style="margin-top:8px"><input id="newPerson" placeholder="Name" aria-label="Name"><select id="newPersonGroup" aria-label="Group">${groupOptions(groupFilter)}</select><button class="btn">Add</button></div></form>`;
    const intro = !data.people.length && !data.items.length
      ? `<div class="panel"><h2>Start your list</h2><p>Tap the mic and say something like "Mom would love the linen apron from Anthropologie." She'll be added, and the link is found for you.</p></div>`
      : "";
    v.innerHTML = banner + intro + filters + (sections || (groupFilter ? `<p class="empty">No one in this group yet.</p>` : "")) + `<div class="grid" style="margin-top:14px">${add}</div>`;
  } else if (view === "ages") {
    const cards = ages().map((a) => {
      const its = data.items.filter((i) => i.age === a.id);
      return `<article class="panel"><div class="phead"><h3>${esc(a.label)}</h3><span class="budget num">${its.length} idea${its.length === 1 ? "" : "s"}</span></div>
        <ul class="items">${its.map((i) => itemRow(i)).join("") || "<li class='empty'>No go-to gifts yet</li>"}</ul>
        <form class="row addAgeIdea" data-age="${esc(a.id)}" style="margin-top:8px"><input placeholder="Add a gift" aria-label="Add a gift for ${esc(a.label)}"><button class="btn ghost">Add</button></form></article>`;
    }).join("");
    const add = `<form class="panel" id="addAge"><h3>Add an age</h3><div class="row" style="margin-top:8px"><input id="newAge" placeholder="7, or a label like Teen" aria-label="Age"><button class="btn">Add</button></div></form>`;
    const intro = `<p class="meta" style="margin:0 0 12px">Your go-to gifts for each age, kept year to year. Tap <b>Give</b> to add one to someone's list. Or tap the mic and say "a good gift for 2 year olds is the Melissa and Doug band set from Target."</p>`;
    v.innerHTML = intro + `<div class="grid">${cards}${add}</div>`;
  } else if (view === "inbox") {
    const opts = forOptions(false);
    const items = data.items.filter(isInbox).map((i) => `<div class="panel">
      <ul class="items">${itemRow(i)}</ul>
      ${i.raw && i.raw !== i.what ? `<p class="meta" style="margin:6px 0 8px">You said: “${esc(i.raw)}”</p>` : ""}
      <div class="row"><select id="file-${i.id}" aria-label="Who is it for">${opts}</select><button class="btn" data-file="${i.id}">File it</button>
      <button class="btn danger" data-drop="${i.id}">Delete</button></div></div>`).join("");
    v.innerHTML = pendingRows() + (items || (pending.length ? "" : `<p class="empty">Inbox is clear. Ideas that don't name anyone and pages you share land here.</p>`));
  } else if (view === "shop") {
    const todo = data.items.filter((i) => i.status === "idea" && !isAgeIdea(i));
    v.innerHTML = `<div class="panel"><div class="phead"><h3>Still to buy</h3><span class="budget num">${todo.length} idea${todo.length === 1 ? "" : "s"}</span></div>
      <ul class="items">${todo.map((i) => itemRow(i, true)).join("") || "<li class='empty'>Everything is bought.</li>"}</ul></div>`;
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
      </div>`;
  }
}

// ---------- events ----------
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-view],[data-cycle],[data-file],[data-drop],[data-use],[data-more],[data-paste],[data-pastesave],[data-edit],[data-unperson],[data-give],[data-givesave],[data-unage],[data-group],[data-gcolor],[data-ungroup]");
  if (!t) return;
  const d = t.dataset;
  if (d.view) { view = d.view; render(); }
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
  else if (d.cycle) {
    commit("Change status", (x) => {
      const it = byId(x, d.cycle);
      if (it) it.status = { idea: "bought", bought: "wrapped", wrapped: "idea" }[it.status] || "idea";
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
    } else searchAgain(d.more);
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
      if (src) x.items.push({ ...structuredClone(src), id: newId(), person, age: null, status: "idea", created: new Date().toISOString() });
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
  else if (d.unperson) {
    commit("Remove person", (x) => {
      x.people = x.people.filter((p) => p.id !== d.unperson);
      x.items.forEach((i) => { if (i.person === d.unperson) i.person = null; });
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
    commit(`Add idea for ${ageLabel(age)}`, (x) => {
      x.ages ||= structuredClone(DEFAULT_AGES);
      x.items.push({ id: newId(), person: null, age, what, note: "", status: "idea", price: null, source: "typed", raw: what, created: new Date().toISOString(), link: { state: "none", hits: [], i: 0, rejected: [] } });
    });
  } else if (e.target.id === "addAge") {
    e.preventDefault();
    const text = $("newAge").value.trim();
    if (!text) return;
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
    commit(`Add ${name}`, (x) => {
      if (!x.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) x.people.push({ id: slug(name), name, group });
    });
  } else if (e.target.id === "addGroup") {
    e.preventDefault();
    const label = $("newGroup").value.trim();
    const id = slug(label);
    if (!label) return;
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

function openCapture(listenNow) {
  $("captureScrim").hidden = false;
  $("memoText").value = "";
  $("micHint").textContent = "Tap and say who it's for and what it is. Name a store to get a link.";
  if (listenNow) listen(true);
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
$("captureForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("memoText").value.trim();
  if (!text) { $("memoText").focus(); return; }
  $("captureSave").disabled = true;
  const ok = await sendIdea("voice", text);
  $("captureSave").disabled = false;
  if (ok) { closeCapture(); toast("Saved. It'll be filed in a moment."); }
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
  syncStatusField();
  $("editPrice").value = it.price ?? "";
  $("editStatus").value = it.status;
  $("editLink").value = it.link?.state === "ok" ? it.link.url || "" : "";
  $("editNote").value = it.note || "";
  $("editScrim").hidden = false;
}
const closeEdit = () => { $("editScrim").hidden = true; editing = null; };
// Age-list ideas are never bought themselves, so they have no status
function syncStatusField() { $("editStatusField").hidden = $("editPerson").value.startsWith("a:"); }
$("editPerson").onchange = syncStatusField;
$("editCancel").onclick = closeEdit;
$("editScrim").addEventListener("click", (e) => { if (e.target.id === "editScrim") closeEdit(); });
$("editDelete").onclick = () => {
  const id = editing;
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
  };
  const to = $("editPerson").value;
  const url = $("editLink").value.trim();
  closeEdit();
  commit("Edit idea", (x) => {
    const it = byId(x, id);
    if (!it) return;
    Object.assign(it, fields);
    assignTo(it, to);
    const had = it.link?.state === "ok" ? it.link.url : "";
    if (url && url !== had) it.link = { ...(it.link || {}), state: "ok", url, store: host(url) };
    else if (!url && had) it.link = { state: "none", hits: [], i: 0, rejected: it.link.rejected || [] };
  });
});

document.addEventListener("change", (e) => {
  const id = e.target.dataset?.persongroup;
  if (!id) return;
  const group = e.target.value || null;
  commit("Change group", (x) => { const p = x.people.find((y) => y.id === id); if (p) p.group = group; });
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("captureScrim").hidden) closeCapture();
  if (!$("editScrim").hidden) closeEdit();
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
  sendIdea("shared", parts.filter(Boolean).join("\n")).then((ok) => ok && toast("Added to your inbox. Filling in the details now."));
} else if (voiceShortcut) {
  openCapture(true);
}
