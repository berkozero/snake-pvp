import { describe, expect, it } from 'vitest';
import { getLobbySlotColors, getMatchPlayerColors } from './playerColors';

describe('playerColors', () => {
  it('renders lobby slots as neutral before a player claims a side', () => {
    expect(getLobbySlotColors('p1', null)).toEqual({
      text: '#f2f2f5',
      status: '#f2f2f5',
    });
    expect(getLobbySlotColors('p2', null)).toEqual({
      text: '#f2f2f5',
      status: '#f2f2f5',
    });
  });

  it('renders only the local lobby slot as green', () => {
    expect(getLobbySlotColors('p1', 'p1')).toEqual({
      text: '#7cff7a',
      status: '#7cff7a',
    });
    expect(getLobbySlotColors('p2', 'p1')).toEqual({
      text: '#f2f2f5',
      status: '#f2f2f5',
    });
  });

  it('renders the local match snake green and the opponent gray', () => {
    expect(getMatchPlayerColors('p1', 'p1')).toEqual({
      fill: '#7cff7a',
      glow: 'rgba(124, 255, 122, 0.24)',
      text: '#7cff7a',
    });
    expect(getMatchPlayerColors('p2', 'p1')).toEqual({
      fill: '#9a9aa3',
      glow: 'rgba(154, 154, 163, 0.22)',
      text: '#b7b7c0',
    });
  });

  it('renders both match snakes gray for viewers', () => {
    expect(getMatchPlayerColors('p1', null)).toEqual({
      fill: '#9a9aa3',
      glow: 'rgba(154, 154, 163, 0.22)',
      text: '#b7b7c0',
    });
    expect(getMatchPlayerColors('p2', null)).toEqual({
      fill: '#9a9aa3',
      glow: 'rgba(154, 154, 163, 0.22)',
      text: '#b7b7c0',
    });
  });
});
