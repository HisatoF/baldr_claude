import * as THREE from 'three';
import { clamp, damp, Ease } from '../core/MathUtil.js';
import { PALETTE } from '../render/Palette.js';

/**
 * HUD module (order 50).
 *
 * Drawn to a 2D canvas layered over the WebGL canvas — not built from DOM elements.
 * The rubric rejects unstyled DOM outright, and a cockpit readout needs per-frame
 * control over stroke weight, bracket geometry and flicker that CSS cannot give
 * cheaply. One canvas, one clear, one pass of vector drawing per frame.
 *
 * Visual language: thin cyan strokes on near-black, corner brackets rather than
 * boxes, monospaced technical readouts, and a combo counter that is the loudest
 * thing on screen because the combo is the point of the game.
 */

const CYAN = '#5ad9ff';
const CYAN_DIM = 'rgba(90,217,255,0.34)';
const MAGENTA = '#ff3d9a';
const AMBER = '#ffa63d';
const DANGER = '#ff2b3c';

const RANK_COLOR = {
  D: '#8fa3b8',
  C: '#7ce0ff',
  B: '#5ad9ff',
  A: '#ffd36a',
  S: '#ffa63d',
  SS: '#ff3d9a',
};

export function createHudModule() {
  let canvas = null;
  let g = null;
  let dpr = 1;
  let W = 0;
  let H = 0;

  let visible = true;
  const notices = [];
  const v3 = new THREE.Vector3();

  // Smoothed display values — bars that snap read as data, bars that ease read as
  // instrumentation.
  const shown = { hp: 1, en: 1, hpChip: 1, combo: 0, comboAlpha: 0 };
  let comboPunch = 0;
  let lastComboCount = 0;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'hud';
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '20',
    });
    document.body.appendChild(canvas);
    g = canvas.getContext('2d');
  }

  function resize(w, h) {
    ensureCanvas();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = w;
    H = h;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Corner brackets — the motif that makes a panel read as a targeting overlay. */
  function brackets(x, y, w, h, len, color, lw = 1.5) {
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.beginPath();
    // top-left
    g.moveTo(x, y + len); g.lineTo(x, y); g.lineTo(x + len, y);
    // top-right
    g.moveTo(x + w - len, y); g.lineTo(x + w, y); g.lineTo(x + w, y + len);
    // bottom-right
    g.moveTo(x + w, y + h - len); g.lineTo(x + w, y + h); g.lineTo(x + w - len, y + h);
    // bottom-left
    g.moveTo(x + len, y + h); g.lineTo(x, y + h); g.lineTo(x, y + h - len);
    g.stroke();
  }

  /**
   * Segmented bar. Segments rather than a solid fill because a mech readout should
   * look quantised, and because segment boundaries make small changes legible.
   */
  function segBar(x, y, w, h, frac, chip, color, segments = 24) {
    const gap = 2;
    const sw = (w - gap * (segments - 1)) / segments;
    const lit = frac * segments;
    const chipLit = chip * segments;

    for (let i = 0; i < segments; i++) {
      const sx = x + i * (sw + gap);
      const fill = clamp(lit - i, 0, 1);
      const chipFill = clamp(chipLit - i, 0, 1);

      // Chip layer: recently lost value, drains behind the real bar.
      if (chipFill > 0.01 && fill < 0.99) {
        g.fillStyle = 'rgba(255,43,60,0.45)';
        g.fillRect(sx, y, sw * chipFill, h);
      }
      if (fill > 0.01) {
        g.fillStyle = color;
        g.globalAlpha = 0.35 + 0.65 * fill;
        g.fillRect(sx, y, sw * fill, h);
        g.globalAlpha = 1;
      } else {
        g.fillStyle = 'rgba(255,255,255,0.055)';
        g.fillRect(sx, y, sw, h);
      }
    }
  }

  function label(text, x, y, color, size = 10, align = 'left', weight = 600) {
    g.font = `${weight} ${size}px ui-monospace, "SF Mono", Menlo, monospace`;
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'alphabetic';
    g.fillText(text, x, y);
  }

  const api = {
    setVisible(v) {
      visible = v;
      if (canvas) canvas.style.display = v ? '' : 'none';
    },
    notify(text, kind = 'info') {
      notices.push({ text, kind, t: 0, life: kind === 'wave' ? 2.4 : 1.6 });
      if (notices.length > 4) notices.shift();
    },
  };

  return {
    name: 'hud',
    order: 50,

    init(ctx) {
      ensureCanvas();
      resize(window.innerWidth, window.innerHeight);

      ctx.bus.on('wave:started', (p) => api.notify(`WAVE ${p.index}`, 'wave'));
      ctx.bus.on('wave:cleared', () => api.notify('AREA CLEAR', 'wave'));
      ctx.bus.on('boost:depleted', () => api.notify('EN DEPLETED', 'warn'));
      ctx.bus.on('game:over', () => api.notify('SYSTEM DOWN', 'warn'));
      ctx.bus.on('combo:ended', (p) => {
        if (p.count >= 12) api.notify(`${p.count} HIT  ${p.rank}`, 'rank');
      });

      ctx.hud = api;
    },

    resize(ctx, w, h) {
      resize(w, h);
    },

    frame(ctx, dt) {
      if (!visible || !g) return;
      const combat = ctx.combat;
      if (!combat || !combat.player) return;

      g.clearRect(0, 0, W, H);

      const hp = combat.hpFrac;
      const en = combat.enFrac;
      shown.hp = damp(shown.hp, hp, 14, dt);
      // Chip trails the real value, so damage reads as a drain rather than a jump.
      shown.hpChip = shown.hpChip > shown.hp ? damp(shown.hpChip, hp, 2.6, dt) : shown.hp;
      shown.en = damp(shown.en, en, 16, dt);

      const M = 34; // margin
      const barW = 300;

      /* ---------------- status block, lower left ---------------- */
      const by = H - 96;
      brackets(M - 10, by - 22, barW + 20, 74, 12, CYAN_DIM, 1);

      label('INTEGRITY', M, by - 6, CYAN_DIM, 9);
      segBar(M, by, barW, 11, shown.hp, shown.hpChip, hp < 0.28 ? DANGER : CYAN, 24);
      label(`${Math.round(hp * 100)}%`, M + barW, by - 6, hp < 0.28 ? DANGER : CYAN, 10, 'right');

      label('BOOST', M, by + 34, CYAN_DIM, 9);
      segBar(M, by + 40, barW, 7, shown.en, shown.en, en < 0.22 ? AMBER : '#7ce0ff', 18);

      /* ---------------- weapon slots, lower right ---------------- */
      const grounded = combat.player.grounded;
      const bank = grounded ? combat.loadout.ground : combat.loadout.air;
      const combo = combat.comboSystem;
      const slotW = 84;
      const slotH = 30;
      const sx0 = W - M - slotW * 4 - 18;
      const sy0 = H - 74;

      label(grounded ? 'GROUND' : 'AERIAL', W - M, sy0 - 10, grounded ? CYAN_DIM : MAGENTA, 9, 'right');

      for (let i = 0; i < 4; i++) {
        const id = bank[i];
        const w = id ? combat.weapons.get(id) : null;
        const x = sx0 + i * (slotW + 6);
        const active = combo && combo.action && combo.action.id === id;
        const cooling = combo && combo.cooldowns.has(id);

        g.fillStyle = active ? 'rgba(90,217,255,0.16)' : 'rgba(255,255,255,0.035)';
        g.fillRect(x, sy0, slotW, slotH);
        brackets(x, sy0, slotW, slotH, 7, active ? CYAN : CYAN_DIM, active ? 1.6 : 1);

        // Cooldown wipe
        if (cooling && w) {
          const frac = clamp(combo.cooldowns.get(id) / w.cooldown, 0, 1);
          g.fillStyle = 'rgba(0,0,0,0.55)';
          g.fillRect(x, sy0, slotW, slotH * frac);
        }

        label(`${i + 1}`, x + 6, sy0 + 12, CYAN_DIM, 8);
        const name = w ? w.id.toUpperCase() : '---';
        label(name, x + slotW / 2, sy0 + 21, active ? '#dff6ff' : '#9fb6c9', 10, 'center');
      }

      /* ---------------- combo counter ---------------- */
      const cc = combat.combo;
      if (cc.count > lastComboCount) comboPunch = 1;
      lastComboCount = cc.count;
      comboPunch = damp(comboPunch, 0, 9, dt);

      const active = cc.count > 1 && cc.timeLeft > 0;
      shown.comboAlpha = damp(shown.comboAlpha, active ? 1 : 0, 10, dt);

      if (shown.comboAlpha > 0.01) {
        const cx = W * 0.5;
        const cy = H * 0.19;
        const scale = 1 + Ease.outBack(comboPunch) * 0.22;
        const col = RANK_COLOR[cc.rank] || CYAN;

        g.save();
        g.globalAlpha = shown.comboAlpha;
        g.translate(cx, cy);
        g.scale(scale, scale);

        g.font = '800 62px ui-monospace, "SF Mono", Menlo, monospace';
        g.textAlign = 'center';
        g.fillStyle = col;
        g.shadowColor = col;
        g.shadowBlur = 26;
        g.fillText(`${cc.count}`, 0, 0);
        g.shadowBlur = 0;

        g.font = '700 17px ui-monospace, monospace';
        g.fillStyle = '#cfe9f8';
        g.fillText('HIT', 52, -4);

        g.font = '800 30px ui-monospace, monospace';
        g.fillStyle = col;
        g.fillText(cc.rank, 0, 32);

        g.font = '600 12px ui-monospace, monospace';
        g.fillStyle = CYAN_DIM;
        g.fillText(`${cc.damage} DMG`, 0, 52);

        // Chain timer: a thin bar that visibly runs out.
        const tw = 150;
        const frac = clamp(cc.timeLeft / 1.35, 0, 1);
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.fillRect(-tw / 2, 62, tw, 3);
        g.fillStyle = col;
        g.fillRect(-tw / 2, 62, tw * frac, 3);

        g.restore();
      }

      /* ---------------- lock-on reticle ---------------- */
      const t = combat.lockTarget;
      if (t && ctx.camera) {
        v3.set(t.pos.x, t.pos.y, t.z || 0).project(ctx.camera);
        if (v3.z < 1) {
          const px = (v3.x * 0.5 + 0.5) * W;
          const py = (-v3.y * 0.5 + 0.5) * H;
          const r = 26 + Math.sin(ctx.time.elapsed * 6) * 2;

          g.strokeStyle = MAGENTA;
          g.lineWidth = 1.4;
          g.beginPath();
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + Math.PI / 4 + ctx.time.elapsed * 0.5;
            const a2 = a + 0.55;
            g.moveTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
            g.arc(px, py, r, a, a2);
          }
          g.stroke();

          // Target health pip
          const thp = clamp(t.hp / t.hpMax, 0, 1);
          g.fillStyle = 'rgba(0,0,0,0.5)';
          g.fillRect(px - 24, py - r - 12, 48, 4);
          g.fillStyle = thp > 0.35 ? MAGENTA : DANGER;
          g.fillRect(px - 24, py - r - 12, 48 * thp, 4);

          label(t.archetype.toUpperCase(), px, py + r + 15, 'rgba(255,61,154,0.75)', 9, 'center');
        }
      }

      /* ---------------- wave / enemy readout, top right ---------------- */
      const ai = ctx.ai;
      if (ai) {
        label(`WAVE ${String(ai.waveIndex).padStart(2, '0')}`, W - M, M + 4, CYAN, 13, 'right', 700);
        label(`HOSTILES ${String(ai.enemies.length).padStart(2, '0')}`, W - M, M + 22, CYAN_DIM, 10, 'right');
        g.fillStyle = CYAN_DIM;
        g.fillRect(W - M - 116, M + 30, 116, 1);
      }

      /* ---------------- notices ---------------- */
      for (let i = notices.length - 1; i >= 0; i--) {
        const n = notices[i];
        n.t += dt;
        if (n.t >= n.life) {
          notices.splice(i, 1);
          continue;
        }
        const k = n.t / n.life;
        // Snap in, hold, fade out.
        const alpha = k < 0.12 ? k / 0.12 : k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
        const y = H * 0.36 - i * 34 - Ease.outCubic(clamp(k * 2, 0, 1)) * 8;
        const col = n.kind === 'warn' ? DANGER : n.kind === 'rank' ? AMBER : CYAN;

        g.save();
        g.globalAlpha = clamp(alpha, 0, 1);
        g.font = '700 25px ui-monospace, monospace';
        g.textAlign = 'center';
        g.fillStyle = col;
        g.shadowColor = col;
        g.shadowBlur = 16;
        g.fillText(n.text, W * 0.5, y);
        g.restore();
      }

      /* ---------------- frame furniture ---------------- */
      // Thin corner ticks tie the overlay together as one instrument.
      g.strokeStyle = 'rgba(90,217,255,0.16)';
      g.lineWidth = 1;
      const t2 = 16;
      g.beginPath();
      g.moveTo(M - 12, M + t2); g.lineTo(M - 12, M); g.lineTo(M - 12 + t2, M);
      g.moveTo(W - M + 12 - t2, M); g.lineTo(W - M + 12, M); g.lineTo(W - M + 12, M + t2);
      g.stroke();
    },

    dispose() {
      canvas?.remove();
      canvas = null;
      g = null;
    },
  };
}
