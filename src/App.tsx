import { useEffect, useMemo, useRef, useState } from 'react';
import { CELL_SIZE, PAUSE_KEY } from './game/constants';
import {
  createGameState,
  formatTime,
  getCountdownLabel,
  getWinnerLabel,
  queueDirection,
  restartGame,
  serializeState,
  startCountdown,
  tick,
  togglePause,
} from './game/engine';
import type { RoundState } from './game/types';

const CANVAS_WIDTH = 36 * CELL_SIZE;
const CANVAS_HEIGHT = 24 * CELL_SIZE;

declare global {
  interface Window {
    __SNAKE_PVP_STATE__?: ReturnType<typeof serializeState>;
    __SNAKE_PVP_TEST_API__?: {
      setState: (updater: (current: RoundState) => RoundState) => void;
      snapshot: () => ReturnType<typeof serializeState>;
    };
  }
}

function drawRound(ctx: CanvasRenderingContext2D, state: RoundState): void {
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const grid = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  grid.addColorStop(0, 'rgba(40, 87, 43, 0.22)');
  grid.addColorStop(1, 'rgba(17, 37, 18, 0.12)');
  ctx.fillStyle = '#020403';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = grid;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.strokeStyle = 'rgba(155, 255, 110, 0.08)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= CANVAS_WIDTH; x += CELL_SIZE) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, CANVAS_HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y <= CANVAS_HEIGHT; y += CELL_SIZE) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(CANVAS_WIDTH, y + 0.5);
    ctx.stroke();
  }

  const foodX = state.food.x * CELL_SIZE + CELL_SIZE / 2;
  const foodY = state.food.y * CELL_SIZE + CELL_SIZE / 2;
  ctx.save();
  ctx.shadowBlur = 20;
  ctx.shadowColor = 'rgba(255, 196, 77, 0.7)';
  ctx.fillStyle = '#ffc44d';
  ctx.beginPath();
  ctx.arc(foodX, foodY, CELL_SIZE * 0.23, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  Object.values(state.players).forEach((player) => {
    player.segments.forEach((segment, index) => {
      const x = segment.x * CELL_SIZE;
      const y = segment.y * CELL_SIZE;
      const inset = index === 0 ? 2 : 4;
      ctx.save();
      ctx.fillStyle = player.color;
      ctx.shadowBlur = index === 0 ? 18 : 10;
      ctx.shadowColor = player.glow;
      ctx.fillRect(x + inset, y + inset, CELL_SIZE - inset * 2, CELL_SIZE - inset * 2);
      ctx.restore();
    });
  });

  if (state.phase === 'paused') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }
}

export default function App() {
  const [state, setState] = useState(() => createGameState());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const accumulatorRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
    window.__SNAKE_PVP_STATE__ = serializeState(state);
  }, [state]);

  useEffect(() => {
    window.__SNAKE_PVP_TEST_API__ = {
      setState: (updater) => {
        setState((current) => updater(current));
      },
      snapshot: () => serializeState(stateRef.current),
    };

    return () => {
      delete window.__SNAKE_PVP_TEST_API__;
      delete window.__SNAKE_PVP_STATE__;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (stateRef.current.phase === 'menu' || stateRef.current.phase === 'finished')) {
        setState(() => startCountdown(restartGame()));
        return;
      }

      if (event.key === PAUSE_KEY) {
        event.preventDefault();
        setState((current) => togglePause(current));
        return;
      }

      setState((current) => queueDirection(current, event.key));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    let frame = 0;
    const loop = (time: number) => {
      const lastFrame = lastFrameRef.current ?? time;
      const delta = time - lastFrame;
      lastFrameRef.current = time;

      setState((current) => {
        if (current.phase === 'menu' || current.phase === 'finished' || current.phase === 'paused') {
          return current;
        }

        if (current.phase === 'countdown') {
          return tick(current, delta, time).state;
        }

        accumulatorRef.current += delta;
        let next = current;
        while (accumulatorRef.current >= current.tickMs) {
          const result = tick(next, current.tickMs, time);
          next = result.state;
          accumulatorRef.current -= current.tickMs;
          if (next.phase === 'finished') {
            accumulatorRef.current = 0;
            break;
          }
        }
        return next;
      });

      frame = window.requestAnimationFrame(loop);
    };

    frame = window.requestAnimationFrame(loop);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    drawRound(context, state);
  }, [state]);

  const countdownLabel = useMemo(() => getCountdownLabel(state), [state]);

  return (
    <main className="shell" data-phase={state.phase}>
      <section className="hud-card">
        <div>
          <p className="eyebrow">Local Arcade Duel</p>
          <h1>Snake PVP</h1>
        </div>
        <div className="status-row">
          <div data-testid="timer-card">
            <span>Timer</span>
            <strong data-testid="timer-value">{formatTime(state.remainingMs)}</strong>
          </div>
          <div data-testid="p1-score-card">
            <span>P1</span>
            <strong data-testid="p1-score">{state.players.p1.score}</strong>
          </div>
          <div data-testid="p2-score-card">
            <span>P2</span>
            <strong data-testid="p2-score">{state.players.p2.score}</strong>
          </div>
        </div>
      </section>

      <section className="arena-card">
        <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} className="arena" data-testid="game-canvas" />

        {state.phase === 'menu' && (
          <div className="overlay" data-testid="menu-overlay">
            <p className="eyebrow">Retro Nokia energy. Modern local duel.</p>
            <h2>One keyboard. Three minutes. Outgrow or outcut.</h2>
            <div className="controls-grid">
              <p><span>P1</span> WASD</p>
              <p><span>P2</span> IJKL</p>
              <p><span>Pause</span> Space</p>
              <p><span>Start</span> Enter / button</p>
            </div>
            <button data-testid="start-match" onClick={() => setState((current) => startCountdown(current))}>Start Match</button>
          </div>
        )}

        {state.phase === 'countdown' && (
          <div className="overlay slim" data-testid="countdown-overlay">
            <p className="eyebrow">Get ready</p>
            <h2 data-testid="countdown-value">{countdownLabel}</h2>
          </div>
        )}

        {state.phase === 'paused' && (
          <div className="overlay slim" data-testid="paused-overlay">
            <p className="eyebrow">Paused</p>
            <h2>Press Space to resume</h2>
          </div>
        )}

        {state.phase === 'finished' && (
          <div className="overlay" data-testid="finished-overlay">
            <p className="eyebrow">Time Up</p>
            <h2 data-testid="winner-label">{getWinnerLabel(state)}</h2>
            <div className="controls-grid score-grid">
              <p><span>P1 Score</span> {state.players.p1.score}</p>
              <p><span>P2 Score</span> {state.players.p2.score}</p>
              <p><span>P1 Length</span> {state.players.p1.segments.length}</p>
              <p><span>P2 Length</span> {state.players.p2.segments.length}</p>
            </div>
            <div className="button-row">
              <button data-testid="play-again" onClick={() => setState(startCountdown(restartGame()))}>Play Again</button>
              <button data-testid="back-to-title" className="secondary" onClick={() => setState(restartGame())}>Back to Title</button>
            </div>
          </div>
        )}
      </section>

      <section className="footer-card">
        <div>
          <span>Cut Rule</span>
          <strong>Hit body segments, not head or neck</strong>
        </div>
        <div>
          <span>Deaths</span>
          <strong>Walls, self, bad collisions</strong>
        </div>
        <div>
          <span>Tiebreak</span>
          <strong>Score, then current length</strong>
        </div>
      </section>
    </main>
  );
}
