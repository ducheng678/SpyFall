import { describe, expect, it } from "vitest";
import {
  addPlayer,
  advanceSpeaker,
  canAdvanceSpeaker,
  castVote,
  canStartVote,
  createRoom,
  ensureHost,
  guessWord,
  kickPlayer,
  maxUndercoverCount,
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

function roomWithPlayers(settings, count = settings.playerCount) {
  const room = createRoom({
    code: "ABCDE",
    hostId: "p1",
    hostName: "玩家1",
    sessionToken: "token-p1",
    settings
  });
  for (let index = 2; index <= count; index += 1) {
    addPlayer(room, {
      id: `p${index}`,
      name: `玩家${index}`,
      sessionToken: `token-p${index}`
    });
  }
  return room;
}

describe("game rules", () => {
  it("limits classic undercover count to half minus one", () => {
    expect(maxUndercoverCount(4)).toBe(1);
    expect(maxUndercoverCount(7)).toBe(3);
  });

  it("classic mode hides identity and only sends each player a word", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);

    const privateState = privatePlayerState(room, "p1");
    expect(privateState.roleLabel).toBeNull();
    expect(["牛奶", "豆浆"]).toContain(privateState.word);
  });

  it("uses speaker order to advance through the current round", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);

    expect(room.speakerOrder).toHaveLength(4);
    expect(new Set(room.speakerOrder).size).toBe(4);
    expect(room.currentSpeakerId).toBe(room.speakerOrder[0]);

    advanceSpeaker(room);
    expect(room.currentSpeakerId).toBe(room.speakerOrder[1]);
    advanceSpeaker(room);
    advanceSpeaker(room);
    advanceSpeaker(room);
    expect(room.phase).toBe("discussion");
    expect(room.currentSpeakerId).toBeNull();
  });

  it("lets the current speaker advance once but blocks non-current players", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    room.speakerOrder = ["p1", "p2", "p3", "p4"];
    room.currentSpeakerId = "p2";
    room.speakerIndex = 1;

    expect(canAdvanceSpeaker(room, "p2")).toBe(true);
    expect(canAdvanceSpeaker(room, "p3")).toBe(false);

    advanceSpeaker(room, "p2");

    expect(room.currentSpeakerId).toBe("p3");
    expect(canAdvanceSpeaker(room, "p2")).toBe(false);
    expect(() => advanceSpeaker(room, "p2")).toThrow("你不能切到下一位");
  });

  it("still lets the host advance speaker turns as a fallback", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    room.speakerOrder = ["p1", "p2", "p3", "p4"];
    room.currentSpeakerId = "p2";
    room.speakerIndex = 1;

    expect(canAdvanceSpeaker(room, "p1")).toBe(true);
    advanceSpeaker(room, "p1");
    expect(room.currentSpeakerId).toBe("p3");
  });

  it("classic civilians win when all undercovers are voted out", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const undercover = room.players.find((player) => player.role === "undercover");
    startVote(room);
    for (const player of room.players.filter((item) => item.alive && item.id !== undercover.id)) {
      castVote(room, player.id, undercover.id);
    }
    castVote(room, undercover.id, room.players.find((player) => player.id !== undercover.id).id);

    expect(room.status).toBe("finished");
    expect(room.result.winner).toBe("civilian");
  });

  it("puts a previous classic undercover first in the next game's first round", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const previousUndercover = room.players.find((player) => player.role === "undercover");

    startVote(room);
    for (const player of room.players.filter((item) => item.alive && item.id !== previousUndercover.id)) {
      castVote(room, player.id, previousUndercover.id);
    }
    castVote(room, previousUndercover.id, room.players.find((player) => player.id !== previousUndercover.id).id);
    expect(room.previousUndercoverIds).toEqual([previousUndercover.id]);

    restartGame(room, () => 0);
    expect(room.speakerOrder[0]).toBe(previousUndercover.id);
  });

  it("falls back to normal first speaker when previous undercover left the room", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    room.previousUndercoverIds = ["missing-player"];
    startGame(room, () => 0);

    expect(room.speakerOrder).toHaveLength(4);
    expect(room.speakerOrder[0]).not.toBe("missing-player");
  });

  it("classic undercovers win when they are not fewer than civilians", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 3,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const civilian = room.players.find(
      (player) => player.role === "civilian" && player.id !== room.hostId
    );
    startVote(room);
    for (const player of room.players.filter((item) => item.alive && item.id !== civilian.id)) {
      castVote(room, player.id, civilian.id);
    }
    castVote(room, civilian.id, room.players.find((player) => player.id !== civilian.id).id);

    expect(room.status).toBe("finished");
    expect(room.result.winner).toBe("undercover");
  });

  it("blank sees no word and wins by guessing the word", () => {
    const room = roomWithPlayers({
      mode: "blank",
      playerCount: 3,
      customCivilianWord: "火锅"
    });
    startGame(room, () => 0);
    const blank = room.players.find((player) => player.role === "blank");

    expect(privatePlayerState(room, blank.id).roleLabel).toBe("白板");
    expect(privatePlayerState(room, blank.id).word).toBeNull();

    guessWord(room, blank.id, " 火锅 ");
    expect(room.status).toBe("finished");
    expect(room.result.winner).toBe("blank");
  });

  it("does not put the blank first in speaker order", () => {
    const room = roomWithPlayers({
      mode: "blank",
      playerCount: 3,
      customCivilianWord: "火锅"
    });
    startGame(room, () => 0);
    const blank = room.players.find((player) => player.role === "blank");

    expect(room.speakerOrder[0]).not.toBe(blank.id);
  });

  it("lets any alive player start a vote in blank mode and shows the rush prompt", () => {
    const room = roomWithPlayers({
      mode: "blank",
      playerCount: 3,
      customCivilianWord: "火锅"
    });
    startGame(room, () => 0);
    const blank = room.players.find((player) => player.role === "blank");
    const civilian = room.players.find(
      (player) => player.role === "civilian" && player.id !== room.hostId
    );

    expect(canStartVote(room, blank.id)).toBe(true);
    expect(canStartVote(room, civilian.id)).toBe(true);

    startVote(room, civilian.id);
    expect(room.phase).toBe("voting");
    expect(room.messages.at(-1).text).toBe("有人抢先发起投票！请投票给你认为的白板！");
  });

  it("blocks eliminated players from starting a vote in blank mode", () => {
    const room = roomWithPlayers({
      mode: "blank",
      playerCount: 3,
      customCivilianWord: "火锅"
    });
    startGame(room, () => 0);
    const civilian = room.players.find(
      (player) => player.role === "civilian" && player.id !== room.hostId
    );
    civilian.alive = false;

    expect(canStartVote(room, civilian.id)).toBe(false);
    expect(() => startVote(room, civilian.id)).toThrow("你不能发起投票");
  });

  it("keeps classic vote starts host-only with the normal prompt", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const nonHost = room.players.find((player) => player.id !== room.hostId);

    expect(canStartVote(room, nonHost.id)).toBe(false);
    expect(() => startVote(room, nonHost.id)).toThrow("你不能发起投票");

    startVote(room, room.hostId);
    expect(room.phase).toBe("voting");
    expect(room.messages.at(-1).text).toBe("投票开始。");
  });

  it("lets the classic host start votes after being eliminated", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 5,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const host = room.players.find((player) => player.id === room.hostId);
    expect(host.role).toBe("civilian");

    startVote(room, host.id);
    for (const player of room.players.filter((item) => item.alive && item.id !== host.id)) {
      castVote(room, player.id, host.id);
    }
    castVote(room, host.id, room.players.find((player) => player.id !== host.id).id);

    expect(room.status).toBe("playing");
    expect(host.alive).toBe(false);
    expect(canStartVote(room, host.id)).toBe(true);

    startVote(room, host.id);
    expect(room.phase).toBe("voting");
  });

  it("blank wrong guess immediately gives civilians the win", () => {
    const room = roomWithPlayers({
      mode: "blank",
      playerCount: 4,
      customCivilianWord: "火锅"
    });
    startGame(room, () => 0);
    const blank = room.players.find((player) => player.role === "blank");

    guessWord(room, blank.id, "烧烤");
    expect(room.status).toBe("finished");
    expect(room.result.winner).toBe("civilian");
  });

  it("blank wins when surviving to final two", () => {
    const room = roomWithPlayers({
      mode: "blank",
      playerCount: 3,
      customCivilianWord: "火锅"
    });
    startGame(room, () => 0);
    const blank = room.players.find((player) => player.role === "blank");
    const civilian = room.players.find((player) => player.role === "civilian");
    const otherCivilian = room.players.find(
      (player) => player.role === "civilian" && player.id !== civilian.id
    );

    startVote(room);
    castVote(room, blank.id, civilian.id);
    castVote(room, civilian.id, otherCivilian.id);
    castVote(room, otherCivilian.id, civilian.id);

    expect(room.status).toBe("finished");
    expect(room.result.winner).toBe("blank");
  });

  it("creates a new speaker order after a non-ending vote", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 5,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const firstOrder = [...room.speakerOrder];
    const civilian = room.players.find((player) => player.role === "civilian");

    startVote(room);
    for (const player of room.players.filter((item) => item.alive && item.id !== civilian.id)) {
      castVote(room, player.id, civilian.id, () => 0.99);
    }
    castVote(room, civilian.id, room.players.find((player) => player.id !== civilian.id).id, () => 0);

    expect(room.status).toBe("playing");
    expect(room.round).toBe(2);
    expect(room.speakerOrder).toHaveLength(4);
    expect(room.speakerOrder).not.toEqual(firstOrder.filter((id) => id !== civilian.id));
  });

  it("tie vote eliminates nobody", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const [p1, p2, p3, p4] = room.players;
    startVote(room);
    castVote(room, p1.id, p2.id);
    castVote(room, p2.id, p1.id);
    castVote(room, p3.id, p4.id);
    castVote(room, p4.id, p3.id);

    expect(room.status).toBe("playing");
    expect(room.phase).toBe("discussion");
    expect(room.players.every((player) => player.alive)).toBe(true);
  });

  it("exposes every player's vote after a resolved elimination outside chat", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const [p1, p2, p3, p4] = room.players;

    startVote(room);
    castVote(room, p1.id, p2.id);
    castVote(room, p2.id, p1.id);
    castVote(room, p3.id, p2.id);
    castVote(room, p4.id, p2.id);

    expect(room.messages.some((message) => message.text.startsWith("投票结果："))).toBe(false);
    expect(publicRoomState(room).lastVoteResult).toMatchObject({
      round: 1,
      tied: false,
      eliminatedId: p2.id,
      eliminatedName: "玩家2",
      choices: [
        { voterId: p1.id, voterName: "玩家1", targetId: p2.id, targetName: "玩家2" },
        { voterId: p2.id, voterName: "玩家2", targetId: p1.id, targetName: "玩家1" },
        { voterId: p3.id, voterName: "玩家3", targetId: p2.id, targetName: "玩家2" },
        { voterId: p4.id, voterName: "玩家4", targetId: p2.id, targetName: "玩家2" }
      ]
    });
  });

  it("exposes every player's vote after a tie outside chat", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const [p1, p2, p3, p4] = room.players;

    startVote(room);
    castVote(room, p1.id, p2.id);
    castVote(room, p2.id, p1.id);
    castVote(room, p3.id, p4.id);
    castVote(room, p4.id, p3.id);

    expect(room.messages.some((message) => message.text.startsWith("投票结果："))).toBe(false);
    expect(publicRoomState(room).lastVoteResult).toMatchObject({
      round: 1,
      tied: true,
      eliminatedId: null,
      eliminatedName: null,
      choices: [
        { voterId: p1.id, voterName: "玩家1", targetId: p2.id, targetName: "玩家2" },
        { voterId: p2.id, voterName: "玩家2", targetId: p1.id, targetName: "玩家1" },
        { voterId: p3.id, voterName: "玩家3", targetId: p4.id, targetName: "玩家4" },
        { voterId: p4.id, voterName: "玩家4", targetId: p3.id, targetName: "玩家3" }
      ]
    });
    expect(room.messages.at(-1).text).toBe("投票平票，本轮无人出局。");
  });

  it("only exposes who has voted, not vote counts", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const [p1, p2] = room.players;
    startVote(room);
    castVote(room, p1.id, p2.id);

    const state = publicRoomState(room);
    expect(state).not.toHaveProperty("voteCounts");
    expect(state.players.find((player) => player.id === p1.id).hasVoted).toBe(true);
    expect(state.players.find((player) => player.id === p2.id).hasVoted).toBe(false);
  });

  it("does not let a player change their vote after voting", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    const [p1, p2, p3] = room.players;

    startVote(room);
    castVote(room, p1.id, p2.id);

    expect(() => castVote(room, p1.id, p3.id)).toThrow("你已经投过票");
    expect(p1.voteTargetId).toBe(p2.id);
  });

  it("removes players from a finished room so previous undercover can be absent", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    room.status = "finished";
    removeOrDisconnectPlayer(room, "p2");
    expect(room.players.some((player) => player.id === "p2")).toBe(false);
  });

  it("lets the host kick a non-host player in lobby and finished rooms", () => {
    const lobbyRoom = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1
    });
    const lobbyRemoved = kickPlayer(lobbyRoom, "p1", "p4");
    expect(lobbyRemoved.name).toBe("玩家4");
    expect(lobbyRoom.players.map((player) => player.id)).toEqual(["p1", "p2", "p3"]);
    addPlayer(lobbyRoom, { id: "p4", name: "玩家4", sessionToken: "token-p4" });
    expect(lobbyRoom.players.map((player) => player.id)).toEqual(["p1", "p2", "p3", "p4"]);

    const finishedRoom = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1
    });
    startGame(finishedRoom, () => 0);
    finishedRoom.status = "finished";
    finishedRoom.phase = "finished";
    kickPlayer(finishedRoom, "p1", "p2");
    expect(finishedRoom.players.some((player) => player.id === "p2")).toBe(false);
  });

  it("blocks kicking online players during play, by non-hosts, or against yourself", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1
    });

    expect(() => kickPlayer(room, "p2", "p3")).toThrow("只有房主可以操作");
    expect(() => kickPlayer(room, "p1", "p1")).toThrow("不能移除自己");

    startGame(room, () => 0);
    expect(() => kickPlayer(room, "p1", "p2")).toThrow("游戏中只能移除掉线玩家");
  });

  it("lets the host kick disconnected players during play and resets active votes", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 5,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    room.players.find((player) => player.id === "p3").connected = false;
    startVote(room, "p1");
    castVote(room, "p1", "p2");
    castVote(room, "p2", "p3");

    kickPlayer(room, "p1", "p3");

    expect(room.players.some((player) => player.id === "p3")).toBe(false);
    expect(room.phase).toBe("discussion");
    expect(room.players.every((player) => player.voteTargetId === null)).toBe(true);
  });

  it("continues speaker order after kicking the current speaker", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    for (const player of room.players) player.role = "civilian";
    room.players.find((player) => player.id === "p3").role = "undercover";
    room.speakerOrder = ["p1", "p2", "p3", "p4"];
    room.currentSpeakerId = "p2";
    room.speakerIndex = 1;
    room.players.find((player) => player.id === "p2").connected = false;

    kickPlayer(room, "p1", "p2");

    expect(room.phase).toBe("describe");
    expect(room.currentSpeakerId).toBe("p3");
    expect(room.speakerIndex).toBe(1);
  });

  it("moves to discussion after kicking the last current speaker", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 5,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);
    for (const player of room.players) player.role = "civilian";
    room.players.find((player) => player.id === "p2").role = "undercover";
    room.speakerOrder = ["p1", "p2", "p3", "p4", "p5"];
    room.currentSpeakerId = "p5";
    room.speakerIndex = 4;
    room.players.find((player) => player.id === "p5").connected = false;

    kickPlayer(room, "p1", "p5");

    expect(room.status).toBe("playing");
    expect(room.phase).toBe("discussion");
    expect(room.currentSpeakerId).toBeNull();
  });

  it("lets the host update target player count within room limits", () => {
    const room = roomWithPlayers(
      {
        mode: "classic",
        playerCount: 5,
        undercoverCount: 1
      },
      3
    );

    updatePlayerCount(room, "p1", 3);
    expect(room.settings.playerCount).toBe(3);
  });

  it("rejects player count updates outside allowed bounds", () => {
    const room = roomWithPlayers(
      {
        mode: "classic",
        playerCount: 5,
        undercoverCount: 1
      },
      4
    );

    expect(() => updatePlayerCount(room, "p2", 4)).toThrow("只有房主可以操作");
    expect(() => updatePlayerCount(room, "p1", 3)).toThrow("人数不能少于 4");
    expect(() => updatePlayerCount(room, "p1", 13)).toThrow("人数不能超过 12");
  });

  it("keeps classic undercover count legal after lowering player count", () => {
    const room = roomWithPlayers(
      {
        mode: "classic",
        playerCount: 7,
        undercoverCount: 3
      },
      4
    );

    updatePlayerCount(room, "p1", 4);
    expect(room.settings.playerCount).toBe(4);
    expect(room.settings.undercoverCount).toBe(1);
  });

  it("temporarily transfers host on disconnect and restores primary host on reconnect", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 3,
      undercoverCount: 1
    });

    room.players.find((player) => player.id === "p1").connected = false;
    ensureHost(room);

    expect(room.primaryHostId).toBe("p1");
    expect(room.hostId).toBe("p2");

    addPlayer(room, { id: "p1", name: "玩家1", sessionToken: "token-p1" });

    expect(room.primaryHostId).toBe("p1");
    expect(room.hostId).toBe("p1");
  });

  it("does not restore primary host after the host actively leaves during play", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 4,
      undercoverCount: 1,
      customCivilianWord: "牛奶",
      customUndercoverWord: "豆浆"
    });
    startGame(room, () => 0);

    removeOrDisconnectPlayer(room, "p1");
    expect(room.players.find((player) => player.id === "p1").connected).toBe(false);
    expect(room.primaryHostId).toBe("p2");
    expect(room.hostId).toBe("p2");

    addPlayer(room, { id: "p1", name: "玩家1", sessionToken: "token-p1" });
    expect(room.players.find((player) => player.id === "p1").connected).toBe(true);
    expect(room.primaryHostId).toBe("p2");
    expect(room.hostId).toBe("p2");
  });

  it("lets a temporary host kick the disconnected primary host without blocking rejoin", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 3,
      undercoverCount: 1
    });

    room.players.find((player) => player.id === "p1").connected = false;
    ensureHost(room);
    expect(room.hostId).toBe("p2");

    kickPlayer(room, "p2", "p1");

    expect(room.primaryHostId).toBe("p2");
    expect(room.hostId).toBe("p2");
    expect(room.players.some((player) => player.id === "p1")).toBe(false);

    addPlayer(room, { id: "p1", name: "玩家1", sessionToken: "token-p1" });

    expect(room.players.some((player) => player.id === "p1")).toBe(true);
    expect(room.primaryHostId).toBe("p2");
    expect(room.hostId).toBe("p2");
  });

  it("blocks rejoin after a player is blacklisted", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 3,
      undercoverCount: 1
    });

    kickPlayer(room, "p1", "p3", { blacklist: true });

    expect(room.blockedPlayerIds).toEqual(["p3"]);
    expect(() =>
      addPlayer(room, { id: "p3", name: "玩家3", sessionToken: "token-p3" })
    ).toThrow("你已被房主拉黑");
  });

  it("requires the private session token to rejoin an existing player", () => {
    const room = roomWithPlayers({
      mode: "classic",
      playerCount: 3,
      undercoverCount: 1
    });
    room.players.find((player) => player.id === "p1").connected = false;
    ensureHost(room);

    expect(() =>
      addPlayer(room, { id: "p1", name: "冒充者", sessionToken: "wrong-token" })
    ).toThrow("玩家身份验证失败");
    expect(room.hostId).toBe("p2");

    addPlayer(room, { id: "p1", name: "玩家1", sessionToken: "token-p1" });
    expect(room.hostId).toBe("p1");
  });
});

describe("room codes", () => {
  it("normalizes room code input to four digits", () => {
    expect(normalizeRoomCodeInput("12 a34 56")).toBe("1234");
  });

  it("accepts exactly four digit custom room codes", () => {
    expect(requireValidRoomCode("0000")).toBe("0000");
    expect(requireValidRoomCode("1234")).toBe("1234");
    expect(() => requireValidRoomCode("123")).toThrow("房间码必须是 4 位数字");
    expect(() => requireValidRoomCode("12345")).toThrow("房间码必须是 4 位数字");
    expect(() => requireValidRoomCode("abcd")).toThrow("房间码必须是 4 位数字");
  });

  it("generates unused four digit numeric room codes", () => {
    const existing = new Set(["0000"]);
    const values = [0, 0.0001];
    expect(createNumericRoomCode(existing, () => values.shift() ?? 0.0001)).toBe("0001");
  });
});
