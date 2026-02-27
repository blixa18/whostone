# 🎵 WhosTune — Quiz Musical Multijoueur

Quiz en temps réel : devine à qui appartient chaque musique parmi les joueurs connectés via Spotify ou Deezer.

---

## ⚡ Démarrage rapide (local)

### 1. Installer les dépendances
```bash
npm install
```

### 2. Configurer les variables d'environnement
```bash
cp .env.example .env
# Ouvre .env et remplis tes clés API
```

### 3. Créer les apps sur les plateformes

#### Spotify
1. Va sur https://developer.spotify.com/dashboard
2. Clique **Create app**
3. Nom : `WhosTune`, Redirect URI : `http://localhost:3000/auth/spotify/callback`
4. Copie le **Client ID** et **Client Secret** dans `.env`

#### Deezer
1. Va sur https://developers.deezer.com/myapps
2. Crée une application
3. Redirect URI : `http://localhost:3000/auth/deezer/callback`
4. Copie le **App ID** et **Secret Key** dans `.env`

### 4. Lancer le serveur
```bash
# Développement (avec rechargement automatique)
npm run dev

# Production
npm start
```

Ouvre → **http://localhost:3000**

---

## 🚀 Déploiement sur Railway (gratuit)

1. Crée un compte sur https://railway.app
2. **New Project → Deploy from GitHub Repo** (pousse ce projet sur GitHub d'abord)
3. Dans les variables d'environnement Railway, ajoute :
   ```
   SPOTIFY_CLIENT_ID=...
   SPOTIFY_CLIENT_SECRET=...
   SPOTIFY_REDIRECT_URI=https://TON-DOMAINE.up.railway.app/auth/spotify/callback
   DEEZER_APP_ID=...
   DEEZER_SECRET_KEY=...
   DEEZER_REDIRECT_URI=https://TON-DOMAINE.up.railway.app/auth/deezer/callback
   SESSION_SECRET=une_chaine_aleatoire_longue
   ```
4. Met à jour les **Redirect URI** dans ton dashboard Spotify et Deezer avec ton domaine Railway
5. Railway détecte automatiquement `npm start` → déploiement automatique ✅

---

## 🎮 Comment jouer

1. Le **créateur** ouvre le site, clique **Créer une partie**, choisit les paramètres
2. Il partage le **code à 4 lettres** avec ses amis
3. Chaque joueur **rejoint** avec le code et connecte **Spotify ou Deezer**
4. L'hôte clique **Lancer la partie** (minimum 2 joueurs connectés)
5. Un extrait de 30s est joué → chaque joueur choisit **à qui appartient cette musique**
6. Plus tu réponds vite, plus tu gagnes de points (500 pts base + bonus vitesse)
7. Classement final après toutes les questions

---

## 🏗️ Architecture

```
whostone/
├── server.js          # Express + Socket.io + OAuth Spotify/Deezer
├── public/
│   ├── index.html     # Accueil + Créer + Rejoindre
│   ├── lobby.html     # Salle d'attente temps réel
│   ├── game.html      # Quiz + résultats
│   └── style.css      # Styles partagés
├── .env.example       # Template variables d'environnement
└── package.json
```

### Événements Socket.io

| Événement | Direction | Description |
|-----------|-----------|-------------|
| `join-room` | client → server | Rejoindre une salle |
| `joined` | server → client | Confirmation + état salle |
| `player-joined` | server → room | Nouveau joueur arrivé |
| `player-left` | server → room | Joueur déconnecté |
| `update-settings` | client → server | Modifier les paramètres (hôte) |
| `settings-updated` | server → room | Paramètres synchronisés |
| `start-game` | client → server | Démarrer la partie (hôte) |
| `game-started` | server → room | Partie lancée |
| `question` | server → room | Nouvelle question |
| `tick` | server → room | Décompte du timer |
| `submit-answer` | client → server | Soumettre une réponse |
| `answer-ack` | server → client | Résultat de ta réponse |
| `answer-count` | server → room | Combien ont répondu |
| `reveal` | server → room | Révélation + scores |
| `next-question` | client → server | Passer à la suivante (hôte) |
| `game-over` | server → room | Fin de partie + classement |

---

## ⚠️ Notes importantes

- **Spotify Premium requis** pour la lecture audio complète. Les previews de 30s sont disponibles sans Premium via `preview_url`, mais certains titres n'en ont pas.
- **Deezer** : les previews de 30s sont disponibles gratuitement pour tous.
- Les données de session sont **en mémoire** — elles sont perdues au redémarrage. Pour la production long terme, utiliser Redis.
- Maximum **8 joueurs** par salle.
