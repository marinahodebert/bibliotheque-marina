// Moteur d'extraction de livres depuis des captures d'écran de la bibliothèque
// Kindle (affichage Liste) : détection des couvertures, OCR titre/auteur,
// fusion des doublons entre captures qui se chevauchent, comparaison à la
// bibliothèque existante. Aucune écriture ici : l'écriture est faite par
// js/kindle-cover-sync.js.
//
// Partagé par l'application (index.html, import « Captures d'écran ») et par
// l'outil de réglage test-cover-extract.html. Les règles ci-dessous ont été
// validées sur de vraies captures le 2026-08-02 : ne pas les assouplir sans
// refaire ce test (fusionner à tort fait perdre un livre).
(function () {
  const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

  const DEFAULT_OPTS = {
    thresholdRatio: 0.14,
    minGap: 10,
    minSize: 60,
    ratioMin: 0.45,
    ratioMax: 1.05,
    mergeGap: 40,
  };

  // -------------------------------------------------------------------------
  // Détection par profils de projection
  // -------------------------------------------------------------------------
  function toGrayscale(imageData) {
    const { data, width, height } = imageData;
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return gray;
  }
  function columnActivity(gray, width, height) {
    const profile = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = 1; y < height; y++) sum += Math.abs(gray[y * width + x] - gray[(y - 1) * width + x]);
      profile[x] = sum / height;
    }
    return profile;
  }
  function rowActivity(gray, width, height) {
    const profile = new Float32Array(height);
    const rowGrad = new Float32Array(width);
    for (let y = 0; y < height; y++) {
      const base = y * width;
      rowGrad[0] = 0;
      for (let x = 1; x < width; x++) rowGrad[x] = Math.abs(gray[base + x] - gray[base + x - 1]);
      const smoothed = smooth(rowGrad, 6);
      let maxVal = 0;
      for (let x = 0; x < width; x++) if (smoothed[x] > maxVal) maxVal = smoothed[x];
      profile[y] = maxVal;
    }
    return profile;
  }
  function smooth(arr, radius) {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let sum = 0, n = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = i + k;
        if (j >= 0 && j < arr.length) { sum += arr[j]; n++; }
      }
      out[i] = sum / n;
    }
    return out;
  }
  function findContentBands(profile, thresholdRatio, minGap) {
    let max = 0;
    for (let i = 0; i < profile.length; i++) if (profile[i] > max) max = profile[i];
    const bands = [];
    let start = null, gapRun = 0;
    for (let i = 0; i < profile.length; i++) {
      const isBackground = profile[i] < max * thresholdRatio;
      if (!isBackground) { if (start === null) start = i; gapRun = 0; }
      else {
        gapRun++;
        if (start !== null && gapRun >= minGap) { bands.push([start, i - gapRun]); start = null; }
      }
    }
    if (start !== null) bands.push([start, profile.length - 1]);
    return bands.filter(([a, b]) => b - a > 3);
  }
  function mergeBands(bands, maxMergeGap) {
    if (!bands.length) return bands;
    const sorted = [...bands].map(b => [...b]).sort((a, b) => a[0] - b[0]);
    const merged = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      const [s, e] = sorted[i];
      if (s - last[1] <= maxMergeGap) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    return merged;
  }
  function columnActivityInRows(gray, width, y0, y1) {
    const h = y1 - y0;
    const profile = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = y0 + 1; y < y1; y++) sum += Math.abs(gray[y * width + x] - gray[(y - 1) * width + x]);
      profile[x] = sum / Math.max(1, h);
    }
    return profile;
  }
  const EDGE_MARGIN = 3;
  function touchesEdge(y0, y1, height) { return y0 <= EDGE_MARGIN || y1 >= height - 1 - EDGE_MARGIN; }

  function detectGrid(gray, width, height, opts) {
    const colProfile = smooth(columnActivity(gray, width, height), 2);
    const rowProfile = smooth(rowActivity(gray, width, height), 2);
    const colBands = findContentBands(colProfile, opts.thresholdRatio, opts.minGap);
    const rowBands = mergeBands(findContentBands(rowProfile, opts.thresholdRatio, opts.minGap), opts.mergeGap);
    const boxes = [];
    for (const [ry0, ry1] of rowBands) {
      for (const [cx0, cx1] of colBands) {
        const w = cx1 - cx0, h = ry1 - ry0;
        if (w < opts.minSize || h < opts.minSize) continue;
        const ratio = w / h;
        if (ratio < opts.ratioMin || ratio > opts.ratioMax) continue;
        boxes.push({ x: cx0, y: ry0, w, h, partial: touchesEdge(ry0, ry1, height), textRegion: null });
      }
    }
    return boxes;
  }
  function detectList(gray, width, height, opts) {
    const rowProfile = smooth(rowActivity(gray, width, height), 2);
    const rowBands = mergeBands(findContentBands(rowProfile, opts.thresholdRatio, opts.minGap), opts.mergeGap);
    const boxes = [];
    for (const [ry0, ry1] of rowBands) {
      if (ry1 - ry0 < opts.minSize) continue;
      const colProfile = smooth(columnActivityInRows(gray, width, ry0, ry1), 2);
      const colBands = findContentBands(colProfile, opts.thresholdRatio, opts.minGap);
      if (!colBands.length) continue;
      const [cx0, cx1] = colBands[0];
      const w = cx1 - cx0, h = ry1 - ry0;
      if (w < opts.minSize || h < opts.minSize) continue;
      const ratio = w / h;
      if (ratio < opts.ratioMin || ratio > opts.ratioMax) continue;
      const textX = Math.min(width - 1, cx1 + 12);
      boxes.push({
        x: cx0, y: ry0, w, h,
        partial: touchesEdge(ry0, ry1, height),
        textRegion: { x: textX, y: ry0, w: Math.max(0, width - textX - 8), h },
      });
    }
    return boxes;
  }

  function cropToDataUrl(img, x, y, w, h, type, quality) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    c.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
    return c.toDataURL(type || "image/jpeg", quality || 0.85);
  }

  // -------------------------------------------------------------------------
  // Lecture du texte OCR
  // -------------------------------------------------------------------------
  function parseOcrText(raw) {
    const rawLines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!rawLines.length) return { title: "", author: "" };
    const clean = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    // Une ligne sans aucune lettre (ex. un "|" isolé, bord de couverture qui
    // déborde dans le recadrage du texte) n'est jamais un fragment de titre.
    const lines = rawLines.filter(l => /\p{L}/u.test(l));
    if (!lines.length) return { title: "", author: "" };
    let end = lines.length;
    if (end > 0 && /dans.{5,40}kind/.test(clean(lines[end - 1]))) end -= 1;
    if (end <= 0) return { title: "", author: "" };
    const author = lines[end - 1] || "";
    const title = lines.slice(0, Math.max(0, end - 1)).join(" ").trim();
    return { title, author };
  }
  // Un suffixe "(Série t.N)" en fin de titre donne série + tome.
  function extractSeriesTome(title) {
    const m = String(title || "").match(/\(([^()]+?)(?:\s+t\.?\s*(\d+)|\s+tome\s*(\d+))?\)\s*$/i);
    if (!m) return { series: "", tome: "" };
    return { series: m[1].trim(), tome: m[2] || m[3] || "" };
  }

  // -------------------------------------------------------------------------
  // Correspondances
  // -------------------------------------------------------------------------
  function protoClean(str) {
    return String(str || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  }
  function tomeConflict(a, b) {
    const ta = a ? Number(a) : null, tb = b ? Number(b) : null;
    return ta !== null && tb !== null && !Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb;
  }
  // cb doit être un préfixe STRICT de ca, à une frontière de mot ("Vicious"
  // n'est pas préfixe de "Viciousness"). `allowDigitBoundary` tolère un
  // chiffre juste après : réservé au cas où ca est un texte OCR tronqué en
  // plein numéro de tome — jamais quand cb est le texte OCR ("Tome 1" vs "Tome 10").
  function isPrefixMatch(ca, cb, allowDigitBoundary) {
    if (!cb || cb.length >= ca.length) return false;
    if (!ca.startsWith(cb)) return false;
    const nextChar = ca[cb.length];
    if (/[a-z]/i.test(nextChar)) return false;
    if (/[0-9]/.test(nextChar) && !allowDigitBoundary) return false;
    return true;
  }
  // Parmi plusieurs détections d'un même livre : titre/auteur non vides
  // d'abord, texte le plus long ensuite, plus grande couverture en dernier.
  function qualityScore(d) {
    let s = 0;
    if (d.title) s += 1000 + d.title.length;
    if (d.author) s += 500;
    s += (d.w * d.h) / 1000;
    return s;
  }

  // Meilleur livre existant pour une détection, avec un niveau de confiance :
  // - "certain" : (a) titre exact + auteur égal (ou absent d'un côté), ou
  //   (b) auteur strictement identique des deux côtés + titre préfixe strict
  //   dans un sens ou l'autre (rallonge Kindle, ou OCR tronqué) ;
  // - "uncertain" : inclusion partielle seulement -> jamais d'action seule.
  // Un conflit de tome élimine le candidat. Plusieurs candidats "certains" :
  // on garde le titre de longueur la plus proche.
  function matchExisting(entry, existingBooks) {
    let uncertain = null;
    const certainCandidates = [];
    for (const b of existingBooks) {
      if (tomeConflict(entry.tome, b.tome)) continue;
      const ca = protoClean(entry.title), cb = protoClean(b.title);
      if (!ca || !cb) continue;
      const titleExact = ca === cb;
      const titleFuzzy = !titleExact && ca.length > 8 && (ca.includes(cb) || cb.includes(ca));
      const prefixMatch = isPrefixMatch(ca, cb, false) || isPrefixMatch(cb, ca, true);
      if (!titleExact && !titleFuzzy && !prefixMatch) continue;
      const aa = entry.author ? protoClean(entry.author) : "";
      const ba = b.author ? protoClean(b.author) : "";
      const authorExact = !aa || !ba || aa === ba;
      const authorStrictExact = !!aa && !!ba && aa === ba;
      const authorFuzzy = !authorExact && aa.length > 3 && ba.length > 3 && (aa.includes(ba) || ba.includes(aa));
      if (!authorExact && !authorFuzzy) continue;
      const debug = { ca, cb, titleExact, titleFuzzy, prefixMatch, aa, ba, authorExact, authorFuzzy };
      if ((titleExact && authorExact) || (prefixMatch && authorStrictExact)) {
        certainCandidates.push({ book: b, debug, lengthDiff: Math.abs(ca.length - cb.length) });
        continue;
      }
      if (!uncertain) uncertain = { book: b, confidence: "uncertain", debug };
    }
    if (certainCandidates.length) {
      certainCandidates.sort((x, y) => x.lengthDiff - y.lengthDiff);
      const best = certainCandidates[0];
      return { book: best.book, confidence: "certain", debug: best.debug };
    }
    return uncertain;
  }

  // Fusion entre captures, volontairement plus stricte que matchExisting :
  // fusionner à tort perd un livre, un doublon se corrige d'un clic.
  //  1) titre ET auteur identiques -> fusion ;
  //  2) sinon préfixe strict accepté seulement si l'auteur est identique ;
  //  3) tomes différents -> jamais ;
  //  4) chacun correspond avec certitude à un livre existant DIFFÉRENT -> jamais ;
  //  5) dans le doute -> non.
  function sameBookForMerge(a, b, existingBooks) {
    if (tomeConflict(a.tome, b.tome)) return false;
    const ca = protoClean(a.title), cb = protoClean(b.title);
    if (!ca || !cb) return false;
    const aa = protoClean(a.author), ba = protoClean(b.author);

    if (ca === cb && aa === ba) return true;
    if (ca === cb) return false;

    const prefix = isPrefixMatch(ca, cb) || isPrefixMatch(cb, ca);
    if (!prefix || !aa || !ba || aa !== ba) return false;

    if (existingBooks && existingBooks.length) {
      const matchA = matchExisting(a, existingBooks);
      const matchB = matchExisting(b, existingBooks);
      if (matchA && matchA.confidence === "certain" && matchB && matchB.confidence === "certain") {
        const idA = protoClean(matchA.book.title) + "|" + protoClean(matchA.book.author);
        const idB = protoClean(matchB.book.title) + "|" + protoClean(matchB.book.author);
        if (idA !== idB) return false;
      }
    }
    return true;
  }

  // Onglets / libellés de l'interface Kindle lus par erreur comme un livre
  // (cas réels : auteur "PLUS", "BIBLIOTHÈQUE PLUS"). Volontairement étroit.
  const KINDLE_UI_WORDS = new Set([
    "accueil", "bibliotheque", "biblotheque", "plus", "boutique", "recherche",
    "rechercher", "decouvrir", "reglages", "parcourir", "retour", "recemment", "ajoutes",
  ]);
  function isKindleUiNoise(title, author) {
    const wordsOf = s => protoClean(s).split(/\s+/).filter(Boolean);
    const allUiWords = s => { const w = wordsOf(s); return w.length > 0 && w.every(x => KINDLE_UI_WORDS.has(x)); };
    if (allUiWords(author) || allUiWords(title)) return true;
    if (author && author.trim().length <= 40 && !/[a-z]/.test(author) && /[A-ZÀ-Ý]/.test(author)) return true;
    return false;
  }

  // Toutes les détections -> livres uniques, chacun rangé dans une catégorie
  // avec une action par défaut :
  //   "new"                -> "add"
  //   "existing-no-cover"  -> "add-cover"
  //   "existing-has-cover" -> "none" (remplacement au choix)
  //   "uncertain"          -> "none" (décision manuelle)
  //   "partial"            -> "none" (couverture coupée par le bord)
  function mergeAndDedupe(detections, existingBooks) {
    const usable = detections.filter(d => !isKindleUiNoise(d.title, d.author));
    const complete = usable.filter(d => !d.partial);
    const partialOnly = usable.filter(d => d.partial);

    const groups = [];
    for (const det of complete) {
      const target = groups.find(g => sameBookForMerge(g.best, det, existingBooks));
      if (target) {
        target.items.push(det);
        if (qualityScore(det) > qualityScore(target.best)) target.best = det;
      } else {
        groups.push({ items: [det], best: det });
      }
    }

    const orphanPartials = partialOnly.filter(p => !groups.some(g => sameBookForMerge(g.best, p, existingBooks)));

    const rawList = groups.map(g => ({
      ...g.best,
      mergedCount: g.items.length,
      mergedFromCaptures: [...new Set(g.items.map(i => i.captureIndex))].sort((a, b) => a - b),
    })).concat(orphanPartials.map(p => ({
      ...p, mergedCount: 1, mergedFromCaptures: [p.captureIndex],
    })));

    return rawList.map(entry => {
      if (entry.partial) {
        return { ...entry, category: "partial", existingMatch: null, action: "none" };
      }
      const match = matchExisting(entry, existingBooks);
      if (!match) {
        return { ...entry, category: "new", existingMatch: null, action: "add" };
      }
      if (match.confidence === "uncertain") {
        return { ...entry, category: "uncertain", existingMatch: match.book, matchDebug: match.debug, action: "none" };
      }
      const category = match.book.cover ? "existing-has-cover" : "existing-no-cover";
      return { ...entry, category, existingMatch: match.book, action: category === "existing-no-cover" ? "add-cover" : "none" };
    });
  }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------
  let tesseractPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractPromise) {
      tesseractPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = TESSERACT_URL;
        s.onload = () => resolve(window.Tesseract);
        s.onerror = () => { tesseractPromise = null; reject(new Error("Impossible de charger le moteur de lecture (connexion ?)")); };
        document.head.appendChild(s);
      });
    }
    return tesseractPromise;
  }

  // files : File[] -> [{ img, name, blob }] dans l'ordre donné.
  function loadImages(items) {
    return Promise.all(items.map(it => new Promise((resolve, reject) => {
      const blob = it.blob || it;
      const img = new Image();
      img.onload = () => resolve({ img, name: it.name || blob.name || "capture", blob });
      img.onerror = () => reject(new Error(`Image illisible : ${it.name || blob.name || "capture"}`));
      img.src = URL.createObjectURL(blob);
    })));
  }

  function detectBoxes(img, layout, opts) {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const gray = toGrayscale(ctx.getImageData(0, 0, canvas.width, canvas.height));
    return layout === "grid"
      ? detectGrid(gray, canvas.width, canvas.height, opts)
      : detectList(gray, canvas.width, canvas.height, opts);
  }

  // Détecte + lit toutes les captures. onProgress({ capture, captures, book, books })
  // est appelé avant chaque étape ; onBoxes(captureIndex, boxes) après la détection.
  async function analyzeCaptures(images, options) {
    options = options || {};
    const opts = { ...DEFAULT_OPTS, ...(options.opts || {}) };
    const layout = options.layout || "list";
    const onProgress = options.onProgress || function () {};
    const onBoxes = options.onBoxes || function () {};

    const Tesseract = await loadTesseract();
    const worker = await Tesseract.createWorker("fra");
    const detections = [];
    try {
      for (let ci = 0; ci < images.length; ci++) {
        const { img } = images[ci];
        onProgress({ capture: ci + 1, captures: images.length, book: 0, books: 0 });
        const boxes = detectBoxes(img, layout, opts);
        onBoxes(ci, boxes);
        for (let bi = 0; bi < boxes.length; bi++) {
          const b = boxes[bi];
          let title = "", author = "";
          if (!b.partial && b.textRegion && b.textRegion.w > 0) {
            onProgress({ capture: ci + 1, captures: images.length, book: bi + 1, books: boxes.length });
            const tc = document.createElement("canvas");
            tc.width = b.textRegion.w;
            tc.height = b.textRegion.h;
            tc.getContext("2d").drawImage(img, b.textRegion.x, b.textRegion.y, b.textRegion.w, b.textRegion.h, 0, 0, b.textRegion.w, b.textRegion.h);
            const { data } = await worker.recognize(tc);
            ({ title, author } = parseOcrText(data.text || ""));
          }
          const { series, tome } = extractSeriesTome(title);
          detections.push({ captureIndex: ci, x: b.x, y: b.y, w: b.w, h: b.h, partial: b.partial, title, author, series, tome });
        }
      }
    } finally {
      await worker.terminate();
    }
    return detections;
  }

  // Source de vérité : le books.json distant (branche configurée). Jamais la
  // copie locale, qui peut être en retard sur le dépôt.
  async function fetchExistingBooks() {
    const cfg = window.MarinaSync ? MarinaSync.getGitHubConfig() : null;
    if (!cfg || !cfg.token) return { books: [], error: "not-connected" };
    try {
      const current = await MarinaSync.githubGetFile(cfg);
      return { books: current.books, error: null };
    } catch (e) {
      return { books: [], error: e.message };
    }
  }

  window.KindleCaptures = {
    DEFAULT_OPTS,
    loadTesseract,
    loadImages,
    detectBoxes,
    analyzeCaptures,
    fetchExistingBooks,
    mergeAndDedupe,
    matchExisting,
    isKindleUiNoise,
    parseOcrText,
    extractSeriesTome,
    cropToDataUrl,
  };
})();
