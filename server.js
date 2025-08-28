import http from 'http'

import { nanoid } from 'nanoid';
import { WebSocketServer } from 'ws';

// http health check
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('status: ok')
})

const wss = new WebSocketServer({ server });

const rooms = new Map();
// rooms[room] = { hosts: new Set(), quizzes: new Map() }

const getRoom = (id) => {
  if (!rooms.has(id)) {
    rooms.set(id, { host: null, quizzes: new Map() });
  }
  return rooms.get(id);
}

const broadcast = (room, payload) => {
  const msg = JSON.stringify(payload);
  for (const h of room.hosts ?? [])  if (h.readyState === 1) h.send(msg);
  console.log('broadcast', payload);
}

wss.on('connection', (ws) => {
  let roomId = null;
  let userId = nanoid(8);

  ws.on('message', (buf) => {
    console.log('msg', buf.toString());
    let m; try { m = JSON.parse(buf); } catch { return; }

    // --- quiz upsert / activate (usually sent by the host on mount) ---
    if (m.type === 'quiz-upsert' && m.room && m.quiz?.id) {
      const room = getRoom(m.room);
      const q = room.quizzes.get(m.quiz.id) || { quiz: m.quiz, counts: {}, answersByUser: new Map() };
      q.quiz = m.quiz; // replace definition
      room.quizzes.set(m.quiz.id, q);
      return;
    }

    // --- counts request (host asks for current tally for a quiz) ---
    if (m.type === 'counts-request' && m.room && m.quizId) {
      const room = getRoom(m.room);
      const q = room.quizzes.get(m.quizId);
      const r = { type: 'counts', room: m.room, quizId: m.quizId, counts: q?.counts || {} };
      console.log('responding with counts', r);
      ws.send(JSON.stringify(r));

      // register host for subsequent broadcasts
      room.hosts ??= new Set();
      room.hosts.add(ws);

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
    room.hosts.delete(ws);
  });
});

const PORT = process.env.PORT || 8080   // 8080 for local, PORT on Render
server.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on http://0.0.0.0:${PORT}`)
})
