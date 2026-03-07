import type { PlayerId } from './game/types';

export type PlayerRenderColors = {
  fill: string;
  glow: string;
  text: string;
};

export type LobbySlotColors = {
  text: string;
  status: string;
};

const OWN_COLORS: PlayerRenderColors = {
  fill: '#7cff7a',
  glow: 'rgba(124, 255, 122, 0.24)',
  text: '#7cff7a',
};

const OPPONENT_COLORS: PlayerRenderColors = {
  fill: '#9a9aa3',
  glow: 'rgba(154, 154, 163, 0.22)',
  text: '#b7b7c0',
};

const LOBBY_NEUTRAL: LobbySlotColors = {
  text: '#f2f2f5',
  status: '#f2f2f5',
};

export function getMatchPlayerColors(playerId: PlayerId, yourSlot: PlayerId | null): PlayerRenderColors {
  if (!yourSlot) {
    return OPPONENT_COLORS;
  }

  return playerId === yourSlot ? OWN_COLORS : OPPONENT_COLORS;
}

export function getLobbySlotColors(playerId: PlayerId, yourSlot: PlayerId | null): LobbySlotColors {
  if (!yourSlot) {
    return LOBBY_NEUTRAL;
  }

  if (playerId === yourSlot) {
    return {
      text: OWN_COLORS.text,
      status: OWN_COLORS.text,
    };
  }

  return LOBBY_NEUTRAL;
}
