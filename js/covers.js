// Module de correspondance de couvertures — étape 1 (recherche + notation de
// confiance uniquement). Ne modifie jamais un livre, ne synchronise rien :
// c'est appelé par la page de test pour l'instant, l'écriture réelle viendra
// dans une étape suivante une fois la qualité des résultats validée.

function coversClean(str) {
  return String(str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function searchGoogleBooks(title, author, apiKey) {
  const q = encodeURIComponent(`${title} ${author}`.trim());
  const keyParam = apiKey ? `&key=${encodeURIComponent(apiKey)}` : "";
  const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5${keyParam}`;
  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch { /* ignore */ }
    throw new Error(`Google Books ${res.status}${detail ? " — " + detail : ""}`);
  }
  const data = await res.json();
  return (data.items || []).map(it => ({
    title: it.volumeInfo?.title || "",
    subtitle: it.volumeInfo?.subtitle || "",
    authors: it.volumeInfo?.authors || [],
    cover: it.volumeInfo?.imageLinks?.thumbnail || it.volumeInfo?.imageLinks?.smallThumbnail || "",
    source: "Google Books",
    link: it.volumeInfo?.infoLink || "",
  }));
}

async function searchOpenLibrary(title, author) {
  const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}&limit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open Library ${res.status}`);
  const data = await res.json();
  return (data.docs || []).map(d => ({
    title: d.title || "",
    subtitle: "",
    authors: d.author_name || [],
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : "",
    source: "Open Library",
    link: d.key ? `https://openlibrary.org${d.key}` : "",
  }));
}

function extractTomeNumber(text) {
  const m = String(text || "").match(/\bt(?:ome)?\.?\s*(\d+)\b/i);
  return m ? m[1] : "";
}
function namesMatch(bookAuthor, candidateAuthors) {
  const a = coversClean(bookAuthor);
  if (!a) return false;
  return (candidateAuthors || []).some(name => {
    const c = coversClean(name);
    if (!c) return false;
    return c === a || (a.length > 3 && (c.includes(a) || a.includes(c)));
  });
}
function titlesMatch(bookTitle, candidateFullTitle) {
  const b = coversClean(bookTitle);
  const c = coversClean(candidateFullTitle);
  if (!b || !c) return false;
  return b === c || (b.length > 8 && (b.includes(c) || c.includes(b)));
}

// Vérifie un candidat contre un livre : titre ET auteur doivent concorder,
// et le numéro de tome (si connu des deux côtés) ne doit pas différer.
// Renvoie { accepted:false, reason } dès le premier critère qui échoue —
// jamais accepté sur la seule ressemblance du titre.
function scoreCandidate(book, candidate) {
  const fullCandidateTitle = `${candidate.title} ${candidate.subtitle || ""}`.trim();
  if (!namesMatch(book.author, candidate.authors)) {
    return { accepted: false, reason: `auteur non correspondant (« ${(candidate.authors || []).join(", ") || "inconnu"} » vs « ${book.author} »)` };
  }
  if (!titlesMatch(book.title, fullCandidateTitle)) {
    return { accepted: false, reason: `titre non correspondant (« ${fullCandidateTitle || "(sans titre)"} »)` };
  }
  const bookTome = String(book.tome || "");
  const candidateTome = extractTomeNumber(fullCandidateTitle);
  if (bookTome && candidateTome && bookTome !== candidateTome) {
    return { accepted: false, reason: `tome différent (attendu t.${bookTome}, trouvé t.${candidateTome})` };
  }
  if (!candidate.cover) {
    return { accepted: false, reason: "aucune image de couverture pour ce résultat" };
  }
  return { accepted: true, reason: "" };
}

// Cascade Google Books -> Open Library (ordre demandé). N'interroge Open
// Library que si Google Books n'a rien renvoyé de qualifié (erreur ou zéro
// candidat conforme), pour ne pas doubler les appels inutilement.
async function findCoverForBook(book, options = {}) {
  const errors = [];
  let source = "Google Books";
  let scored = [];

  try {
    const candidates = await searchGoogleBooks(book.title, book.author, options.googleApiKey);
    scored = candidates.map(c => ({ candidate: c, ...scoreCandidate(book, c) }));
  } catch (err) {
    errors.push({ source: "Google Books", message: err.message });
  }

  let accepted = scored.filter(s => s.accepted);

  if (!accepted.length) {
    try {
      const olCandidates = await searchOpenLibrary(book.title, book.author);
      const olScored = olCandidates.map(c => ({ candidate: c, ...scoreCandidate(book, c) }));
      const olAccepted = olScored.filter(s => s.accepted);
      if (olAccepted.length) {
        source = "Open Library";
        scored = olScored;
        accepted = olAccepted;
      } else {
        scored = scored.concat(olScored);
      }
    } catch (err) {
      errors.push({ source: "Open Library", message: err.message });
    }
  }

  const seenCovers = new Set();
  const uniqueAccepted = accepted.filter(s => {
    if (seenCovers.has(s.candidate.cover)) return false;
    seenCovers.add(s.candidate.cover);
    return true;
  });

  const status = uniqueAccepted.length === 1 ? "confident" : uniqueAccepted.length > 1 ? "ambiguous" : "none";

  return {
    book,
    status,
    source: uniqueAccepted.length ? source : null,
    accepted: uniqueAccepted.map(s => s.candidate),
    rejected: scored.filter(s => !s.accepted),
    errors,
  };
}

window.MarinaCovers = { searchGoogleBooks, searchOpenLibrary, scoreCandidate, findCoverForBook, extractTomeNumber };
