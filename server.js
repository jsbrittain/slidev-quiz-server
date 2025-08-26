import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';

const wss = new WebSocketServer({ port: 8080 });
console.log('WS running on port 8080');

const rooms = new Map();
// rooms[room] = { hosts: new Set(), players: new Set(), quizzes: new Map() }

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { host: null, players: new Set(), quizzes: new Map() });
  }
  return rooms.get(id);
}

function broadcast(room, payload) {
  const msg = JSON.stringify(payload);
  for (const h of room.hosts ?? [])  if (h.readyState === 1) h.send(msg);
  for (const p of room.players ?? []) if (p.readyState === 1) p.send(msg);
  console.log('broadcast', payload);
}

wss.on('connection', (ws) => {
  let roomId = null;
  let role = 'player'; // or 'host'
  let userId = nanoid(8);

  ws.on('message', (buf) => {
    console.log('msg', buf.toString());
    let m; try { m = JSON.parse(buf); } catch { return; }

    // --- host create / identify ---
    if (m.type === 'host-create') {
      roomId = m.room || nanoid(6).toUpperCase();
      role = 'host';
      const room = getRoom(roomId);
      room.hosts ??= new Set();
      room.hosts.add(ws);
      ws.send(JSON.stringify({ type: 'room', room: roomId }));
      return;
    }

    if (m.type === 'player-join') {
      roomId = m.room;
      role = 'player';
      const room = getRoom(roomId);
      room.players.add(ws);
      ws.send(JSON.stringify({ type: 'joined', room: roomId }));
      broadcast(room, { type: 'players', room: roomId, count: room.players.size });
      return;
    }

    // --- quiz upsert / activate (usually sent by slide/player/host on mount) ---
    if (m.type === 'quiz-upsert' && m.room && m.quiz?.id) {
      const room = getRoom(m.room);
      const q = room.quizzes.get(m.quiz.id) || { quiz: m.quiz, counts: {}, answersByUser: new Map() };
      q.quiz = m.quiz; // replace definition
      room.quizzes.set(m.quiz.id, q);
      return;
    }

    if (m.type === 'quiz-activate' && m.room && m.id) {
      const room = getRoom(m.room);
      const q = room.quizzes.get(m.id) || { quiz: { id: m.id }, counts: {}, answersByUser: new Map() };
      // optional reset on activate:
      if (m.reset === true) { q.counts = {}; q.answersByUser.clear(); }
      room.quizzes.set(m.id, q);
      broadcast(room, { type: 'quiz-active', room: m.room, quiz: q.quiz, counts: q.counts });
      return;
    }

    // --- counts request (host asks for current tally for a quiz) ---
    if (m.type === 'counts-request' && m.room && m.quizId) {
      const room = getRoom(m.room);
      const q = room.quizzes.get(m.quizId);
      const r = { type: 'counts', room: m.room, quizId: m.quizId, counts: q?.counts || {} };
      console.log('responding with counts', r);
      ws.send(JSON.stringify(r));
      return;
    }

    // --- answers ---
    if (m.type === 'answer' && m.room && m.quizId && m.choice) {
      const room = getRoom(m.room);
      const q = room.quizzes.get(m.quizId) || { quiz: { id: m.quizId }, counts: {}, answersByUser: new Map() };
      // one answer per userId (simple anti-spam)
      const prev = q.answersByUser.get(userId);
      if (prev) { q.counts[prev] = Math.max(0, (q.counts[prev] || 0) - 1); }
      q.answersByUser.set(userId, m.choice);
      q.counts[m.choice] = (q.counts[m.choice] || 0) + 1;
      room.quizzes.set(m.quizId, q);

      // ack to the answering client
      ws.send(JSON.stringify({ type: 'answer-ack', quizId: m.quizId, choice: m.choice }));
      // broadcast latest counts to all
      broadcast(room, { type: 'counts', room: m.room, quizId: m.quizId, counts: q.counts });
      return;
    }

    // --- reset a quiz tally ---
    if (m.type === 'quiz-reset' && m.room && m.quizId) {
      const room = getRoom(m.room);
      const q = room.quizzes.get(m.quizId);
      if (q) { q.counts = {}; q.answersByUser.clear(); }
      broadcast(room, { type: 'counts', room: m.room, quizId: m.quizId, counts: q?.counts || {} });
      return;
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.host === ws) room.host = null;
    room.players.delete(ws);
  });
});
