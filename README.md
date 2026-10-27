# SwipeFlix

Application web (installable sur téléphone) pour choisir un film à deux, façon Tinder :
chacun swipe de son côté, et quand vous aimez tous les deux le même film, c'est un match.

## Fonctionnement

- **Salon** : l'un crée un salon (code à 6 caractères), l'autre le rejoint via le lien partagé.
- **Swipe** : glisser à droite / ♥ = j'aime, à gauche / ✕ = je passe, toucher la carte = fiche du film.
- Les films que ta moitié a aimés sont glissés dans ton paquet pour augmenter les chances de match.
- **Matchs** en temps réel, fiche avec plateformes de streaming (France) et bande-annonce, liste « À voir / Vus ».
- **Filtres communs** : plateformes (Netflix, Prime Video, Disney+, Canal+…), genres, tri, note, année.

## Architecture

- Front statique (HTML/CSS/JS, sans build) : `index.html`, `styles.css`, `app.js`, `config.js`, PWA (`manifest.webmanifest`, `sw.js`).
- Supabase (projet `swipeflix`) :
  - base de données : `supabase/migrations/0001_init.sql` (tables verrouillées par RLS, accès uniquement via fonctions SQL) ;
  - temps réel : canal broadcast/presence `room-<CODE>` ;
  - Edge Function `tmdb` (`supabase/functions/tmdb`) : proxy TMDB, la clé reste côté serveur (secret `TMDB_API_KEY`).

## Mise en ligne

N'importe quel hébergement statique (Netlify, GitHub Pages…) : publier le dossier racine tel quel.
