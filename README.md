# Bibliothèque Marina

Application personnelle de suivi de lectures Kindle / Books, installable sur iPhone (PWA).

Site : https://marinahodebert.github.io/bibliotheque-marina/

## Fonctionnalités

- Accueil personnel : reprendre la lecture, ajoutés récemment, dernières lectures
- Bibliothèque complète avec recherche, filtres par statut et filtre « À vérifier »
- Vues Séries (progression, tomes manquants) et Auteurs
- Fiche détail modifiable (statut, notes, infos), suppression
- Ajout manuel avec suggestions et détection de doublons
- Import Kindle par copier-coller de la liste
- Import Kindle par captures d'écran (bouton « + » → Captures d'écran Kindle) : titres, auteurs et couvertures extraits automatiquement, doublons entre captures fusionnés, comparaison à la bibliothèque, puis un seul commit livres + couvertures
- Synchronisation GitHub : `data/books.json` sur `main` est la source de vérité, chaque ajout ou modification devient un commit
- Export / import JSON

## Structure

```text
bibliotheque-marina/
├── index.html              application
├── test-cover-extract.html outil de réglage de l'extraction (seuils, diagnostic)
├── test-covers.html        outil de test du rapprochement des couvertures
├── manifest.json
├── service-worker.js       réseau d'abord, cache en secours hors ligne
├── css/style.css
├── js/
│   ├── app.js              interface
│   ├── sync.js             lecture/écriture de books.json via l'API GitHub
│   ├── kindle-captures.js  extraction depuis les captures (détection, OCR, fusion, rapprochement)
│   ├── captures-import.js  écran d'import par captures dans l'appli
│   ├── kindle-cover-sync.js écriture livres + couvertures en un seul commit
│   └── covers.js           recherche de couvertures (Google Books, Open Library, Apple Books)
├── data/books.json
├── covers/                 images de couvertures
└── icons/
```

## Synchronisation

Dans l'appli : Synchronisation → token GitHub (fine-grained, accès « Contents: read and write » à ce dépôt), dépôt `marinahodebert/bibliotheque-marina`, branche `main`. Le token reste dans le navigateur (localStorage), jamais dans le dépôt.

## Déploiement

GitHub Pages, depuis `main` / racine. Chaque commit sur `main` (y compris ceux faits par la synchronisation) republie le site en une minute environ.
