import * as THREE from 'three';
import {
  BeachEnvironmentConfig,
  CompletedWaveTelemetry,
  ExecutionQuality,
  FallType,
  ManeuverAvailability,
  ManeuverType,
  SurfInputState,
  SurfPhase,
  WaveSection,
} from '../types/game';
import { getBeachHeightAt } from './oceanShader';

export const SURF_SPEED_KMH_FACTOR = 6.0;

export interface SurfWaveParams {
  enabled: boolean;
  waveCenterZ: number; // Advancing toward shore (+Z)
  waveHeight: number;
  waveSpeed: number;
  steepness: number;
  power: number;
  breakX: number; // Current breaking curl X position
  breakDir: number; // +1 peels right (+X), -1 peels left (-X)
  barrelFactor: number; // 0..1 how hollow the curl is
  waveLengthZ: number;
  simTime: number;
}

export interface WaveSample {
  height: number;
  normal: THREE.Vector3;
  slopeSteepness: number; // 0..1
  faceProgress: number; // 0 = trough/ahead, 0.5 = mid-face, 1 = crest
  section: WaveSection;
  inBarrelZone: boolean;
  barrelDepth: number; // 0..1 inside the tube
  curlHeight: number;
  curlOverhangZ: number;
}

const _nTmp = new THREE.Vector3();
const _noseN = new THREE.Vector3();
const _tailN = new THREE.Vector3();
const _leftN = new THREE.Vector3();
const _rightN = new THREE.Vector3();
const _contactN = new THREE.Vector3();

/**
 * Shared progressive shoaling & breaking profile as a wave travels from deep ocean
 * (-160) across the outer reef/sandbar (-85..-30) onto the beach (+12).
 * Mirrored identically in the Ocean GPU shader and BarrelCurlSystem.
 */
export function getWaveShoaling(waveCenterZ: number): {
  heightScale: number;
  steepScale: number;
  breakProgress: number;
} {
  const shoalBuild = THREE.MathUtils.smoothstep(waveCenterZ, -135, -36);
  const shoreDecay = THREE.MathUtils.smoothstep(waveCenterZ, -2, 13);
  const heightScale = (0.58 + shoalBuild * 0.52) * (1.0 - shoreDecay * 0.34);
  const steepScale = (0.62 + shoalBuild * 0.46) * (1.0 - shoreDecay * 0.25);
  const breakProgress = THREE.MathUtils.smoothstep(waveCenterZ, -82, -26);
  return { heightScale, steepScale, breakProgress };
}

/**
 * Evaluates the dynamic surfing wave surface at world (x, z).
 * Shares exact wave profile math with the Ocean GPU shader during gameplay.
 */
export function sampleSurfWave(
  x: number,
  z: number,
  params: SurfWaveParams,
  outNormal?: THREE.Vector3
): WaveSample {
  const normal = outNormal ?? _nTmp;

  const t = params.simTime;
  const swellBase =
    Math.sin(z * 0.065 - t * 1.35 + x * 0.01) * 0.28 +
    Math.cos(z * 0.12 - t * 1.9 - x * 0.03) * 0.11;

  const dz = z - params.waveCenterZ;
  const halfWidthZ = params.waveLengthZ * 0.5;
  const relBreak = (x - params.breakX) * params.breakDir;

  const { heightScale, steepScale, breakProgress } = getWaveShoaling(params.waveCenterZ);

  const lateralDecay = Math.exp(-Math.pow((x - params.breakX * 0.4) / 145, 2));
  const shoulderTaper = 1.0 - THREE.MathUtils.smoothstep(relBreak, 14, 72) * 0.42;
  const whitewaterDamp = 1.0 - THREE.MathUtils.smoothstep(-relBreak, 4, 28) * (0.14 + 0.22 * breakProgress);
  const localH = params.waveHeight * heightScale * lateralDecay * shoulderTaper * whitewaterDamp;

  const pocketSteepBoost =
    1.0 + Math.exp(-Math.pow((relBreak - 5.5) / 11.0, 2)) * 0.45 * params.steepness * steepScale;

  let waveY = 0;
  let dWaveDz = 0;
  let dWaveDx = 0;
  let faceProgress = 0;

  if (dz >= -halfWidthZ && dz <= halfWidthZ) {
    if (dz >= 0) {
      const frontSpan = 10.5 / Math.max(0.75, pocketSteepBoost * 0.85);
      const u = Math.min(1, dz / frontSpan);
      const curve = Math.pow(1 - u, 1.85);
      waveY = localH * curve;
      if (u < 1) {
        dWaveDz = -localH * 1.85 * Math.pow(1 - u, 0.85) / frontSpan;
      }
      faceProgress = 1 - u;
    } else {
      const backSpan = 19.0;
      const u = Math.min(1, -dz / backSpan);
      const curve = Math.pow(1 - u, 1.55);
      waveY = localH * curve;
      if (u < 1) {
        dWaveDz = localH * 1.55 * Math.pow(1 - u, 0.55) / backSpan;
      }
      faceProgress = 1.0;
    }

    const shoulderSlopeFactor = -0.006 * params.breakDir * THREE.MathUtils.smoothstep(relBreak, 6, 55);
    dWaveDx = waveY * shoulderSlopeFactor;
  }

  let whitewaterTurbulence = 0;
  if (breakProgress > 0.04 && relBreak < 2.0 && dz >= -2.5 && dz <= 9.5) {
    const wwStrength = THREE.MathUtils.smoothstep(2.0 - relBreak, 0, 6.0) * breakProgress;
    const frontFade = 1.0 - THREE.MathUtils.smoothstep(dz, 4.0, 9.5);
    whitewaterTurbulence =
      wwStrength *
      frontFade *
      (Math.sin(x * 0.75 + t * 5.5) * 0.14 + Math.cos(z * 0.9 - t * 6.8) * 0.12 + 0.18);
  }

  const totalY = swellBase + waveY + whitewaterTurbulence;
  const dSwellDz = Math.cos(z * 0.065 - t * 1.35 + x * 0.01) * 0.28 * 0.065;
  const dSwellDx = Math.cos(z * 0.065 - t * 1.35 + x * 0.01) * 0.28 * 0.01;
  normal.set(-(dWaveDx + dSwellDx), 1.0, -(dWaveDz + dSwellDz)).normalize();

  const slopeSteepness = THREE.MathUtils.clamp(Math.abs(dWaveDz) * 1.45, 0, 1);

  let section: WaveSection = 'flat';
  if (dz >= -2.5 && dz <= 11.5 && localH > 0.7) {
    if (breakProgress > 0.28 && relBreak < -1.5) {
      section = 'whitewater';
    } else if (breakProgress > 0.2 && dz < 2.2 && relBreak >= -1.5 && relBreak < 28) {
      section = 'lip';
    } else if (relBreak >= -1.5 && relBreak <= 15.0) {
      section = 'pocket';
    } else if (relBreak > 15.0 && relBreak <= 44) {
      section = 'face';
    } else if (relBreak > 44) {
      section = 'shoulder';
    }
  }

  // Spacious hollow barrel tube check on large waves once wave begins pitching
  const curlPeak =
    params.barrelFactor *
    THREE.MathUtils.smoothstep(breakProgress, 0.22, 0.78) *
    (localH / Math.max(1.0, params.waveHeight));
  const isBigTubeWave = localH >= 2.65 && params.barrelFactor >= 0.65;
  const inLateralTube = relBreak >= -1.5 && relBreak <= (isBigTubeWave ? 13.5 : 10.5);
  const inFrontTube = dz >= 0.5 && dz <= (isBigTubeWave ? 6.2 : 4.6) * (0.7 + 0.3 * params.barrelFactor);
  const inBarrelZone = curlPeak > 0.45 && localH >= 2.2 && inLateralTube && inFrontTube;

  let barrelDepth = 0;
  if (inBarrelZone) {
    const latCenter = 1.0 - Math.abs((relBreak - 5.0) / 7.5);
    const zCenter = 1.0 - Math.abs((dz - 2.8) / 3.0);
    barrelDepth = THREE.MathUtils.clamp(latCenter * zCenter * curlPeak * 1.45, 0, 1);
  }

  return {
    height: totalY,
    normal,
    slopeSteepness,
    faceProgress,
    section,
    inBarrelZone,
    barrelDepth,
    curlHeight: localH,
    curlOverhangZ: 2.4 + localH * 0.85 * params.barrelFactor * breakProgress,
  };
}

export interface SurferPhysicsState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  heading: number; // Yaw angle in radians (0 = +Z toward beach, PI = -Z toward sea)
  roll: number; // Rail lean angle
  pitch: number; // Nose up/down pitch
  boardNormal: THREE.Vector3;
  phase: SurfPhase;
  speed: number; // m/s
  balance: number; // -1..+1
  stability: number; // 0..1
  catchProgress: number; // 0..1
  takeoffTimer: number;
  duckDiveTimer: number;
  duckDiveBonusAwarded: boolean;
  paddleStrokePhase: number;
  walkPhase: number;

  // Maneuver state
  activeManeuver: ManeuverType | null;
  maneuverTimer: number;
  maneuverDuration: number;
  maneuverQuality: ExecutionQuality | null;
  maneuverSpin: number;

  // Air state
  verticalVel: number;
  airHeight: number;

  // Barrel state
  inBarrel: boolean;
  barrelTimer: number;
  barrelExitedAwarded: boolean;

  // Realistic Fall, Underwater Submersion & Detached Board Recovery
  fallType: FallType;
  fallDir: number; // -1..+1
  fallIntensity: number; // 0..1
  wipeoutTimer: number;
  wipeoutSplashTriggered: boolean;
  submersionDepth: number; // meters below water surface
  underwaterAmount: number; // 0..1 smooth lens/audio factor
  recoverTimer: number;
  boardDetached: boolean;
  boardPos: THREE.Vector3;
  boardVel: THREE.Vector3;
  boardHeading: number;
  boardRoll: number;
  boardPitch: number;

  // Water Impact Telemetry (consumed per frame by camera/audio/particles)
  impactEventIntensity: number; // 0..1 instantaneous collision pulse
  impactWhitewater: number; // 0..1 whitewater screen wash trigger
  justResurfaced: boolean;

  // Scoring & Slow motion
  score: number;
  combo: number;
  comboTimer: number;
  timeScale: number;
  targetTimeScale: number;
  slowMoHoldTimer: number;
  waveNumber: number;
  currentWavePoints: number;
  currentWaveManeuvers: number;
  currentWaveBestManeuver: string;
  currentWaveBestManeuverPts: number;
  currentWaveBarrelTime: number;
  completedWaves: CompletedWaveTelemetry[];
  isBigBarrelWave: boolean;
  lastCallout: string;
  lastQuality: ExecutionQuality | null;
  calloutId: number;

  // Telemetry for particle emitters
  justSplashed: boolean;
  splashIntensity: number;
  carvingIntensity: number;
}

export class SurfPhysicsEngine {
  public state: SurferPhysicsState;
  public waveParams: SurfWaveParams;
  private beachEnv: BeachEnvironmentConfig;
  private cooldownTimer = 0;
  private sprayImpactCooldown = 0;
  private speedGateCalloutCooldown = 0;
  private whitewaterExposure = 0;

  constructor(beachEnv: BeachEnvironmentConfig) {
    this.beachEnv = beachEnv;
    this.waveParams = this.createWaveParams(beachEnv, 1, 0);
    this.state = this.createInitialState();
    this.resetSession(beachEnv);
  }

  private createWaveParams(env: BeachEnvironmentConfig, waveNum: number, simTime: number): SurfWaveParams {
    const isHeavySet = waveNum % 2 === 0 || waveNum % 3 === 0 || env.waveAmplitude >= 1.25;
    const heightBoost = isHeavySet ? 1.48 : 1.05;
    const baseH = THREE.MathUtils.clamp(env.waveAmplitude * 2.55 * heightBoost, 2.3, 4.75);
    const speed = THREE.MathUtils.clamp(6.8 + env.waveSpeed * 2.3, 7.2, 11.2);
    const steepness = THREE.MathUtils.clamp(
      (0.78 + env.choppiness * 0.45) * (isHeavySet ? 1.15 : 0.96),
      0.72,
      1.38
    );
    const breakDir = waveNum % 2 === 1 ? 1 : -1;
    const barrelFactor = isHeavySet
      ? THREE.MathUtils.clamp(0.88 + (env.waveAmplitude - 0.8) * 0.15, 0.85, 1.0)
      : THREE.MathUtils.clamp(0.62 + (env.waveAmplitude - 0.8) * 0.25, 0.55, 0.88);

    return {
      enabled: true,
      waveCenterZ: -148,
      waveHeight: baseH,
      waveSpeed: speed,
      steepness,
      power: baseH * steepness,
      breakX: breakDir > 0 ? -18 : 18,
      breakDir,
      barrelFactor,
      waveLengthZ: 36,
      simTime,
    };
  }

  private createInitialState(): SurferPhysicsState {
    return {
      position: new THREE.Vector3(0, 0.65, 19.5),
      velocity: new THREE.Vector3(0, 0, 0),
      heading: Math.PI,
      roll: 0,
      pitch: 0,
      boardNormal: new THREE.Vector3(0, 1, 0),
      phase: 'beachWalk',
      speed: 0,
      balance: 0,
      stability: 1.0,
      catchProgress: 0,
      takeoffTimer: 0,
      duckDiveTimer: 0,
      duckDiveBonusAwarded: false,
      paddleStrokePhase: 0,
      walkPhase: 0,
      activeManeuver: null,
      maneuverTimer: 0,
      maneuverDuration: 1.0,
      maneuverQuality: null,
      maneuverSpin: 0,
      verticalVel: 0,
      airHeight: 0,
      inBarrel: false,
      barrelTimer: 0,
      barrelExitedAwarded: false,
      fallType: 'sideways',
      fallDir: 1,
      fallIntensity: 0.6,
      wipeoutTimer: 0,
      wipeoutSplashTriggered: false,
      submersionDepth: 0,
      underwaterAmount: 0,
      recoverTimer: 0,
      boardDetached: false,
      boardPos: new THREE.Vector3(0, 0.65, 19.5),
      boardVel: new THREE.Vector3(0, 0, 0),
      boardHeading: Math.PI,
      boardRoll: 0,
      boardPitch: 0,
      impactEventIntensity: 0,
      impactWhitewater: 0,
      justResurfaced: false,
      score: 0,
      combo: 1,
      comboTimer: 0,
      timeScale: 1.0,
      targetTimeScale: 1.0,
      slowMoHoldTimer: 0,
      waveNumber: 1,
      currentWavePoints: 0,
      currentWaveManeuvers: 0,
      currentWaveBestManeuver: '',
      currentWaveBestManeuverPts: 0,
      currentWaveBarrelTime: 0,
      completedWaves: [],
      isBigBarrelWave: false,
      lastCallout: 'Walk to the water',
      lastQuality: null,
      calloutId: 1,
      justSplashed: false,
      splashIntensity: 0,
      carvingIntensity: 0,
    };
  }

  public resetSession(beachEnv: BeachEnvironmentConfig, startInWater = false) {
    this.beachEnv = beachEnv;
    this.waveParams = this.createWaveParams(beachEnv, 1, 0);
    this.state = this.createInitialState();
    this.whitewaterExposure = 0;
    this.speedGateCalloutCooldown = 0;

    if (startInWater) {
      const startX = -1.5;
      const startZ = -18.0;
      const waterY = sampleSurfWave(startX, startZ, this.waveParams).height;
      this.state.position.set(startX, waterY + 0.03, startZ);
      this.state.boardPos.copy(this.state.position);
      this.state.heading = Math.PI;
      this.state.boardHeading = Math.PI;
      this.state.phase = 'paddling';
      this.waveParams.waveCenterZ = -78;
      this.waveParams.breakX = -15;
      this.state.isBigBarrelWave = this.waveParams.waveHeight >= 3.2;
      this.triggerCallout('In the lineup — reach 50 km/h to drop in', null);
    } else {
      const startX = -1.5;
      const startZ = 18.8;
      const groundY = getBeachHeightAt(startX, startZ);
      this.state.position.set(startX, groundY, startZ);
      this.state.boardPos.copy(this.state.position);
      this.state.heading = Math.PI;
      this.state.boardHeading = Math.PI;
      this.state.phase = 'beachWalk';
      this.waveParams.waveCenterZ = -142;
      this.waveParams.breakX = -16;
      this.state.isBigBarrelWave = this.waveParams.waveHeight >= 3.2;
      this.triggerCallout('Walk with your board to the water', null);
    }
  }

  public updateBeachEnv(beachEnv: BeachEnvironmentConfig) {
    this.beachEnv = beachEnv;
  }

  private commitCurrentWaveIfScored() {
    const s = this.state;
    if (
      s.currentWavePoints > 0 ||
      s.currentWaveManeuvers > 0 ||
      s.currentWaveBarrelTime > 0.25
    ) {
      s.completedWaves.push({
        waveNumber: s.waveNumber,
        points: s.currentWavePoints,
        barrelTime: Math.round(s.currentWaveBarrelTime * 10) / 10,
        maneuvers: s.currentWaveManeuvers,
        bestManeuver: s.currentWaveBestManeuver || 'Linha na Parede',
      });
    }
    s.currentWavePoints = 0;
    s.currentWaveManeuvers = 0;
    s.currentWaveBestManeuver = '';
    s.currentWaveBestManeuverPts = 0;
    s.currentWaveBarrelTime = 0;
  }

  private spawnNextWave(fromShore = false, keepPhase: 'paddling' | 'recovering' = 'paddling') {
    const s = this.state;
    if (keepPhase === 'paddling') {
      this.commitCurrentWaveIfScored();
    }
    const wNum = s.waveNumber + 1;
    s.waveNumber = wNum;

    const nextParams = this.createWaveParams(this.beachEnv, wNum, this.waveParams.simTime);
    const surferZ = fromShore ? -22 : THREE.MathUtils.clamp(s.position.z, -46, -12);
    nextParams.waveCenterZ = THREE.MathUtils.clamp(surferZ - 76, -158, -88);
    nextParams.breakX = s.position.x - nextParams.breakDir * 13;
    this.waveParams = nextParams;
    s.isBigBarrelWave = nextParams.waveHeight >= 3.2;

    if (!fromShore && s.position.z > -4) {
      const shiftZ = -28 - s.position.z;
      s.position.z = -28;
      s.position.x = THREE.MathUtils.clamp(s.position.x, -26, 26);
      s.boardPos.z += shiftZ;
      s.boardPos.x = THREE.MathUtils.clamp(s.boardPos.x, -30, 30);
      this.waveParams.waveCenterZ = THREE.MathUtils.clamp(s.position.z - 76, -158, -88);
      this.waveParams.breakX = s.position.x - nextParams.breakDir * 13;
    }

    s.phase = keepPhase;
    s.catchProgress = 0;
    s.duckDiveTimer = 0;
    s.duckDiveBonusAwarded = false;
    s.balance = 0;
    s.stability = 1.0;
    s.activeManeuver = null;
    s.inBarrel = false;
    s.barrelTimer = 0;
    s.barrelExitedAwarded = false;
    s.airHeight = 0;
    s.verticalVel = 0;
    s.submersionDepth = 0;
    s.underwaterAmount = 0;
    s.targetTimeScale = 1.0;
    s.slowMoHoldTimer = 0;
    this.whitewaterExposure = 0;

    if (keepPhase === 'paddling') {
      s.boardDetached = false;
      this.triggerCallout(
        s.isBigBarrelWave ? `Heavy Barrel Set · Wave ${wNum}` : `Wave ${wNum} incoming`,
        null
      );
    }
  }

  private triggerCallout(text: string, quality: ExecutionQuality | null) {
    this.state.lastCallout = text;
    this.state.lastQuality = quality;
    this.state.calloutId += 1;
  }

  public getManeuverAvailability(): ManeuverAvailability {
    const s = this.state;
    const sample = sampleSurfWave(s.position.x, s.position.z, this.waveParams);
    const dz = s.position.z - this.waveParams.waveCenterZ;
    const canDuckDive =
      s.phase === 'paddling' &&
      this.cooldownTimer <= 0 &&
      ((dz > -4.5 && dz < 24.0) ||
        sample.slopeSteepness > 0.08 ||
        sample.section === 'whitewater' ||
        sample.section === 'lip');
    if (s.phase !== 'riding' && s.phase !== 'barrel') {
      return { bottomTurn: false, cutback: false, floater: false, air: false, duckDive: canDuckDive };
    }
    const spd = s.speed;
    return {
      bottomTurn:
        spd > 6.2 &&
        (sample.faceProgress < 0.62 || sample.section === 'face' || sample.section === 'pocket'),
      cutback:
        spd > 7.0 &&
        (sample.section === 'shoulder' || sample.section === 'face' || sample.section === 'pocket'),
      floater:
        spd > 6.8 &&
        (sample.section === 'lip' || sample.section === 'whitewater' || sample.faceProgress > 0.54),
      air:
        spd > 8.8 &&
        (sample.section === 'lip' || sample.section === 'pocket' || sample.faceProgress > 0.58),
      duckDive: false,
    };
  }

  /**
   * Computes multi-point water surface height & normal across the surfboard footprint.
   */
  private sampleBoardContact(x: number, z: number, heading: number, wp: SurfWaveParams) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const rx = fz;
    const rz = -fx;

    const halfLen = 0.92;
    const halfWid = 0.24;

    const c = sampleSurfWave(x, z, wp);
    const nose = sampleSurfWave(x + fx * halfLen, z + fz * halfLen, wp, _noseN);
    const tail = sampleSurfWave(x - fx * halfLen, z - fz * halfLen, wp, _tailN);
    const left = sampleSurfWave(x + rx * halfWid, z + rz * halfWid, wp, _leftN);
    const right = sampleSurfWave(x - rx * halfWid, z - rz * halfWid, wp, _rightN);

    const avgY = (c.height * 2 + nose.height + tail.height + left.height + right.height) / 6;
    const dfdz = (nose.height - tail.height) / (halfLen * 2);
    const dfdr = (left.height - right.height) / (halfWid * 2);
    _contactN
      .set(
        c.normal.x * 0.45 - (fx * dfdz + rx * dfdr) * 0.55,
        1.0,
        c.normal.z * 0.45 - (fz * dfdz + rz * dfdr) * 0.55
      )
      .normalize();

    return { avgY, blendedNormal: _contactN, centerSample: c };
  }

  public step(
    rawDt: number,
    input: SurfInputState,
    camForwardX: number,
    camForwardZ: number,
    isFirstPerson = false
  ): WaveSample {
    const s = this.state;
    s.justSplashed = false;
    s.splashIntensity = 0;
    s.carvingIntensity = 0;
    s.impactEventIntensity = 0;
    s.impactWhitewater = 0;
    s.justResurfaced = false;

    const baseWaveTimeScale =
      s.phase === 'beachWalk' ||
      s.phase === 'paddling' ||
      s.phase === 'duckDive' ||
      s.phase === 'recovering'
        ? 1.0
        : s.phase === 'wipeout'
          ? 0.72
          : s.phase === 'barrel'
            ? 0.34
            : 0.42;

    if (s.slowMoHoldTimer > 0) {
      s.slowMoHoldTimer = Math.max(0, s.slowMoHoldTimer - rawDt);
      if (s.slowMoHoldTimer <= 0) {
        s.targetTimeScale = baseWaveTimeScale;
      }
    } else {
      s.targetTimeScale = baseWaveTimeScale;
    }
    const scaleLambda = s.targetTimeScale < s.timeScale ? 11.0 : 4.2;
    s.timeScale = THREE.MathUtils.damp(s.timeScale, s.targetTimeScale, scaleLambda, rawDt);

    const dt = Math.min(rawDt, 0.05) * s.timeScale;
    this.waveParams.simTime += dt;
    this.cooldownTimer = Math.max(0, this.cooldownTimer - dt);
    this.sprayImpactCooldown = Math.max(0, this.sprayImpactCooldown - rawDt);
    this.speedGateCalloutCooldown = Math.max(0, this.speedGateCalloutCooldown - rawDt);

    const wp = this.waveParams;
    wp.waveCenterZ += wp.waveSpeed * dt;
    const peelSpeed = wp.waveSpeed * 0.58;
    wp.breakX += wp.breakDir * peelSpeed * dt;

    if (
      (s.phase === 'beachWalk' ||
        s.phase === 'paddling' ||
        s.phase === 'duckDive' ||
        s.phase === 'recovering') &&
      wp.waveCenterZ > 11.5
    ) {
      wp.waveCenterZ = -145;
      wp.breakX = s.position.x - wp.breakDir * 14;
    }

    if (s.combo > 1 && s.phase !== 'barrel' && s.phase !== 'maneuver') {
      s.comboTimer -= dt * 0.14;
      if (s.comboTimer <= 0) {
        s.combo = 1;
        s.comboTimer = 0;
      }
    }

    const waveSample = sampleSurfWave(s.position.x, s.position.z, wp);
    const camRightX = -camForwardZ;
    const camRightZ = camForwardX;

    switch (s.phase) {
      case 'beachWalk':
        this.stepBeachWalk(dt, input, camForwardX, camForwardZ, camRightX, camRightZ, waveSample, isFirstPerson);
        break;
      case 'paddling':
        this.stepPaddling(dt, input, camForwardX, camForwardZ, camRightX, camRightZ, waveSample, isFirstPerson);
        break;
      case 'duckDive':
        this.stepDuckDive(dt, input, waveSample);
        break;
      case 'takeoff':
        this.stepTakeoff(dt, waveSample);
        break;
      case 'riding':
      case 'barrel':
        this.stepRiding(dt, input, waveSample);
        break;
      case 'maneuver':
        this.stepManeuver(dt, input, waveSample);
        break;
      case 'airborne':
        this.stepAirborne(dt, input, waveSample);
        break;
      case 'wipeout':
        this.stepWipeout(dt, waveSample);
        break;
      case 'recovering':
        this.stepRecovering(dt, input, camForwardX, camForwardZ, camRightX, camRightZ, waveSample, isFirstPerson);
        break;
    }

    // Keep detached board synchronized with live wave surface during wipeout & recovery
    if (s.boardDetached) {
      this.stepDetachedBoard(dt, wp);
    } else {
      s.boardPos.copy(s.position);
      s.boardHeading = s.heading;
      s.boardRoll = s.roll;
      s.boardPitch = s.pitch;
    }

    // Check if wave closed out while riding
    const beachDepth = -getBeachHeightAt(s.position.x, s.position.z);
    if (
      s.phase !== 'beachWalk' &&
      s.phase !== 'paddling' &&
      s.phase !== 'duckDive' &&
      s.phase !== 'wipeout' &&
      s.phase !== 'recovering' &&
      (wp.waveCenterZ > 10.5 || beachDepth < 0.45)
    ) {
      this.triggerCallout('Wave closed out — paddling back out', null);
      this.spawnNextWave(false, 'paddling');
    } else if (
      (s.phase === 'paddling' || s.phase === 'duckDive') &&
      s.position.z - wp.waveCenterZ < -22
    ) {
      this.spawnNextWave(false, 'paddling');
    }

    return sampleSurfWave(s.position.x, s.position.z, wp);
  }

  private stepDetachedBoard(dt: number, wp: SurfWaveParams) {
    const s = this.state;
    const boardSample = sampleSurfWave(s.boardPos.x, s.boardPos.z, wp);

    // Wave push + whitewater drift moves board organically along the water
    const dz = s.boardPos.z - wp.waveCenterZ;
    if (dz > -4 && dz < 11 && boardSample.height > 0.35) {
      s.boardVel.z += wp.waveSpeed * 0.52 * boardSample.slopeSteepness * dt;
      s.boardVel.x += wp.breakDir * 2.2 * boardSample.slopeSteepness * dt;
    }
    // Hydrodynamic drag on empty surfboard
    s.boardVel.multiplyScalar(Math.exp(-1.55 * dt));

    s.boardPos.x += s.boardVel.x * dt;
    s.boardPos.z += s.boardVel.z * dt;
    s.boardPos.x = THREE.MathUtils.clamp(s.boardPos.x, -45, 65);
    if (s.boardPos.z > 8.8) {
      s.boardPos.z = 8.8;
      s.boardVel.z = Math.min(0, s.boardVel.z);
    }

    // Keep board within reasonable swimming distance so recovery always feels fair & cozy
    const dx = s.boardPos.x - s.position.x;
    const dzz = s.boardPos.z - s.position.z;
    const dist = Math.hypot(dx, dzz);
    if (dist > 8.5) {
      const pull = (dist - 8.5) * 1.4;
      s.boardPos.x -= (dx / dist) * pull * dt;
      s.boardPos.z -= (dzz / dist) * pull * dt;
    }

    const contact = this.sampleBoardContact(s.boardPos.x, s.boardPos.z, s.boardHeading, wp);
    s.boardPos.y = THREE.MathUtils.damp(s.boardPos.y, contact.avgY + 0.035, 14, dt);
    s.boardHeading += Math.sin(wp.simTime * 1.8) * 0.25 * dt;
    s.boardRoll = THREE.MathUtils.damp(
      s.boardRoll,
      Math.sin(wp.simTime * 3.1) * 0.14 * (0.4 + boardSample.slopeSteepness),
      6,
      dt
    );
    s.boardPitch = THREE.MathUtils.damp(
      s.boardPitch,
      Math.cos(wp.simTime * 2.4) * 0.08,
      6,
      dt
    );
  }

  private stepBeachWalk(
    dt: number,
    input: SurfInputState,
    camFwdX: number,
    camFwdZ: number,
    camRightX: number,
    camRightZ: number,
    sample: WaveSample,
    isFirstPerson: boolean
  ) {
    const s = this.state;

    if (isFirstPerson) {
      // In 1P, left/right steers smoothly without feeding back into camera yaw
      if (Math.abs(input.moveX) > 0.08) {
        s.heading -= input.moveX * 2.3 * dt;
      }
      const fwdMag = THREE.MathUtils.clamp(input.moveY, -1, 1);
      const turnWalkMag = Math.abs(input.moveX) > 0.12 && Math.abs(fwdMag) < 0.15 ? 0.35 : 0;
      const moveSpeed = 4.2 * Math.max(Math.abs(fwdMag), turnWalkMag);
      if (Math.abs(fwdMag) > 0.08) {
        const dirSign = fwdMag >= 0 ? 1 : -1;
        s.velocity.x = THREE.MathUtils.damp(s.velocity.x, Math.sin(s.heading) * dirSign * moveSpeed, 9, dt);
        s.velocity.z = THREE.MathUtils.damp(s.velocity.z, Math.cos(s.heading) * dirSign * moveSpeed, 9, dt);
        s.walkPhase += dt * (7.5 + moveSpeed * 1.1);
      } else if (turnWalkMag > 0) {
        s.velocity.multiplyScalar(Math.exp(-10 * dt));
        s.walkPhase += dt * 5.0;
      } else {
        s.velocity.multiplyScalar(Math.exp(-10 * dt));
      }
    } else {
      const moveVecX = camRightX * input.moveX + camFwdX * input.moveY;
      const moveVecZ = camRightZ * input.moveX + camFwdZ * input.moveY;
      const inputMag = Math.min(1, Math.hypot(input.moveX, input.moveY));

      const walkSpeed = 4.2 * inputMag;
      if (inputMag > 0.08) {
        const targetHeading = Math.atan2(moveVecX, moveVecZ);
        s.heading = lerpAngle(s.heading, targetHeading, 1 - Math.exp(-10 * dt));
        s.velocity.x = THREE.MathUtils.damp(s.velocity.x, moveVecX * walkSpeed, 9, dt);
        s.velocity.z = THREE.MathUtils.damp(s.velocity.z, moveVecZ * walkSpeed, 9, dt);
        s.walkPhase += dt * (7.5 + walkSpeed * 1.1);
      } else {
        s.velocity.multiplyScalar(Math.exp(-10 * dt));
      }
    }

    s.position.x += s.velocity.x * dt;
    s.position.z += s.velocity.z * dt;
    s.position.x = THREE.MathUtils.clamp(s.position.x, -26, 26);
    s.position.z = THREE.MathUtils.clamp(s.position.z, -4, 24);
    s.speed = Math.hypot(s.velocity.x, s.velocity.z);

    const beachY = getBeachHeightAt(s.position.x, s.position.z);
    const waterDepth = sample.height - beachY;
    s.position.y = Math.max(beachY, sample.height - 0.15);
    s.boardNormal.set(0, 1, 0);
    s.pitch = 0;
    s.roll = 0;
    s.submersionDepth = 0;
    s.underwaterAmount = 0;

    if (waterDepth > 0.36 || s.position.z < 9.5) {
      s.phase = 'paddling';
      s.heading = Math.PI;
      s.justSplashed = true;
      s.splashIntensity = 0.55;
      s.impactEventIntensity = 0.25;
      if (this.waveParams.waveCenterZ > -18) {
        this.waveParams.waveCenterZ = -126;
        this.waveParams.breakX = s.position.x - this.waveParams.breakDir * 14;
      }
      this.triggerCallout(
        this.state.isBigBarrelWave
          ? 'Big barrel set ahead — paddle out'
          : 'In the water — paddle for the wave',
        null
      );
    }
  }

  private stepPaddling(
    dt: number,
    input: SurfInputState,
    camFwdX: number,
    camFwdZ: number,
    camRightX: number,
    camRightZ: number,
    sample: WaveSample,
    isFirstPerson: boolean
  ) {
    const s = this.state;
    const wp = this.waveParams;

    if (isFirstPerson) {
      if (Math.abs(input.moveX) > 0.08) {
        s.heading -= input.moveX * 2.15 * dt;
      }
      if (Math.abs(input.moveY) > 0.08) {
        const paddleForce = 16.5 * input.moveY;
        s.velocity.x += Math.sin(s.heading) * paddleForce * dt;
        s.velocity.z += Math.cos(s.heading) * paddleForce * dt;
      }
    } else {
      const moveVecX = camRightX * input.moveX + camFwdX * input.moveY;
      const moveVecZ = camRightZ * input.moveX + camFwdZ * input.moveY;
      const inputMag = Math.min(1, Math.hypot(input.moveX, input.moveY));

      if (inputMag > 0.08) {
        const targetHeading = Math.atan2(moveVecX, moveVecZ);
        s.heading = lerpAngle(s.heading, targetHeading, 1 - Math.exp(-6.5 * dt));
        const paddleForce = 16.5 * inputMag;
        s.velocity.x += Math.sin(s.heading) * paddleForce * dt;
        s.velocity.z += Math.cos(s.heading) * paddleForce * dt;
      }
    }

    s.velocity.multiplyScalar(Math.exp(-1.9 * dt));

    const dz = s.position.z - wp.waveCenterZ;
    if (dz > -3.5 && dz < 11.0) {
      const slopeAccel = 11.0 * sample.slopeSteepness;
      s.velocity.z += slopeAccel * dt;
      s.velocity.x += wp.breakDir * slopeAccel * 0.4 * dt;
    }

    s.position.x += s.velocity.x * dt;
    s.position.z += s.velocity.z * dt;
    s.position.x = THREE.MathUtils.clamp(s.position.x, -45, 65);
    const minWaterZ = 9.0;
    if (s.position.z > minWaterZ) {
      s.position.z = minWaterZ;
      s.velocity.z = Math.min(0, s.velocity.z);
    }

    const contact = this.sampleBoardContact(s.position.x, s.position.z, s.heading, wp);
    s.position.y = THREE.MathUtils.damp(s.position.y, contact.avgY + 0.03, 14, dt);
    s.speed = Math.hypot(s.velocity.x, s.velocity.z);
    s.paddleStrokePhase += dt * (2.8 + s.speed * 0.45);

    s.boardNormal.lerp(contact.blendedNormal, 1 - Math.exp(-10 * dt));
    s.pitch = THREE.MathUtils.damp(s.pitch, 0, 8, dt);
    s.roll = THREE.MathUtils.damp(s.roll, input.moveX * 0.14, 8, dt);
    s.submersionDepth = 0;
    s.underwaterAmount = THREE.MathUtils.damp(s.underwaterAmount, 0, 8, dt);

    // Light chop splash if wave whitewater washes past while paddling
    if (sample.section === 'whitewater' && this.sprayImpactCooldown <= 0) {
      s.impactEventIntensity = 0.28;
      s.impactWhitewater = 0.35;
      this.sprayImpactCooldown = 1.1;
    }

    if (input.requestedDuckDive && this.cooldownTimer <= 0) {
      s.phase = 'duckDive';
      s.duckDiveTimer = 0;
      s.duckDiveBonusAwarded = false;
      s.catchProgress = 0;
      s.justSplashed = true;
      s.splashIntensity = 0.58;
      s.impactEventIntensity = 0.22;
      const diveHeading = Math.cos(s.heading) > 0.2 ? Math.PI : s.heading;
      s.heading = diveHeading;
      s.velocity.x += Math.sin(diveHeading) * 3.4;
      s.velocity.z += Math.cos(diveHeading) * 3.4;
      this.triggerCallout('Duck Dive', null);
      return;
    }

    const speedKmh = Math.round(s.speed * SURF_SPEED_KMH_FACTOR);
    const onWaveFace =
      dz >= -0.8 && dz <= 9.0 && sample.slopeSteepness > 0.16 && s.velocity.z > 0.5;
    if (onWaveFace && speedKmh >= 50) {
      s.catchProgress += dt * (4.2 + sample.slopeSteepness * 2.2);
      if (s.catchProgress >= 1.0) {
        s.phase = 'takeoff';
        s.takeoffTimer = 0;
        s.targetTimeScale = 0.42;
        s.velocity.z = Math.max(s.velocity.z, wp.waveSpeed * 0.92);
        s.velocity.x += wp.breakDir * 2.8;
        s.speed = Math.hypot(s.velocity.x, s.velocity.z);
        s.heading = Math.atan2(s.velocity.x, s.velocity.z);
        s.justSplashed = true;
        s.splashIntensity = 0.65;
        s.impactEventIntensity = 0.26;
        this.whitewaterExposure = 0;
        this.triggerCallout('Wave Caught', null);
      }
    } else {
      s.catchProgress = Math.max(0, s.catchProgress - dt * 0.7);
      if (onWaveFace && speedKmh < 50 && this.speedGateCalloutCooldown <= 0) {
        this.speedGateCalloutCooldown = 3.0;
        this.triggerCallout('Reach 50 km/h to catch the wave', null);
      }
    }
  }

  private stepDuckDive(dt: number, input: SurfInputState, sample: WaveSample) {
    const s = this.state;
    const wp = this.waveParams;
    const duration = 1.1;
    s.duckDiveTimer += dt;
    const t = THREE.MathUtils.clamp(s.duckDiveTimer / duration, 0, 1);

    if (Math.abs(input.moveX) > 0.08) {
      s.heading -= input.moveX * 1.15 * dt;
    }

    const fwdX = Math.sin(s.heading);
    const fwdZ = Math.cos(s.heading);
    const targetGlide = 4.6;
    s.velocity.x = THREE.MathUtils.damp(s.velocity.x, fwdX * targetGlide, 4.0, dt);
    s.velocity.z = THREE.MathUtils.damp(s.velocity.z, fwdZ * targetGlide, 4.0, dt);

    s.position.x += s.velocity.x * dt;
    s.position.z += s.velocity.z * dt;
    s.position.x = THREE.MathUtils.clamp(s.position.x, -45, 65);
    if (s.position.z > 9.0) {
      s.position.z = 9.0;
      s.velocity.z = Math.min(0, s.velocity.z);
    }

    const contact = this.sampleBoardContact(s.position.x, s.position.z, s.heading, wp);
    const diveDepth = Math.sin(t * Math.PI) * 0.98;
    s.submersionDepth = diveDepth;
    s.underwaterAmount = THREE.MathUtils.clamp(diveDepth / 0.42, 0, 1);
    s.position.y = THREE.MathUtils.damp(s.position.y, contact.avgY - diveDepth, 18, dt);

    const targetPitch =
      t < 0.45
        ? 0.65 * Math.sin((t / 0.45) * Math.PI * 0.5)
        : THREE.MathUtils.lerp(0.65, -0.34, (t - 0.45) / 0.55);
    s.pitch = THREE.MathUtils.damp(s.pitch, targetPitch, 14, dt);
    s.roll = THREE.MathUtils.damp(s.roll, input.moveX * 0.16, 8, dt);
    s.boardNormal.lerp(contact.blendedNormal, 1 - Math.exp(-8 * dt));
    s.speed = Math.hypot(s.velocity.x, s.velocity.z);

    const dz = s.position.z - wp.waveCenterZ;
    if (
      !s.duckDiveBonusAwarded &&
      t > 0.2 &&
      t < 0.85 &&
      dz > -4.5 &&
      dz < 11.5 &&
      (sample.slopeSteepness > 0.14 || sample.section === 'whitewater' || sample.section === 'lip')
    ) {
      s.duckDiveBonusAwarded = true;
      const pts = Math.round(75 * s.combo);
      s.score += pts;
      s.currentWavePoints += pts;
      s.comboTimer = 1.0;
      this.triggerCallout(`Clean Duck Dive · +${pts}`, 'Good');
    }

    if (t >= 1.0) {
      s.phase = 'paddling';
      s.submersionDepth = 0;
      s.underwaterAmount = 0;
      s.justResurfaced = true;
      s.justSplashed = true;
      s.splashIntensity = 0.48;
      this.cooldownTimer = 0.25;
    }
  }

  private stepTakeoff(dt: number, sample: WaveSample) {
    const s = this.state;
    const wp = this.waveParams;
    s.takeoffTimer += dt;

    const slopeAccel = 12.5 * Math.max(0.35, sample.slopeSteepness);
    s.velocity.z += slopeAccel * dt;
    s.velocity.x += wp.breakDir * 4.2 * dt;

    s.position.x += s.velocity.x * dt;
    s.position.z += s.velocity.z * dt;
    s.speed = Math.hypot(s.velocity.x, s.velocity.z);

    const targetHeading = Math.atan2(s.velocity.x, s.velocity.z);
    s.heading = lerpAngle(s.heading, targetHeading, 1 - Math.exp(-8 * dt));

    const contact = this.sampleBoardContact(s.position.x, s.position.z, s.heading, wp);
    s.position.y = THREE.MathUtils.damp(s.position.y, contact.avgY + 0.03, 18, dt);
    s.boardNormal.lerp(contact.blendedNormal, 1 - Math.exp(-14 * dt));
    s.pitch = THREE.MathUtils.damp(s.pitch, 0.06, 9, dt);

    if (s.takeoffTimer >= 0.40) {
      s.phase = 'riding';
      s.currentWavePoints = Math.max(s.currentWavePoints, 60);
      this.triggerCallout(s.isBigBarrelWave ? 'Drop In — Line up the Barrel' : 'Drop In', null);
    }
  }

  private stepRiding(dt: number, input: SurfInputState, sample: WaveSample) {
    const s = this.state;
    const wp = this.waveParams;

    const steerInput = input.moveX;
    const trimInput = input.moveY;

    const turnRate = (3.45 - Math.min(0.85, s.speed * 0.032)) * steerInput;
    s.heading -= turnRate * dt;

    const dirX = Math.sin(s.heading);
    const dirZ = Math.cos(s.heading);

    const gravityPush = 15.2 * sample.slopeSteepness * Math.max(-0.35, dirZ * 0.8 + 0.25);
    const pumpGain = Math.abs(steerInput) * 1.65 + (sample.section === 'pocket' ? 5.2 : 2.3);
    const trimBoost = -trimInput * 2.1;

    const turnDrag = Math.abs(steerInput) * 0.16;
    const waterDrag = (0.04 + turnDrag * 0.045) * s.speed * s.speed * 0.135;
    const whitewaterDrag = sample.section === 'whitewater' ? 3.5 : 0;

    s.speed += (gravityPush + pumpGain + trimBoost - waterDrag - whitewaterDrag) * dt;
    const minWaveMatch = wp.waveSpeed * (sample.section === 'flat' ? 0.28 : 0.75);
    s.speed = THREE.MathUtils.clamp(s.speed, Math.max(3.8, minWaveMatch * 0.62), 22.0);

    const targetVx = dirX * s.speed;
    const targetVz = dirZ * s.speed + (sample.section !== 'flat' ? wp.waveSpeed * 0.28 : 0);
    const grip = sample.section === 'whitewater' ? 4.8 : 9.2;
    s.velocity.x = THREE.MathUtils.damp(s.velocity.x, targetVx, grip, dt);
    s.velocity.z = THREE.MathUtils.damp(s.velocity.z, targetVz, grip, dt);

    s.position.x += s.velocity.x * dt;
    s.position.z += (s.velocity.z - trimInput * 3.6) * dt;
    s.position.x = THREE.MathUtils.clamp(s.position.x, -70, 95);

    const contact = this.sampleBoardContact(s.position.x, s.position.z, s.heading, wp);
    s.position.y = THREE.MathUtils.damp(s.position.y, contact.avgY + 0.025, 22, dt);
    s.boardNormal.lerp(contact.blendedNormal, 1 - Math.exp(-16 * dt));

    const targetRoll = THREE.MathUtils.clamp(steerInput * 0.60 + s.balance * 0.26, -0.80, 0.80);
    s.roll = THREE.MathUtils.damp(s.roll, targetRoll, 11, dt);
    s.pitch = THREE.MathUtils.damp(s.pitch, dirZ * 0.06, 10, dt);

    const nextSample = contact.centerSample;

    s.carvingIntensity = THREE.MathUtils.clamp(
      (Math.abs(steerInput) * 0.78 + nextSample.slopeSteepness * 0.35) * (s.speed / 13.5),
      0,
      1.25
    );

    // Light camera spray pulse on aggressive rail carves
    if (s.carvingIntensity > 0.94 && this.sprayImpactCooldown <= 0) {
      s.impactEventIntensity = 0.22;
      this.sprayImpactCooldown = 0.95;
    }

    // Balance, speed wobble & breaking-section impact physics
    const isWhitewater = nextSample.section === 'whitewater';
    const turbulence = isWhitewater
      ? Math.sin(wp.simTime * 11.0) * 0.98 + 0.36 * wp.breakDir
      : 0;
    const speedWobble =
      s.speed > 18.2 && Math.abs(steerInput) > 0.72
        ? Math.sin(wp.simTime * 16.0) * ((s.speed - 18.0) * 0.26)
        : 0;

    const carveTorque = steerInput * (s.speed / 18) * 0.42;
    const balanceForce = carveTorque + turbulence + speedWobble + input.balanceAdjust * 1.95;
    s.balance += balanceForce * dt;
    const stabilizeDamp = input.balanceStabilize ? 3.2 : 0.92;
    s.balance *= Math.exp(-stabilizeDamp * dt);
    s.balance = THREE.MathUtils.clamp(s.balance, -1.25, 1.25);

    if (isWhitewater) {
      this.whitewaterExposure += dt;
      if (this.sprayImpactCooldown <= 0) {
        s.impactEventIntensity = Math.max(s.impactEventIntensity, 0.48);
        s.impactWhitewater = 0.55;
        this.sprayImpactCooldown = 0.7;
      }
      // Getting caught inside heavy whitewater lip throws the surfer off!
      if (this.whitewaterExposure > 0.72 && (nextSample.curlHeight > 2.8 || s.speed < wp.waveSpeed * 0.85)) {
        this.triggerWipeout('Caught by the Lip', 'lipSlam', 0.92, wp.breakDir);
        return;
      }
    } else {
      this.whitewaterExposure = Math.max(0, this.whitewaterExposure - dt * 1.4);
    }

    if (Math.abs(s.balance) > 0.88) {
      s.stability = Math.max(0, s.stability - dt * 0.75);
    } else {
      s.stability = Math.min(1, s.stability + dt * 0.48);
    }

    if (s.stability <= 0.05) {
      const fType: FallType =
        s.speed > 18.2
          ? 'forward'
          : isWhitewater
            ? 'backward'
            : 'sideways';
      const dir = s.balance >= 0 ? 1 : -1;
      this.triggerWipeout(
        s.speed > 18.2 ? 'Lost Control at Speed' : 'Lost Balance',
        fType,
        THREE.MathUtils.clamp(0.55 + s.speed / 28, 0.55, 0.95),
        dir
      );
      return;
    }

    // Barrel Detection & Tube Riding
    if (nextSample.inBarrelZone) {
      if (!s.inBarrel) {
        s.inBarrel = true;
        s.phase = 'barrel';
        s.barrelTimer = 0;
        s.barrelExitedAwarded = false;
        s.targetTimeScale = 0.34;
        s.impactEventIntensity = Math.max(s.impactEventIntensity, 0.25);
        this.triggerCallout('In the Barrel', null);
      }
      s.barrelTimer += dt;
      s.currentWaveBarrelTime += dt;
      const barrelTickPts = Math.round(150 * dt * s.combo);
      s.score += barrelTickPts;
      s.currentWavePoints += barrelTickPts;
      if (s.currentWaveBestManeuverPts < 350) {
        s.currentWaveBestManeuver = 'Tubo';
        s.currentWaveBestManeuverPts = 350;
      }
      s.comboTimer = 1.0;

      if (nextSample.section === 'whitewater' && s.barrelTimer > 0.38) {
        this.triggerWipeout('Pinched in the Tube', 'barrelPinch', 0.98, -wp.breakDir);
        return;
      }
    } else if (s.inBarrel) {
      s.inBarrel = false;
      s.phase = 'riding';
      if (s.barrelTimer > 0.6 && !s.barrelExitedAwarded && nextSample.section !== 'whitewater') {
        s.barrelExitedAwarded = true;
        const pts = Math.round((400 + s.barrelTimer * 260) * s.combo);
        s.score += pts;
        s.currentWavePoints += pts;
        s.currentWaveManeuvers += 1;
        if (pts >= s.currentWaveBestManeuverPts) {
          s.currentWaveBestManeuver = 'Tubo Profundo';
          s.currentWaveBestManeuverPts = pts;
        }
        s.combo = Math.min(8, s.combo + 1);
        s.comboTimer = 1.0;
        s.targetTimeScale = 0.22;
        s.slowMoHoldTimer = 0.55;
        s.justSplashed = true;
        s.splashIntensity = 0.85;
        s.impactEventIntensity = Math.max(s.impactEventIntensity, 0.52);
        s.impactWhitewater = 0.45;
        this.triggerCallout(`Spit Out · +${pts}`, 'Perfect');
      }
    }

    if (input.requestedManeuver && this.cooldownTimer <= 0) {
      this.attemptManeuver(input.requestedManeuver, nextSample);
    }
    void sample;
  }

  private attemptManeuver(type: ManeuverType, sample: WaveSample) {
    const s = this.state;
    const speed = s.speed;
    const balPenalty = Math.abs(s.balance);

    let scoreMetric = 0;

    if (type === 'bottomTurn') {
      const inLowerFace = sample.faceProgress < 0.62;
      if (speed < 6.0) {
        this.failManeuver(type, 'Too slow for Bottom Turn');
        return;
      }
      scoreMetric =
        (inLowerFace ? 0.45 : 0.20) +
        THREE.MathUtils.clamp((speed - 6.0) / 8.0, 0, 0.35) +
        (1 - balPenalty) * 0.25;
      s.maneuverDuration = 0.95;
    } else if (type === 'cutback') {
      const onOpenFace =
        sample.section === 'shoulder' || sample.section === 'face' || sample.section === 'pocket';
      if (!onOpenFace || speed < 6.8) {
        this.failManeuver(
          type,
          speed < 6.8 ? 'Need more speed for Cutback' : 'Wrong section for Cutback'
        );
        return;
      }
      scoreMetric =
        (sample.section === 'shoulder' || sample.section === 'face' ? 0.45 : 0.25) +
        THREE.MathUtils.clamp((speed - 6.8) / 9.0, 0, 0.35) +
        (1 - balPenalty) * 0.25;
      s.maneuverDuration = 1.1;
    } else if (type === 'floater') {
      const nearLip =
        sample.section === 'lip' || sample.section === 'whitewater' || sample.faceProgress > 0.50;
      if (!nearLip || speed < 6.4) {
        this.failManeuver(
          type,
          !nearLip ? 'Must hit the breaking lip' : 'Insufficient speed for Floater'
        );
        return;
      }
      scoreMetric =
        (sample.section === 'lip' ? 0.5 : 0.3) +
        THREE.MathUtils.clamp((speed - 6.4) / 8.5, 0, 0.3) +
        (1 - balPenalty) * 0.25;
      s.maneuverDuration = 1.05;
    } else if (type === 'air') {
      const atLaunchLip =
        sample.section === 'lip' || sample.section === 'pocket' || sample.faceProgress > 0.54;
      if (!atLaunchLip || speed < 8.4) {
        this.failManeuver(
          type,
          speed < 8.4 ? 'Need high speed to launch Air' : 'Launch from the upper lip'
        );
        return;
      }
      scoreMetric =
        (sample.section === 'lip' ? 0.48 : 0.32) +
        THREE.MathUtils.clamp((speed - 8.4) / 9.0, 0, 0.32) +
        (1 - balPenalty) * 0.25;
      s.maneuverDuration = 1.25;
    }

    let quality: ExecutionQuality = 'Basic';
    if (scoreMetric >= 0.80) quality = 'Perfect';
    else if (scoreMetric >= 0.60) quality = 'Good';

    s.activeManeuver = type;
    s.maneuverTimer = 0;
    s.maneuverQuality = quality;
    s.maneuverSpin = 0;
    s.inBarrel = false;
    this.cooldownTimer = 0.45;

    const slowFactor = quality === 'Perfect' ? 0.16 : quality === 'Good' ? 0.24 : 0.34;
    s.targetTimeScale = slowFactor;
    s.slowMoHoldTimer = s.maneuverDuration * 0.85;

    if (type === 'air') {
      s.phase = 'airborne';
      s.airHeight = 0.05;
      const launchBoost = quality === 'Perfect' ? 8.4 : quality === 'Good' ? 7.1 : 5.8;
      s.verticalVel = launchBoost;
      s.justSplashed = true;
      s.splashIntensity = 0.75;
      s.impactEventIntensity = 0.22;
    } else {
      s.phase = 'maneuver';
      s.justSplashed = true;
      s.splashIntensity = quality === 'Perfect' ? 1.0 : 0.72;
      s.impactEventIntensity = quality === 'Perfect' ? 0.30 : 0.20;
    }

    const basePts =
      type === 'air' ? 420 : type === 'cutback' ? 320 : type === 'floater' ? 300 : 240;
    const mult = quality === 'Perfect' ? 1.75 : quality === 'Good' ? 1.3 : 1.0;
    const awarded = Math.round(basePts * mult * s.combo);
    s.score += awarded;
    s.currentWavePoints += awarded;
    s.currentWaveManeuvers += 1;
    if (quality === 'Good' || quality === 'Perfect') {
      s.combo = Math.min(8, s.combo + 1);
    }
    s.comboTimer = 1.0;

    const labelMap: Record<ManeuverType, string> = {
      bottomTurn: 'Bottom Turn',
      cutback: 'Cutback',
      floater: 'Floater',
      air: 'Aerial',
    };
    if (awarded >= s.currentWaveBestManeuverPts) {
      s.currentWaveBestManeuver = `${quality} ${labelMap[type]}`;
      s.currentWaveBestManeuverPts = awarded;
    }
    this.triggerCallout(`${quality} ${labelMap[type]} · +${awarded}`, quality);
  }

  private failManeuver(type: ManeuverType, reason: string) {
    const s = this.state;
    const labelMap: Record<ManeuverType, string> = {
      bottomTurn: 'Bottom Turn',
      cutback: 'Cutback',
      floater: 'Floater',
      air: 'Aerial',
    };

    // Wrong maneuver while already unstable triggers a natural fall
    if (s.stability < 0.45 || Math.abs(s.balance) > 0.65) {
      this.triggerWipeout(
        `${labelMap[type]} Mistimed`,
        type === 'floater' || type === 'air' ? 'backward' : 'sideways',
        0.72,
        s.balance >= 0 ? 1 : -1
      );
      return;
    }

    s.balance += (s.balance >= 0 ? 1 : -1) * 0.48;
    s.stability = Math.max(0.18, s.stability - 0.32);
    s.speed = Math.max(4.0, s.speed * 0.82);
    s.combo = 1;
    s.impactEventIntensity = 0.36;
    this.cooldownTimer = 0.55;
    this.triggerCallout(`Failed ${labelMap[type]} — ${reason}`, 'Failed');
  }

  private stepManeuver(dt: number, input: SurfInputState, sample: WaveSample) {
    const s = this.state;
    const wp = this.waveParams;
    s.maneuverTimer += dt;
    const t = THREE.MathUtils.clamp(s.maneuverTimer / s.maneuverDuration, 0, 1);

    // Turning hard or neglecting balance during maneuver shifts stability dynamically
    const drift =
      s.activeManeuver === 'cutback'
        ? Math.sin(t * Math.PI) * 0.25 * -wp.breakDir
        : s.activeManeuver === 'bottomTurn'
          ? Math.sin(t * Math.PI) * 0.22 * wp.breakDir
          : 0;
    s.balance = THREE.MathUtils.clamp(
      s.balance + (drift + input.balanceAdjust * 1.75) * dt,
      -1.2,
      1.2
    );
    if (input.balanceStabilize) {
      s.balance *= Math.exp(-2.6 * dt);
    }

    if (Math.abs(s.balance) > 1.08 && t > 0.28) {
      this.triggerWipeout(
        'Slipped Out of Turn',
        'sideways',
        0.78,
        s.balance >= 0 ? 1 : -1
      );
      return;
    }

    if (s.activeManeuver === 'bottomTurn') {
      const targetHeading = wp.breakDir * (0.25 + Math.sin(t * Math.PI) * 0.95) - input.moveX * 0.32;
      s.heading = lerpAngle(s.heading, targetHeading, 1 - Math.exp(-8 * dt));
      s.roll = THREE.MathUtils.damp(s.roll, -wp.breakDir * 0.76 * Math.sin(t * Math.PI), 12, dt);
      s.speed = Math.min(20, s.speed + 2.5 * dt);
      s.carvingIntensity = 1.15;
    } else if (s.activeManeuver === 'cutback') {
      const arc = Math.sin(t * Math.PI * 1.15);
      const targetHeading = -wp.breakDir * 1.45 * arc + wp.breakDir * 0.45 - input.moveX * 0.28;
      s.heading = lerpAngle(s.heading, targetHeading, 1 - Math.exp(-7 * dt));
      s.roll = THREE.MathUtils.damp(s.roll, wp.breakDir * 0.72 * Math.sin(t * Math.PI), 11, dt);
      s.carvingIntensity = 1.25;
    } else if (s.activeManeuver === 'floater') {
      const lift = Math.sin(t * Math.PI) * 0.55;
      s.position.z -= Math.cos(t * Math.PI) * 2.5 * dt;
      s.position.y = sample.height + 0.08 + lift;
      s.roll = THREE.MathUtils.damp(s.roll, Math.sin(t * Math.PI * 2) * 0.25, 10, dt);
      s.pitch = THREE.MathUtils.damp(s.pitch, -0.18 + t * 0.42, 10, dt);
      s.carvingIntensity = 0.85;
    }

    const dirX = Math.sin(s.heading);
    const dirZ = Math.cos(s.heading);
    s.velocity.x = dirX * s.speed;
    s.velocity.z = dirZ * s.speed + wp.waveSpeed * 0.22;
    s.position.x += s.velocity.x * dt;
    s.position.z += s.velocity.z * dt;

    const contact = this.sampleBoardContact(s.position.x, s.position.z, s.heading, wp);
    if (s.activeManeuver !== 'floater') {
      s.position.y = THREE.MathUtils.damp(s.position.y, contact.avgY + 0.025, 22, dt);
    }
    s.boardNormal.lerp(contact.blendedNormal, 1 - Math.exp(-14 * dt));

    if (t >= 1.0) {
      const finishedManeuver = s.activeManeuver;
      s.phase = 'riding';
      s.activeManeuver = null;
      s.targetTimeScale = 0.42;
      if (finishedManeuver === 'floater') {
        s.impactEventIntensity = 0.45;
        s.justSplashed = true;
        s.splashIntensity = 0.7;
      }
      if (Math.abs(s.balance) > 0.94) {
        this.triggerWipeout('Lost Control on Exit', 'sideways', 0.74, s.balance >= 0 ? 1 : -1);
      }
    }
  }

  private stepAirborne(dt: number, input: SurfInputState, sample: WaveSample) {
    const s = this.state;
    const wp = this.waveParams;
    s.maneuverTimer += dt;

    s.verticalVel -= 11.8 * dt;
    s.airHeight += s.verticalVel * dt;

    const spinRate = s.maneuverQuality === 'Perfect' ? Math.PI * 2.0 : Math.PI * 1.1;
    s.maneuverSpin = Math.min(Math.PI * 2, s.maneuverSpin + spinRate * dt);
    s.balance = THREE.MathUtils.clamp(
      s.balance + input.moveX * 0.45 * dt + input.balanceAdjust * 1.6 * dt,
      -1.2,
      1.2
    );
    if (input.balanceStabilize) {
      s.balance *= Math.exp(-2.4 * dt);
    }

    const dirX = Math.sin(s.heading);
    const dirZ = Math.cos(s.heading);
    s.position.x += dirX * s.speed * 0.92 * dt;
    s.position.z += (dirZ * s.speed * 0.85 + wp.waveSpeed * 0.45) * dt;

    const waterUnder = sampleSurfWave(s.position.x, s.position.z, wp);
    s.position.y = waterUnder.height + Math.max(0.025, s.airHeight);
    s.pitch = THREE.MathUtils.damp(
      s.pitch,
      THREE.MathUtils.clamp(-s.verticalVel * 0.06, -0.45, 0.45),
      8,
      dt
    );

    if (s.airHeight <= 0.02 && s.verticalVel < 0) {
      s.airHeight = 0;
      s.verticalVel = 0;
      s.maneuverSpin = 0;
      s.justSplashed = true;
      s.splashIntensity = 1.15;
      s.targetTimeScale = 0.42;

      if (Math.abs(s.balance) > 0.76 || waterUnder.section === 'flat') {
        this.triggerWipeout(
          waterUnder.section === 'flat' ? 'Flat Water Slam' : 'Rough Air Landing',
          'forward',
          0.88,
          s.balance >= 0 ? 1 : -1
        );
      } else {
        s.phase = 'riding';
        s.activeManeuver = null;
        s.speed = Math.min(21, s.speed * 1.08);
        s.impactEventIntensity = 0.54; // Medium splash impact on clean air landing
        s.impactWhitewater = 0.28;
      }
    }
    void sample;
  }

  private triggerWipeout(
    reason: string,
    fallType: FallType = 'sideways',
    intensity = 0.78,
    fallDir = 1
  ) {
    const s = this.state;
    s.phase = 'wipeout';
    s.wipeoutTimer = 0;
    s.wipeoutSplashTriggered = false;
    s.fallType = fallType;
    s.fallDir = fallDir >= 0 ? 1 : -1;
    s.fallIntensity = THREE.MathUtils.clamp(intensity, 0.35, 1.0);
    s.submersionDepth = 0;
    s.activeManeuver = null;
    s.inBarrel = false;
    s.combo = 1;
    s.comboTimer = 0;
    s.targetTimeScale = 0.72;
    s.slowMoHoldTimer = 0.42;
    this.whitewaterExposure = 0;

    // Separate the surfboard from the surfer cleanly!
    s.boardDetached = true;
    s.boardPos.copy(s.position);
    s.boardHeading = s.heading;
    s.boardRoll = s.roll;
    s.boardPitch = s.pitch;
    this.commitCurrentWaveIfScored();

    const fwdX = Math.sin(s.heading);
    const fwdZ = Math.cos(s.heading);
    const sideX = Math.cos(s.heading) * s.fallDir;
    const sideZ = -Math.sin(s.heading) * s.fallDir;

    // Board shoots away in opposite direction of surfer's body ejection
    s.boardVel.set(
      s.velocity.x * 0.72 - sideX * (2.2 + s.fallIntensity * 1.8) + fwdX * 2.2,
      0,
      s.velocity.z * 0.72 - sideZ * (2.2 + s.fallIntensity * 1.8) + fwdZ * 2.2
    );

    // Surfer tumbles in fall direction
    s.velocity.set(
      s.velocity.x * 0.45 + sideX * (2.4 + s.fallIntensity * 1.6),
      0,
      s.velocity.z * 0.45 + sideZ * (2.4 + s.fallIntensity * 1.6)
    );
    s.verticalVel = fallType === 'lipSlam' || fallType === 'forward' ? 2.4 : 1.5;

    s.justSplashed = true;
    s.splashIntensity = 0.75 + s.fallIntensity * 0.55;
    s.impactEventIntensity = THREE.MathUtils.clamp(0.45 + s.fallIntensity * 0.45, 0.45, 0.95);
    s.impactWhitewater = fallType === 'lipSlam' || fallType === 'barrelPinch' ? 0.85 : 0.45;
    this.triggerCallout(`Wipeout — ${reason}`, 'Failed');
  }

  private stepWipeout(dt: number, sample: WaveSample) {
    const s = this.state;
    const wp = this.waveParams;
    s.wipeoutTimer += dt;
    const wt = s.wipeoutTimer;

    // 1. Ejection & impact entry -> brief underwater plunge -> resurfacing
    s.velocity.multiplyScalar(Math.exp(-2.4 * dt));
    s.position.x += s.velocity.x * dt;
    s.position.z += (s.velocity.z + wp.waveSpeed * 0.25) * dt;
    s.position.x = THREE.MathUtils.clamp(s.position.x, -45, 65);
    if (s.position.z > 8.8) {
      s.position.z = 8.8;
    }

    const waterHere = sampleSurfWave(s.position.x, s.position.z, wp);

    let targetSubmersion = 0;
    if (wt < 0.46) {
      // Thrown off board just above water
      s.verticalVel -= 11.5 * dt;
      s.airHeight = Math.max(0, s.airHeight + s.verticalVel * dt);
      targetSubmersion = 0;
    } else if (wt < 1.38) {
      // Splash entry & underwater tumble
      if (!s.wipeoutSplashTriggered) {
        s.wipeoutSplashTriggered = true;
        s.justSplashed = true;
        s.splashIntensity = 1.05 + s.fallIntensity * 0.35;
        s.impactEventIntensity = THREE.MathUtils.clamp(0.65 + s.fallIntensity * 0.35, 0.65, 1.0);
        s.impactWhitewater = 0.92;
      }
      s.airHeight = 0;
      const underP = (wt - 0.46) / 0.92;
      targetSubmersion = Math.sin(underP * Math.PI) * (0.68 + s.fallIntensity * 0.42);
    } else {
      // Rising back to surface
      const surfP = THREE.MathUtils.clamp((wt - 1.38) / 0.65, 0, 1);
      targetSubmersion = (1 - surfP) * 0.22;
      if (surfP > 0.35 && s.underwaterAmount > 0.25 && !s.justResurfaced) {
        s.justResurfaced = true;
        s.justSplashed = true;
        s.splashIntensity = 0.55;
      }
    }

    s.submersionDepth = THREE.MathUtils.damp(s.submersionDepth, targetSubmersion, 10, dt);
    s.underwaterAmount = THREE.MathUtils.clamp(s.submersionDepth / 0.42, 0, 1);
    s.position.y = waterHere.height + s.airHeight - s.submersionDepth;
    s.speed = Math.hypot(s.velocity.x, s.velocity.z);

    if (wt >= 2.08) {
      s.phase = 'recovering';
      s.recoverTimer = 0;
      s.submersionDepth = 0;
      s.underwaterAmount = 0;
      s.targetTimeScale = 1.0;
      s.justResurfaced = true;
      this.triggerCallout('Swim back to your board', null);
    }
    void sample;
  }

  private stepRecovering(
    dt: number,
    input: SurfInputState,
    camFwdX: number,
    camFwdZ: number,
    camRightX: number,
    camRightZ: number,
    sample: WaveSample,
    isFirstPerson: boolean
  ) {
    const s = this.state;
    s.recoverTimer += dt;
    s.submersionDepth = THREE.MathUtils.damp(s.submersionDepth, 0, 8, dt);
    s.underwaterAmount = THREE.MathUtils.damp(s.underwaterAmount, 0, 8, dt);

    if (isFirstPerson) {
      if (Math.abs(input.moveX) > 0.08) {
        s.heading -= input.moveX * 2.35 * dt;
      }
      if (Math.abs(input.moveY) > 0.08) {
        const swimForce = 9.5 * input.moveY;
        s.velocity.x += Math.sin(s.heading) * swimForce * dt;
        s.velocity.z += Math.cos(s.heading) * swimForce * dt;
      } else {
        const dx = s.boardPos.x - s.position.x;
        const dz = s.boardPos.z - s.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 1.2 && Math.abs(input.moveX) <= 0.08) {
          s.heading = lerpAngle(s.heading, Math.atan2(dx, dz), 1 - Math.exp(-2.8 * dt));
        }
      }
    } else {
      // Player controls swimmer direction toward their floating board
      const moveVecX = camRightX * input.moveX + camFwdX * input.moveY;
      const moveVecZ = camRightZ * input.moveX + camFwdZ * input.moveY;
      const inputMag = Math.min(1, Math.hypot(input.moveX, input.moveY));

      if (inputMag > 0.08) {
        const targetHeading = Math.atan2(moveVecX, moveVecZ);
        s.heading = lerpAngle(s.heading, targetHeading, 1 - Math.exp(-7 * dt));
        const swimForce = 9.5 * inputMag;
        s.velocity.x += Math.sin(s.heading) * swimForce * dt;
        s.velocity.z += Math.cos(s.heading) * swimForce * dt;
      } else {
        // Gentle leash/current drift toward the board if player is stationary
        const dx = s.boardPos.x - s.position.x;
        const dz = s.boardPos.z - s.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 1.2) {
          s.heading = lerpAngle(s.heading, Math.atan2(dx, dz), 1 - Math.exp(-3.5 * dt));
        }
      }
    }

    s.velocity.multiplyScalar(Math.exp(-2.4 * dt));
    s.position.x += s.velocity.x * dt;
    s.position.z += s.velocity.z * dt;
    s.position.x = THREE.MathUtils.clamp(s.position.x, -45, 65);
    if (s.position.z > 8.8) {
      s.position.z = 8.8;
    }

    s.position.y = THREE.MathUtils.damp(s.position.y, sample.height - 0.14, 12, dt);
    s.speed = Math.hypot(s.velocity.x, s.velocity.z);
    s.paddleStrokePhase += dt * (3.0 + s.speed * 0.9);
    s.boardNormal.set(0, 1, 0);
    s.roll = THREE.MathUtils.damp(s.roll, 0, 8, dt);
    s.pitch = THREE.MathUtils.damp(s.pitch, 0, 8, dt);

    const distToBoard = Math.hypot(s.boardPos.x - s.position.x, s.boardPos.z - s.position.z);
    if (distToBoard < 1.65 || s.recoverTimer > 3.6) {
      // Reclaim board smoothly and resume paddling in the lineup!
      s.boardDetached = false;
      s.phase = 'paddling';
      s.heading = Math.PI;
      s.balance = 0;
      s.stability = 1.0;
      s.justSplashed = true;
      s.splashIntensity = 0.45;
      s.impactEventIntensity = 0.18;

      if (this.waveParams.waveCenterZ > s.position.z - 8) {
        this.spawnNextWave(false, 'paddling');
      } else {
        this.triggerCallout('Back on Board — Paddle for the Wave', null);
      }
    }
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
