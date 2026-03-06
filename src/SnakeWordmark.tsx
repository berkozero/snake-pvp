import { useId } from 'react';

type SnakeWordmarkProps = {
  className?: string;
};

const CELL_W = 34;
const CELL_H = 36;
const GAP = 2;
const STEP_X = CELL_W + GAP;
const STEP_Y = CELL_H + GAP;
const ORIGIN_Y = 24;

const EXTRUDE_DX = 10;
const EXTRUDE_DY = 12;
const EXTRUDE_STEPS = 6;
const EXTRUDE_COLOR = '#38383f';

const FACE_COLOR = '#b8b8be';
const BEVEL_SIZE = 3;
const HIGHLIGHT_COLOR = 'rgba(255,255,255,0.25)';
const SHADOW_EDGE_COLOR = 'rgba(0,0,0,0.22)';

type BlockDef = [number, number];

const LETTER_DEFS: { key: string; x: number; blocks: BlockDef[] }[] = [
  {
    key: 's',
    x: 24,
    blocks: [
      [0, 0], [1, 0], [2, 0], [3, 0],
      [0, 1],
      [0, 2], [1, 2], [2, 2], [3, 2],
      [3, 3],
      [0, 4], [1, 4], [2, 4], [3, 4],
    ],
  },
  {
    key: 'n',
    x: 180,
    blocks: [
      [0, 0], [3, 0],
      [0, 1], [1, 1], [3, 1],
      [0, 2], [1, 2], [2, 2], [3, 2],
      [0, 3], [2, 3], [3, 3],
      [0, 4], [3, 4],
    ],
  },
  {
    key: 'a',
    x: 336,
    blocks: [
      [0, 0], [1, 0], [2, 0], [3, 0],
      [0, 1], [3, 1],
      [0, 2], [1, 2], [2, 2], [3, 2],
      [0, 3], [3, 3],
      [0, 4], [3, 4],
    ],
  },
  {
    key: 'k',
    x: 492,
    blocks: [
      [0, 0], [2, 0], [3, 0],
      [0, 1], [1, 1], [2, 1],
      [0, 2], [1, 2],
      [0, 3], [1, 3], [2, 3],
      [0, 4], [2, 4], [3, 4],
    ],
  },
  {
    key: 'e',
    x: 648,
    blocks: [
      [0, 0], [1, 0], [2, 0], [3, 0],
      [0, 1],
      [0, 2], [1, 2], [2, 2],
      [0, 3],
      [0, 4], [1, 4], [2, 4], [3, 4],
    ],
  },
];

function blockX(letterX: number, col: number) {
  return letterX + col * STEP_X;
}

function blockY(row: number) {
  return ORIGIN_Y + row * STEP_Y;
}

export default function SnakeWordmark({ className }: SnakeWordmarkProps) {
  const id = useId().replace(/:/g, '');
  const gradId = `snake-face-${id}`;

  return (
    <svg
      className={className}
      viewBox="14 14 790 220"
      role="img"
      aria-label="Snake"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#d0d0d6" />
          <stop offset="100%" stopColor="#a0a0a8" />
        </linearGradient>
      </defs>

      {Array.from({ length: EXTRUDE_STEPS }, (_, step) => {
        const t = (EXTRUDE_STEPS - step) / EXTRUDE_STEPS;
        const dx = Math.round(EXTRUDE_DX * t);
        const dy = Math.round(EXTRUDE_DY * t);
        return (
          <g key={`ext-${step}`} transform={`translate(${dx} ${dy})`}>
            {LETTER_DEFS.map((letter) =>
              letter.blocks.map(([col, row], i) => (
                <rect
                  key={`${letter.key}-${i}`}
                  x={blockX(letter.x, col)}
                  y={blockY(row)}
                  width={CELL_W}
                  height={CELL_H}
                  fill={EXTRUDE_COLOR}
                />
              )),
            )}
          </g>
        );
      })}

      {LETTER_DEFS.map((letter) =>
        letter.blocks.map(([col, row], i) => {
          const x = blockX(letter.x, col);
          const y = blockY(row);
          return (
            <g key={`${letter.key}-face-${i}`}>
              <rect x={x} y={y} width={CELL_W} height={CELL_H} fill={`url(#${gradId})`} />
              <rect x={x} y={y} width={CELL_W} height={BEVEL_SIZE} fill={HIGHLIGHT_COLOR} />
              <rect x={x} y={y} width={BEVEL_SIZE} height={CELL_H} fill={HIGHLIGHT_COLOR} />
              <rect x={x} y={y + CELL_H - BEVEL_SIZE} width={CELL_W} height={BEVEL_SIZE} fill={SHADOW_EDGE_COLOR} />
              <rect x={x + CELL_W - BEVEL_SIZE} y={y} width={BEVEL_SIZE} height={CELL_H} fill={SHADOW_EDGE_COLOR} />
            </g>
          );
        }),
      )}
    </svg>
  );
}
