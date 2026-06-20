import { blankWords, classicWordPairs } from "./wordBank.mjs";

export const MODES = {
  CLASSIC: "classic",
  BLANK: "blank"
};

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 3;

export function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, "").toLowerCase();
}

export function normalizeName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 16);
}

export function clampPlayerCount(value) {
  const count = Number.parseInt(value, 10);
  if (Number.isNaN(count)) return 6;
  return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, count));
}

export function maxUndercoverCount(playerCount) {
  return Math.max(1, Math.floor((playerCount - 1) / 2));
}

export function normalizeSettings(input = {}) {
  const mode = input.mode === MODES.BLANK ? MODES.BLANK : MODES.CLASSIC;
  const playerCount = clampPlayerCount(input.playerCount);
  const undercoverCount =
    mode === MODES.CLASSIC
      ? Math.max(
          1,
          Math.min(
            maxUndercoverCount(playerCount),
            Number.parseInt(input.undercoverCount, 10) || 1
          )
        )
      : 0;

  return {
    mode,
    playerCount,
    undercoverCount,
    customCivilianWord: String(input.customCivilianWord ?? "").trim().slice(0, 20),
    customUndercoverWord: String(input.customUndercoverWord ?? "").trim().slice(0, 20)
  };
}

export function createRoom({ code, hostId, hostName, sessionToken, settings }) {
  const room = {
    code,
    createdAt: Date.now(),
    hostId,
    primaryHostId: hostId,
    status: "lobby",
    phase: "lobby",
    round: 0,
    settings: normalizeSettings(settings),
    words: null,
    players: [],
    messages: [],
    currentSpeakerId: null,
    speakerOrder: [],
    speakerIndex: -1,
    previousUndercoverIds: [],
    blockedPlayerIds: [],
    result: null
  };
  addPlayer(room, { id: hostId, name: hostName, sessionToken });
  return room;
}

export function addPlayer(room, { id, name, sessionToken }) {
  if (!id) throw new Error("缺少玩家身份");
  if (room.blockedPlayerIds?.includes(id)) throw new Error("你已被房主拉黑");

  const existing = room.players.find((player) => player.id === id);
  if (existing) {
    if (!sessionToken || existing.sessionToken !== sessionToken) {
      throw new Error("玩家身份验证失败");
    }
    const cleanName = normalizeName(name);
    existing.name = existing.name || cleanName;
    existing.connected = true;
    ensureHost(room);
    return existing;
  }

  if (!sessionToken) throw new Error("缺少玩家凭证");
  const cleanName = normalizeName(name);
  if (!cleanName) throw new Error("请输入昵称");
  if (room.status !== "lobby") throw new Error("游戏已经开始，不能加入新玩家");
  if (room.players.length >= room.settings.playerCount) throw new Error("房间已满");
  if (room.players.some((player) => player.name === cleanName)) {
    throw new Error("昵称已被使用");
  }

  const player = {
    id,
    name: cleanName,
    connected: true,
    alive: true,
    joinedAt: Date.now(),
    role: null,
    word: null,
    voteTargetId: null,
    sessionToken
  };
  room.players.push(player);
  ensureHost(room);
  return player;
}

export function removeOrDisconnectPlayer(room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) return;
  if (room.status === "lobby" || room.status === "finished") {
    room.players = room.players.filter((item) => item.id !== playerId);
  } else {
    player.connected = false;
  }
  if (room.primaryHostId === playerId) {
    transferPrimaryHost(room, playerId);
  }
  ensureHost(room);
}

export function kickPlayer(room, hostId, targetId, { blacklist = false } = {}) {
  requireKickableRoom(room, hostId, targetId);
  const target = room.players.find((player) => player.id === targetId);
  if (!target) throw new Error("玩家不存在");
  if (target.id === hostId) throw new Error("不能移除自己");

  const removedSpeakerIndex = room.speakerOrder.findIndex((id) => id === target.id);
  const removedCurrentSpeaker =
    room.status === "playing" &&
    room.phase === "describe" &&
    room.currentSpeakerId === target.id;

  if (blacklist) {
    room.blockedPlayerIds = [...new Set([...(room.blockedPlayerIds ?? []), target.id])];
  }
  room.players = room.players.filter((player) => player.id !== target.id);
  room.speakerOrder = room.speakerOrder.filter((id) => id !== target.id);
  if (room.primaryHostId === target.id) {
    transferPrimaryHost(room, target.id);
  }
  ensureHost(room);

  if (room.status === "playing") {
    if (removedCurrentSpeaker) {
      advanceAfterRemovedSpeaker(room, removedSpeakerIndex);
    } else if (room.currentSpeakerId) {
      room.speakerIndex = room.speakerOrder.findIndex((id) => id === room.currentSpeakerId);
    }

    clearVotes(room);
    const result = evaluateWin(room);
    if (result) {
      finishGame(room, result);
    } else if (room.phase === "voting") {
      room.phase = "discussion";
      room.currentSpeakerId = null;
      addSystemMessage(room, "有掉线玩家被移除，本轮投票已重置。");
    }
  }
  return target;
}

export function updatePlayerCount(room, hostId, value) {
  requireManageableRoom(room, hostId);
  const playerCount = Number.parseInt(value, 10);
  if (Number.isNaN(playerCount)) throw new Error("请输入有效人数");

  const minPlayerCount = Math.max(MIN_PLAYERS, room.players.length);
  if (playerCount < minPlayerCount) {
    throw new Error(`人数不能少于 ${minPlayerCount}`);
  }
  if (playerCount > MAX_PLAYERS) {
    throw new Error(`人数不能超过 ${MAX_PLAYERS}`);
  }

  room.settings.playerCount = playerCount;
  if (room.settings.mode === MODES.CLASSIC) {
    room.settings.undercoverCount = Math.min(
      room.settings.undercoverCount,
      maxUndercoverCount(playerCount)
    );
  }
  return room.settings;
}

export function ensureHost(room) {
  const primaryHost = room.players.find((player) => player.id === room.primaryHostId);
  if (primaryHost?.connected) {
    room.hostId = primaryHost.id;
    return;
  }

  if (room.players.some((player) => player.id === room.hostId && player.connected)) return;

  const nextHost = room.players.find((player) => player.connected);
  room.hostId = nextHost?.id ?? room.players[0]?.id ?? null;
}

function transferPrimaryHost(room, previousHostId) {
  const nextPrimary =
    room.players.find((player) => player.id !== previousHostId && player.connected) ??
    room.players.find((player) => player.id !== previousHostId) ??
    null;
  room.primaryHostId = nextPrimary?.id ?? null;
  room.hostId = nextPrimary?.id ?? null;
}

function advanceAfterRemovedSpeaker(room, removedSpeakerIndex) {
  const nextSpeakerId = room.speakerOrder
    .slice(Math.max(removedSpeakerIndex, 0))
    .find((id) => room.players.some((player) => player.id === id && player.alive));

  if (nextSpeakerId) {
    room.currentSpeakerId = nextSpeakerId;
    room.speakerIndex = room.speakerOrder.findIndex((id) => id === nextSpeakerId);
  } else {
    room.phase = "discussion";
    room.currentSpeakerId = null;
    room.speakerIndex = -1;
    addSystemMessage(room, "本轮描述结束，可以讨论或发起投票。");
  }
}

export function startGame(room, rng = Math.random) {
  if (room.status === "playing") throw new Error("游戏已经开始");
  if (room.players.length !== room.settings.playerCount) {
    throw new Error(`需要 ${room.settings.playerCount} 名玩家到齐后才能开始`);
  }

  const orderedPlayers = [...room.players].sort((a, b) => a.joinedAt - b.joinedAt);
  const shuffledPlayers = shuffle(orderedPlayers, rng);
  room.words = pickWords(room.settings, rng);
  room.status = "playing";
  room.phase = "describe";
  room.round = 1;
  room.result = null;
  room.messages = [];
  room.speakerOrder = [];
  room.speakerIndex = -1;

  for (const player of room.players) {
    player.alive = true;
    player.voteTargetId = null;
    player.role = "civilian";
    player.word = room.words.civilianWord;
  }

  if (room.settings.mode === MODES.CLASSIC) {
    for (const player of shuffledPlayers.slice(0, room.settings.undercoverCount)) {
      player.role = "undercover";
      player.word = room.words.undercoverWord;
    }
  } else {
    const blank = shuffledPlayers[0];
    blank.role = "blank";
    blank.word = null;
  }

  prepareSpeakerOrder(room, rng, { firstRound: true });
  addSystemMessage(room, "游戏开始，按顺序描述自己的词。");
  return room;
}

export function restartGame(room, rng = Math.random) {
  if (room.players.length !== room.settings.playerCount) {
    throw new Error(`需要 ${room.settings.playerCount} 名玩家到齐后才能重新开始`);
  }
  room.status = "lobby";
  room.phase = "lobby";
  room.result = null;
  return startGame(room, rng);
}

export function advanceSpeaker(room) {
  assertPlaying(room);
  const orderedAliveIds = room.speakerOrder.filter((id) =>
    room.players.some((player) => player.id === id && player.alive)
  );
  if (!orderedAliveIds.length) {
    prepareSpeakerOrder(room);
    return room;
  }

  if (room.phase !== "describe") {
    room.phase = "describe";
    room.speakerIndex = 0;
    room.currentSpeakerId = orderedAliveIds[0];
    return room;
  }

  const currentIndex = orderedAliveIds.findIndex((id) => id === room.currentSpeakerId);
  if (currentIndex < 0) {
    room.speakerIndex = 0;
    room.currentSpeakerId = orderedAliveIds[0];
  } else if (currentIndex + 1 < orderedAliveIds.length) {
    room.speakerIndex = currentIndex + 1;
    room.currentSpeakerId = orderedAliveIds[currentIndex + 1];
  } else {
    room.phase = "discussion";
    room.currentSpeakerId = null;
    addSystemMessage(room, "本轮描述结束，可以讨论或发起投票。");
  }
  return room;
}

export function startVote(room, playerId = room.hostId) {
  assertPlaying(room);
  if (room.phase === "voting") throw new Error("正在投票中");
  if (!canStartVote(room, playerId)) throw new Error("你不能发起投票");
  room.phase = "voting";
  room.currentSpeakerId = null;
  clearVotes(room);
  addSystemMessage(
    room,
    room.settings.mode === MODES.BLANK
      ? "有人抢先发起投票！请投票给你认为的白板！"
      : "投票开始。"
  );
  return room;
}

export function canStartVote(room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  if (room.settings.mode === MODES.BLANK) return Boolean(player?.alive);
  return Boolean(player) && room.hostId === playerId;
}

export function castVote(room, voterId, targetId, rng = Math.random) {
  assertPlaying(room);
  if (room.phase !== "voting") throw new Error("当前不在投票阶段");
  const voter = requireAlivePlayer(room, voterId);
  const target = requireAlivePlayer(room, targetId);
  if (voter.id === target.id) throw new Error("不能投给自己");
  voter.voteTargetId = target.id;

  const alivePlayers = room.players.filter((player) => player.alive);
  if (alivePlayers.every((player) => player.voteTargetId)) {
    return resolveVote(room, rng);
  }
  return { room, resolved: false };
}

export function guessWord(room, playerId, guess) {
  assertPlaying(room);
  if (room.settings.mode !== MODES.BLANK) throw new Error("只有白板模式可以猜词");
  const player = requireAlivePlayer(room, playerId);
  if (player.role !== "blank") throw new Error("只有白板可以猜词");
  const cleanGuess = String(guess ?? "").trim().slice(0, 20);
  if (!cleanGuess) throw new Error("请输入猜测的词");

  if (normalizeText(cleanGuess) === normalizeText(room.words?.civilianWord)) {
    finishGame(room, {
      winner: "blank",
      title: "白板胜利",
      reason: `白板猜中了词：${room.words.civilianWord}`,
      guess: cleanGuess
    });
  } else {
    finishGame(room, {
      winner: "civilian",
      title: "平民胜利",
      reason: `白板猜错了词：${cleanGuess}`,
      guess: cleanGuess
    });
  }
  return room;
}

export function addChatMessage(room, playerId, text) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) throw new Error("玩家不存在");
  const cleanText = String(text ?? "").trim().slice(0, 240);
  if (!cleanText) throw new Error("消息不能为空");
  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: "player",
    playerId,
    name: player.name,
    text: cleanText,
    createdAt: Date.now()
  };
  room.messages.push(message);
  trimMessages(room);
  return message;
}

export function publicRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    phase: room.phase,
    round: room.round,
    mode: room.settings.mode,
    settings: {
      playerCount: room.settings.playerCount,
      undercoverCount: room.settings.undercoverCount
    },
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      alive: player.alive,
      host: player.id === room.hostId,
      hasVoted: Boolean(player.voteTargetId)
    })),
    currentSpeakerId: room.currentSpeakerId,
    speakerOrder: room.speakerOrder,
    messages: room.messages.slice(-80),
    result: room.result
  };
}

export function privatePlayerState(room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) return null;
  const base = {
    playerId,
    host: player.id === room.hostId,
    mode: room.settings.mode,
    alive: player.alive,
    canStartVote: room.status === "playing" && canStartVote(room, playerId)
  };

  if (room.status === "lobby") {
    return { ...base, word: null, roleLabel: null, canGuess: false };
  }

  if (room.settings.mode === MODES.CLASSIC) {
    return {
      ...base,
      word: player.word,
      roleLabel: null,
      canGuess: false,
      hint: "经典模式不显示身份，只显示你的词。"
    };
  }

  if (player.role === "blank") {
    return {
      ...base,
      word: null,
      roleLabel: "白板",
      canGuess: player.alive && room.status === "playing",
      hint: "你是白板，没有词。"
    };
  }

  return {
    ...base,
    word: player.word,
    roleLabel: "平民",
    canGuess: false,
    hint: "你是平民。"
  };
}

function resolveVote(room, rng = Math.random) {
  const counts = voteCounts(room);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const topCount = entries[0]?.[1] ?? 0;
  const topTargets = entries.filter(([, count]) => count === topCount);

  if (topTargets.length !== 1) {
    clearVotes(room);
    room.phase = "discussion";
    addSystemMessage(room, "投票平票，本轮无人出局。");
    return { room, resolved: true, tie: true };
  }

  const target = room.players.find((player) => player.id === topTargets[0][0]);
  target.alive = false;
  addSystemMessage(room, `${target.name} 被投票出局。`);
  clearVotes(room);

  const result = evaluateWin(room);
  if (result) {
    finishGame(room, result);
  } else {
    room.phase = "describe";
    room.round += 1;
    prepareSpeakerOrder(room, rng, { firstRound: false });
    addSystemMessage(room, `第 ${room.round} 轮开始。`);
  }
  return { room, resolved: true, eliminatedId: target.id };
}

export function evaluateWin(room) {
  if (room.settings.mode === MODES.CLASSIC) {
    const aliveUndercover = room.players.filter(
      (player) => player.alive && player.role === "undercover"
    ).length;
    const aliveCivilian = room.players.filter(
      (player) => player.alive && player.role === "civilian"
    ).length;

    if (aliveUndercover === 0) {
      return {
        winner: "civilian",
        title: "平民胜利",
        reason: "所有卧底都已出局。"
      };
    }
    if (aliveUndercover >= aliveCivilian) {
      return {
        winner: "undercover",
        title: "卧底胜利",
        reason: "存活卧底数已不少于存活平民数。"
      };
    }
    return null;
  }

  const blank = room.players.find((player) => player.role === "blank");
  if (!blank?.alive) {
    return {
      winner: "civilian",
      title: "平民胜利",
      reason: "白板已出局。"
    };
  }

  const aliveCount = room.players.filter((player) => player.alive).length;
  if (aliveCount <= 2) {
    return {
      winner: "blank",
      title: "白板胜利",
      reason: "白板存活到最后两人。"
    };
  }
  return null;
}

function finishGame(room, result) {
  if (room.settings.mode === MODES.CLASSIC) {
    room.previousUndercoverIds = room.players
      .filter((player) => player.role === "undercover")
      .map((player) => player.id);
  }
  room.status = "finished";
  room.phase = "finished";
  room.currentSpeakerId = null;
  room.result = {
    ...result,
    reveal: {
      civilianWord: room.words?.civilianWord ?? null,
      undercoverWord: room.words?.undercoverWord ?? null,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        word: player.word,
        alive: player.alive
      }))
    }
  };
  addSystemMessage(room, result.reason);
}

export function finishGameByHost(room) {
  finishGame(room, {
    winner: "ended",
    title: "游戏结束",
    reason: "房主结束了游戏。"
  });
  return room;
}

function pickWords(settings, rng) {
  if (settings.mode === MODES.CLASSIC) {
    if (settings.customCivilianWord && settings.customUndercoverWord) {
      return {
        civilianWord: settings.customCivilianWord,
        undercoverWord: settings.customUndercoverWord
      };
    }
    const pair = classicWordPairs[Math.floor(rng() * classicWordPairs.length)];
    return {
      civilianWord: pair[0],
      undercoverWord: pair[1]
    };
  }

  return {
    civilianWord:
      settings.customCivilianWord ||
      blankWords[Math.floor(rng() * blankWords.length)],
    undercoverWord: null
  };
}

function shuffle(items, rng) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function prepareSpeakerOrder(room, rng = Math.random, { firstRound = false } = {}) {
  const alivePlayers = room.players.filter((player) => player.alive);
  let orderedPlayers = shuffle(alivePlayers, rng);

  if (room.settings.mode === MODES.CLASSIC && firstRound) {
    const previousUndercoverCandidates = alivePlayers.filter((player) =>
      room.previousUndercoverIds.includes(player.id)
    );
    if (previousUndercoverCandidates.length) {
      const preferred =
        previousUndercoverCandidates[
          Math.floor(rng() * previousUndercoverCandidates.length)
        ];
      orderedPlayers = [
        preferred,
        ...shuffle(
          alivePlayers.filter((player) => player.id !== preferred.id),
          rng
        )
      ];
    }
  }

  if (room.settings.mode === MODES.BLANK && orderedPlayers[0]?.role === "blank") {
    const civilianIndex = orderedPlayers.findIndex((player) => player.role !== "blank");
    if (civilianIndex > 0) {
      [orderedPlayers[0], orderedPlayers[civilianIndex]] = [
        orderedPlayers[civilianIndex],
        orderedPlayers[0]
      ];
    }
  }

  room.speakerOrder = orderedPlayers.map((player) => player.id);
  room.speakerIndex = room.speakerOrder.length ? 0 : -1;
  room.currentSpeakerId = room.speakerOrder[0] ?? null;
  return room.speakerOrder;
}

function clearVotes(room) {
  for (const player of room.players) {
    player.voteTargetId = null;
  }
}

function voteCounts(room) {
  const counts = {};
  for (const player of room.players) {
    if (player.alive && player.voteTargetId) {
      counts[player.voteTargetId] = (counts[player.voteTargetId] ?? 0) + 1;
    }
  }
  return counts;
}

function requireAlivePlayer(room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) throw new Error("玩家不存在");
  if (!player.alive) throw new Error("出局玩家不能操作");
  return player;
}

function assertPlaying(room) {
  if (room.status !== "playing") throw new Error("游戏未进行中");
}

function requireManageableRoom(room, playerId) {
  if (room.hostId !== playerId) throw new Error("只有房主可以操作");
  if (room.status !== "lobby" && room.status !== "finished") {
    throw new Error("游戏进行中不能管理房间");
  }
}

function requireKickableRoom(room, hostId, targetId) {
  if (room.hostId !== hostId) throw new Error("只有房主可以操作");
  if (targetId === hostId) return;
  if (room.status === "lobby" || room.status === "finished") return;
  if (room.status !== "playing") throw new Error("不能管理房间");

  const target = room.players.find((player) => player.id === targetId);
  if (target?.connected) throw new Error("游戏中只能移除掉线玩家");
}

function addSystemMessage(room, text) {
  room.messages.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: "system",
    text,
    createdAt: Date.now()
  });
  trimMessages(room);
}

function trimMessages(room) {
  if (room.messages.length > 120) {
    room.messages = room.messages.slice(-120);
  }
}
