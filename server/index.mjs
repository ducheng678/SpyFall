import express from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import {
  addChatMessage,
  addPlayer,
  advanceSpeaker,
  castVote,
  createRoom,
  ensureHost,
  finishGameByHost,
  guessWord,
  kickPlayer,
  normalizeName,
  normalizeSettings,
  privatePlayerState,
  publicRoomState,
  removeOrDisconnectPlayer,
  restartGame,
  startGame,
  startVote,
  updatePlayerCount
} from "./gameLogic.mjs";
import {
  createNumericRoomCode,
  normalizeRoomCodeInput,
  requireValidRoomCode
} from "./roomCode.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT || 3000);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true
  }
});

const rooms = new Map();
const socketIndex = new Map();

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.use(express.static(distDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

io.on("connection", (socket) => {
  socket.on("createRoom", (payload, reply) => {
    try {
      const playerId = createPlayerId();
      const sessionToken = createSessionToken();
      const name = normalizeName(payload?.name);
      if (!name) throw new Error("请输入昵称");

      const settings = normalizeSettings(payload?.settings);
      const code = resolveCreateRoomCode(payload?.code);
      const room = createRoom({ code, hostId: playerId, hostName: name, sessionToken, settings });
      rooms.set(code, room);
      attachSocket(socket, room, playerId);
      replyOk(reply, { code, playerId, sessionToken });
      broadcastRoom(room);
    } catch (error) {
      replyError(reply, error);
    }
  });

  socket.on("joinRoom", (payload, reply) => {
    try {
      const code = requireValidRoomCode(payload?.code);
      const room = requireRoom(code);
      const playerId = safeId(payload?.playerId);
      const sessionToken = safeToken(payload?.sessionToken);
      const name = normalizeName(payload?.name);
      const existingPlayer = playerId
        ? room.players.find((item) => item.id === playerId)
        : null;
      if (playerId && !existingPlayer && room.kickedPlayerIds?.includes(playerId)) {
        throw new Error("你已被房主移出房间");
      }

      const nextPlayerId = existingPlayer ? playerId : createPlayerId();
      const nextSessionToken = existingPlayer ? sessionToken : createSessionToken();
      const player = addPlayer(room, {
        id: nextPlayerId,
        name,
        sessionToken: nextSessionToken
      });
      player.connected = true;
      attachSocket(socket, room, player.id);
      if (!existingPlayer) addRoomMessage(room, `${player.name} 加入了房间。`);
      replyOk(reply, { code, playerId: player.id, sessionToken: player.sessionToken });
      broadcastRoom(room);
    } catch (error) {
      replyError(reply, error);
    }
  });

  socket.on("startGame", (_payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      requireHost(room, playerId);
      startGame(room);
      broadcastRoom(room);
    });
  });

  socket.on("kickPlayer", (payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      const removed = kickPlayer(room, playerId, safeId(payload?.targetId));
      detachPlayerSockets(room, removed.id, "你已被房主移出房间。");
      addRoomMessage(room, `房主移除了 ${removed.name}。`);
      if (room.players.length === 0) rooms.delete(room.code);
      else broadcastRoom(room);
    });
  });

  socket.on("updatePlayerCount", (payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      updatePlayerCount(room, playerId, payload?.playerCount);
      addRoomMessage(room, `房间人数调整为 ${room.settings.playerCount} 人。`);
      broadcastRoom(room);
    });
  });

  socket.on("advanceSpeaker", (_payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      requireHost(room, playerId);
      advanceSpeaker(room);
      broadcastRoom(room);
    });
  });

  socket.on("startVote", (_payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      startVote(room, playerId);
      broadcastRoom(room);
    });
  });

  socket.on("castVote", (payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      castVote(room, playerId, payload?.targetId);
      broadcastRoom(room);
    });
  });

  socket.on("guessWord", (payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      guessWord(room, playerId, payload?.guess);
      broadcastRoom(room);
    });
  });

  socket.on("sendMessage", (payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      addChatMessage(room, playerId, payload?.text);
      broadcastRoom(room);
    });
  });

  socket.on("restartGame", (_payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      requireHost(room, playerId);
      restartGame(room);
      broadcastRoom(room);
    });
  });

  socket.on("endGame", (_payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      requireHost(room, playerId);
      finishGameByHost(room);
      broadcastRoom(room);
    });
  });

  socket.on("leaveRoom", (_payload, reply) => {
    const entry = socketIndex.get(socket.id);
    if (!entry) return replyOk(reply);
    const room = rooms.get(entry.code);
    socket.leave(entry.code);
    socketIndex.delete(socket.id);
    if (room) {
      removeOrDisconnectPlayer(room, entry.playerId);
      addRoomMessage(room, "有玩家离开了房间。");
      if (room.players.length === 0) rooms.delete(room.code);
      else broadcastRoom(room);
    }
    replyOk(reply);
  });

  socket.on("disconnect", () => {
    const entry = socketIndex.get(socket.id);
    if (!entry) return;
    socketIndex.delete(socket.id);
    const room = rooms.get(entry.code);
    if (!room) return;
    if (hasPlayerSocket(entry.code, entry.playerId)) return;
    const player = room.players.find((item) => item.id === entry.playerId);
    if (player) player.connected = false;
    ensureHost(room);
    broadcastRoom(room);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
});

function withRoom(socket, reply, handler) {
  try {
    const entry = socketIndex.get(socket.id);
    if (!entry) throw new Error("请先加入房间");
    const room = requireRoom(entry.code);
    handler({ room, playerId: entry.playerId });
    replyOk(reply);
  } catch (error) {
    replyError(reply, error);
  }
}

function attachSocket(socket, room, playerId) {
  socket.join(room.code);
  socketIndex.set(socket.id, { code: room.code, playerId });
  const player = room.players.find((item) => item.id === playerId);
  if (player) player.connected = true;
}

function detachPlayerSockets(room, playerId, reason) {
  for (const [socketId, entry] of [...socketIndex]) {
    if (entry.code !== room.code || entry.playerId !== playerId) continue;
    io.to(socketId).emit("kicked", { reason });
    io.sockets.sockets.get(socketId)?.leave(room.code);
    socketIndex.delete(socketId);
  }
}

function hasPlayerSocket(code, playerId) {
  for (const entry of socketIndex.values()) {
    if (entry.code === code && entry.playerId === playerId) return true;
  }
  return false;
}

function broadcastRoom(room) {
  const publicState = publicRoomState(room);
  io.to(room.code).emit("roomState", publicState);
  for (const [socketId, entry] of socketIndex) {
    if (entry.code !== room.code) continue;
    io.to(socketId).emit("privateState", privatePlayerState(room, entry.playerId));
  }
}

function resolveCreateRoomCode(value) {
  const rawCode = String(value ?? "").trim();
  if (!rawCode) return createNumericRoomCode(rooms);
  const code = requireValidRoomCode(rawCode);
  if (rooms.has(code)) throw new Error("房间码已被使用");
  return code;
}

function safeId(value) {
  return String(value ?? "").trim().slice(0, 80);
}

function safeToken(value) {
  return String(value ?? "").trim().slice(0, 120);
}

function createPlayerId() {
  return randomUUID();
}

function createSessionToken() {
  return randomUUID();
}

function requireRoom(code) {
  const room = rooms.get(code);
  if (!room) throw new Error("房间不存在");
  return room;
}

function requireHost(room, playerId) {
  if (room.hostId !== playerId) throw new Error("只有房主可以操作");
}

function replyOk(reply, data = {}) {
  if (typeof reply === "function") reply({ ok: true, ...data });
}

function replyError(reply, error) {
  const message = error instanceof Error ? error.message : "操作失败";
  if (typeof reply === "function") reply({ ok: false, error: message });
}

function addRoomMessage(room, text) {
  room.messages.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: "system",
    text,
    createdAt: Date.now()
  });
  if (room.messages.length > 120) room.messages = room.messages.slice(-120);
}
