# Bibliothèque Marina

Application personnelle de suivi de lectures Kindle / Books.

## Fonctionnalités v0.2

- Liste des livres lus
- Recherche instantanée
- Filtres par année, auteur, série, statut et livres disparus Kindle
- Vues par livres, auteurs, séries et éléments à vérifier
- Progression des séries avec détection de tomes manquants possibles
- Ajout manuel de livres depuis l'application
- Export / import des ajouts locaux
- Mode clair / sombre
- PWA installable sur iPhone

## Structure

```text
bibliotheque-marina/
├── index.html
├── manifest.json
├── service-worker.js
├── README.md
├── css/
│   └── style.css
├── js/
│   └── app.js
├── data/
│   └── data.js
└── icons/
    ├── icon.svg
    ├── icon-192.png
    └── icon-512.png
```

## Déploiement GitHub Pages

1. Déposer tous les fichiers et dossiers dans le dépôt.
2. Aller dans Settings > Pages.
3. Source : Deploy from a branch.
4. Branch : main / root.
5. Enregistrer.

L'application sera ensuite disponible via GitHub Pages.
