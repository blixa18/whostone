require('dotenv').config();
const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const session        = require('express-session');
const cors           = require('cors');
const path           = require('path');
const https          = require('https');
const crypto         = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'whostone_dev_secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 2 } // 2h
}));

// ═══════════════════════════════════════════════
// IN-MEMORY STORE
// ═══════════════════════════════════════════════

/**
 * rooms = {
 *   [code]: {
 *     code, hostId, settings: { questions, timer },
 *     players: [{ id, name, emoji, platform, socketId, tracks:[] }],
 *     state: 'lobby' | 'playing' | 'finished',
 *     quiz: { questions:[], current:0, scores:{}, timerJob }
 *   }
 * }
 */
const rooms = {};

// sessionId → { name, emoji, platform, tracks, roomCode }
const sessions = {};

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function randCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase().slice(0, 4);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const parsed  = new URL(url);
    const opts = {
      hostname: parsed.hostname, port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(bodyStr), ...headers }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function randFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const EMOJIS = ['🎸','🎹','🥁','🎷','🎺','🎻','🎤','🎧','🪗','🪘','🎼','🎵','🎶','🔊','🪕','🎙'];

// ═══════════════════════════════════════════════
// SPOTIFY AUTH
// ═══════════════════════════════════════════════
const SPOTIFY_SCOPES = 'user-top-read user-library-read';

app.get('/auth/spotify', (req, res) => {
  const { roomCode, playerName } = req.query;
  req.session.pendingRoom  = roomCode;
  req.session.pendingName  = playerName;
  req.session.pendingEmoji = randFrom(EMOJIS);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.SPOTIFY_CLIENT_ID,
    scope:         SPOTIFY_SCOPES,
    redirect_uri:  process.env.SPOTIFY_REDIRECT_URI,
    state:         req.session.id
  });
  res.redirect('https://accounts.spotify.com/authorize?' + params);
});

app.get('/auth/spotify/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=spotify_denied');

  try {
    // Exchange code for token
    const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const token = await httpsPost(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri: process.env.SPOTIFY_REDIRECT_URI }).toString(),
      { 'Content-Type':'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` }
    );

    if (!token.access_token) throw new Error('No access token');

    // Fetch top tracks (short_term = last 4 weeks)
    const [topShort, topMed, saved] = await Promise.all([
      httpsGet('https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=short_term')
        .then(r => r.items || []).catch(() => []),
      httpsGet('https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term')
        .then(r => r.items || []).catch(() => []),
      httpsGet('https://api.spotify.com/v1/me/tracks?limit=50')
        .then(r => (r.items||[]).map(i=>i.track)).catch(() => [])
    ].map(async (p, i) => {
      const headers = { Authorization: `Bearer ${token.access_token}` };
      // Re-fetch with auth (we passed promises already)
      return p;
    }));

    // Actually fetch with proper auth header
    const withAuth = url => {
      return new Promise((resolve, reject) => {
        https.get(url, { headers: { Authorization: `Bearer ${token.access_token}` } }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e){ reject(e); } });
        }).on('error', reject);
      });
    };

    const [r1, r2, r3] = await Promise.all([
      withAuth('https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=short_term').catch(() => ({ items:[] })),
      withAuth('https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term').catch(() => ({ items:[] })),
      withAuth('https://api.spotify.com/v1/me/tracks?limit=50').catch(() => ({ items:[] })),
    ]);

    const allTracks = [
      ...(r1.items || []),
      ...(r2.items || []),
      ...((r3.items||[]).map(i => i.track).filter(Boolean))
    ];

    // Deduplicate + keep only tracks with preview
    const seen = new Set();
    const tracks = allTracks.filter(t => {
      if (!t || seen.has(t.id)) return false;
      seen.add(t.id);
      return true; // keep all, preview_url may be null (handled in quiz)
    }).map(t => ({
      id:         t.id,
      title:      t.name,
      artist:     t.artists.map(a=>a.name).join(', '),
      previewUrl: t.preview_url || null,
      albumArt:   t.album?.images?.[1]?.url || null,
    }));

    req.session.spotifyToken  = token.access_token;
    req.session.spotifyTracks = tracks;
    req.session.platform      = 'spotify';

    sessions[req.session.id] = {
      name:      req.session.pendingName || 'Joueur',
      emoji:     req.session.pendingEmoji,
      platform:  'spotify',
      tracks,
      roomCode:  req.session.pendingRoom || '',
    };

    res.redirect(`/lobby.html?room=${req.session.pendingRoom || ''}&sid=${req.session.id}&status=connected`);
  } catch(err) {
    console.error('Spotify callback error:', err);
    res.redirect('/?error=spotify_error');
  }
});

// ═══════════════════════════════════════════════
// DEEZER AUTH
// ═══════════════════════════════════════════════
app.get('/auth/deezer', (req, res) => {
  const { roomCode, playerName } = req.query;
  req.session.pendingRoom  = roomCode;
  req.session.pendingName  = playerName;
  req.session.pendingEmoji = randFrom(EMOJIS);

  const params = new URLSearchParams({
    app_id:       process.env.DEEZER_APP_ID,
    redirect_uri: process.env.DEEZER_REDIRECT_URI,
    perms:        'basic_access,listening_history',
    state:        req.session.id
  });
  res.redirect('https://connect.deezer.com/oauth/auth.php?' + params);
});

app.get('/auth/deezer/callback', async (req, res) => {
  const { code, error_reason } = req.query;
  if (error_reason || !code) return res.redirect('/?error=deezer_denied');

  try {
    const tokenData = await httpsGet(
      `https://connect.deezer.com/oauth/access_token.php?app_id=${process.env.DEEZER_APP_ID}&secret=${process.env.DEEZER_SECRET_KEY}&code=${code}&output=json`
    );
    if (!tokenData.access_token) throw new Error('No Deezer token');
    const at = tokenData.access_token;

    // Fetch tracks
    const withAuth = url => httpsGet(url + (url.includes('?') ? '&' : '?') + `access_token=${at}&limit=50`).catch(() => ({ data:[] }));

    const [favs, hist] = await Promise.all([
      withAuth('https://api.deezer.com/user/me/tracks'),
      withAuth('https://api.deezer.com/user/me/history'),
    ]);

    const seen   = new Set();
    const tracks = [...(favs.data||[]), ...(hist.data||[])]
      .filter(t => { if(!t||seen.has(t.id)) return false; seen.add(t.id); return true; })
      .map(t => ({
        id:         String(t.id),
        title:      t.title,
        artist:     t.artist?.name || '',
        previewUrl: t.preview || null,
        albumArt:   t.album?.cover_medium || null,
      }));

    req.session.deezerToken  = at;
    req.session.deezerTracks = tracks;
    req.session.platform     = 'deezer';

    sessions[req.session.id] = {
      name:     req.session.pendingName || 'Joueur',
      emoji:    req.session.pendingEmoji,
      platform: 'deezer',
      tracks,
      roomCode: req.session.pendingRoom || '',
    };

    res.redirect(`/lobby.html?room=${req.session.pendingRoom || ''}&sid=${req.session.id}&status=connected`);
  } catch(err) {
    console.error('Deezer callback error:', err);
    res.redirect('/?error=deezer_error');
  }
});

// ═══════════════════════════════════════════════
// REST — Room management
// ═══════════════════════════════════════════════
app.post('/api/room/create', (req, res) => {
  const { settings, forceCode } = req.body;
  let code;
  if (forceCode && !rooms[forceCode]) {
    code = forceCode.toUpperCase();
  } else {
    do { code = randCode(); } while (rooms[code]);
  }

  rooms[code] = {
    code,
    hostId: null,
    settings: settings || { questions: 10, timer: 20 },
    players:  [],
    state:    'lobby',
    quiz:     { questions:[], current:0, scores:{}, timerJob:null }
  };

  res.json({ code });
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code:     room.code,
    state:    room.state,
    settings: room.settings,
    players:  room.players.map(p => ({ id:p.id, name:p.name, emoji:p.emoji, platform:p.platform }))
  });
});

// ═══════════════════════════════════════════════
// SOCKET.IO — Real-time game
// ═══════════════════════════════════════════════
io.on('connection', socket => {
  console.log('Socket connected:', socket.id);

  // ── Join room ──
  socket.on('join-room', ({ roomCode, sessionId, playerName, playerEmoji }) => {
    const code = roomCode?.toUpperCase();
    if (!rooms[code]) {
      socket.emit('error', { message: 'Salle introuvable' });
      return;
    }
    const room = rooms[code];
    if (room.state !== 'lobby') {
      socket.emit('error', { message: 'Partie déjà en cours' });
      return;
    }
    if (room.players.length >= 8) {
      socket.emit('error', { message: 'Salle pleine (8 joueurs max)' });
      return;
    }

    // Get session data if available
    const sess   = sessions[sessionId] || {};
    const name   = sess.name   || playerName || 'Joueur';
    const emoji  = sess.emoji  || playerEmoji || randFrom(EMOJIS);
    const plat   = sess.platform || null;
    const tracks = sess.tracks   || [];

    // Avoid duplicate socket
    const existing = room.players.find(p => p.sessionId === sessionId);
    if (existing) {
      existing.socketId = socket.id;
      socket.join(code);
      socket.emit('joined', { playerId: existing.id, room: sanitizeRoom(room) });
      return;
    }

    const player = {
      id: socket.id,
      sessionId,
      socketId: socket.id,
      name, emoji,
      platform: plat,
      tracks,
      isHost: room.players.length === 0
    };

    if (player.isHost) room.hostId = socket.id;
    room.players.push(player);
    socket.join(code);

    socket.emit('joined', { playerId: socket.id, isHost: player.isHost, room: sanitizeRoom(room) });
    socket.to(code).emit('player-joined', { player: sanitizePlayer(player), room: sanitizeRoom(room) });

    console.log(`[${code}] ${name} joined (${room.players.length} players)`);
  });

  // ── Update settings (host only) ──
  socket.on('update-settings', ({ roomCode, settings }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.settings = { ...room.settings, ...settings };
    io.to(roomCode).emit('settings-updated', room.settings);
  });

  // ── Start game (host only) ──
  socket.on('start-game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    const activePlayers = room.players.filter(p => p.platform && p.tracks.length > 0);
    if (activePlayers.length < 2) {
      socket.emit('error', { message: 'Minimum 2 joueurs avec musique connectée' });
      return;
    }

    // Build question set
    const questions = buildQuestions(activePlayers, room.settings.questions);
    if (!questions.length) {
      socket.emit('error', { message: 'Pas assez de musiques disponibles' });
      return;
    }

    room.state = 'playing';
    room.quiz  = {
      questions,
      current:  0,
      scores:   Object.fromEntries(activePlayers.map(p => [p.id, 0])),
      timerJob: null,
      answers:  {} // socketId → answeredPlayerId
    };

    io.to(roomCode).emit('game-started', {
      totalQuestions: questions.length,
      timer: room.settings.timer,
      players: activePlayers.map(sanitizePlayer)
    });

    setTimeout(() => sendQuestion(roomCode), 800);
  });

  // ── Submit answer ──
  socket.on('submit-answer', ({ roomCode, answeredPlayerId }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'playing') return;

    const quiz = room.quiz;
    if (quiz.answers[socket.id] !== undefined) return; // already answered

    const q         = quiz.questions[quiz.current];
    const correct   = answeredPlayerId === q.ownerId;
    const timeLeft  = quiz.timeLeft || 0;
    const bonus     = Math.round(timeLeft / room.settings.timer * 500);
    const pts       = correct ? 500 + bonus : 0;

    quiz.answers[socket.id] = { answeredPlayerId, correct, pts };

    if (correct && quiz.scores[socket.id] !== undefined) {
      quiz.scores[socket.id] += pts;
    }

    // Acknowledge to the answering player
    socket.emit('answer-ack', { correct, pts, correctPlayerId: q.ownerId });

    // Broadcast to room how many answered
    const answeredCount = Object.keys(quiz.answers).length;
    const totalPlayers  = room.players.filter(p => p.platform && p.tracks.length > 0).length;
    io.to(roomCode).emit('answer-count', { answered: answeredCount, total: totalPlayers });

    // If everyone answered, skip timer
    if (answeredCount >= totalPlayers) {
      clearInterval(quiz.timerJob);
      revealQuestion(roomCode);
    }
  });

  // ── Next question (host) ──
  socket.on('next-question', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    const quiz = room.quiz;
    quiz.current++;
    if (quiz.current >= quiz.questions.length) {
      endGame(roomCode);
    } else {
      setTimeout(() => sendQuestion(roomCode), 500);
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx === -1) continue;
      const [player] = room.players.splice(idx, 1);
      io.to(code).emit('player-left', { playerId: player.id, room: sanitizeRoom(room) });

      // If host left, assign new host
      if (room.hostId === socket.id && room.players.length > 0) {
        room.players[0].isHost = true;
        room.hostId = room.players[0].socketId;
        io.to(code).emit('new-host', { playerId: room.players[0].id });
      }

      // Clean empty rooms
      if (room.players.length === 0) {
        clearInterval(room.quiz?.timerJob);
        delete rooms[code];
      }
      break;
    }
  });
});

// ═══════════════════════════════════════════════
// GAME ENGINE
// ═══════════════════════════════════════════════
function buildQuestions(players, count) {
  const questions = [];
  const shuffledTracks = shuffle(players.flatMap(p =>
    p.tracks.slice(0, 30).map(t => ({ ...t, ownerId: p.id, ownerName: p.name, ownerEmoji: p.emoji }))
  ));

  for (const track of shuffledTracks) {
    if (questions.length >= count) break;
    if (!track.title) continue;

    const owner      = players.find(p => p.id === track.ownerId);
    if (!owner) continue;
    const others     = shuffle(players.filter(p => p.id !== track.ownerId)).slice(0, 3);
    const options    = shuffle([owner, ...others]).map(p => ({
      id: p.id, name: p.name, emoji: p.emoji, platform: p.platform
    }));

    questions.push({
      trackId:    track.id,
      title:      track.title,
      artist:     track.artist,
      previewUrl: track.previewUrl,
      albumArt:   track.albumArt,
      ownerId:    track.ownerId,
      ownerName:  track.ownerName,
      ownerEmoji: track.ownerEmoji,
      options
    });
  }
  return questions;
}

function sendQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const quiz = room.quiz;
  const q    = quiz.questions[quiz.current];

  quiz.answers  = {};
  quiz.timeLeft = room.settings.timer;

  // Send question (WITHOUT revealing owner — that's only in reveal)
  io.to(roomCode).emit('question', {
    index:     quiz.current,
    total:     quiz.questions.length,
    title:     q.title,
    artist:    q.artist,
    previewUrl: q.previewUrl,
    albumArt:  q.albumArt,
    options:   q.options,
    timer:     room.settings.timer
  });

  // Server-side countdown
  clearInterval(quiz.timerJob);
  quiz.timerJob = setInterval(() => {
    quiz.timeLeft--;
    io.to(roomCode).emit('tick', { t: quiz.timeLeft });
    if (quiz.timeLeft <= 0) {
      clearInterval(quiz.timerJob);
      revealQuestion(roomCode);
    }
  }, 1000);
}

function revealQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const quiz = room.quiz;
  const q    = quiz.questions[quiz.current];

  io.to(roomCode).emit('reveal', {
    ownerId:    q.ownerId,
    ownerName:  q.ownerName,
    ownerEmoji: q.ownerEmoji,
    title:      q.title,
    artist:     q.artist,
    answers:    quiz.answers,
    scores:     quiz.scores,
    isLast:     quiz.current >= quiz.questions.length - 1
  });
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  clearInterval(room.quiz.timerJob);
  room.state = 'finished';

  const sorted = room.players
    .filter(p => room.quiz.scores[p.id] !== undefined)
    .sort((a,b) => (room.quiz.scores[b.id]||0) - (room.quiz.scores[a.id]||0))
    .map((p,i) => ({ rank:i+1, id:p.id, name:p.name, emoji:p.emoji, platform:p.platform, score:room.quiz.scores[p.id]||0 }));

  io.to(roomCode).emit('game-over', { rankings: sorted });
}

// ═══════════════════════════════════════════════
// SANITIZERS
// ═══════════════════════════════════════════════
function sanitizePlayer(p) {
  return { id:p.id, name:p.name, emoji:p.emoji, platform:p.platform, isHost:p.isHost||false };
}
function sanitizeRoom(r) {
  return {
    code:     r.code,
    state:    r.state,
    settings: r.settings,
    players:  r.players.map(sanitizePlayer)
  };
}

// ═══════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`\n🎵 WhosTune en ligne → http://localhost:${PORT}\n`);
});
