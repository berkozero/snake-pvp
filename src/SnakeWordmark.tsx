import { useId } from 'react';

type SnakeWordmarkProps = {
  className?: string;
};

const LETTERS = [
  { key: 's', path: 'M20 18H168V60H62V94H168V136H126V170H168V212H20V170H126V136H20V18Z' },
  { key: 'n', path: 'M206 18H248V140L332 18H378V212H336V90L252 212H206Z' },
  { key: 'a', path: 'M416 212L478 18H566L628 212H582L569 170H475L462 212ZM487 132H557L522 52Z' },
  { key: 'k', path: 'M666 18H708V96L782 18H836L754 108L842 212H790L728 138L708 156V212H666Z' },
  { key: 'e', path: 'M882 18H1044V60H924V94H1024V136H924V170H1044V212H882Z' },
] as const;

const ECHO_OFFSETS = [
  { x: 14, y: 16, opacity: 0.4 },
  { x: 24, y: 26, opacity: 0.24 },
  { x: 32, y: 34, opacity: 0.12 },
];

export default function SnakeWordmark({ className }: SnakeWordmarkProps) {
  const id = useId().replace(/:/g, '');
  const fillId = `snake-wordmark-fill-${id}`;
  const strokeId = `snake-wordmark-stroke-${id}`;
  const glowId = `snake-wordmark-glow-${id}`;

  return (
    <svg
      className={className}
      viewBox="0 0 1088 248"
      role="img"
      aria-label="Snake"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={fillId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#fcfcff" />
          <stop offset="45%" stopColor="#d8d8df" />
          <stop offset="100%" stopColor="#a4a4ae" />
        </linearGradient>
        <linearGradient id={strokeId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f6f6fa" />
          <stop offset="100%" stopColor="#9c9ca6" />
        </linearGradient>
        <filter id={glowId} x="-12%" y="-18%" width="124%" height="136%">
          <feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="rgba(255,255,255,0.28)" />
          <feDropShadow dx="0" dy="0" stdDeviation="18" floodColor="rgba(190,190,205,0.16)" />
        </filter>
      </defs>

      <g fill="none" stroke={`url(#${strokeId})`} strokeWidth="4">
        {ECHO_OFFSETS.map((offset) => (
          <g
            key={`${offset.x}-${offset.y}`}
            transform={`translate(${offset.x} ${offset.y})`}
            opacity={offset.opacity}
          >
            {LETTERS.map((letter) => (
              <path key={letter.key} d={letter.path} />
            ))}
          </g>
        ))}
      </g>

      <g filter={`url(#${glowId})`}>
        {LETTERS.map((letter) => (
          <path key={letter.key} d={letter.path} fill={`url(#${fillId})`} />
        ))}
      </g>
    </svg>
  );
}
