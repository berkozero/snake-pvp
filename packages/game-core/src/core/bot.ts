import { directionVectors, oppositeDirection } from '../constants';
import type { Cell, Direction, PlayerId } from '../types';
import type { SimulatorSnapshot } from './simulator';

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

function move(cell: Cell, direction: Direction): Cell {
  const vector = directionVectors[direction];
  return { x: cell.x + vector.x, y: cell.y + vector.y };
}

function isInside(board: SimulatorSnapshot['board'], cell: Cell): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < board.width && cell.y < board.height;
}

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function chooseHeuristicDirection(snapshot: SimulatorSnapshot, playerId: PlayerId): Direction {
  const player = snapshot.players[playerId];
  const opponentId: PlayerId = playerId === 'p1' ? 'p2' : 'p1';
  const opponent = snapshot.players[opponentId];

  if (!player.alive || !player.head) {
    return player.direction;
  }

  const safeMoves = DIRECTIONS.filter((direction) => {
    if (oppositeDirection[player.direction] === direction) {
      return false;
    }

    const head = move(player.head!, direction);
    const willEatFood = head.x === snapshot.food.x && head.y === snapshot.food.y;
    const occupied = new Set<string>();
    for (const id of [playerId, opponentId] as PlayerId[]) {
      const segments = snapshot.players[id].segments;
      const tailIndex = segments.length - 1;
      segments.forEach((segment, index) => {
        const isOwnVacatingTail = id === playerId && index === tailIndex && !willEatFood;
        if (!isOwnVacatingTail) {
          occupied.add(cellKey(segment));
        }
      });
    }

    if (!isInside(snapshot.board, head) || occupied.has(cellKey(head))) {
      return false;
    }

    if (opponent.alive && opponent.head) {
      const opponentThreats = DIRECTIONS
        .filter((candidate) => oppositeDirection[opponent.direction] !== candidate)
        .map((candidate) => move(opponent.head!, candidate));

      const losingHeadOn = opponentThreats.some(
        (threat) => threat.x === head.x && threat.y === head.y && opponent.length >= player.length,
      );
      if (losingHeadOn) {
        return false;
      }
    }

    return true;
  });

  if (safeMoves.length === 0) {
    return player.direction;
  }

  safeMoves.sort((a, b) => {
    const nextA = move(player.head!, a);
    const nextB = move(player.head!, b);
    const scoreA = manhattan(nextA, snapshot.food);
    const scoreB = manhattan(nextB, snapshot.food);
    return scoreA - scoreB;
  });

  return safeMoves[0];
}
