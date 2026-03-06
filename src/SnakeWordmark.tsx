type SnakeWordmarkProps = {
  className?: string;
};

const CELL_W = 34;
const CELL_H = 36;
const GAP = 2;
const STEP_X = CELL_W + GAP;
const STEP_Y = CELL_H + GAP;
const ORIGIN_Y = 20;
const BLOCK_COLOR = '#b8b8be';

const ECHO_LAYERS = [
  { dx: 6, dy: 7, opacity: 0.35 },
  { dx: 12, dy: 14, opacity: 0.18 },
  { dx: 18, dy: 21, opacity: 0.08 },
];

type BlockDef = [number, number];

const LETTER_DEFS: { key: string; x: number; blocks: BlockDef[] }[] = [
  {
    key: 's',
    x: 20,
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
    x: 176,
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
    x: 332,
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
    x: 488,
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
    x: 644,
    blocks: [
      [0, 0], [1, 0], [2, 0], [3, 0],
      [0, 1],
      [0, 2], [1, 2], [2, 2],
      [0, 3],
      [0, 4], [1, 4], [2, 4], [3, 4],
    ],
  },
];

export default function SnakeWordmark({ className }: SnakeWordmarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 830 250"
      role="img"
      aria-label="Snake"
      xmlns="http://www.w3.org/2000/svg"
    >
      {ECHO_LAYERS.map((echo) => (
        <g
          key={`echo-${echo.dx}`}
          transform={`translate(${echo.dx} ${echo.dy})`}
          opacity={echo.opacity}
          fill="none"
          stroke="rgba(180,180,190,0.5)"
          strokeWidth="1.5"
        >
          {LETTER_DEFS.map((letter) =>
            letter.blocks.map(([col, row], i) => (
              <rect
                key={`${letter.key}-${i}`}
                x={letter.x + col * STEP_X}
                y={ORIGIN_Y + row * STEP_Y}
                width={CELL_W}
                height={CELL_H}
              />
            )),
          )}
        </g>
      ))}

      {LETTER_DEFS.map((letter) =>
        letter.blocks.map(([col, row], i) => (
          <rect
            key={`${letter.key}-${i}`}
            x={letter.x + col * STEP_X}
            y={ORIGIN_Y + row * STEP_Y}
            width={CELL_W}
            height={CELL_H}
            fill={BLOCK_COLOR}
          />
        )),
      )}
    </svg>
  );
}
