const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

const rooms = {};
const queue = [];
const STATS = ['hp', 'attack', 'special-attack', 'defense', 'special-defense', 'speed'];
const GEN_RANGES = {
  '1': [1, 151], '2': [152, 251], '3': [252, 386], '4': [387, 493],
  '5': [494, 649], '6': [650, 721], '7': [722, 809], '8': [810, 905], '9': [906, 1025]
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function randId(gens) {
  if (!gens || gens.includes('all')) return Math.floor(Math.random() * 1010) + 1;
  const pool = [];
  gens.forEach(g => {
    const [a, b] = GEN_RANGES[g] || [1, 151];
    for (let i = a; i <= b; i++) pool.push(i);
  });
  return pool[Math.floor(Math.random() * pool.length)];
}

async function fetchFrName(id) {
  try {
    const r = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${id}`);
    const d = await r.json();
    const fr = d.names.find(n => n.language.name === 'fr');
    return fr ? fr.name : null;
  } catch { return null; }
}

async function fetchPokemon(id) {
  const [r1, frName] = await Promise.all([
    fetch(`https://pokeapi.co/api/v2/pokemon/${id}`).then(r => r.json()),
    fetchFrName(id)
  ]);
  const stats = {};
  r1.stats.forEach(s => stats[s.stat.name] = s.base_stat);
  return {
    id: r1.id,
    name: frName || r1.name,
    sprite: r1.sprites.front_default,
    types: r1.types.map(t => t.type.name),
    stats
  };
}

async function loadSixPokemons(gens) {
  const ids = new Set();
  while (ids.size < 6) ids.add(randId(gens));
  return Promise.all([...ids].map(fetchPokemon));
}

function getRandomAvailableStat(usedStats) {
  const avail = STATS.filter(s => !usedStats.includes(s));
  if (avail.length === 0) return STATS[0];
  return avail[Math.floor(Math.random() * avail.length)];
}

// ── LOGIQUE DE ROUND ─────────────────────────────────────────────
function startRound(roomCode, gameId) {
  const room = rooms[roomCode];
  if (!room) return;
  if (room.gameId !== gameId) return;

  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }

  room.roundChoices = {};
  room.roundResolved = false;
  room.resolving = false;
  room.roundId = (room.roundId || 0) + 1;
  const currentRoundId = room.roundId;

  room.roundTimer = setTimeout(() => {
    if (room.gameId !== gameId) return;
    if (room.roundId !== currentRoundId) return;
    if (room.roundResolved) return;

    const players = Object.keys(room.players);
    players.forEach(pid => {
      if (!room.roundChoices[pid]) {
        const usedStats = room.usedStats[pid] || [];
        room.roundChoices[pid] = room.statPool[room.round];
      }
    });
    resolveRound(roomCode, gameId);
  }, 10000);

  io.to(roomCode).emit('round_start', {
    round: room.round,
    pokemon: room.pokemons[room.round]
  });
}

function resolveRound(roomCode, gameId) {
  const room = rooms[roomCode];
  if (!room) return;
  if (room.gameId !== gameId) return;
  if (room.resolving) return;
  room.resolving = true;

  if (room.roundResolved) return;
  room.roundResolved = true;

  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
  if (room.nextRoundTimer) { clearTimeout(room.nextRoundTimer); room.nextRoundTimer = null; }

  try {
    const currentRound = room.round;
    const poke = room.pokemons[currentRound];

    if (!poke) {
      room.resolving = false;
      return;
    }

    const players = Object.keys(room.players);

    players.forEach(pid => {
      if (!room.roundChoices[pid]) {
        room.roundChoices[pid] = room.statPool[currentRound];
      }
    });

    players.forEach(pid => {
      if (!room.usedStats[pid]) room.usedStats[pid] = [];
      room.usedStats[pid].push(room.roundChoices[pid]);
      const val = poke.stats[room.roundChoices[pid]] || 0;
      room.scores[pid] = (room.scores[pid] || 0) + val;
    });

    const result = {};
    players.forEach(pid => {
      result[pid] = {
        stat: room.roundChoices[pid],
        value: poke.stats[room.roundChoices[pid]] || 0
      };
    });

    io.to(roomCode).emit('round_result', {
      round: currentRound,
      pokemon: poke,
      choices: result,
      scores: room.scores
    });

    room.round++;
    room.resolving = false;

    const gId = gameId;

    if (room.round >= 6) {
      room.nextRoundTimer = setTimeout(() => {
        if (!rooms[roomCode]) return;
        if (rooms[roomCode].gameId !== gId) return;
        endGame(roomCode);
      }, 3500);
    } else {
      room.nextRoundTimer = setTimeout(() => {
        if (!rooms[roomCode]) return;
        if (rooms[roomCode].gameId !== gId) return;
        if (rooms[roomCode].status !== 'playing') return;
        startRound(roomCode, gId);
      }, 3500);
    }
  } catch(e) {
    console.error('resolveRound CRASH:', e);
    room.resolving = false;
  }
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const gameIdAtEnd = room.gameId;

  const players = Object.keys(room.players);
  let winnerId = null;
  if (room.scores[players[0]] > room.scores[players[1]]) winnerId = players[0];
  else if (room.scores[players[1]] > room.scores[players[0]]) winnerId = players[1];

  io.to(roomCode).emit('game_end', {
    scores: room.scores,
    players: room.players,
    winnerId,
    history: room.history || []
  });

  setTimeout(() => {
    if (!rooms[roomCode]) return;
    if (rooms[roomCode].gameId !== gameIdAtEnd) return; // ← ne supprime pas si rematch
    delete rooms[roomCode];
  }, 60000);
}

// ── SOCKET.IO EVENTS ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connecté: ${socket.id}`);
  socket.on('join_queue', ({ pseudo, gens }) => {
  // Retire le joueur de la queue s'il y était déjà
  const existing = queue.findIndex(p => p.id === socket.id);
  if (existing !== -1) queue.splice(existing, 1);

  socket.pseudo = pseudo;
  socket.gens = gens;

  // Cherche un adversaire dans la queue
  const opponent = queue.find(p => p.id !== socket.id);

  if (opponent) {
    queue.splice(queue.indexOf(opponent), 1);
    clearTimeout(opponent.timeout);

    // Crée la room
    let code = generateRoomCode();
    while (rooms[code]) code = generateRoomCode();

    const gens_merged = ['all']; // toutes gens ou filter commun possible plus tard

    rooms[code] = {
      code,
      gens: gens || ['all'],
      players: { [opponent.id]: opponent.pseudo, [socket.id]: pseudo },
      pokemons: [],
      round: 0,
      gameId: 1,
      roundId: 0,
      scores: { [opponent.id]: 0, [socket.id]: 0 },
      usedStats: { [opponent.id]: [], [socket.id]: [] },
      roundChoices: {},
      roundTimer: null,
      nextRoundTimer: null,
      roundResolved: false,
      resolving: false,
      history: [],
      status: 'loading',
      statPool: shuffle([...STATS])
    };

    opponent.socket.roomCode = code;
    socket.roomCode = code;
    opponent.socket.join(code);
    socket.join(code);

    console.log(`[Matchmaking] ${opponent.pseudo} vs ${pseudo} → room ${code}`);

    io.to(code).emit('room_joined', { code, players: rooms[code].players });

    const currentGameId = 1;
    loadSixPokemons(rooms[code].gens).then(pokemons => {
      if (!rooms[code] || rooms[code].gameId !== currentGameId) return;
      rooms[code].pokemons = pokemons;
      rooms[code].status = 'playing';
      io.to(code).emit('game_start', { players: rooms[code].players });
      setTimeout(() => startRound(code, currentGameId), 1000);
    });

  } else {
    // Pas d'adversaire — met en attente avec timeout 60s
    const timeout = setTimeout(() => {
      const idx = queue.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        queue.splice(idx, 1);
        socket.emit('queue_timeout');
      }
    }, 60000);

    queue.push({ id: socket.id, socket, pseudo, gens: gens || ['all'], timeout });
    socket.emit('queue_waiting');
    console.log(`[Queue] ${pseudo} en attente (${queue.length} dans la file)`);
  }
});

socket.on('leave_queue', () => {
  const idx = queue.findIndex(p => p.id === socket.id);
  if (idx !== -1) {
    clearTimeout(queue[idx].timeout);
    queue.splice(idx, 1);
    console.log(`[Queue] ${socket.pseudo} a quitté la file`);
  }
});

  socket.on('create_room', ({ pseudo, gens }) => {
    let code = generateRoomCode();
    while (rooms[code]) code = generateRoomCode();

    rooms[code] = {
      code,
      gens: gens || ['all'],
      players: { [socket.id]: pseudo },
      pokemons: [],
      round: 0,
      gameId: 0,
      roundId: 0,
      scores: { [socket.id]: 0 },
      usedStats: { [socket.id]: [] },
      roundChoices: {},
      roundTimer: null,
      nextRoundTimer: null,
      roundResolved: false,
      resolving: false,
      history: [],
      status: 'waiting'
    };

    socket.join(code);
    socket.roomCode = code;
    socket.pseudo = pseudo;

    socket.emit('room_created', { code, pseudo });
    console.log(`[Room] ${code} créée par ${pseudo}`);
  });

  socket.on('join_room', ({ pseudo, code }) => {
    const room = rooms[code];

    if (!room) { socket.emit('error', { message: 'Room introuvable.' }); return; }
    if (Object.keys(room.players).length >= 2) { socket.emit('error', { message: 'Room complète.' }); return; }
    if (room.status !== 'waiting') { socket.emit('error', { message: 'Partie déjà en cours.' }); return; }

    room.players[socket.id] = pseudo;
    room.scores[socket.id] = 0;
    room.usedStats[socket.id] = [];

    socket.join(code);
    socket.roomCode = code;
    socket.pseudo = pseudo;

    io.to(code).emit('room_joined', { code, players: room.players });
    console.log(`[Room] ${pseudo} a rejoint ${code}`);

    room.status = 'loading';
    room.gameId = 1;
    const currentGameId = room.gameId;
    room.statPool = shuffle([...STATS]);

    loadSixPokemons(room.gens).then(pokemons => {
      if (room.gameId !== currentGameId) return;
      room.pokemons = pokemons;
      room.status = 'playing';
      io.to(code).emit('game_start', { players: room.players });
      setTimeout(() => startRound(code, currentGameId), 1000);
    });
  });

  socket.on('choose_stat', ({ stat }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.status !== 'playing') return;
    if (room.roundChoices[socket.id]) return;
    if (room.roundResolved) return;
    if (room.resolving) return;

    const usedStats = room.usedStats[socket.id] || [];
    if (usedStats.includes(stat)) return;

    room.roundChoices[socket.id] = stat;
    socket.to(code).emit('opponent_chose');

    const players = Object.keys(room.players);
    if (players.every(pid => room.roundChoices[pid])) {
      resolveRound(code, room.gameId);
    }
  });

  socket.on('request_rematch', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;

    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(socket.id);

    socket.to(code).emit('opponent_wants_rematch', {
      pseudo: room.players[socket.id]
    });

    if (room.rematchVotes.size === 2) {
      clearTimeout(room.roundTimer);
      clearTimeout(room.nextRoundTimer);

      room.rematchVotes = new Set();
      room.round = 0;
      room.roundId = 0;
      room.scores = {};
      room.usedStats = {};
      room.history = [];
      room.roundChoices = {};
      room.roundResolved = false;
      room.resolving = false;
      room.gameId = (room.gameId || 0) + 1;
      room.statPool = shuffle([...STATS]);
      const currentGameId = room.gameId;

      room.status = 'loading';
      Object.keys(room.players).forEach(pid => {
        room.scores[pid] = 0;
        room.usedStats[pid] = [];
      });

      io.to(code).emit('game_start', { players: room.players });
      loadSixPokemons(room.gens).then(pokemons => {
        if (room.gameId !== currentGameId) return;
        room.pokemons = pokemons;
        room.status = 'playing';
        setTimeout(() => startRound(code, currentGameId), 1000);
      });
    }
  });

  socket.on('disconnect', () => {
  console.log(`[-] Déconnecté: ${socket.id}, roomCode: ${socket.roomCode}`);

  // Retire de la queue en premier, avant tout
  const qIdx = queue.findIndex(p => p.id === socket.id);
  if (qIdx !== -1) {
    clearTimeout(queue[qIdx].timeout);
    queue.splice(qIdx, 1);
  }

  const code = socket.roomCode;
  if (!code || !rooms[code]) return;

  const room = rooms[code];
  console.log(`Room ${code} players restants: ${Object.keys(room.players).length - 1}`);
  const pseudo = room.players[socket.id];
  delete room.players[socket.id];

  if (room.status === 'playing') {
    clearTimeout(room.roundTimer);
    clearTimeout(room.nextRoundTimer);
    io.to(code).emit('opponent_disconnected', { pseudo });
  }

  if (Object.keys(room.players).length === 0) {
    delete rooms[code];
  }
});
});

app.get('/', (req, res) => res.send('PokéStat Duel Server OK'));

server.listen(PORT, () => {
  console.log(`✅ Serveur lancé sur http://localhost:${PORT}`);
});
