export type GameMode = "classic" | "blank";
export type GameStatus = "lobby" | "playing" | "finished";
export type GamePhase = "lobby" | "describe" | "discussion" | "voting" | "finished";

export interface PlayerState {
  id: string;
  name: string;
  connected: boolean;
  alive: boolean;
  host: boolean;
  hasVoted: boolean;
}

export interface ChatMessage {
  id: string;
  type: "system" | "player";
  playerId?: string;
  name?: string;
  text: string;
  createdAt: number;
}

export interface GameResult {
  winner: "civilian" | "undercover" | "blank" | "ended";
  title: string;
  reason: string;
  reveal?: {
    civilianWord: string | null;
    undercoverWord: string | null;
    players: Array<{
      id: string;
      name: string;
      role: "civilian" | "undercover" | "blank" | null;
      word: string | null;
      alive: boolean;
    }>;
  };
}

export interface VoteResult {
  id: string;
  round: number;
  createdAt: number;
  tied: boolean;
  eliminatedId: string | null;
  eliminatedName: string | null;
  choices: Array<{
    voterId: string;
    voterName: string;
    targetId: string | null;
    targetName: string;
  }>;
}

export interface RoomState {
  code: string;
  hostId: string;
  status: GameStatus;
  phase: GamePhase;
  round: number;
  mode: GameMode;
  settings: {
    playerCount: number;
    undercoverCount: number;
  };
  players: PlayerState[];
  currentSpeakerId: string | null;
  speakerOrder: string[];
  messages: ChatMessage[];
  lastVoteResult?: VoteResult | null;
  result: GameResult | null;
}

export interface PrivateState {
  playerId: string;
  host: boolean;
  mode: GameMode;
  alive: boolean;
  word: string | null;
  roleLabel: string | null;
  canGuess: boolean;
  canAdvanceSpeaker: boolean;
  canStartVote: boolean;
  hint?: string;
}

export interface Ack {
  ok: boolean;
  code?: string;
  playerId?: string;
  sessionToken?: string;
  error?: string;
}
