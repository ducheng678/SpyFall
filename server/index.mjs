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
const adminToken = String(process.env.ADMIN_TOKEN || "").trim();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true
  }
});

const rooms = new Map();
const socketIndex = new Map();
const activityLog = [];
const MAX_ACTIVITY_EVENTS = 500;

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get("/activity", (req, res) => {
  if (!adminToken) {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }
  if (!isAuthorizedAdminRequest(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  const limit = clampActivityLimit(req.query.limit);
  res.json({
    ok: true,
    total: activityLog.length,
    events: activityLog.slice(-limit).reverse()
  });
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
      recordActivity("room.created", room, {
        playerId,
        playerName: name,
        mode: room.settings.mode,
        playerCount: room.settings.playerCount
      });
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
      if (playerId && !existingPlayer && room.blockedPlayerIds?.includes(playerId)) {
        throw new Error("你已被房主拉黑");
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
      if (!existingPlayer) {
        addRoomMessage(room, `${player.name} 加入了房间。`);
        recordActivity("player.joined", room, {
          playerId: player.id,
          playerName: player.name
        });
      } else {
        recordActivity("player.reconnected", room, {
          playerId: player.id,
          playerName: player.name
        });
      }
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
      recordActivity("game.started", room, {
        playerId,
        playerName: playerName(room, playerId),
        mode: room.settings.mode,
        playerCount: room.players.length
      });
      broadcastRoom(room);
    });
  });

  socket.on("kickPlayer", (payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      const blacklist = Boolean(payload?.blacklist);
      const removed = kickPlayer(room, playerId, safeId(payload?.targetId), { blacklist });
      detachPlayerSockets(
        room,
        removed.id,
        blacklist ? "你已被房主拉黑并移出房间。" : "你已被房主移出房间。",
        { blacklisted: blacklist }
      );
      addRoomMessage(room, `房主${blacklist ? "拉黑并移除了" : "移除了"} ${removed.name}。`);
      recordActivity(blacklist ? "player.blacklisted" : "player.kicked", room, {
        playerId: removed.id,
        playerName: removed.name,
        actorId: playerId,
        actorName: playerName(room, playerId)
      });
      if (room.players.length === 0) rooms.delete(room.code);
      else broadcastRoom(room);
    });
  });

  socket.on("updatePlayerCount", (payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      updatePlayerCount(room, playerId, payload?.playerCount);
      addRoomMessage(room, `房间人数调整为 ${room.settings.playerCount} 人。`);
      recordActivity("room.player_count_updated", room, {
        playerId,
        playerName: playerName(room, playerId),
        playerCount: room.settings.playerCount
      });
      broadcastRoom(room);
    });
  });

  socket.on("advanceSpeaker", (_payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      advanceSpeaker(room, playerId);
      broadcastRoom(room);
    });
  });

  socket.on("startVote", (_payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      startVote(room, playerId);
      recordActivity("vote.started", room, {
        playerId,
        playerName: playerName(room, playerId),
        phase: room.phase
      });
      broadcastRoom(room);
    });
  });

  socket.on("castVote", (payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      castVote(room, playerId, payload?.targetId);
      recordActivity("vote.cast", room, {
        playerId,
        playerName: playerName(room, playerId),
        targetId: safeId(payload?.targetId),
        targetName: playerName(room, safeId(payload?.targetId)),
        phase: room.phase,
        status: room.status
      });
      broadcastRoom(room);
    });
  });

  socket.on("guessWord", (payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      guessWord(room, playerId, payload?.guess);
      recordActivity("blank.guessed", room, {
        playerId,
        playerName: playerName(room, playerId),
        status: room.status
      });
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
      recordActivity("game.restarted", room, {
        playerId,
        playerName: playerName(room, playerId),
        mode: room.settings.mode,
        playerCount: room.players.length
      });
      broadcastRoom(room);
    });
  });

  socket.on("endGame", (_payload, reply) => {
    withRoom(socket, reply, ({ room, playerId }) => {
      requireHost(room, playerId);
      finishGameByHost(room);
      recordActivity("game.ended", room, {
        playerId,
        playerName: playerName(room, playerId),
        reason: "host"
      });
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
      const leavingPlayer = room.players.find((item) => item.id === entry.playerId);
      removeOrDisconnectPlayer(room, entry.playerId);
      addRoomMessage(room, "有玩家离开了房间。");
      recordActivity("player.left", room, {
        playerId: entry.playerId,
        playerName: leavingPlayer?.name ?? null
      });
      if (room.players.length === 0) {
        recordActivity("room.deleted", room, { reason: "empty" });
        rooms.delete(room.code);
      } else {
        broadcastRoom(room);
      }
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
    recordActivity("player.disconnected", room, {
      playerId: entry.playerId,
      playerName: player?.name ?? null
    });
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

function detachPlayerSockets(room, playerId, reason, data = {}) {
  for (const [socketId, entry] of [...socketIndex]) {
    if (entry.code !== room.code || entry.playerId !== playerId) continue;
    io.to(socketId).emit("kicked", { reason, ...data });
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

function isAuthorizedAdminRequest(req) {
  const header = String(req.get("authorization") || "").trim();
  const bearerPrefix = "Bearer ";
  const bearerToken = header.startsWith(bearerPrefix)
    ? header.slice(bearerPrefix.length).trim()
    : "";
  const queryToken = String(req.query.token || "").trim();
  return bearerToken === adminToken || queryToken === adminToken;
}

function recordActivity(type, room, details = {}) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    roomCode: room.code,
    createdAt: new Date().toISOString(),
    activeRooms: rooms.size,
    roomStatus: room.status,
    roomPhase: room.phase,
    players: room.players.length,
    connectedPlayers: room.players.filter((player) => player.connected).length,
    details
  };
  activityLog.push(event);
  if (activityLog.length > MAX_ACTIVITY_EVENTS) {
    activityLog.splice(0, activityLog.length - MAX_ACTIVITY_EVENTS);
  }
}

function playerName(room, playerId) {
  return room.players.find((player) => player.id === playerId)?.name ?? null;
}

function clampActivityLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (Number.isNaN(limit)) return 100;
  return Math.max(1, Math.min(500, limit));
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
