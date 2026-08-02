// Écriture réelle (dépôt GitHub) du prototype d'extraction multi-captures Kindle.
// Fichier séparé de js/sync.js : ne modifie jamais data/books.json seul, mais
// livres + couvertures en un unique commit atomique (API Git Data), pour ne
// jamais laisser le dépôt dans un état incohérent (couvertures écrites sans
// les livres, ou l'inverse) en cas de panne à mi-parcours.
(function () {
  const GH_API = "https://api.github.com";

  function clean(str) {
    return String(str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  function slug(str) {
    return clean(str).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }
  // Même formule que genId() dans js/app.js ; regénère si l'id tombe déjà dans
  // ce lot (plusieurs "add" du même clic peuvent partager le même Date.now()).
  function genId(title, usedIds) {
    let id;
    do {
      id = `${slug(title || "livre")}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  }

  function cropToJpegDataUrl(img, x, y, w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    c.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.85);
  }

  // Transforme la liste consolidée (issue de mergeAndDedupe) en mutations
  // books.json + fichiers de couverture à committer. N'écrit rien elle-même.
  function buildMutationsFromConsolidated(consolidated, capturedImages) {
    const adds = [];
    const edits = {};
    const coverFiles = [];
    const warnings = [];
    const usedIds = new Set();

    consolidated.forEach(entry => {
      if (entry.action !== "add" && entry.action !== "add-cover" && entry.action !== "replace-cover") return;
      const img = capturedImages[entry.captureIndex] && capturedImages[entry.captureIndex].img;
      const dataUrl = img ? cropToJpegDataUrl(img, entry.x, entry.y, entry.w, entry.h) : null;

      if (entry.action === "add") {
        const id = genId(entry.title, usedIds);
        const cover = `covers/${id}.jpg`;
        adds.push({
          id,
          title: (entry.title || "").trim(),
          author: (entry.author || "").trim(),
          series: (entry.series || "").trim(),
          tome: entry.tome ? Number(entry.tome) : "",
          year: new Date().getFullYear(),
          dateAdded: new Date().toISOString().slice(0, 10),
          status: "lu",
          missing: false,
          notes: "",
          cover,
        });
        if (dataUrl) coverFiles.push({ path: cover, dataUrl });
      } else {
        const targetId = entry.existingMatch && entry.existingMatch.id;
        if (!targetId) {
          warnings.push(`Livre existant sans id retrouvé pour « ${entry.title} » — couverture ignorée.`);
          return;
        }
        const cover = `covers/${targetId}.jpg`;
        edits[targetId] = { ...(edits[targetId] || {}), cover };
        if (dataUrl) coverFiles.push({ path: cover, dataUrl });
      }
    });

    return {
      adds,
      edits,
      coverFiles,
      warnings,
      tally: { adds: adds.length, edits: Object.keys(edits).length, files: coverFiles.length + 1 },
    };
  }

  async function ghFetch(cfg, path, opts) {
    opts = opts || {};
    const res = await fetch(`${GH_API}${path}`, {
      method: opts.method || "GET",
      headers: {
        "Authorization": `Bearer ${cfg.token}`,
        "Accept": "application/vnd.github+json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      const err = new Error(detail.message || `Erreur GitHub (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
  }
  function dataUrlToBase64(dataUrl) {
    const idx = dataUrl.indexOf(",");
    return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  }

  async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
  }

  // Commit atomique (API Git Data : blobs -> tree -> commit -> update ref) de
  // data/books.json (fusionné avec adds/edits, même algorithme que
  // MarinaSync.syncMutations) et de tous les fichiers de couverture. Rien
  // n'est visible dans le dépôt tant que la toute dernière étape (déplacer la
  // branche) n'a pas réussi.
  async function commitBatchAtomic(cfg, mutations, opts) {
    opts = opts || {};
    const concurrency = opts.concurrency || 4;
    const onProgress = opts.onProgress || function () {};
    const { adds, edits, coverFiles } = mutations;

    const total = 1 + coverFiles.length;
    let done = 0;
    const report = () => { done++; onProgress(done, total); };

    const coverBlobs = await mapWithConcurrency(coverFiles, concurrency, async (file) => {
      const blob = await ghFetch(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: dataUrlToBase64(file.dataUrl), encoding: "base64" }),
      });
      report();
      return { path: file.path, sha: blob.sha };
    });

    async function attempt(retriesLeft) {
      const branchInfo = await ghFetch(cfg, `/repos/${cfg.owner}/${cfg.repo}/branches/${encodeURIComponent(cfg.branch)}`);
      const parentCommitSha = branchInfo.commit.sha;
      const baseTreeSha = branchInfo.commit.commit.tree.sha;

      const current = await window.MarinaSync.githubGetFile(cfg);
      const survivors = current.books.map(b => (edits[b.id] ? { ...b, ...edits[b.id] } : b));
      const missingEdits = Object.keys(edits).filter(id => !current.books.some(b => b.id === id));
      const merged = [...survivors, ...adds];

      const booksBlob = await ghFetch(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: utf8ToBase64(JSON.stringify(merged, null, 2) + "\n"), encoding: "base64" }),
      });
      if (retriesLeft === 1) report();

      const treeEntries = [
        { path: "data/books.json", mode: "100644", type: "blob", sha: booksBlob.sha },
        ...coverBlobs.map(c => ({ path: c.path, mode: "100644", type: "blob", sha: c.sha })),
      ];
      const newTree = await ghFetch(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
      });

      const parts = [];
      if (adds.length) parts.push(`+${adds.length}`);
      if (Object.keys(edits).length) parts.push(`✎${Object.keys(edits).length}`);
      const message = `Import Kindle : ${parts.join(" ") || "mise à jour"}`;
      const newCommit = await ghFetch(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message, tree: newTree.sha, parents: [parentCommitSha] }),
      });

      try {
        await ghFetch(cfg, `/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/${encodeURIComponent(cfg.branch)}`, {
          method: "PATCH",
          body: JSON.stringify({ sha: newCommit.sha, force: false }),
        });
      } catch (err) {
        if ((err.status === 422 || err.status === 409) && retriesLeft > 0) {
          return attempt(retriesLeft - 1);
        }
        throw err;
      }

      return { commitSha: newCommit.sha, missingEdits, filesWritten: total };
    }

    return attempt(1);
  }

  window.KindleCoverSync = { buildMutationsFromConsolidated, commitBatchAtomic };
})();
