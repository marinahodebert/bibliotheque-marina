const STORAGE_KEY = "marinaBooksLocalAdds";
const PREF_KEY = "marinaBooksTheme";
const BOOKS_URL = "data/books.json";

let currentView = "books";
let localAdds = loadLocalAdds();
let remoteBooks = [];
let allBooks = [];

const els = {
  stats: document.querySelector("#stats"),
  content: document.querySelector("#content"),
  search: document.querySelector("#searchInput"),
  year: document.querySelector("#yearFilter"),
  author: document.querySelector("#authorFilter"),
  series: document.querySelector("#seriesFilter"),
  status: document.querySelector("#statusFilter"),
  missing: document.querySelector("#missingFilter"),
  dialog: document.querySelector("#bookDialog"),
  form: document.querySelector("#bookForm"),
  syncDialog: document.querySelector("#syncDialog"),
  syncBtn: document.querySelector("#syncBtn"),
  syncStatusText: document.querySelector("#syncStatusText"),
  ghToken: document.querySelector("#ghToken"),
  ghRepo: document.querySelector("#ghRepo"),
  ghBranch: document.querySelector("#ghBranch"),
  ghPendingText: document.querySelector("#ghPendingText"),
};

init();

async function init() {
  applyTheme();
  registerSW();
  bindEvents();
  remoteBooks = await loadRemoteBooks();
  allBooks = normalizeBooks([...remoteBooks, ...localAdds]);
  populateFilters();
  render();
  updateSyncStatusUI();
}

async function loadRemoteBooks() {
  const cfg = window.MarinaSync?.getGitHubConfig();
  if (cfg?.token) {
    try {
      const file = await MarinaSync.githubGetFile(cfg);
      return file.books;
    } catch (err) {
      console.error("Lecture GitHub échouée, repli sur le fichier local", err);
    }
  }
  try {
    const res = await fetch(BOOKS_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("Impossible de charger data/books.json", err);
    els.content.innerHTML = `<div class="empty card">Impossible de charger la bibliothèque (${err.message}). Vérifie ta connexion et recharge la page.</div>`;
    return [];
  }
}

function bindEvents() {
  [els.search, els.year, els.author, els.series, els.status, els.missing].forEach(el => el.addEventListener("input", render));
  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
    currentView = btn.dataset.view;
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
    render();
  }));
  document.querySelector("#themeToggle").addEventListener("click", toggleTheme);
  document.querySelector("#addBookBtn").addEventListener("click", () => els.dialog.showModal());
  document.querySelector("#exportBtn").addEventListener("click", exportData);
  document.querySelector("#importInput").addEventListener("change", importData);
  els.form.addEventListener("submit", addBook);

  els.syncBtn.addEventListener("click", () => { fillSyncForm(); els.syncDialog.showModal(); });
  document.querySelector("#ghSaveBtn").addEventListener("click", saveAndTestGitHub);
  document.querySelector("#ghDisconnectBtn").addEventListener("click", disconnectGitHub);
  document.querySelector("#ghSyncNowBtn").addEventListener("click", () => syncNow(true));
}

function normalizeBooks(books) {
  return books.map((b, i) => ({
    id: b.id || `${slug(b.title || "livre")}-${i}`,
    title: (b.title || "(titre indisponible)").trim(),
    author: (b.author || "Auteur non disponible").trim(),
    series: (b.series || "").trim(),
    tome: b.tome === undefined ? "" : b.tome,
    year: b.year || "",
    dateAdded: b.dateAdded || "",
    status: b.status || "lu",
    missing: Boolean(b.missing),
    notes: b.notes || "",
  }));
}

function getFilteredBooks() {
  const q = clean(els.search.value);
  return allBooks.filter(b => {
    const haystack = clean(`${b.title} ${b.author} ${b.series} ${b.notes}`);
    if (q && !haystack.includes(q)) return false;
    if (els.year.value && String(b.year) !== els.year.value) return false;
    if (els.author.value && b.author !== els.author.value) return false;
    if (els.series.value && b.series !== els.series.value) return false;
    if (els.status.value && b.status !== els.status.value) return false;
    if (els.missing.value === "missing" && !b.missing) return false;
    if (els.missing.value === "visible" && b.missing) return false;
    return true;
  });
}

function render() {
  renderStats();
  const books = getFilteredBooks();
  if (currentView === "books") renderBooks(books);
  if (currentView === "authors") renderAuthors(books);
  if (currentView === "series") renderSeries(books);
  if (currentView === "missing") renderBooks(books.filter(b => b.missing || !b.author || b.author === "Auteur non disponible" || b.title.includes("indisponible")));
}

function renderStats() {
  const visible = allBooks.filter(b => !b.missing).length;
  const missing = allBooks.filter(b => b.missing).length;
  const authors = new Set(allBooks.map(b => b.author).filter(a => a && a !== "Auteur non disponible")).size;
  const series = new Set(allBooks.map(b => b.series).filter(Boolean)).size;
  els.stats.innerHTML = `
    <div class="stat"><strong>${allBooks.length}</strong><span>livres recensés</span></div>
    <div class="stat"><strong>${visible}</strong><span>visibles Kindle</span></div>
    <div class="stat"><strong>${missing}</strong><span>à vérifier</span></div>
    <div class="stat"><strong>${authors}</strong><span>auteurs</span></div>
    <div class="stat"><strong>${series}</strong><span>séries</span></div>
    <div class="stat"><strong>${countByYear(2025)}</strong><span>lus en 2025</span></div>
    <div class="stat"><strong>${countByYear(2026)}</strong><span>lus en 2026</span></div>
    <div class="stat"><strong>${topAuthor()}</strong><span>auteur le plus lu</span></div>`;
}

function renderBooks(books) {
  if (!books.length) return empty();
  els.content.innerHTML = books.map(b => `
    <article class="book">
      <div>
        <h3>${escapeHtml(b.title)}</h3>
        <div class="meta">
          <span>${escapeHtml(b.author)}</span>
          ${b.series ? `<span class="badge">${escapeHtml(b.series)}${b.tome ? ` · t.${b.tome}` : ""}</span>` : ""}
          ${b.year ? `<span class="badge">${b.year}</span>` : ""}
          <span class="badge">${escapeHtml(b.status)}</span>
          ${b.missing ? `<span class="badge missing">Kindle disparu</span>` : ""}
        </div>
        ${b.notes ? `<p class="meta">${escapeHtml(b.notes)}</p>` : ""}
      </div>
    </article>`).join("");
}

function renderAuthors(books) {
  const groups = groupBy(books, b => b.author || "Auteur non disponible");
  renderGroups(groups, "auteur");
}

function renderSeries(books) {
  const withSeries = books.filter(b => b.series);
  const groups = groupBy(withSeries, b => b.series);
  renderGroups(groups, "série", true);
}

function renderGroups(groups, label, showProgress = false) {
  const entries = Object.entries(groups).sort((a,b) => a[0].localeCompare(b[0], "fr"));
  if (!entries.length) return empty();
  els.content.innerHTML = entries.map(([name, items]) => {
    const sorted = [...items].sort((a,b) => (Number(a.tome)||999) - (Number(b.tome)||999) || a.title.localeCompare(b.title, "fr"));
    const progress = showProgress ? seriesProgress(sorted) : null;
    return `<details class="group-card" open>
      <summary>${escapeHtml(name)} <span class="badge">${items.length} livre${items.length > 1 ? "s" : ""}</span></summary>
      ${progress ? `<div class="progress" title="${progress.label}"><span style="width:${progress.percent}%"></span></div><p class="meta">${progress.label}</p>` : ""}
      <ul>${sorted.map(b => `<li>${b.tome ? `Tome ${b.tome} — ` : ""}${escapeHtml(b.title)} ${b.year ? `<span class="badge">${b.year}</span>` : ""}</li>`).join("")}</ul>
    </details>`;
  }).join("");
}

function seriesProgress(items) {
  const tomes = items.map(b => Number(b.tome)).filter(n => Number.isFinite(n) && n > 0);
  if (!tomes.length) return null;
  const max = Math.max(...tomes);
  const unique = new Set(tomes);
  const missing = [];
  for (let i = 1; i <= max; i++) if (!unique.has(i)) missing.push(i);
  const percent = Math.round((unique.size / max) * 100);
  return { percent, label: missing.length ? `${unique.size}/${max} tomes repérés · manquants possibles : ${missing.join(", ")}` : `${unique.size}/${max} tomes repérés · série complète selon la base` };
}

function populateFilters() {
  fillSelect(els.year, [...new Set(allBooks.map(b => b.year).filter(Boolean))].sort((a,b) => b-a));
  fillSelect(els.author, [...new Set(allBooks.map(b => b.author).filter(Boolean))].sort((a,b) => a.localeCompare(b, "fr")));
  fillSelect(els.series, [...new Set(allBooks.map(b => b.series).filter(Boolean))].sort((a,b) => a.localeCompare(b, "fr")));
}
function fillSelect(select, values) {
  const first = select.options[0].outerHTML;
  select.innerHTML = first + values.map(v => `<option value="${escapeHtml(String(v))}">${escapeHtml(String(v))}</option>`).join("");
}

function addBook(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(els.form));
  const book = { ...data, year: data.year ? Number(data.year) : new Date().getFullYear(), missing: false, dateAdded: new Date().toISOString().slice(0,10) };
  localAdds.push(book);
  saveLocalAdds();
  allBooks = normalizeBooks([...remoteBooks, ...localAdds]);
  populateFilters();
  els.form.reset();
  els.dialog.close();
  render();
  syncNow(false);
}

function exportData() {
  const payload = { exportedAt: new Date().toISOString(), localAdds, allBooks };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `bibliotheque-marina-export-${new Date().toISOString().slice(0,10)}.json`; a.click();
  URL.revokeObjectURL(url);
}
async function importData(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const json = JSON.parse(await file.text());
  localAdds = Array.isArray(json.localAdds) ? json.localAdds : Array.isArray(json) ? json : [];
  saveLocalAdds();
  allBooks = normalizeBooks([...remoteBooks, ...localAdds]);
  populateFilters();
  render();
}

function fillSyncForm() {
  const cfg = MarinaSync.getGitHubConfig();
  els.ghRepo.value = cfg ? `${cfg.owner}/${cfg.repo}` : "marinahodebert/bibliotheque-marina";
  els.ghBranch.value = cfg?.branch || "refonte-v2";
  els.ghToken.value = "";
  els.ghToken.placeholder = cfg?.token ? "•••• déjà enregistré (laisse vide pour garder)" : "github_pat_…";
  updateSyncStatusUI();
}

function updateSyncStatusUI() {
  const cfg = MarinaSync.getGitHubConfig();
  const last = localStorage.getItem(MarinaSync.GH_LAST_SYNC_KEY);
  if (cfg?.token) {
    els.syncStatusText.textContent = `Connecté à ${cfg.owner}/${cfg.repo} (branche ${cfg.branch})${last ? " · dernière synchro " + new Date(last).toLocaleString("fr-FR") : ""}`;
    els.syncStatusText.className = "meta sync-ok";
  } else {
    els.syncStatusText.textContent = "Non connecté.";
    els.syncStatusText.className = "meta";
  }
  els.ghPendingText.textContent = localAdds.length
    ? `${localAdds.length} livre${localAdds.length > 1 ? "s" : ""} en attente de synchronisation.`
    : "Rien en attente, tout est synchronisé.";
  els.syncBtn.textContent = localAdds.length ? `Synchronisation (${localAdds.length})` : "Synchronisation";
}

async function saveAndTestGitHub() {
  const [owner, repo] = els.ghRepo.value.trim().split("/").map(s => s.trim());
  const branch = els.ghBranch.value.trim() || "refonte-v2";
  const existing = MarinaSync.getGitHubConfig();
  const token = els.ghToken.value.trim() || existing?.token;
  if (!owner || !repo || !token) {
    els.syncStatusText.textContent = "Renseigne le dépôt (owner/repo) et un token.";
    els.syncStatusText.className = "meta sync-err";
    return;
  }
  const cfg = { owner, repo, branch, token };
  els.syncStatusText.textContent = "Test de connexion…";
  els.syncStatusText.className = "meta";
  try {
    const result = await MarinaSync.testGitHubConnection(cfg);
    MarinaSync.saveGitHubConfig(cfg);
    remoteBooks = await loadRemoteBooks();
    allBooks = normalizeBooks([...remoteBooks, ...localAdds]);
    populateFilters();
    render();
    els.syncStatusText.textContent = `Connecté ✓ ${result.count} livres trouvés sur ${owner}/${repo} (${branch}).`;
    els.syncStatusText.className = "meta sync-ok";
    els.ghPendingText.textContent = localAdds.length
      ? `${localAdds.length} livre${localAdds.length > 1 ? "s" : ""} en attente de synchronisation.`
      : "Rien en attente, tout est synchronisé.";
  } catch (err) {
    els.syncStatusText.textContent = `Échec : ${err.message}`;
    els.syncStatusText.className = "meta sync-err";
  }
}

function disconnectGitHub() {
  MarinaSync.clearGitHubConfig();
  fillSyncForm();
}

async function syncNow(manual) {
  const cfg = MarinaSync.getGitHubConfig();
  if (!cfg?.token) {
    if (manual) { els.syncStatusText.textContent = "Connecte d'abord GitHub."; els.syncStatusText.className = "meta sync-err"; }
    return;
  }
  if (!localAdds.length) {
    if (manual) updateSyncStatusUI();
    return;
  }
  if (manual) { els.syncStatusText.textContent = "Synchronisation en cours…"; els.syncStatusText.className = "meta"; }
  try {
    const merged = await MarinaSync.syncPendingBooks(localAdds);
    remoteBooks = merged;
    localAdds = [];
    saveLocalAdds();
    allBooks = normalizeBooks([...remoteBooks, ...localAdds]);
    populateFilters();
    render();
  } catch (err) {
    console.error("Synchronisation échouée", err);
    if (manual) { els.syncStatusText.textContent = `Échec de synchronisation : ${err.message}`; els.syncStatusText.className = "meta sync-err"; }
  }
  updateSyncStatusUI();
}

function loadLocalAdds() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } }
function saveLocalAdds() { localStorage.setItem(STORAGE_KEY, JSON.stringify(localAdds)); }
function clean(str) { return String(str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function slug(str) { return clean(str).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function escapeHtml(str) { return String(str ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch])); }
function groupBy(arr, fn) { return arr.reduce((acc, item) => { const key = fn(item) || "Sans série"; (acc[key] ||= []).push(item); return acc; }, {}); }
function countByYear(year) { return allBooks.filter(b => Number(b.year) === year).length; }
function topAuthor() { const counts = {}; allBooks.forEach(b => { if (b.author && b.author !== "Auteur non disponible") counts[b.author] = (counts[b.author] || 0) + 1; }); const top = Object.entries(counts).sort((a,b) => b[1]-a[1])[0]; return top ? top[0].split(" ")[0] : "—"; }
function empty() { els.content.innerHTML = `<div class="empty card">Aucun livre trouvé.</div>`; }
function applyTheme() { const theme = localStorage.getItem(PREF_KEY); if (theme === "light") document.documentElement.classList.add("light"); }
function toggleTheme() { document.documentElement.classList.toggle("light"); localStorage.setItem(PREF_KEY, document.documentElement.classList.contains("light") ? "light" : "dark"); }
function registerSW() { if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {}); }
