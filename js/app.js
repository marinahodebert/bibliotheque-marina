const STORAGE_KEY = "marinaBooksLocalAdds";
const EDITS_KEY = "marinaBooksLocalEdits";
const DELETES_KEY = "marinaBooksLocalDeletes";
const BOOKS_URL = "data/books.json";

const ICO_SEARCH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;
const ICO_BACK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>`;
const ICO_PENCIL = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const ICO_SYNC = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>`;

const NAV_ITEMS = [
  { key: "home", label: "Accueil" },
  { key: "library", label: "Bibliothèque" },
  { key: "series", label: "Séries" },
  { key: "authors", label: "Auteurs" },
];
const STATUS_ORDER = [
  { value: "lu", label: "Lu", slug: "lu" },
  { value: "à lire", label: "À lire", slug: "a-lire" },
  { value: "en cours", label: "En cours", slug: "en-cours" },
  { value: "abandonné", label: "Abandonné", slug: "abandonne" },
  { value: "non défini", label: "Non défini", slug: "non-defini" },
];
const KINDLE_STATUS_CHOICES = ["à lire", "lu", "en cours", "non défini"];

let currentView = "home";
let currentDetailId = null;
let editingDetail = false;
let libraryState = { search: "", status: "", year: "" };

let localAdds = loadLocalAdds();
let localEdits = loadLocalEdits();
let localDeletes = loadLocalDeletes();
let remoteBooks = [];
let allBooks = [];

const els = {
  content: document.querySelector("#content"),
  sidebarNav: document.querySelector("#sidebarNav"),
  tabbar: document.querySelector("#tabbar"),
  detailOverlay: document.querySelector("#detailOverlay"),
  detailPanel: document.querySelector("#detailPanel"),
  dialog: document.querySelector("#bookDialog"),
  form: document.querySelector("#bookForm"),
  syncDialog: document.querySelector("#syncDialog"),
  syncBtnDesktop: document.querySelector("#syncBtnDesktop"),
  syncStatusText: document.querySelector("#syncStatusText"),
  ghToken: document.querySelector("#ghToken"),
  ghRepo: document.querySelector("#ghRepo"),
  ghBranch: document.querySelector("#ghBranch"),
  ghPendingText: document.querySelector("#ghPendingText"),
  addChoiceDialog: document.querySelector("#addChoiceDialog"),
  kindleDialog: document.querySelector("#kindleDialog"),
  kindleBody: document.querySelector("#kindleBody"),
};

init();

async function init() {
  bindEvents();
  const raw = await loadRemoteBooks();
  remoteBooks = normalizeBooks(raw);
  refreshAndRender();
  switchView("home");
  updateSyncStatusUI();
  registerSW();
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
    els.content.innerHTML = `<div class="empty-state">Impossible de charger la bibliothèque (${escapeHtml(err.message)}). Vérifie ta connexion et recharge la page.</div>`;
    return [];
  }
}

/* ============ events (delegated, bound once) ============ */
function bindEvents() {
  document.querySelectorAll("[data-dialog-close]").forEach(btn => {
    btn.addEventListener("click", () => btn.closest("dialog")?.close());
  });

  document.querySelector("#addBookBtn").addEventListener("click", () => els.addChoiceDialog.showModal());
  document.querySelector("#addBookBtnDesktop").addEventListener("click", () => els.addChoiceDialog.showModal());
  document.querySelector("#chooseManual").addEventListener("click", () => { els.addChoiceDialog.close(); els.dialog.showModal(); });
  document.querySelector("#chooseKindle").addEventListener("click", () => { els.addChoiceDialog.close(); openKindleDialog(); });
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(els.form));
    if (!data.title || !data.title.trim()) return;
    addBookFromForm(data);
    els.form.reset();
    els.dialog.close();
  });

  bindKindleDialogEvents();

  els.syncBtnDesktop.addEventListener("click", openSyncDialog);
  document.querySelector("#ghSaveBtn").addEventListener("click", saveAndTestGitHub);
  document.querySelector("#ghDisconnectBtn").addEventListener("click", disconnectGitHub);
  document.querySelector("#ghSyncNowBtn").addEventListener("click", () => syncNow(true));
  document.querySelector("#exportBtn").addEventListener("click", exportData);
  document.querySelector("#importInput").addEventListener("change", importData);

  els.sidebarNav.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) switchView(b.dataset.view);
  });
  els.tabbar.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) switchView(b.dataset.view);
  });

  els.content.addEventListener("click", (e) => {
    const coverEl = e.target.closest(".cover[data-id]");
    if (coverEl) { openDetail(coverEl.dataset.id); return; }
    const openBtn = e.target.closest("[data-open-detail]");
    if (openBtn) { openDetail(openBtn.dataset.openDetail); return; }
    const gotoLib = e.target.closest("[data-goto-library]");
    if (gotoLib) { switchView("library"); return; }
    const chip = e.target.closest(".chip[data-status]");
    if (chip) { libraryState.status = chip.dataset.status; renderLibrary(); return; }
    const syncIcon = e.target.closest("#homeSyncIcon");
    if (syncIcon) { openSyncDialog(); return; }
  });
  els.content.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const coverEl = e.target.closest(".cover[data-id]");
    if (coverEl) { e.preventDefault(); openDetail(coverEl.dataset.id); }
  });
  els.content.addEventListener("input", (e) => {
    if (e.target.id === "librarySearchInput") { libraryState.search = e.target.value; renderLibraryResults(); }
  });
  els.content.addEventListener("change", (e) => {
    if (e.target.id === "libraryYearSelect") { libraryState.year = e.target.value; renderLibraryResults(); }
  });

  els.detailPanel.addEventListener("click", (e) => {
    if (e.target === els.detailPanel) { closeDetail(); return; }
    if (e.target.closest("[data-detail-back]") || e.target.closest("[data-detail-cancel-edit]")) {
      if (e.target.closest("[data-detail-cancel-edit]")) { editingDetail = false; renderDetail(); return; }
      closeDetail();
      return;
    }
    if (e.target.closest("[data-detail-edit]")) { editingDetail = true; renderDetail(); return; }
    if (e.target.closest("[data-detail-delete]")) {
      const b = allBooks.find(x => x.id === currentDetailId);
      if (b && confirm(`Supprimer « ${b.title} » de ta bibliothèque ?`)) {
        deleteBookById(currentDetailId);
        closeDetail();
      }
      return;
    }
    const pill = e.target.closest("[data-set-status]");
    if (pill) { updateBookField(currentDetailId, { status: pill.dataset.setStatus }); renderDetail(); }
  });
  els.detailPanel.addEventListener("submit", (e) => {
    if (e.target.id !== "editForm") return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    updateBookField(currentDetailId, {
      title: data.title.trim(),
      author: data.author.trim(),
      series: data.series.trim(),
      tome: data.tome ? Number(data.tome) : "",
      year: data.year ? Number(data.year) : "",
      notes: data.notes.trim(),
    });
    editingDetail = false;
    renderDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.detailOverlay.classList.contains("open")) closeDetail();
  });
}

/* ============ data model ============ */
function normalizeBooks(books) {
  return books.map((b, i) => ({
    id: b.id || genId(b.title || `livre-${i}`),
    title: (b.title || "(titre indisponible)").trim(),
    author: (b.author || "Auteur non disponible").trim(),
    series: (b.series || "").trim(),
    tome: b.tome === undefined ? "" : b.tome,
    year: b.year || "",
    dateAdded: b.dateAdded || "",
    status: b.status || "lu",
    missing: Boolean(b.missing),
    notes: b.notes || "",
    cover: b.cover || "",
  }));
}
function genId(title) {
  return `${slug(title || "livre")}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
}
function statusSlug(status) {
  const s = STATUS_ORDER.find(s => s.value === status);
  return s ? s.slug : slug(status);
}
function computeAllBooks() {
  const combined = [...remoteBooks, ...localAdds];
  return combined
    .filter(b => !localDeletes.includes(b.id))
    .map(b => (localEdits[b.id] ? { ...b, ...localEdits[b.id] } : b));
}
function refreshAndRender() {
  allBooks = computeAllBooks();
  renderNav();
  renderCurrentView();
  if (currentDetailId) renderDetail();
}

/* ============ mutations ============ */
function addBookFromForm(data) {
  const book = {
    id: genId(data.title),
    title: (data.title || "").trim(),
    author: (data.author || "").trim(),
    series: (data.series || "").trim(),
    tome: data.tome ? Number(data.tome) : "",
    year: data.year ? Number(data.year) : new Date().getFullYear(),
    dateAdded: new Date().toISOString().slice(0, 10),
    status: data.status || "lu",
    missing: false,
    notes: (data.notes || "").trim(),
    cover: "",
  };
  localAdds.push(book);
  saveLocalAdds();
  refreshAndRender();
  syncNow(false);
}
function updateBookField(id, patch) {
  const addIdx = localAdds.findIndex(b => b.id === id);
  if (addIdx !== -1) {
    localAdds[addIdx] = { ...localAdds[addIdx], ...patch };
    saveLocalAdds();
  } else {
    localEdits[id] = { ...(localEdits[id] || {}), ...patch };
    saveLocalEdits();
  }
  refreshAndRender();
  syncNow(false);
}
function deleteBookById(id) {
  const addIdx = localAdds.findIndex(b => b.id === id);
  if (addIdx !== -1) {
    localAdds.splice(addIdx, 1);
    saveLocalAdds();
  } else {
    localDeletes.push(id);
    saveLocalDeletes();
  }
  if (localEdits[id]) { delete localEdits[id]; saveLocalEdits(); }
  refreshAndRender();
  syncNow(false);
}

/* ============ navigation ============ */
function navCounts() {
  return {
    library: allBooks.length,
    series: new Set(allBooks.map(b => b.series).filter(Boolean)).size,
    authors: new Set(allBooks.map(b => b.author).filter(a => a && a !== "Auteur non disponible")).size,
  };
}
function renderNav() {
  const counts = navCounts();
  const itemHtml = it => `<button type="button" data-view="${it.key}" class="${currentView === it.key ? "active" : ""}"><i></i>${it.label}${counts[it.key] !== undefined ? `<span class="n">${counts[it.key]}</span>` : ""}</button>`;
  els.sidebarNav.innerHTML = NAV_ITEMS.map(itemHtml).join("");
  els.tabbar.innerHTML = NAV_ITEMS.map(itemHtml).join("");
}
function switchView(view) {
  currentView = view;
  closeDetail();
  renderNav();
  renderCurrentView();
}
function renderCurrentView() {
  if (currentView === "home") renderHome();
  else if (currentView === "library") renderLibrary();
  else if (currentView === "series") renderSeries();
  else if (currentView === "authors") renderAuthors();
}

/* ============ covers ============ */
function coverHTML(b) {
  const statusCls = b.missing ? "verifier" : statusSlug(b.status);
  const label = escapeHtml(b.title === "(titre indisponible)" ? "Titre indisponible" : b.title);
  if (b.cover) {
    return `<div class="cover" data-id="${b.id}" tabindex="0" role="button" aria-label="${label}">
      <img src="${escapeHtml(b.cover)}" alt="" loading="lazy" />
      <div class="status-dot ${statusCls}"><i></i></div>
    </div>`;
  }
  const unknown = b.title.includes("indisponible");
  return `<div class="cover placeholder${unknown ? " unknown" : ""}" data-id="${b.id}" tabindex="0" role="button" aria-label="${label}">
    <div class="ph-rule"></div>
    <div class="ph-title">${unknown ? "Titre indisponible" : escapeHtml(b.title)}</div>
    ${unknown ? "" : `<div class="ph-author">${escapeHtml((b.author || "").toUpperCase())}</div>`}
    <div class="status-dot ${statusCls}"><i></i></div>
  </div>`;
}

/* ============ accueil ============ */
function pickCurrentRead() {
  const candidates = allBooks.filter(b => b.status === "en cours");
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => (b.dateAdded || "").localeCompare(a.dateAdded || ""))[0];
}
function recentlyAddedBooks(n) {
  return allBooks
    .map((b, i) => ({ b, i }))
    .sort((x, y) => {
      const dx = x.b.dateAdded || "", dy = y.b.dateAdded || "";
      if (dx !== dy) return dy.localeCompare(dx);
      return y.i - x.i;
    })
    .slice(0, n).map(x => x.b);
}
function recentReadsBooks(n) {
  return allBooks.filter(b => b.status === "lu")
    .map((b, i) => ({ b, i }))
    .sort((x, y) => (Number(y.b.year) || 0) - (Number(x.b.year) || 0) || y.i - x.i)
    .slice(0, n).map(x => x.b);
}
function heroSectionHTML(b) {
  return `<div class="section hero-row">
    ${coverHTML(b)}
    <div class="hero-info">
      <span class="tag accent-text">Reprendre la lecture</span>
      <h3>${escapeHtml(b.title)}</h3>
      <p class="meta">${escapeHtml(b.author)}${b.series ? " · " + escapeHtml(b.series) + (b.tome ? " · Tome " + b.tome : "") : ""}</p>
      <button class="continue-btn" type="button" data-open-detail="${b.id}"><i></i>Continuer la lecture</button>
    </div>
  </div>`;
}
function rowSectionHTML(title, list) {
  return `<div class="section">
    <div class="section-head"><h2>${title}</h2><button class="link" type="button" data-goto-library="1">Voir tout →</button></div>
    <div class="hrow">${list.map(coverHTML).join("")}</div>
  </div>`;
}
function ctaCardHTML() {
  return `<button class="cta-card" type="button" data-goto-library="1">
    <div><p class="t">Toute ta bibliothèque</p><p class="s">${allBooks.length} livre${allBooks.length > 1 ? "s" : ""}, avec recherche et filtres</p></div>
    <span class="arrow accent-text">→</span>
  </button>`;
}
function renderHome() {
  const current = pickCurrentRead();
  const recent = recentlyAddedBooks(12);
  const reads = recentReadsBooks(12);
  els.content.innerHTML = `
    <div class="app-header">
      <div class="brand"><small>MarinaBooks</small>Accueil</div>
      <button class="icon-btn" id="homeSyncIcon" type="button" aria-label="Synchronisation">${ICO_SYNC}</button>
    </div>
    ${current ? heroSectionHTML(current) : ""}
    ${recent.length ? rowSectionHTML("Ajoutés récemment", recent) : ""}
    ${reads.length ? rowSectionHTML("Dernières lectures", reads) : ""}
    ${allBooks.length ? ctaCardHTML() : `<div class="empty-state">Ta bibliothèque est vide pour l'instant — ajoute un premier livre.</div>`}
  `;
}

/* ============ bibliothèque ============ */
function getFilteredLibraryBooks() {
  const q = clean(libraryState.search);
  return allBooks.filter(b => {
    const haystack = clean(`${b.title} ${b.author} ${b.series} ${b.notes}`);
    if (q && !haystack.includes(q)) return false;
    if (libraryState.status === "verifier") { if (!b.missing) return false; }
    else if (libraryState.status) { if (statusSlug(b.status) !== libraryState.status) return false; }
    if (libraryState.year && String(b.year) !== libraryState.year) return false;
    return true;
  });
}
function libraryShellHTML() {
  const verifCount = allBooks.filter(b => b.missing).length;
  const years = [...new Set(allBooks.map(b => b.year).filter(Boolean))].sort((a, b) => b - a);
  const chips = [
    { status: "", label: "Tous" },
    { status: "lu", label: "Lu" },
    { status: "a-lire", label: "À lire" },
    { status: "en-cours", label: "En cours" },
    { status: "abandonne", label: "Abandonné" },
    { status: "non-defini", label: "Non défini" },
  ];
  return `
    <div class="library-header"><h1>Bibliothèque</h1><p class="count">${allBooks.length} livre${allBooks.length > 1 ? "s" : ""}</p></div>
    <div class="searchbar library-search">${ICO_SEARCH}<input id="librarySearchInput" type="search" placeholder="Rechercher un titre, une autrice, une série…" value="${escapeHtml(libraryState.search)}" /></div>
    <div class="chiprow">
      ${chips.map(c => `<button class="chip ${libraryState.status === c.status ? "active" : ""}" type="button" data-status="${c.status}">${c.label}</button>`).join("")}
      <button class="chip warn ${libraryState.status === "verifier" ? "active" : ""}" type="button" data-status="verifier">À vérifier <span class="badge">${verifCount}</span></button>
      ${years.length ? `<select id="libraryYearSelect" class="chip">
        <option value="">Toutes les années</option>
        ${years.map(y => `<option value="${y}" ${String(libraryState.year) === String(y) ? "selected" : ""}>${y}</option>`).join("")}
      </select>` : ""}
    </div>
    <div id="libraryResults"></div>
  `;
}
function renderLibrary() {
  els.content.innerHTML = libraryShellHTML();
  renderLibraryResults();
}
function renderLibraryResults() {
  const books = getFilteredLibraryBooks();
  const target = document.getElementById("libraryResults");
  if (!target) return;
  target.innerHTML = books.length ? gridHTML(books) : `<div class="empty-state">Aucun livre trouvé.</div>`;
}
function gridHTML(books) {
  return `<div class="grid">${books.map(b => `
    <div class="grid-item">
      ${coverHTML(b)}
      <div class="grid-cap">
        <p class="t">${escapeHtml(b.title)}</p>
        <p class="a">${escapeHtml(b.author || "Auteur non disponible")}</p>
      </div>
    </div>`).join("")}</div>`;
}

/* ============ séries / auteurs ============ */
function renderSeries() {
  const withSeries = allBooks.filter(b => b.series);
  const groups = groupBy(withSeries, b => b.series);
  const entries = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0], "fr"));
  els.content.innerHTML = `
    <div class="app-header"><div class="brand"><small>MarinaBooks</small>Séries</div></div>
    ${entries.length ? entries.map(([name, items]) => seriesGroupHTML(name, items)).join("") : `<div class="empty-state">Aucune série pour l'instant.</div>`}
  `;
}
function seriesGroupHTML(name, items) {
  const sorted = [...items].sort((a, b) => (Number(a.tome) || 999) - (Number(b.tome) || 999) || a.title.localeCompare(b.title, "fr"));
  const progress = seriesProgress(sorted);
  return `<div class="section">
    <div class="section-head"><h2>${escapeHtml(name)}</h2><span class="meta">${items.length} livre${items.length > 1 ? "s" : ""}</span></div>
    ${progress ? `<p class="group-progress">${progress.label}</p>` : ""}
    <div class="hrow">${sorted.map(coverHTML).join("")}</div>
  </div>`;
}
function renderAuthors() {
  const groups = groupBy(allBooks, b => b.author || "Auteur non disponible");
  const entries = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0], "fr"));
  els.content.innerHTML = `
    <div class="app-header"><div class="brand"><small>MarinaBooks</small>Auteurs</div></div>
    ${entries.length ? entries.map(([name, items]) => `<div class="section">
      <div class="section-head"><h2>${escapeHtml(name)}</h2><span class="meta">${items.length} livre${items.length > 1 ? "s" : ""}</span></div>
      <div class="hrow">${items.map(coverHTML).join("")}</div>
    </div>`).join("") : `<div class="empty-state">Aucun auteur pour l'instant.</div>`}
  `;
}
function groupBy(arr, fn) { return arr.reduce((acc, item) => { const key = fn(item) || "Sans série"; (acc[key] ||= []).push(item); return acc; }, {}); }
function seriesProgress(items) {
  const tomes = items.map(b => Number(b.tome)).filter(n => Number.isFinite(n) && n > 0);
  if (!tomes.length) return null;
  const max = Math.max(...tomes);
  const unique = new Set(tomes);
  const missing = [];
  for (let i = 1; i <= max; i++) if (!unique.has(i)) missing.push(i);
  return { label: missing.length ? `${unique.size}/${max} tomes repérés · manquants possibles : ${missing.join(", ")}` : `${unique.size}/${max} tomes repérés · série complète selon la base` };
}

/* ============ fiche détail ============ */
function openDetail(id) {
  currentDetailId = id;
  editingDetail = false;
  renderDetail();
  els.detailOverlay.classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeDetail() {
  currentDetailId = null;
  editingDetail = false;
  els.detailOverlay.classList.remove("open");
  document.body.style.overflow = "";
}
function renderDetail() {
  const b = allBooks.find(x => x.id === currentDetailId);
  if (!b) { closeDetail(); return; }
  els.detailPanel.innerHTML = editingDetail ? detailEditHTML(b) : detailViewHTML(b);
}
function detailViewHTML(b) {
  const seriesLine = b.series ? `${escapeHtml(b.series)}${b.tome ? " · Tome " + b.tome : ""}` : "Titre indépendant";
  return `
    <div class="detail-header">
      <button class="icon-btn" type="button" data-detail-back aria-label="Retour">${ICO_BACK}</button>
      <button class="icon-btn" type="button" data-detail-edit aria-label="Modifier">${ICO_PENCIL}</button>
    </div>
    <div class="detail-card">
      <button class="icon-btn detail-close" type="button" data-detail-back aria-label="Fermer">×</button>
      <div class="detail-top">
        <div class="detail-cover-wrap">${coverHTML(b)}</div>
        <div class="detail-info">
          <h2 class="detail-title">${escapeHtml(b.title)}</h2>
          <p class="detail-author">${escapeHtml(b.author || "Auteur non disponible")}</p>
          <p class="detail-series">${seriesLine}</p>
          <div class="status-pills">
            ${STATUS_ORDER.map(s => `<button class="status-pill-lg ${s.slug} ${b.status === s.value ? "active" : ""}" type="button" data-set-status="${escapeHtml(s.value)}">${s.label}</button>`).join("")}
          </div>
        </div>
      </div>
      <div class="detail-bottom">
        ${b.missing ? `<p class="meta sync-err" style="margin:0 0 1rem;">Marqué comme disparu de la bibliothèque Kindle.</p>` : ""}
        <div class="notes-block">
          <p class="block-label">Notes</p>
          ${b.notes ? `<p class="notes-text">${escapeHtml(b.notes)}</p>` : `<p class="notes-empty">Aucune note pour l'instant.</p>`}
        </div>
        <div class="detail-actions">
          <button class="ghost-btn" type="button" data-detail-edit>Modifier les informations</button>
          <button class="ghost-btn danger" type="button" data-detail-delete>Supprimer ce livre</button>
        </div>
      </div>
    </div>
  `;
}
function detailEditHTML(b) {
  return `
    <div class="detail-header">
      <button class="icon-btn" type="button" data-detail-cancel-edit aria-label="Annuler">${ICO_BACK}</button>
      <span class="meta" style="font-weight:700;color:var(--ink);">Modifier</span>
      <span style="width:34px;"></span>
    </div>
    <div class="detail-card">
      <button class="icon-btn detail-close" type="button" data-detail-cancel-edit aria-label="Fermer">×</button>
      <form id="editForm" class="edit-form">
        <label>Titre<input name="title" value="${escapeHtml(b.title)}" required /></label>
        <label>Auteur<input name="author" value="${escapeHtml(b.author === "Auteur non disponible" ? "" : b.author)}" /></label>
        <div class="edit-grid">
          <label>Série<input name="series" value="${escapeHtml(b.series)}" /></label>
          <label>Tome<input name="tome" inputmode="numeric" value="${escapeHtml(String(b.tome === "" ? "" : b.tome))}" /></label>
        </div>
        <label>Année<input name="year" inputmode="numeric" value="${escapeHtml(String(b.year === "" ? "" : b.year))}" /></label>
        <label>Notes<textarea name="notes" rows="3">${escapeHtml(b.notes)}</textarea></label>
        <div class="btn-row">
          <button class="primary-btn" type="submit">Enregistrer</button>
          <button class="ghost-btn" type="button" data-detail-cancel-edit>Annuler</button>
        </div>
      </form>
    </div>
  `;
}

/* ============ synchronisation GitHub ============ */
function openSyncDialog() { fillSyncForm(); els.syncDialog.showModal(); }
function fillSyncForm() {
  const cfg = MarinaSync.getGitHubConfig();
  els.ghRepo.value = cfg ? `${cfg.owner}/${cfg.repo}` : "marinahodebert/bibliotheque-marina";
  els.ghBranch.value = cfg?.branch || "refonte-v2";
  els.ghToken.value = "";
  els.ghToken.placeholder = cfg?.token ? "•••• déjà enregistré (laisse vide pour garder)" : "github_pat_…";
  updateSyncStatusUI();
}
function pendingCount() { return localAdds.length + Object.keys(localEdits).length + localDeletes.length; }
function setSyncStatus(text, kind) {
  els.syncStatusText.textContent = text;
  els.syncStatusText.className = kind ? `meta sync-${kind}` : "meta";
}
function updateSyncStatusUI() {
  const cfg = MarinaSync.getGitHubConfig();
  const last = localStorage.getItem(MarinaSync.GH_LAST_SYNC_KEY);
  if (cfg?.token) {
    setSyncStatus(`Connecté à ${cfg.owner}/${cfg.repo} (branche ${cfg.branch})${last ? " · dernière synchro " + new Date(last).toLocaleString("fr-FR") : ""}`, "ok");
  } else {
    setSyncStatus("Non connecté.");
  }
  const n = pendingCount();
  els.ghPendingText.textContent = n ? `${n} changement${n > 1 ? "s" : ""} en attente de synchronisation.` : "Rien en attente, tout est synchronisé.";
  els.syncBtnDesktop.textContent = n ? `Synchronisation (${n})` : "Synchronisation";
}
async function saveAndTestGitHub() {
  const [owner, repo] = els.ghRepo.value.trim().split("/").map(s => s.trim());
  const branch = els.ghBranch.value.trim() || "refonte-v2";
  const existing = MarinaSync.getGitHubConfig();
  const token = els.ghToken.value.trim() || existing?.token;
  if (!owner || !repo || !token) { setSyncStatus("Renseigne le dépôt (owner/repo) et un token.", "err"); return; }
  const cfg = { owner, repo, branch, token };
  setSyncStatus("Test de connexion…");
  try {
    const result = await MarinaSync.testGitHubConnection(cfg);
    MarinaSync.saveGitHubConfig(cfg);
    remoteBooks = normalizeBooks(await loadRemoteBooks());
    refreshAndRender();
    setSyncStatus(`Connecté ✓ ${result.count} livres trouvés sur ${owner}/${repo} (${branch}).`, "ok");
    updateSyncStatusUI();
  } catch (err) {
    setSyncStatus(`Échec : ${err.message}`, "err");
  }
}
function disconnectGitHub() { MarinaSync.clearGitHubConfig(); fillSyncForm(); }
async function syncNow(manual) {
  const cfg = MarinaSync.getGitHubConfig();
  if (!cfg?.token) { if (manual) setSyncStatus("Connecte d'abord GitHub.", "err"); return; }
  if (!pendingCount()) { if (manual) updateSyncStatusUI(); return; }
  if (manual) setSyncStatus("Synchronisation en cours…");
  try {
    const merged = await MarinaSync.syncMutations({ adds: localAdds, edits: localEdits, deletes: localDeletes });
    remoteBooks = normalizeBooks(merged);
    localAdds = []; localEdits = {}; localDeletes = [];
    saveLocalAdds(); saveLocalEdits(); saveLocalDeletes();
    refreshAndRender();
  } catch (err) {
    console.error("Synchronisation échouée", err);
    if (manual) setSyncStatus(`Échec de synchronisation : ${err.message}`, "err");
  }
  updateSyncStatusUI();
}

/* ============ import Kindle ============ */
let kindleStep = "paste";
let kindleRows = [];

function openKindleDialog() {
  kindleStep = "paste";
  kindleRows = [];
  renderKindleDialog();
  els.kindleDialog.showModal();
}
function renderKindleDialog() {
  document.getElementById("kindleTitle").textContent = kindleStep === "paste" ? "Import Kindle" : "Vérifie les livres détectés";
  els.kindleBody.innerHTML = kindleStep === "paste" ? kindlePasteHTML() : kindlePreviewHTML();
}
function kindlePasteHTML() {
  return `
    <div class="dialog-body">
      <p class="meta">Colle ci-dessous le texte copié depuis ta bibliothèque Kindle (autant de livres que tu veux, d'un coup). Les lignes vides et le texte parasite (« dans la bibliothèque Kindle », numéros de page…) sont filtrés automatiquement.</p>
      <textarea id="kindleTextarea" rows="12" placeholder="Colle ta liste Kindle ici…"></textarea>
      <div class="btn-row" style="margin-top:.9rem;">
        <button class="primary-btn" type="button" id="kindleAnalyzeBtn">Analyser</button>
        <button class="ghost-btn" type="button" data-dialog-close>Annuler</button>
      </div>
    </div>
  `;
}
function kindlePreviewHTML() {
  const total = kindleRows.length;
  const dupes = kindleRows.filter(r => r.dupe).length;
  const incomplete = kindleRows.filter(r => r.incomplete).length;
  const selectedCount = kindleRows.filter(r => r.selected).length;
  if (!total) {
    return `<div class="dialog-body">
      <p class="empty-state">Aucun livre reconnaissable dans ce texte. Vérifie le collage puis réessaie.</p>
      <div class="btn-row"><button class="ghost-btn" type="button" id="kindleBackBtn">Retour</button></div>
    </div>`;
  }
  return `
    <div class="dialog-body">
      <p class="import-summary">${total} livre${total > 1 ? "s" : ""} détecté${total > 1 ? "s" : ""} · ${dupes} doublon${dupes > 1 ? "s" : ""} probable${dupes > 1 ? "s" : ""} · ${incomplete} ligne${incomplete > 1 ? "s" : ""} incomplète${incomplete > 1 ? "s" : ""}</p>
      <label>Statut pour tous les livres importés
        <select id="kindleGlobalStatus">
          ${KINDLE_STATUS_CHOICES.map(s => `<option value="${s}">${STATUS_ORDER.find(o => o.value === s).label}</option>`).join("")}
        </select>
      </label>
      <div class="btn-row" style="margin-bottom:.9rem;">
        <button class="ghost-btn" type="button" id="kindleSelectAll">Tout sélectionner</button>
        <button class="ghost-btn" type="button" id="kindleSelectNone">Tout désélectionner</button>
      </div>
      <div id="kindleRows">${kindleRows.map(kindleRowHTML).join("")}</div>
      <div class="btn-row" style="margin-top:1rem;">
        <button class="primary-btn" type="button" id="kindleCommitBtn">Importer ${selectedCount} livre${selectedCount > 1 ? "s" : ""}</button>
        <button class="ghost-btn" type="button" id="kindleBackBtn">Retour</button>
      </div>
    </div>
  `;
}
function kindleRowHTML(r, i) {
  const dupeLabel = r.dupe === "bibliothèque" ? "Doublon probable — déjà dans ta bibliothèque" : r.dupe === "import" ? "Doublon probable — répété dans ce collage" : "";
  return `
    <div class="import-row${r.dupe ? " dupe" : ""}" data-row="${i}">
      <input type="checkbox" class="chk" data-field="selected" ${r.selected ? "checked" : ""} aria-label="Importer cette ligne" />
      <div class="fields">
        <input type="text" data-field="title" value="${escapeHtml(r.title)}" placeholder="Titre" />
        <div class="row2">
          <input type="text" data-field="author" value="${escapeHtml(r.author)}" placeholder="Auteur" />
          <select data-field="status">
            ${KINDLE_STATUS_CHOICES.map(s => `<option value="${s}" ${r.status === s ? "selected" : ""}>${STATUS_ORDER.find(o => o.value === s).label}</option>`).join("")}
          </select>
        </div>
        <div class="row3">
          <input type="text" data-field="series" value="${escapeHtml(r.series)}" placeholder="Série (optionnel)" />
          <input type="text" data-field="tome" value="${escapeHtml(String(r.tome || ""))}" placeholder="Tome" inputmode="numeric" />
        </div>
        ${dupeLabel ? `<span class="dupe-badge">${dupeLabel}</span>` : ""}
        ${r.incomplete ? `<span class="warn-badge">Auteur manquant — vérifie cette ligne</span>` : ""}
      </div>
      <button class="remove-row" type="button" data-remove-row aria-label="Retirer cette ligne">×</button>
    </div>
  `;
}
function runKindleAnalyze() {
  const raw = document.getElementById("kindleTextarea").value;
  kindleRows = buildKindleRows(raw, "à lire");
  kindleStep = "preview";
  renderKindleDialog();
}
function refreshKindleCommitLabel() {
  const btn = document.getElementById("kindleCommitBtn");
  if (!btn) return;
  const n = kindleRows.filter(r => r.selected).length;
  btn.textContent = `Importer ${n} livre${n > 1 ? "s" : ""}`;
}
function commitKindleImport() {
  const toAdd = kindleRows.filter(r => r.selected && r.title.trim());
  toAdd.forEach(r => {
    localAdds.push({
      id: genId(r.title),
      title: r.title.trim(),
      author: r.author.trim(),
      series: r.series.trim(),
      tome: r.tome ? Number(r.tome) : "",
      year: new Date().getFullYear(),
      dateAdded: new Date().toISOString().slice(0, 10),
      status: r.status,
      missing: false,
      notes: "",
      cover: "",
    });
  });
  saveLocalAdds();
  refreshAndRender();
  syncNow(false);
  els.kindleDialog.close();
  switchView("library");
}
function bindKindleDialogEvents() {
  els.kindleDialog.addEventListener("click", (e) => {
    if (e.target.id === "kindleAnalyzeBtn") { runKindleAnalyze(); return; }
    if (e.target.id === "kindleBackBtn") { kindleStep = "paste"; renderKindleDialog(); return; }
    if (e.target.id === "kindleSelectAll") { kindleRows.forEach(r => r.selected = true); renderKindleDialog(); return; }
    if (e.target.id === "kindleSelectNone") { kindleRows.forEach(r => r.selected = false); renderKindleDialog(); return; }
    if (e.target.id === "kindleCommitBtn") { commitKindleImport(); return; }
    const rmBtn = e.target.closest("[data-remove-row]");
    if (rmBtn) {
      const idx = Number(rmBtn.closest(".import-row").dataset.row);
      kindleRows.splice(idx, 1);
      renderKindleDialog();
    }
  });
  els.kindleDialog.addEventListener("input", (e) => {
    if (e.target.tagName !== "INPUT" || e.target.type !== "text") return;
    const row = e.target.closest(".import-row");
    if (!row) return;
    const idx = Number(row.dataset.row);
    const field = e.target.dataset.field;
    if (field) kindleRows[idx][field] = e.target.value;
  });
  els.kindleDialog.addEventListener("change", (e) => {
    if (e.target.id === "kindleGlobalStatus") {
      kindleRows.forEach(r => r.status = e.target.value);
      renderKindleDialog();
      return;
    }
    const row = e.target.closest(".import-row");
    if (!row) return;
    const idx = Number(row.dataset.row);
    const field = e.target.dataset.field;
    if (field === "selected") { kindleRows[idx].selected = e.target.checked; refreshKindleCommitLabel(); }
    else if (field) kindleRows[idx][field] = e.target.value;
  });
}

// Reconnaît la ligne marqueur même quand l'auteur est collé dessus
// ("Piper Sullivan dans la bibliothèque Kindle"), pas seulement seule.
const KINDLE_MARKER_RE = /^(.*?)\s*dans\s+la\s+biblioth[eè]que\s+kindle\s*$/i;
// Libellés de l'interface Kindle (barre de navigation, boutons...) qui peuvent
// se retrouver collés en fin de texte : jamais un livre à eux seuls.
const KINDLE_UI_WORDS = new Set([
  "accueil", "bibliotheque", "ma bibliotheque", "plus", "rechercher", "recherche",
  "parametres", "reglages", "retour", "boutique kindle", "acheter", "lire maintenant",
  "menu", "profil", "notifications", "voir plus", "voir sur amazon", "precedent", "suivant",
]);

// Une ligne "bruit" typique du copier-coller Kindle (fragments de jaquette,
// libellés d'interface) est courte/tout en majuscules, sans un seul mot en
// minuscule reconnaissable — un vrai titre ou auteur contient toujours des
// minuscules en français ("Le gardien...", "Piper Sullivan"...).
function looksLikeNoiseFragment(line) {
  if (KINDLE_UI_WORDS.has(clean(line))) return true;
  const letters = line.replace(/[^\p{L}]/gu, "");
  if (!letters) return true;
  return !/\p{Ll}/u.test(letters);
}
// Retire un préfixe tout en majuscules collé devant le vrai titre (ex.
// "PIPER SULLIVAN Curvy Fake Wife..." -> "Curvy Fake Wife...") : ce sont des
// fragments de jaquette/nom d'autrice répétés par le copier-coller Kindle.
function stripLeadingCapsNoise(line) {
  const m = line.match(/^((?:[A-ZÀ-Þ]{2,}[:.'-]?\s+)+)(?=[A-ZÀ-Þ][a-zà-ÿ]|[a-zà-ÿ])/);
  return m ? line.slice(m[1].length).trim() : line;
}

function parseKindleText(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const hasMarker = lines.some(l => KINDLE_MARKER_RE.test(l));

  if (!hasMarker) {
    const usable = lines.filter(l => !looksLikeNoiseFragment(l));
    const pairs = [];
    for (let i = 0; i < usable.length; i += 2) {
      pairs.push({ title: stripLeadingCapsNoise(usable[i]), author: usable[i + 1] || "", incomplete: !usable[i + 1] });
    }
    return pairs;
  }

  const records = [];
  let buffer = [];
  for (const line of lines) {
    const m = line.match(KINDLE_MARKER_RE);
    if (m) {
      const inlineAuthor = m[1].trim();
      let author, titleLines;
      if (inlineAuthor) {
        author = inlineAuthor;
        titleLines = buffer;
      } else if (buffer.length) {
        author = buffer[buffer.length - 1];
        titleLines = buffer.slice(0, -1);
      } else {
        author = "";
        titleLines = [];
      }
      if (titleLines.length) {
        records.push({ title: stripLeadingCapsNoise(titleLines.join(" ")), author, incomplete: !author });
      }
      buffer = [];
      continue;
    }
    if (!looksLikeNoiseFragment(line)) buffer.push(line);
  }
  // Un reliquat en fin de texte qui n'a jamais atteint de marqueur n'est
  // volontairement PAS transformé en livre : le plus souvent c'est la barre
  // de navigation de l'app Kindle, pas un livre coupé. Mieux vaut ne rien
  // créer que créer un faux livre.

  return records;
}
function extractSeriesTome(title) {
  const m = title.match(/\(([^()]+?)(?:\s+t\.?\s*(\d+)|\s+tome\s*(\d+))?\)\s*$/i);
  if (!m) return { series: "", tome: "" };
  return { series: m[1].trim(), tome: m[2] || m[3] || "" };
}
function findDuplicate(title, existingBooks, batchTitlesSeen) {
  const ct = clean(title);
  if (!ct) return null;
  const inExisting = existingBooks.some(b => {
    const et = clean(b.title);
    if (!et) return false;
    return et === ct || (ct.length > 8 && (et.includes(ct) || ct.includes(et)));
  });
  if (inExisting) return "bibliothèque";
  if (batchTitlesSeen.has(ct)) return "import";
  return null;
}
function buildKindleRows(rawText, defaultStatus) {
  const parsed = parseKindleText(rawText);
  const seen = new Set();
  return parsed.filter(p => p.title && p.title.trim()).map((p, i) => {
    const { series, tome } = extractSeriesTome(p.title);
    const dupe = findDuplicate(p.title, allBooks, seen);
    seen.add(clean(p.title));
    return {
      title: p.title,
      author: p.author || "",
      series,
      tome,
      status: defaultStatus,
      selected: !dupe,
      dupe,
      incomplete: Boolean(p.incomplete),
    };
  });
}

/* ============ export / import ============ */
function exportData() {
  const payload = { exportedAt: new Date().toISOString(), localAdds, localEdits, localDeletes, allBooks };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `bibliotheque-marina-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  URL.revokeObjectURL(url);
}
async function importData(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const json = JSON.parse(await file.text());
  localAdds = Array.isArray(json.localAdds) ? json.localAdds : Array.isArray(json) ? json : [];
  localEdits = json.localEdits && typeof json.localEdits === "object" ? json.localEdits : {};
  localDeletes = Array.isArray(json.localDeletes) ? json.localDeletes : [];
  saveLocalAdds(); saveLocalEdits(); saveLocalDeletes();
  refreshAndRender();
  syncNow(false);
  e.target.value = "";
}

/* ============ storage / utils ============ */
function loadLocalAdds() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } }
function saveLocalAdds() { localStorage.setItem(STORAGE_KEY, JSON.stringify(localAdds)); }
function loadLocalEdits() { try { return JSON.parse(localStorage.getItem(EDITS_KEY)) || {}; } catch { return {}; } }
function saveLocalEdits() { localStorage.setItem(EDITS_KEY, JSON.stringify(localEdits)); }
function loadLocalDeletes() { try { return JSON.parse(localStorage.getItem(DELETES_KEY)) || []; } catch { return []; } }
function saveLocalDeletes() { localStorage.setItem(DELETES_KEY, JSON.stringify(localDeletes)); }
function clean(str) { return String(str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function slug(str) { return clean(str).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function escapeHtml(str) { return String(str ?? "").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch])); }
function registerSW() { if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {}); }
