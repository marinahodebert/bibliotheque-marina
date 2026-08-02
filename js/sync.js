const GH_CONFIG_KEY = "marinaBooksGitHubConfig";
const GH_LAST_SYNC_KEY = "marinaBooksLastSync";
const GH_API = "https://api.github.com";
const GH_PATH = "data/books.json";

function getGitHubConfig() {
  try { return JSON.parse(localStorage.getItem(GH_CONFIG_KEY)) || null; }
  catch { return null; }
}
function saveGitHubConfig(cfg) { localStorage.setItem(GH_CONFIG_KEY, JSON.stringify(cfg)); }
function clearGitHubConfig() { localStorage.removeItem(GH_CONFIG_KEY); }

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}
function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function githubRequest(cfg, method, body) {
  const url = `${GH_API}/repos/${cfg.owner}/${cfg.repo}/contents/${GH_PATH}${method === "GET" ? `?ref=${encodeURIComponent(cfg.branch)}` : ""}`;
  return fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${cfg.token}`,
      "Accept": "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function githubGetFile(cfg) {
  const res = await githubRequest(cfg, "GET");
  if (!res.ok) {
    if (res.status === 404) throw new Error(`data/books.json introuvable sur la branche "${cfg.branch}"`);
    if (res.status === 401) throw new Error("Token GitHub invalide ou expiré");
    if (res.status === 403) throw new Error("Accès refusé (permissions du token, ou limite d'API atteinte)");
    throw new Error(`Erreur GitHub (${res.status})`);
  }
  const json = await res.json();
  const books = JSON.parse(base64ToUtf8(json.content));
  return { sha: json.sha, books };
}

async function githubPutFile(cfg, books, sha, message) {
  const body = {
    message,
    content: utf8ToBase64(JSON.stringify(books, null, 2) + "\n"),
    branch: cfg.branch,
    sha,
  };
  const res = await githubRequest(cfg, "PUT", body);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const err = new Error(detail.message || `Erreur GitHub (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function testGitHubConnection(cfg) {
  const file = await githubGetFile(cfg);
  return { ok: true, count: file.books.length };
}

// Pousse les livres `pending` (pas encore synchronisés) dans data/books.json
// sur la branche configurée. Relit le fichier avant d'écrire (sha à jour) et
// retente une fois en cas de conflit d'écriture concurrente (409).
async function syncPendingBooks(pending, { attempt = 1 } = {}) {
  const cfg = getGitHubConfig();
  if (!cfg || !cfg.token) throw new Error("GitHub non connecté");
  if (!pending.length) return null;

  const current = await githubGetFile(cfg);
  const merged = [...current.books, ...pending];
  const message = pending.length === 1
    ? `Ajout : ${pending[0].title}`
    : `Ajout de ${pending.length} livres`;

  try {
    await githubPutFile(cfg, merged, current.sha, message);
  } catch (err) {
    if (err.status === 409 && attempt < 2) {
      return syncPendingBooks(pending, { attempt: attempt + 1 });
    }
    throw err;
  }

  localStorage.setItem(GH_LAST_SYNC_KEY, new Date().toISOString());
  return merged;
}

window.MarinaSync = {
  getGitHubConfig,
  saveGitHubConfig,
  clearGitHubConfig,
  githubGetFile,
  testGitHubConnection,
  syncPendingBooks,
  GH_LAST_SYNC_KEY,
};
