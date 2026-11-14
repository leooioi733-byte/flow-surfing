import * as THREE from 'three';
import { ExecutionQuality, FallType, ManeuverType, SurfPhase } from '../types/game';
import { SurferPhysicsState, SurfWaveParams } from './wavePhysics';

export const MAX_REPLAY_SECONDS = 15.0;

export interface ReplayFrame {
  recordTime: number;
  elapsedTime: number;
  // Wave parameters
  simTime: number;
  waveCenterZ: number;
  waveHeight: number;
  waveSpeed: number;
  steepness: number;
  power: number;
  breakX: number;
  breakDir: number;
  barrelFactor: number;
  waveLengthZ: number;
  // Surfer & Board physics
  posX: number;
  posY: number;
  posZ: number;
  heading: number;
  roll: number;
  pitch: number;
  boardNormalX: number;
  boardNormalY: number;
  boardNormalZ: number;
  phase: SurfPhase;
  speed: number;
  balance: number;
  paddleStrokePhase: number;
  duckDiveTimer: number;
  walkPhase: number;
  activeManeuver: ManeuverType | null;
  maneuverTimer: number;
  maneuverDuration: number;
  maneuverSpin: number;
  airHeight: number;
  inBarrel: boolean;
  barrelTimer: number;
  fallType: FallType;
  fallDir: number;
  fallIntensity: number;
  wipeoutTimer: number;
  submersionDepth: number;
  underwaterAmount: number;
  boardDetached: boolean;
  boardPosX: number;
  boardPosY: number;
  boardPosZ: number;
  boardHeading: number;
  boardRoll: number;
  boardPitch: number;
  justSplashed: boolean;
  splashIntensity: number;
  carvingIntensity: number;
  score: number;
  combo: number;
  waveNumber: number;
  timeScale: number;
  lastCallout: string;
  lastQuality: ExecutionQuality | null;
  calloutId: number;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export class ReplayBuffer {
  private frames: ReplayFrame[] = [];
  private recordClock = 0;
  private lastSampledClock = -1;
  private lastSplashFrameIdx = -1;

  public clear() {
    this.frames.length = 0;
    this.recordClock = 0;
    this.lastSampledClock = -1;
    this.lastSplashFrameIdx = -1;
  }

  public getDuration(): number {
    if (this.frames.length < 2) return 0;
    return Math.max(0, this.frames[this.frames.length - 1].recordTime - this.frames[0].recordTime);
  }

  public hasClip(): boolean {
    return this.frames.length >= 12 && this.getDuration() >= 0.75;
  }

  public resetPlaybackCursor() {
    this.lastSplashFrameIdx = -1;
  }

  public record(
    rawDt: number,
    elapsedTime: number,
    state: SurferPhysicsState,
    wp: SurfWaveParams
  ) {
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    this.recordClock += dt;

    // Sample up to ~45 Hz for smooth slow-motion interpolation while preserving splash bursts
    const minInterval = state.justSplashed ? 0 : 0.022;
    if (this.lastSampledClock >= 0 && this.recordClock - this.lastSampledClock < minInterval) {
      return;
    }
    this.lastSampledClock = this.recordClock;

    this.frames.push({
      recordTime: this.recordClock,
      elapsedTime,
      simTime: wp.simTime,
      waveCenterZ: wp.waveCenterZ,
      waveHeight: wp.waveHeight,
      waveSpeed: wp.waveSpeed,
      steepness: wp.steepness,
      power: wp.power,
      breakX: wp.breakX,
      breakDir: wp.breakDir,
      barrelFactor: wp.barrelFactor,
      waveLengthZ: wp.waveLengthZ,
      posX: state.position.x,
      posY: state.position.y,
      posZ: state.position.z,
      heading: state.heading,
      roll: state.roll,
      pitch: state.pitch,
      boardNormalX: state.boardNormal.x,
      boardNormalY: state.boardNormal.y,
      boardNormalZ: state.boardNormal.z,
      phase: state.phase,
      speed: state.speed,
      balance: state.balance,
      paddleStrokePhase: state.paddleStrokePhase,
      duckDiveTimer: state.duckDiveTimer,
      walkPhase: state.walkPhase,
      activeManeuver: state.activeManeuver,
      maneuverTimer: state.maneuverTimer,
      maneuverDuration: state.maneuverDuration,
      maneuverSpin: state.maneuverSpin,
      airHeight: state.airHeight,
      inBarrel: state.inBarrel,
      barrelTimer: state.barrelTimer,
      fallType: state.fallType,
      fallDir: state.fallDir,
      fallIntensity: state.fallIntensity,
      wipeoutTimer: state.wipeoutTimer,
      submersionDepth: state.submersionDepth,
      underwaterAmount: state.underwaterAmount,
      boardDetached: state.boardDetached,
      boardPosX: state.boardPos.x,
      boardPosY: state.boardPos.y,
      boardPosZ: state.boardPos.z,
      boardHeading: state.boardHeading,
      boardRoll: state.boardRoll,
      boardPitch: state.boardPitch,
      justSplashed: state.justSplashed,
      splashIntensity: state.splashIntensity,
      carvingIntensity: state.carvingIntensity,
      score: state.score,
      combo: state.combo,
      waveNumber: state.waveNumber,
      timeScale: state.timeScale,
      lastCallout: state.lastCallout,
      lastQuality: state.lastQuality,
      calloutId: state.calloutId,
    });

    // Keep strictly the last 15 seconds (+0.15s margin for smooth endpoints)
    const cutoff = this.recordClock - (MAX_REPLAY_SECONDS + 0.15);
    let dropCount = 0;
    while (this.frames.length - dropCount > 2 && this.frames[dropCount + 1].recordTime < cutoff) {
      dropCount++;
    }
    if (dropCount >= 24) {
      this.frames.splice(0, dropCount);
    }
  }

  /**
   * Computes a steady shoreline telephoto camera anchor that frames the whole captured ride.
   */
  public computeBeachAnchor(out: THREE.Vector3) {
    if (this.frames.length === 0) {
      out.set(4, 3.6, 17);
      return;
    }
    let sumX = 0;
    let maxZ = -999;
    let maxH = 2.0;
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      sumX += f.posX;
      if (f.posZ > maxZ) maxZ = f.posZ;
      if (f.waveHeight > maxH) maxH = f.waveHeight;
    }
    const avgX = sumX / this.frames.length;
    const last = this.frames[this.frames.length - 1];
    const camZ = THREE.MathUtils.clamp(Math.max(14.5, maxZ + 12.0), 14.5, 30.0);
    const camX = avgX + last.breakDir * 6.5;
    out.set(camX, 2.85 + maxH * 0.45, camZ);
  }

  /**
   * Samples an interpolated physics & wave snapshot at `replayTime` in [0, duration].
   */
  public sampleAt(
    replayTime: number,
    isPlayingForward: boolean,
    outState: SurferPhysicsState,
    outWave: SurfWaveParams
  ): { elapsedTime: number } {
    if (this.frames.length === 0) {
      return { elapsedTime: 0 };
    }

    const first = this.frames[0];
    const last = this.frames[this.frames.length - 1];
    const targetClock = THREE.MathUtils.clamp(
      first.recordTime + replayTime,
      first.recordTime,
      last.recordTime
    );

    // Binary search for bracketing frame index
    let lo = 0;
    let hi = this.frames.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].recordTime <= targetClock) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    const a = this.frames[lo];
    const b = this.frames[Math.min(lo + 1, this.frames.length - 1)];
    const span = Math.max(0.0001, b.recordTime - a.recordTime);
    const t = a === b ? 0 : THREE.MathUtils.clamp((targetClock - a.recordTime) / span, 0, 1);

    // Prevent wave discontinuity interpolation if a new wave spawned mid-clip
    const sameWave = a.waveNumber === b.waveNumber && Math.abs(b.waveCenterZ - a.waveCenterZ) < 12;
    const ref = t < 0.5 ? a : b;

    // Populate wave params
    outWave.enabled = true;
    outWave.simTime = sameWave ? THREE.MathUtils.lerp(a.simTime, b.simTime, t) : ref.simTime;
    outWave.waveCenterZ = sameWave
      ? THREE.MathUtils.lerp(a.waveCenterZ, b.waveCenterZ, t)
      : ref.waveCenterZ;
    outWave.waveHeight = sameWave
      ? THREE.MathUtils.lerp(a.waveHeight, b.waveHeight, t)
      : ref.waveHeight;
    outWave.waveSpeed = sameWave
      ? THREE.MathUtils.lerp(a.waveSpeed, b.waveSpeed, t)
      : ref.waveSpeed;
    outWave.steepness = sameWave
      ? THREE.MathUtils.lerp(a.steepness, b.steepness, t)
      : ref.steepness;
    outWave.power = sameWave ? THREE.MathUtils.lerp(a.power, b.power, t) : ref.power;
    outWave.breakX = sameWave ? THREE.MathUtils.lerp(a.breakX, b.breakX, t) : ref.breakX;
    outWave.breakDir = ref.breakDir;
    outWave.barrelFactor = sameWave
      ? THREE.MathUtils.lerp(a.barrelFactor, b.barrelFactor, t)
      : ref.barrelFactor;
    outWave.waveLengthZ = sameWave
      ? THREE.MathUtils.lerp(a.waveLengthZ, b.waveLengthZ, t)
      : ref.waveLengthZ;

    // Populate surfer & board state
    const blend = sameWave && Math.abs(b.posZ - a.posZ) < 6;
    const lerpNum = (va: number, vb: number) => (blend ? THREE.MathUtils.lerp(va, vb, t) : t < 0.5 ? va : vb);

    outState.position.set(
      lerpNum(a.posX, b.posX),
      lerpNum(a.posY, b.posY),
      lerpNum(a.posZ, b.posZ)
    );
    outState.heading = blend ? lerpAngle(a.heading, b.heading, t) : ref.heading;
    outState.roll = lerpNum(a.roll, b.roll);
    outState.pitch = lerpNum(a.pitch, b.pitch);
    outState.boardNormal
      .set(
        lerpNum(a.boardNormalX, b.boardNormalX),
        lerpNum(a.boardNormalY, b.boardNormalY),
        lerpNum(a.boardNormalZ, b.boardNormalZ)
      )
      .normalize();

    outState.phase = ref.phase;
    outState.speed = lerpNum(a.speed, b.speed);
    outState.balance = lerpNum(a.balance, b.balance);
    outState.paddleStrokePhase = lerpNum(a.paddleStrokePhase, b.paddleStrokePhase);
    outState.duckDiveTimer = lerpNum(a.duckDiveTimer, b.duckDiveTimer);
    outState.walkPhase = lerpNum(a.walkPhase, b.walkPhase);
    outState.activeManeuver = ref.activeManeuver;
    outState.maneuverTimer = lerpNum(a.maneuverTimer, b.maneuverTimer);
    outState.maneuverDuration = ref.maneuverDuration;
    outState.maneuverSpin = blend ? lerpAngle(a.maneuverSpin, b.maneuverSpin, t) : ref.maneuverSpin;
    outState.airHeight = lerpNum(a.airHeight, b.airHeight);
    outState.inBarrel = ref.inBarrel;
    outState.barrelTimer = lerpNum(a.barrelTimer, b.barrelTimer);
    outState.fallType = ref.fallType;
    outState.fallDir = ref.fallDir;
    outState.fallIntensity = ref.fallIntensity;
    outState.wipeoutTimer = lerpNum(a.wipeoutTimer, b.wipeoutTimer);
    outState.submersionDepth = lerpNum(a.submersionDepth, b.submersionDepth);
    outState.underwaterAmount = lerpNum(a.underwaterAmount, b.underwaterAmount);

    outState.boardDetached = ref.boardDetached;
    outState.boardPos.set(
      lerpNum(a.boardPosX, b.boardPosX),
      lerpNum(a.boardPosY, b.boardPosY),
      lerpNum(a.boardPosZ, b.boardPosZ)
    );
    outState.boardHeading = blend ? lerpAngle(a.boardHeading, b.boardHeading, t) : ref.boardHeading;
    outState.boardRoll = lerpNum(a.boardRoll, b.boardRoll);
    outState.boardPitch = lerpNum(a.boardPitch, b.boardPitch);

    outState.carvingIntensity = lerpNum(a.carvingIntensity, b.carvingIntensity);
    outState.score = ref.score;
    outState.combo = ref.combo;
    outState.waveNumber = ref.waveNumber;
    outState.timeScale = ref.timeScale;
    outState.lastCallout = ref.lastCallout;
    outState.lastQuality = ref.lastQuality;
    outState.calloutId = ref.calloutId;

    // Trigger particle splash bursts once when advancing past recorded splash frames
    outState.justSplashed = false;
    outState.splashIntensity = 0;
    if (isPlayingForward && lo !== this.lastSplashFrameIdx) {
      const startCheck = Math.max(0, this.lastSplashFrameIdx + 1);
      for (let idx = startCheck; idx <= lo; idx++) {
        if (this.frames[idx]?.justSplashed) {
          outState.justSplashed = true;
          outState.splashIntensity = Math.max(
            outState.splashIntensity,
            this.frames[idx].splashIntensity
          );
        }
      }
      this.lastSplashFrameIdx = lo;
    } else if (!isPlayingForward) {
      this.lastSplashFrameIdx = lo;
    }

    return {
      elapsedTime: THREE.MathUtils.lerp(a.elapsedTime, b.elapsedTime, t),
    };
  }
}
