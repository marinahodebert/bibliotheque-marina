// Import de livres depuis des captures d'écran de la bibliothèque Kindle,
// directement dans l'application. Étapes : choisir les captures -> lecture
// automatique (js/kindle-captures.js) -> vérification -> un seul commit
// GitHub livres + couvertures (js/kindle-cover-sync.js).
//
// Chargé après js/app.js : utilise ses fonctions globales (escapeHtml,
// loadRemoteBooks, normalizeBooks, refreshAndRender, switchView,
// openSyncDialog, STATUS_ORDER) et la variable remoteBooks.
(function () {
  const dialog = document.getElementById("capturesDialog");
  const body = document.getElementById("capturesBody");
  const titleEl = document.getElementById("capturesTitle");
  const fileInput = document.getElementById("capturesInput");

  const STATUS_CHOICES = ["lu", "à lire", "en cours", "non défini"];

  let step = "pick";          // pick | analyzing | review | writing | done | error
  let images = [];            // [{ img, name, blob }]
  let detections = [];
  let entries = [];           // livres uniques (mergeAndDedupe) + vignette
  let newStatus = "lu";
  let progress = { text: "", ratio: 0 };
  let result = null;          // { commitSha, adds, covers, warn }
  let errorMsg = "";
  let writeInFlight = false;

  function isConnected() {
    const cfg = window.MarinaSync && MarinaSync.getGitHubConfig();
    return !!(cfg && cfg.token);
  }

  // Fermer la fenêtre n'interrompt rien : une lecture ou un envoi en cours
  // continue, et la rouvrir montre où on en est.
  function open() {
    if (step === "analyzing" || writeInFlight) { render(); dialog.showModal(); return; }
    step = "pick";
    images = []; detections = []; entries = []; result = null; errorMsg = "";
    render();
    dialog.showModal();
  }

  // ---------------------------------------------------------------- rendu
  function render() {
    titleEl.textContent = {
      pick: "Importer des captures Kindle",
      analyzing: "Lecture des captures…",
      review: "Vérifie avant d'ajouter",
      writing: "Enregistrement…",
      done: "C'est fait",
      error: "Oups",
    }[step];
    body.innerHTML = {
      pick: pickHTML,
      analyzing: analyzingHTML,
      review: reviewHTML,
      writing: writingHTML,
      done: doneHTML,
      error: errorHTML,
    }[step]();
  }

  function pickHTML() {
    const connected = isConnected();
    return `<div class="dialog-body">
      <ol class="cap-steps">
        <li>Dans l'appli Kindle, ouvre ta <b>Bibliothèque</b> en <b>affichage Liste</b> (une couverture par ligne, avec le titre à côté).</li>
        <li>Fais des captures d'écran en faisant défiler. Elles peuvent se chevaucher, les doublons sont fusionnés.</li>
        <li>Choisis-les toutes ici : titres, auteurs et couvertures sont extraits automatiquement.</li>
      </ol>
      ${connected ? "" : `<div class="cap-warn">
        <p>Connecte d'abord GitHub : c'est nécessaire pour comparer à ta bibliothèque et enregistrer les livres.</p>
        <button class="ghost-btn" type="button" data-cap="connect">Connecter GitHub</button>
      </div>`}
      <div class="btn-row" style="margin-top:1rem;">
        <button class="primary-btn" type="button" data-cap="choose" ${connected ? "" : "disabled"}>Choisir les captures</button>
        <button class="ghost-btn" type="button" data-dialog-close>Annuler</button>
      </div>
    </div>`;
  }

  function analyzingHTML() {
    return `<div class="dialog-body">
      <p class="meta">${images.length} capture${images.length > 1 ? "s" : ""}. Garde l'écran allumé pendant la lecture. La première fois, le moteur de lecture se télécharge (quelques secondes de plus).</p>
      <div class="cap-progress"><i style="width:${Math.round(progress.ratio * 100)}%"></i></div>
      <p class="meta" id="capProgressText">${escapeHtml(progress.text)}</p>
    </div>`;
  }

  function entryFieldsHTML(e, i) {
    return `<div class="fields">
      <input type="text" data-i="${i}" data-field="title" value="${escapeHtml(e.title)}" placeholder="Titre" />
      <input type="text" data-i="${i}" data-field="author" value="${escapeHtml(e.author)}" placeholder="Auteur" />
      <div class="row3">
        <input type="text" data-i="${i}" data-field="series" value="${escapeHtml(e.series)}" placeholder="Série (optionnel)" />
        <input type="text" data-i="${i}" data-field="tome" value="${escapeHtml(String(e.tome || ""))}" placeholder="Tome" inputmode="numeric" />
      </div>
    </div>`;
  }

  function cardHTML(e, i) {
    const thumb = `<img class="cap-thumb" src="${e.thumb}" alt="" />`;
    if (e.category === "new") {
      return `<div class="cap-card${e.action === "add" ? "" : " off"}">
        ${thumb}
        ${entryFieldsHTML(e, i)}
        <label class="cap-check"><input type="checkbox" data-i="${i}" data-toggle="add" ${e.action === "add" ? "checked" : ""} /> Ajouter</label>
      </div>`;
    }
    if (e.category === "existing-no-cover" || e.category === "existing-has-cover") {
      const on = e.category === "existing-no-cover" ? "add-cover" : "replace-cover";
      const label = e.category === "existing-no-cover" ? "Ajouter la couverture" : "Remplacer la couverture";
      const old = e.existingMatch.cover ? `<img class="cap-thumb old" src="${escapeHtml(e.existingMatch.cover)}" alt="Couverture actuelle" />` : "";
      return `<div class="cap-card${e.action === on ? "" : " off"}">
        <div class="cap-thumbs">${thumb}${old}</div>
        <div class="fields"><p class="cap-title">${escapeHtml(e.existingMatch.title)}</p><p class="meta">${escapeHtml(e.existingMatch.author || "")}</p></div>
        <label class="cap-check"><input type="checkbox" data-i="${i}" data-toggle="${on}" ${e.action === on ? "checked" : ""} /> ${label}</label>
      </div>`;
    }
    if (e.category === "uncertain") {
      const name = `cap-resolve-${i}`;
      return `<div class="cap-card uncertain">
        ${thumb}
        <div class="fields">
          <p class="meta">Lu sur la capture :</p>
          ${entryFieldsHTML(e, i)}
          <p class="meta">Ressemble à « <b>${escapeHtml(e.existingMatch.title)}</b> » — ${escapeHtml(e.existingMatch.author || "")}</p>
          <div class="cap-radios">
            <label><input type="radio" name="${name}" data-i="${i}" value="none" ${e.action === "none" ? "checked" : ""} /> Ignorer</label>
            <label><input type="radio" name="${name}" data-i="${i}" value="add-cover" ${e.action === "add-cover" ? "checked" : ""} /> C'est le même livre : ajouter la couverture</label>
            <label><input type="radio" name="${name}" data-i="${i}" value="add" ${e.action === "add" ? "checked" : ""} /> C'est un autre livre : l'ajouter</label>
          </div>
        </div>
      </div>`;
    }
    return `<div class="cap-card off">${thumb}<div class="fields"><p class="meta">Couverture coupée par le bord de la capture : reprends-la dans une autre capture.</p></div></div>`;
  }

  function section(title, list, opts) {
    if (!list.length) return "";
    const cards = list.map(({ e, i }) => cardHTML(e, i)).join("");
    if (opts && opts.collapsed) {
      return `<details class="cap-section"><summary>${title} <span class="cap-n">${list.length}</span></summary>${cards}</details>`;
    }
    return `<section class="cap-section"><h3>${title} <span class="cap-n">${list.length}</span></h3>${opts && opts.hint ? `<p class="meta">${opts.hint}</p>` : ""}${cards}</section>`;
  }

  function tally() {
    let adds = 0, covers = 0;
    entries.forEach(e => {
      if (e.action === "add") adds++;
      else if (e.action === "add-cover" || e.action === "replace-cover") covers++;
    });
    return { adds, covers };
  }
  function commitLabel() {
    const { adds, covers } = tally();
    const parts = [];
    if (adds) parts.push(`${adds} livre${adds > 1 ? "s" : ""}`);
    if (covers) parts.push(`${covers} couverture${covers > 1 ? "s" : ""}`);
    return parts.length ? `Ajouter ${parts.join(" et ")}` : "Rien de coché";
  }

  function reviewHTML() {
    const idx = entries.map((e, i) => ({ e, i }));
    const by = cat => idx.filter(x => x.e.category === cat);
    const existing = idx.filter(x => x.e.category === "existing-no-cover" || x.e.category === "existing-has-cover");
    const withCover = existing.filter(x => x.e.category === "existing-has-cover");
    const noCover = existing.filter(x => x.e.category === "existing-no-cover");
    const { adds, covers } = tally();

    if (!entries.length) {
      return `<div class="dialog-body">
        <p class="empty-state">Aucun livre reconnu sur ces captures. Vérifie que la bibliothèque Kindle est bien en affichage Liste, puis réessaie.</p>
        <div class="btn-row"><button class="ghost-btn" type="button" data-cap="restart">Choisir d'autres captures</button></div>
      </div>`;
    }

    return `<div class="dialog-body">
      <p class="import-summary">${images.length} capture${images.length > 1 ? "s" : ""} · ${entries.length} livre${entries.length > 1 ? "s" : ""} trouvé${entries.length > 1 ? "s" : ""}. Corrige ce qui a été mal lu si besoin.</p>
      ${by("new").length ? `<label>Statut des nouveaux livres
        <select data-cap="status">${STATUS_CHOICES.map(s => `<option value="${s}" ${s === newStatus ? "selected" : ""}>${STATUS_ORDER.find(o => o.value === s).label}</option>`).join("")}</select>
      </label>` : ""}
      ${section("Nouveaux livres", by("new"))}
      ${section("À confirmer", by("uncertain"), { hint: "Le titre ressemble à un livre que tu as déjà, sans certitude." })}
      ${section("Couvertures à compléter", noCover, { hint: "Déjà dans ta bibliothèque, sans couverture." })}
      ${section("Déjà là, avec couverture", withCover, { collapsed: true })}
      ${section("Ignorés", by("partial"), { collapsed: true })}
      <div class="cap-footer">
        <button class="primary-btn" type="button" data-cap="commit" ${adds + covers ? "" : "disabled"}>${commitLabel()}</button>
        <button class="ghost-btn" type="button" data-cap="restart">Recommencer</button>
      </div>
    </div>`;
  }

  function writingHTML() {
    return `<div class="dialog-body">
      <div class="cap-progress"><i style="width:${Math.round(progress.ratio * 100)}%"></i></div>
      <p class="meta" id="capProgressText">${escapeHtml(progress.text)}</p>
    </div>`;
  }

  function doneHTML() {
    const cfg = MarinaSync.getGitHubConfig();
    const parts = [];
    if (result.adds) parts.push(`${result.adds} livre${result.adds > 1 ? "s" : ""} ajouté${result.adds > 1 ? "s" : ""}`);
    if (result.covers) parts.push(`${result.covers} couverture${result.covers > 1 ? "s" : ""} enregistrée${result.covers > 1 ? "s" : ""}`);
    return `<div class="dialog-body">
      <p class="cap-done">${parts.join(", ")}.</p>
      ${result.warn ? `<p class="meta sync-err">${escapeHtml(result.warn)}</p>` : ""}
      <p class="meta">Enregistré sur GitHub en un seul commit (<a href="https://github.com/${cfg.owner}/${cfg.repo}/commit/${result.commitSha}" target="_blank" rel="noopener">${result.commitSha.slice(0, 7)}</a>).</p>
      <div class="btn-row" style="margin-top:1rem;">
        <button class="primary-btn" type="button" data-cap="see">Voir ma bibliothèque</button>
        <button class="ghost-btn" type="button" data-cap="restart">Importer d'autres captures</button>
      </div>
    </div>`;
  }

  function errorHTML() {
    return `<div class="dialog-body">
      <p class="meta sync-err">${escapeHtml(errorMsg)}</p>
      <div class="btn-row" style="margin-top:1rem;">
        ${entries.length ? `<button class="primary-btn" type="button" data-cap="back-review">Retour à la vérification</button>` : ""}
        <button class="ghost-btn" type="button" data-cap="restart">Recommencer</button>
      </div>
    </div>`;
  }

  function setProgress(text, ratio) {
    progress = { text, ratio };
    const t = document.getElementById("capProgressText");
    const bar = body.querySelector(".cap-progress i");
    if (t) t.textContent = text;
    if (bar) bar.style.width = `${Math.round(ratio * 100)}%`;
  }

  // ---------------------------------------------------------------- actions
  async function analyze(files) {
    step = "analyzing";
    progress = { text: "Préparation…", ratio: 0 };
    render();
    try {
      images = await KindleCaptures.loadImages(files);
      setProgress("Chargement du moteur de lecture…", 0.02);
      detections = await KindleCaptures.analyzeCaptures(images, {
        layout: "list",
        onProgress: ({ capture, captures, book, books }) => {
          const ratio = ((capture - 1) + (books ? book / books : 0)) / captures;
          setProgress(book
            ? `Capture ${capture}/${captures} · livre ${book}/${books}`
            : `Capture ${capture}/${captures} · repérage des couvertures`, 0.05 + ratio * 0.85);
        },
      });
      setProgress("Comparaison avec ta bibliothèque…", 0.93);
      const existing = await KindleCaptures.fetchExistingBooks();
      if (existing.error) throw new Error(existing.error === "not-connected"
        ? "GitHub n'est pas connecté."
        : `Lecture de ta bibliothèque impossible : ${existing.error}`);
      entries = KindleCaptures.mergeAndDedupe(detections, existing.books).map(e => ({
        ...e,
        thumb: KindleCaptures.cropToDataUrl(images[e.captureIndex].img, e.x, e.y, e.w, e.h, "image/jpeg", 0.7),
      }));
      step = "review";
    } catch (err) {
      console.error("Import captures", err);
      errorMsg = `La lecture des captures a échoué : ${err.message}`;
      entries = [];
      step = "error";
    }
    render();
  }

  async function commit() {
    if (writeInFlight) return;
    const cfg = MarinaSync.getGitHubConfig();
    if (!cfg || !cfg.token) { errorMsg = "GitHub n'est pas connecté."; step = "error"; render(); return; }

    const scoped = entries.map(e => ({ ...e, status: newStatus }));
    const mutations = KindleCoverSync.buildMutationsFromConsolidated(scoped, images);
    if (!mutations.adds.length && !Object.keys(mutations.edits).length) return;

    writeInFlight = true;
    step = "writing";
    progress = { text: "Envoi des couvertures…", ratio: 0 };
    render();
    try {
      const res = await KindleCoverSync.commitBatchAtomic(cfg, mutations, {
        concurrency: 4,
        onProgress: (done, total) => setProgress(`Envoi ${done}/${total}…`, done / total),
      });
      result = {
        commitSha: res.commitSha,
        adds: mutations.tally.adds,
        covers: mutations.tally.edits,
        warn: [
          ...mutations.warnings,
          ...(res.missingEdits.length ? [`${res.missingEdits.length} livre(s) n'existaient plus dans la bibliothèque : leur couverture n'a pas été rattachée.`] : []),
        ].join(" "),
      };
      remoteBooks = normalizeBooks(await loadRemoteBooks());
      refreshAndRender();
      step = "done";
    } catch (err) {
      console.error("Écriture captures", err);
      let msg = err.message || "Erreur inconnue";
      if (err.status === 401) msg = "Token GitHub invalide ou expiré.";
      else if (err.status === 403) msg = "Accès refusé (permissions du token, ou limite d'API atteinte).";
      else if (err.status === 404) msg = "Dépôt ou branche introuvable.";
      else if (err.status === 409 || err.status === 422) msg = "La bibliothèque a été modifiée entre-temps. Réessaie.";
      errorMsg = `L'enregistrement a échoué, rien n'a été modifié : ${msg}`;
      step = "error";
    } finally {
      writeInFlight = false;
    }
    render();
  }

  // ---------------------------------------------------------------- événements
  document.getElementById("chooseCaptures").addEventListener("click", () => {
    document.getElementById("addChoiceDialog").close();
    open();
  });

  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []).filter(f => f.type.startsWith("image/"));
    fileInput.value = "";
    if (files.length) analyze(files);
  });

  dialog.addEventListener("click", (e) => {
    if (e.target.closest("[data-dialog-close]")) { dialog.close(); return; }
    const btn = e.target.closest("[data-cap]");
    if (!btn) return;
    const what = btn.dataset.cap;
    if (what === "choose") fileInput.click();
    else if (what === "connect") { dialog.close(); openSyncDialog(); }
    else if (what === "restart") { step = "pick"; entries = []; render(); }
    else if (what === "back-review") { step = "review"; render(); }
    else if (what === "commit") commit();
    else if (what === "see") { dialog.close(); switchView("library"); }
  });

  dialog.addEventListener("input", (e) => {
    const i = e.target.dataset.i;
    const field = e.target.dataset.field;
    if (i === undefined || !field || !entries[i]) return;
    entries[i][field] = e.target.value;
  });

  dialog.addEventListener("change", (e) => {
    if (e.target.dataset.cap === "status") { newStatus = e.target.value; return; }
    const i = e.target.dataset.i;
    if (i === undefined || !entries[i]) return;
    if (e.target.type === "checkbox") {
      entries[i].action = e.target.checked ? e.target.dataset.toggle : "none";
      e.target.closest(".cap-card").classList.toggle("off", !e.target.checked);
    } else if (e.target.type === "radio") {
      entries[i].action = e.target.value;
    } else {
      return;
    }
    const commitBtn = body.querySelector('[data-cap="commit"]');
    if (commitBtn) {
      const { adds, covers } = tally();
      commitBtn.textContent = commitLabel();
      commitBtn.disabled = !(adds + covers);
    }
  });
})();
