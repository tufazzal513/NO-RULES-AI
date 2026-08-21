/**
 * Live GPU-training monitor (Colab / Kaggle → control panel).
 * ----------------------------------------------------------
 * `train_lora.py` runs on a free Colab T4 or a Kaggle P100, far away from
 * this server. It POSTs a small heartbeat every few steps to
 * `/api/v1/training/gpu/report`; this module keeps the latest state plus a
 * bounded history so the control panel's Training page can render a live
 * view of a run that is happening on someone else's GPU.
 *
 * Everything is in memory and bounded — same approach as `logs.ts`. A run
 * that stops reporting for STALE_AFTER_MS is shown as "stalled" (the usual
 * cause is a Colab disconnect), never as "running" forever.
 */

export type GpuPhase =
  | "starting"
  | "data"
  | "model"
  | "probe"
  | "training"
  | "saving"
  | "export"
  | "testing"
  | "done"
  | "failed"
  | "oom-recovery";

export interface GpuStepSample {
  at: string;
  step: number;
  loss: number | null;
  lr: number | null;
}

export interface GpuEvent {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface GpuRun {
  id: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  phase: GpuPhase;
  ok: boolean | null;
  /** Where it runs: "colab" | "kaggle" | "local" | free text. */
  platform: string;
  gpu: string | null;
  vramGb: number | null;
  ramGb: number | null;
  model: string | null;
  recipe: string | null;
  trainRows: number | null;
  valRows: number | null;
  step: number;
  totalSteps: number;
  loss: number | null;
  bestLoss: number | null;
  learningRate: number | null;
  secondsPerStep: number | null;
  /** Seconds left in the wall-clock budget, as reported by the trainer. */
  budgetSecondsLeft: number | null;
  batchSize: number | null;
  gradAccum: number | null;
  maxSeqLength: number | null;
  packing: boolean | null;
  oomRetries: number;
  message: string | null;
  samples: GpuStepSample[];
  events: GpuEvent[];
}

const MAX_RUNS = 8;
const MAX_SAMPLES = 240;
const MAX_EVENTS = 60;
/** No heartbeat for this long ⇒ the run is reported as stalled. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

const runs: GpuRun[] = [];

function nowIso(): string {
  return new Date().toISOString();
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function str(v: unknown, max = 200): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function blankRun(id: string, platform: string): GpuRun {
  return {
    id,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
    phase: "starting",
    ok: null,
    platform,
    gpu: null,
    vramGb: null,
    ramGb: null,
    model: null,
    recipe: null,
    trainRows: null,
    valRows: null,
    step: 0,
    totalSteps: 0,
    loss: null,
    bestLoss: null,
    learningRate: null,
    secondsPerStep: null,
    budgetSecondsLeft: null,
    batchSize: null,
    gradAccum: null,
    maxSeqLength: null,
    packing: null,
    oomRetries: 0,
    message: null,
    samples: [],
    events: [],
  };
}

/**
 * Record one heartbeat. Unknown/missing fields keep their previous value, so
 * the trainer can send a tiny `{runId, step, loss}` payload most of the time
 * and a fat one only when something actually changes.
 */
export function reportGpuTraining(payload: Record<string, any>): GpuRun {
  const id = str(payload.runId, 80) || "gpu-run";
  const platform = str(payload.platform, 40) || "colab";

  let run = runs.find((r) => r.id === id);
  if (!run) {
    run = blankRun(id, platform);
    runs.unshift(run);
    if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  }

  run.updatedAt = nowIso();
  if (payload.platform !== undefined) run.platform = platform;

  const assignStr = (key: keyof GpuRun, value: unknown, max = 200) => {
    if (value === undefined) return;
    (run as any)[key] = str(value, max);
  };
  const assignNum = (key: keyof GpuRun, value: unknown) => {
    if (value === undefined) return;
    (run as any)[key] = num(value);
  };

  assignStr("gpu", payload.gpu, 80);
  assignStr("model", payload.model, 120);
  assignStr("recipe", payload.recipe, 40);
  assignStr("message", payload.message, 500);
  assignNum("vramGb", payload.vramGb);
  assignNum("ramGb", payload.ramGb);
  assignNum("trainRows", payload.trainRows);
  assignNum("valRows", payload.valRows);
  assignNum("learningRate", payload.learningRate);
  assignNum("secondsPerStep", payload.secondsPerStep);
  assignNum("budgetSecondsLeft", payload.budgetSecondsLeft);
  assignNum("batchSize", payload.batchSize);
  assignNum("gradAccum", payload.gradAccum);
  assignNum("maxSeqLength", payload.maxSeqLength);

  if (payload.packing !== undefined) run.packing = Boolean(payload.packing);
  if (payload.oomRetries !== undefined) run.oomRetries = int(payload.oomRetries, run.oomRetries);
  if (payload.totalSteps !== undefined) run.totalSteps = int(payload.totalSteps, run.totalSteps);
  if (payload.phase !== undefined) run.phase = (str(payload.phase, 20) as GpuPhase) || run.phase;

  if (payload.step !== undefined) {
    const step = int(payload.step, run.step);
    const loss = num(payload.loss);
    run.step = step;
    if (loss !== null) {
      run.loss = loss;
      run.bestLoss = run.bestLoss === null ? loss : Math.min(run.bestLoss, loss);
    }
    run.samples.push({ at: run.updatedAt, step, loss, lr: num(payload.learningRate) });
    if (run.samples.length > MAX_SAMPLES) run.samples.splice(0, run.samples.length - MAX_SAMPLES);
  }

  const event = str(payload.event, 400);
  if (event) {
    const level = payload.eventLevel === "error" ? "error" : payload.eventLevel === "warn" ? "warn" : "info";
    run.events.push({ at: run.updatedAt, level, message: event });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  }

  if (run.phase === "done" || run.phase === "failed") {
    run.finishedAt = run.updatedAt;
    run.ok = run.phase === "done";
  }

  return run;
}

/** Derived view for the UI: progress %, ETA, stalled detection. */
export function gpuTrainingState() {
  const now = Date.now();
  const decorate = (r: GpuRun) => {
    const age = now - Date.parse(r.updatedAt);
    const finished = r.phase === "done" || r.phase === "failed";
    const stalled = !finished && age > STALE_AFTER_MS;
    const progress = r.totalSteps > 0 ? Math.max(0, Math.min(100, (r.step / r.totalSteps) * 100)) : 0;
    const stepsLeft = Math.max(0, r.totalSteps - r.step);
    const etaSeconds =
      !finished && r.secondsPerStep && stepsLeft > 0 ? Math.round(stepsLeft * r.secondsPerStep) : null;
    return {
      ...r,
      running: !finished && !stalled,
      stalled,
      finished,
      ageMs: age,
      progress: Math.round(progress * 10) / 10,
      stepsLeft,
      etaSeconds,
      elapsedSeconds: Math.round((Date.parse(r.updatedAt) - Date.parse(r.startedAt)) / 1000),
    };
  };
  const all = runs.map(decorate);
  return {
    current: all.find((r) => r.running) ?? all[0] ?? null,
    runs: all,
    staleAfterMs: STALE_AFTER_MS,
  };
}

/** Drop every recorded run (control panel "Clear" button). */
export function clearGpuTraining(): void {
  runs.length = 0;
}
