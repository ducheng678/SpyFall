import {
  CheckCircle2,
  Copy,
  Crown,
  DoorOpen,
  Eye,
  MessageCircle,
  Play,
  RefreshCw,
  Send,
  Settings,
  Swords,
  UserPlus,
  UserMinus,
  Vote,
  XCircle
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import type { Ack, GameMode, PrivateState, RoomState } from "./types";

const PLAYER_NAME_KEY = "undercover.playerName";
const LAST_ROOM_KEY = "undercover.lastRoom";
const ROOM_SESSIONS_KEY = "undercover.roomSessions";

interface StoredRoomSession {
  playerId: string;
  sessionToken: string;
}

function readRoomSessions(): Record<string, StoredRoomSession> {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROOM_SESSIONS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getRoomSession(code: string) {
  return readRoomSessions()[code] || null;
}

function saveRoomSession(code: string, session: StoredRoomSession) {
  localStorage.setItem(
    ROOM_SESSIONS_KEY,
    JSON.stringify({ ...readRoomSessions(), [code]: session })
  );
}

function removeRoomSession(code: string) {
  const sessions = readRoomSessions();
  delete sessions[code];
  localStorage.setItem(ROOM_SESSIONS_KEY, JSON.stringify(sessions));
}

function roomCodeFromUrl() {
  return onlyRoomCodeDigits(new URLSearchParams(window.location.search).get("room") || "");
}

function preferredRoomCode(currentRoom: RoomState | null) {
  return roomCodeFromUrl() || currentRoom?.code || localStorage.getItem(LAST_ROOM_KEY) || "";
}

function maxUndercoverCount(playerCount: number) {
  return Math.max(1, Math.floor((playerCount - 1) / 2));
}

function phaseLabel(phase: RoomState["phase"]) {
  return {
    lobby: "等待开始",
    describe: "轮流描述",
    discussion: "自由讨论",
    voting: "投票中",
    finished: "已结束"
  }[phase];
}

function roleName(role: string | null) {
  const labels: Record<string, string> = {
    civilian: "平民",
    undercover: "卧底",
    blank: "白板"
  };
  return labels[role ?? ""] ?? "未知";
}

function onlyRoomCodeDigits(value: string) {
  return value.replace(/\D/g, "").slice(0, 4);
}

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const roomRef = useRef<RoomState | null>(null);
  const sessionRef = useRef<StoredRoomSession | null>(null);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [privateState, setPrivateState] = useState<PrivateState | null>(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    const socket = io({
      transports: ["websocket", "polling"]
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnected(true);
      const currentRoom = roomRef.current;
      const code = preferredRoomCode(currentRoom);
      if (!code) return;

      const session = getRoomSession(code);
      if (!session) {
        if (currentRoom) {
          roomRef.current = null;
          sessionRef.current = null;
          setRoom(null);
          setPrivateState(null);
        }
        return;
      }
      sessionRef.current = session;

      socket.emit(
        "joinRoom",
        { code, playerId: session.playerId, sessionToken: session.sessionToken },
        (ack: Ack) => {
          if (ack?.ok) {
            rememberSession(ack);
            return;
          }
          roomRef.current = null;
          sessionRef.current = null;
          setRoom(null);
          setPrivateState(null);
          removeRoomSession(code);
          localStorage.removeItem(LAST_ROOM_KEY);
          window.history.replaceState(null, "", window.location.pathname);
          setToast(ack?.error || "重新加入房间失败");
        }
      );
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("roomState", (state: RoomState) => {
      roomRef.current = state;
      setRoom(state);
      localStorage.setItem(LAST_ROOM_KEY, state.code);
      window.history.replaceState(null, "", `?room=${state.code}`);
    });
    socket.on("privateState", (state: PrivateState) => setPrivateState(state));
    socket.on("errorMessage", (message: string) => setToast(message));
    socket.on("kicked", ({ reason }: { reason?: string }) => {
      const code = roomRef.current?.code || localStorage.getItem(LAST_ROOM_KEY);
      if (code) removeRoomSession(code);
      roomRef.current = null;
      sessionRef.current = null;
      setRoom(null);
      setPrivateState(null);
      localStorage.removeItem(LAST_ROOM_KEY);
      window.history.replaceState(null, "", window.location.pathname);
      setToast(reason || "你已被移出房间");
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const emitAck = (event: string, payload: unknown = {}) =>
    new Promise<Ack>((resolve) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        resolve({ ok: false, error: "连接尚未建立" });
        return;
      }
      socket.emit(event, payload, (ack: Ack) => resolve(ack));
    });

  const run = async (event: string, payload: unknown = {}) => {
    const ack = await emitAck(event, payload);
    if (ack.ok) rememberSession(ack);
    if (!ack.ok) setToast(ack.error || "操作失败");
    return ack;
  };

  const rememberSession = (ack: Ack) => {
    if (!ack.code || !ack.playerId || !ack.sessionToken) return;
    const session = { playerId: ack.playerId, sessionToken: ack.sessionToken };
    saveRoomSession(ack.code, session);
    sessionRef.current = session;
  };

  const leaveRoom = async () => {
    const code = roomRef.current?.code;
    await run("leaveRoom");
    if (code) removeRoomSession(code);
    roomRef.current = null;
    sessionRef.current = null;
    setRoom(null);
    setPrivateState(null);
    localStorage.removeItem(LAST_ROOM_KEY);
    window.history.replaceState(null, "", window.location.pathname);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">实时房间</p>
          <h1>谁是卧底</h1>
        </div>
        <div className={`connection ${connected ? "online" : "offline"}`}>
          <span />
          {connected ? "已连接" : "连接中"}
        </div>
      </header>

      {!room ? (
        <EntryView run={run} setToast={setToast} />
      ) : (
        <GameView
          room={room}
          privateState={privateState}
          run={run}
          leaveRoom={leaveRoom}
          setToast={setToast}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

interface EntryViewProps {
  run: (event: string, payload?: unknown) => Promise<Ack>;
  setToast: (message: string) => void;
}

function EntryView({ run, setToast }: EntryViewProps) {
  const roomFromUrl = roomCodeFromUrl() || localStorage.getItem(LAST_ROOM_KEY) || "";
  const [name, setName] = useState(localStorage.getItem(PLAYER_NAME_KEY) || "");
  const [joinCode, setJoinCode] = useState(roomFromUrl);
  const [customRoomCode, setCustomRoomCode] = useState("");
  const [mode, setMode] = useState<GameMode>("classic");
  const [playerCount, setPlayerCount] = useState(6);
  const [undercoverCount, setUndercoverCount] = useState(1);
  const [civilianWord, setCivilianWord] = useState("");
  const [undercoverWord, setUndercoverWord] = useState("");

  useEffect(() => {
    setUndercoverCount((value) => Math.min(value, maxUndercoverCount(playerCount)));
  }, [playerCount]);

  const rememberName = () => {
    localStorage.setItem(PLAYER_NAME_KEY, name.trim());
  };

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    rememberName();
    const ack = await run("createRoom", {
      name,
      code: customRoomCode,
      settings: {
        mode,
        playerCount,
        undercoverCount,
        customCivilianWord: civilianWord,
        customUndercoverWord: undercoverWord
      }
    });
    if (ack.ok && ack.code) setToast(`房间 ${ack.code} 已创建`);
  };

  const joinRoom = async (event: FormEvent) => {
    event.preventDefault();
    rememberName();
    const session = getRoomSession(joinCode);
    await run("joinRoom", {
      ...(session ? { playerId: session.playerId, sessionToken: session.sessionToken } : {}),
      name,
      code: joinCode
    });
  };

  return (
    <main className="entry-grid">
      <section className="entry-panel create-panel">
        <div className="panel-heading">
          <Settings size={20} />
          <h2>创建房间</h2>
        </div>
        <form onSubmit={createRoom} className="stack">
          <label>
            昵称
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={16} />
          </label>

          <label>
            自定义房间码
            <input
              value={customRoomCode}
              onChange={(event) => setCustomRoomCode(onlyRoomCodeDigits(event.target.value))}
              inputMode="numeric"
              maxLength={4}
              placeholder="4 位数字，可留空"
            />
          </label>

          <div className="segmented">
            <button
              type="button"
              className={mode === "classic" ? "active" : ""}
              onClick={() => setMode("classic")}
            >
              经典
            </button>
            <button
              type="button"
              className={mode === "blank" ? "active" : ""}
              onClick={() => setMode("blank")}
            >
              白板
            </button>
          </div>

          <div className="form-row">
            <label>
              玩家数
              <input
                type="number"
                min={3}
                max={12}
                value={playerCount}
                onChange={(event) => setPlayerCount(Number(event.target.value))}
              />
            </label>
            {mode === "classic" ? (
              <label>
                卧底数
                <input
                  type="number"
                  min={1}
                  max={maxUndercoverCount(playerCount)}
                  value={undercoverCount}
                  onChange={(event) => setUndercoverCount(Number(event.target.value))}
                />
              </label>
            ) : (
              <label>
                白板数
                <input value="1" disabled />
              </label>
            )}
          </div>

          <div className="form-row">
            <label>
              平民词
              <input
                value={civilianWord}
                onChange={(event) => setCivilianWord(event.target.value)}
                maxLength={20}
                placeholder="可留空"
              />
            </label>
            {mode === "classic" && (
              <label>
                卧底词
                <input
                  value={undercoverWord}
                  onChange={(event) => setUndercoverWord(event.target.value)}
                  maxLength={20}
                  placeholder="可留空"
                />
              </label>
            )}
          </div>

          <button className="primary-action" type="submit">
            <Play size={18} />
            创建
          </button>
        </form>
      </section>

      <section className="entry-panel join-panel">
        <div className="panel-heading">
          <UserPlus size={20} />
          <h2>加入房间</h2>
        </div>
        <form onSubmit={joinRoom} className="stack">
          <label>
            昵称
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={16} />
          </label>
          <label>
            房间码
            <input
              value={joinCode}
              onChange={(event) => setJoinCode(onlyRoomCodeDigits(event.target.value))}
              inputMode="numeric"
              maxLength={4}
            />
          </label>
          <button className="secondary-action" type="submit">
            <DoorOpen size={18} />
            加入
          </button>
        </form>
      </section>
    </main>
  );
}

interface GameViewProps {
  room: RoomState;
  privateState: PrivateState | null;
  run: (event: string, payload?: unknown) => Promise<Ack>;
  leaveRoom: () => void;
  setToast: (message: string) => void;
}

function GameView({ room, privateState, run, leaveRoom, setToast }: GameViewProps) {
  const [message, setMessage] = useState("");
  const [guess, setGuess] = useState("");
  const [resultOpen, setResultOpen] = useState(true);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const me = room.players.find((player) => player.id === privateState?.playerId);
  const isHost = Boolean(privateState?.host);
  const alivePlayers = room.players.filter((player) => player.alive);
  const currentSpeaker = room.players.find((player) => player.id === room.currentSpeakerId);
  const orderedPlayers = room.speakerOrder
    .map((id) => room.players.find((player) => player.id === id))
    .filter((player): player is RoomState["players"][number] => Boolean(player));

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [room.messages.length]);

  useEffect(() => {
    setResultOpen(true);
  }, [room.result?.title, room.result?.reason]);

  const shareUrl = useMemo(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("room", room.code);
    return url.toString();
  }, [room.code]);

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setToast("已复制房间链接");
    } catch {
      setToast(shareUrl);
    }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    const ack = await run("sendMessage", { text: message });
    if (ack.ok) setMessage("");
  };

  const submitGuess = async (event: FormEvent) => {
    event.preventDefault();
    if (!guess.trim()) return;
    const ack = await run("guessWord", { guess });
    if (ack.ok) setGuess("");
  };

  return (
    <main className="game-layout">
      <section className="game-stage">
        <div className="room-strip">
          <div>
            <span className="room-code">{room.code}</span>
            <span className="mode-pill">{room.mode === "classic" ? "经典模式" : "白板模式"}</span>
          </div>
          <button className="icon-button" onClick={copyShare} aria-label="复制房间链接">
            <Copy size={18} />
          </button>
        </div>

        <div className="status-band">
          <div>
            <p>阶段</p>
            <strong>{phaseLabel(room.phase)}</strong>
          </div>
          <div>
            <p>轮次</p>
            <strong>{room.round || "-"}</strong>
          </div>
          <div>
            <p>当前</p>
            <strong>{currentSpeaker?.name || "无"}</strong>
          </div>
        </div>

        <WordPanel room={room} privateState={privateState} />

        <SpeakerOrder players={orderedPlayers} currentSpeakerId={room.currentSpeakerId} />

        <section className="players-grid" aria-label="玩家列表">
          {room.players.map((player) => (
            <PlayerTile
              key={player.id}
              player={player}
              selected={player.id === me?.id}
              speaking={player.id === room.currentSpeakerId}
              showVoted={room.phase === "voting" && player.hasVoted}
              onVote={() => run("castVote", { targetId: player.id })}
              canVote={
                room.phase === "voting" &&
                Boolean(me?.alive) &&
                player.alive &&
                player.id !== me?.id
              }
            />
          ))}
        </section>
      </section>

      <aside className="side-panel">
        <HostControls
          room={room}
          isHost={isHost}
          canStartVote={Boolean(privateState?.canStartVote)}
          liveCount={alivePlayers.length}
          run={run}
          leaveRoom={leaveRoom}
        />

        {privateState?.canGuess && room.status === "playing" && (
          <form className="guess-panel" onSubmit={submitGuess}>
            <label>
              白板猜词
              <input
                value={guess}
                onChange={(event) => setGuess(event.target.value)}
                maxLength={20}
                placeholder="输入平民词"
              />
            </label>
            <button type="submit" className="danger-action">
              <Eye size={18} />
              猜词
            </button>
          </form>
        )}

        <section className="chat-panel">
          <div className="panel-heading compact">
            <MessageCircle size={18} />
            <h2>聊天</h2>
          </div>
          <div className="messages" ref={messagesRef}>
            {room.messages.map((item) => (
              <div key={item.id} className={`message ${item.type}`}>
                {item.type === "player" && <strong>{item.name}</strong>}
                <span>{item.text}</span>
              </div>
            ))}
          </div>
          <form className="message-form" onSubmit={sendMessage}>
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={240}
              placeholder="输入消息"
            />
            <button type="submit" aria-label="发送">
              <Send size={18} />
            </button>
          </form>
        </section>
      </aside>

      {room.result && resultOpen && (
        <ResultOverlay result={room.result} onClose={() => setResultOpen(false)} />
      )}
    </main>
  );
}

function WordPanel({ room, privateState }: { room: RoomState; privateState: PrivateState | null }) {
  return (
    <section className="word-panel">
      <div>
        <p>{room.status === "lobby" ? "等待开始" : privateState?.hint || "你的信息"}</p>
        <strong>
          {room.status === "lobby"
            ? `${room.players.length}/${room.settings.playerCount}`
            : privateState?.word || privateState?.roleLabel || "无词"}
        </strong>
      </div>
      <div className="rule-note">
        {room.mode === "classic"
          ? "经典模式只显示你的词，不显示身份。"
          : "白板可随时猜词，猜错平民胜。"}
      </div>
    </section>
  );
}

function SpeakerOrder({
  players,
  currentSpeakerId
}: {
  players: RoomState["players"];
  currentSpeakerId: string | null;
}) {
  if (!players.length) return null;
  return (
    <section className="speaker-order" aria-label="本轮发言顺序">
      <p>本轮顺序</p>
      <div>
        {players.map((player, index) => (
          <span
            key={player.id}
            className={player.id === currentSpeakerId ? "active" : ""}
          >
            {index + 1}. {player.name}
          </span>
        ))}
      </div>
    </section>
  );
}

function PlayerTile({
  player,
  selected,
  speaking,
  showVoted,
  canVote,
  onVote
}: {
  player: RoomState["players"][number];
  selected: boolean;
  speaking: boolean;
  showVoted: boolean;
  canVote: boolean;
  onVote: () => void;
}) {
  return (
    <article
      className={`player-tile ${selected ? "me" : ""} ${speaking ? "speaking" : ""} ${
        !player.alive ? "out" : ""
      }`}
    >
      <div className="avatar">{player.name.slice(0, 1)}</div>
      <div>
        <h3>
          {player.name}
          {player.host && <Crown size={14} />}
        </h3>
        <p>{player.alive ? (player.connected ? "在线" : "离线") : "出局"}</p>
      </div>
      {showVoted && <span className="voted-badge">已投</span>}
      {canVote && (
        <button className="vote-button" onClick={onVote}>
          <Vote size={16} />
          投票
        </button>
      )}
    </article>
  );
}

function HostControls({
  room,
  isHost,
  canStartVote,
  liveCount,
  run,
  leaveRoom
}: {
  room: RoomState;
  isHost: boolean;
  canStartVote: boolean;
  liveCount: number;
  run: (event: string, payload?: unknown) => Promise<Ack>;
  leaveRoom: () => void;
}) {
  return (
    <section className="host-panel">
      <div className="panel-heading compact">
        <Swords size={18} />
        <h2>操作</h2>
      </div>
      <div className="control-grid">
        {room.status === "lobby" && (
          <button
            disabled={!isHost || room.players.length !== room.settings.playerCount}
            onClick={() => run("startGame")}
          >
            <Play size={17} />
            开始
          </button>
        )}
        {room.status === "playing" && (
          <>
            <button disabled={!isHost} onClick={() => run("advanceSpeaker")}>
              <CheckCircle2 size={17} />
              下一位
            </button>
            <button disabled={!canStartVote || room.phase === "voting"} onClick={() => run("startVote")}>
              <Vote size={17} />
              投票
            </button>
            <button disabled={!isHost} onClick={() => run("endGame")}>
              <XCircle size={17} />
              结束
            </button>
          </>
        )}
        {room.status === "finished" && (
          <button disabled={!isHost || room.players.length !== room.settings.playerCount} onClick={() => run("restartGame")}>
            <RefreshCw size={17} />
            重开
          </button>
        )}
        <button onClick={leaveRoom}>
          <DoorOpen size={17} />
          退出
        </button>
      </div>
      {isHost &&
        (room.status === "lobby" ||
          room.status === "finished" ||
          room.players.some((player) => !player.host && !player.connected)) && (
        <RoomManagement room={room} run={run} />
      )}
      <p className="small-line">存活 {liveCount} 人</p>
    </section>
  );
}

function RoomManagement({
  room,
  run
}: {
  room: RoomState;
  run: (event: string, payload?: unknown) => Promise<Ack>;
}) {
  const canEditCount = room.status === "lobby" || room.status === "finished";
  const minPlayerCount = Math.max(3, room.players.length);
  const [targetCount, setTargetCount] = useState(room.settings.playerCount);

  useEffect(() => {
    setTargetCount(room.settings.playerCount);
  }, [room.settings.playerCount]);

  const countInvalid = targetCount < minPlayerCount || targetCount > 12;
  const removablePlayers = room.players.filter(
    (player) => !player.host && (canEditCount || !player.connected)
  );

  return (
    <div className="room-management">
      <div className="management-title">
        <Settings size={16} />
        <h3>房间管理</h3>
      </div>

      {canEditCount ? (
        <>
          <div className="count-editor">
            <label>
              目标人数
              <input
                type="number"
                min={minPlayerCount}
                max={12}
                value={targetCount}
                onChange={(event) => setTargetCount(Number(event.target.value))}
              />
            </label>
            <button
              disabled={countInvalid || targetCount === room.settings.playerCount}
              onClick={() => run("updatePlayerCount", { playerCount: targetCount })}
            >
              <CheckCircle2 size={16} />
              更新
            </button>
          </div>

          <p className="small-line">
            当前 {room.players.length} 人，目标 {room.settings.playerCount} 人
          </p>
        </>
      ) : (
        <p className="small-line">游戏中只能移除掉线玩家</p>
      )}

      <div className="managed-players">
        {removablePlayers.map((player) => (
          <div key={player.id} className="managed-player">
            <div>
              <strong>{player.name}</strong>
              <span>{player.connected ? "在线" : "离线"}</span>
            </div>
            <button onClick={() => run("kickPlayer", { targetId: player.id })}>
              <UserMinus size={15} />
              移除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultOverlay({
  result,
  onClose
}: {
  result: NonNullable<RoomState["result"]>;
  onClose: () => void;
}) {
  return (
    <div className="result-overlay">
      <section className="result-panel">
        <h2>{result.title}</h2>
        <p>{result.reason}</p>
        {result.reveal && (
          <>
            <div className="reveal-words">
              <span>平民词：{result.reveal.civilianWord || "-"}</span>
              {result.reveal.undercoverWord && <span>卧底词：{result.reveal.undercoverWord}</span>}
            </div>
            <div className="reveal-list">
              {result.reveal.players.map((player) => (
                <div key={player.id}>
                  <strong>{player.name}</strong>
                  <span>{roleName(player.role)}</span>
                  <span>{player.word || "无词"}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <button className="secondary-action result-close" onClick={onClose}>
          <CheckCircle2 size={18} />
          返回房间
        </button>
      </section>
    </div>
  );
}
