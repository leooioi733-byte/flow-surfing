import * as THREE from 'three';
import { SurfboardSpec, SurferProfile } from '../types/game';
import { createSurfboardGroup } from './coastalEnvironment';
import { SurferPhysicsState } from './wavePhysics';

export interface SurferRig {
  root: THREE.Group;
  characterGroup: THREE.Group;
  boardContainer: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  leftShoulder: THREE.Group;
  leftElbow: THREE.Group;
  rightShoulder: THREE.Group;
  rightElbow: THREE.Group;
  leftHip: THREE.Group;
  leftKnee: THREE.Group;
  rightHip: THREE.Group;
  rightKnee: THREE.Group;
  updateBoard: (spec: SurfboardSpec) => void;
  updateProfile: (profile: SurferProfile) => void;
  setFirstPersonMode: (enabled: boolean) => void;
  getFirstPersonPose: (
    state: SurferPhysicsState,
    lookYawOffset: number,
    lookPitchOffset: number,
    outEyePos: THREE.Vector3,
    outQuat: THREE.Quaternion
  ) => void;
  animate: (state: SurferPhysicsState, time: number, dt: number) => void;
  dispose: () => void;
}

const _up = new THREE.Vector3(0, 1, 0);
const _alignQuat = new THREE.Quaternion();
const _yawQuat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _pitchQuat = new THREE.Quaternion();
const _spinQuat = new THREE.Quaternion();
const _bankQuat = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _xAxis = new THREE.Vector3(1, 0, 0);
const _fpTarget = new THREE.Vector3();
const _fpFwd = new THREE.Vector3();
const _fpUpVec = new THREE.Vector3();
const _fpLookMat = new THREE.Matrix4();

/**
 * Hierarchical articulated 3D surfer character standing/paddling on the active surfboard,
 * with independent detached-board transforms during wipeout & swim recovery and an accurate
 * head/eye anchor for seamless first-person surfing.
 */
export function createSurferRig(
  initialBoard: SurfboardSpec,
  initialProfile: SurferProfile
): SurferRig {
  const root = new THREE.Group();

  // Surfboard container is a sibling of characterGroup so the board can separate
  // and react independently to the ocean surface after a wipeout.
  const boardContainer = new THREE.Group();
  root.add(boardContainer);

  let boardMesh = createSurfboardGroup(initialBoard);
  boardContainer.add(boardMesh);

  const characterGroup = new THREE.Group();
  root.add(characterGroup);

  const suitMat = new THREE.MeshStandardMaterial({
    color: initialProfile.suitColor,
    roughness: 0.72,
    metalness: 0.05,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: initialProfile.accentColor,
    roughness: 0.55,
    metalness: 0.08,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    color: initialProfile.skinTone ?? '#c98e6b',
    roughness: 0.62,
    metalness: 0.0,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: initialProfile.hairColor ?? '#1e1916',
    roughness: 0.88,
    metalness: 0.0,
  });

  // Character rig mounted inside characterGroup
  const hips = new THREE.Group();
  hips.position.set(0, 0.92, -0.05);
  characterGroup.add(hips);

  // Pelvis
  const pelvisMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.1, 6, 12), suitMat);
  pelvisMesh.rotation.z = Math.PI / 2;
  pelvisMesh.castShadow = true;
  hips.add(pelvisMesh);

  // Torso
  const torso = new THREE.Group();
  torso.position.set(0, 0.08, 0);
  hips.add(torso);

  const chestMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.145, 0.28, 8, 14), suitMat);
  chestMesh.position.set(0, 0.22, 0);
  chestMesh.scale.set(1.15, 1.0, 0.78);
  chestMesh.castShadow = true;
  torso.add(chestMesh);

  // Wetsuit chest stripe accent
  const chestBand = new THREE.Mesh(new THREE.CylinderGeometry(0.152, 0.142, 0.11, 14), accentMat);
  chestBand.position.set(0, 0.29, 0);
  chestBand.scale.set(1.12, 1.0, 0.78);
  torso.add(chestBand);

  // Head & Neck
  const head = new THREE.Group();
  head.position.set(0, 0.45, 0);
  torso.add(head);

  const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.055, 0.1, 10), skinMat);
  neckMesh.position.y = 0.04;
  head.add(neckMesh);

  const skullMesh = new THREE.Mesh(new THREE.SphereGeometry(0.105, 16, 14), skinMat);
  skullMesh.position.y = 0.16;
  skullMesh.scale.set(0.92, 1.08, 0.98);
  skullMesh.castShadow = true;
  head.add(skullMesh);

  const hairMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
    hairMat
  );
  hairMesh.position.set(0, 0.17, -0.01);
  hairMesh.rotation.x = -0.18;
  head.add(hairMesh);

  // Exact eye-bridge anchor inside head coordinate frame for clip-free 1P camera
  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.position.set(0, 0.21, 0.085);
  head.add(eyeAnchor);

  // Helper for articulated arms
  function buildArm(side: number) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.2, 0.36, 0);
    torso.add(shoulder);

    const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.22, 6, 10), suitMat);
    upperArm.position.y = -0.13;
    upperArm.castShadow = true;
    shoulder.add(upperArm);

    const elbow = new THREE.Group();
    elbow.position.set(0, -0.26, 0);
    shoulder.add(elbow);

    const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.21, 6, 10), skinMat);
    forearm.position.y = -0.12;
    forearm.castShadow = true;
    elbow.add(forearm);

    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.042, 8, 8), skinMat);
    hand.position.y = -0.25;
    hand.scale.set(0.85, 1.25, 0.65);
    elbow.add(hand);

    return { shoulder, elbow };
  }

  const { shoulder: leftShoulder, elbow: leftElbow } = buildArm(-1);
  const { shoulder: rightShoulder, elbow: rightElbow } = buildArm(1);

  // Helper for articulated legs
  function buildLeg(side: number) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.095, -0.04, 0);
    hips.add(hip);

    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.068, 0.3, 6, 12), suitMat);
    thigh.position.y = -0.18;
    thigh.castShadow = true;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.set(0, -0.37, 0);
    hip.add(knee);

    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.32, 6, 12), suitMat);
    shin.position.y = -0.19;
    shin.castShadow = true;
    knee.add(shin);

    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.05, 0.21), skinMat);
    foot.position.set(0, -0.4, 0.05);
    knee.add(foot);

    return { hip, knee };
  }

  const { hip: leftHip, knee: leftKnee } = buildLeg(-1);
  const { hip: rightHip, knee: rightKnee } = buildLeg(1);

  let isGoofy = initialProfile.stance === 'Goofy';
  let currentBoardId = initialBoard.id;
  let lastProfileKey = `${initialProfile.suitColor}|${initialProfile.accentColor}|${initialProfile.skinTone ?? ''}|${initialProfile.hairColor ?? ''}|${initialProfile.stance}`;

  const updateBoard = (spec: SurfboardSpec) => {
    if (spec.id === currentBoardId) return;
    boardContainer.remove(boardMesh);
    boardMesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
    boardMesh = createSurfboardGroup(spec);
    boardContainer.add(boardMesh);
    currentBoardId = spec.id;
  };

  const updateProfile = (profile: SurferProfile) => {
    const nextKey = `${profile.suitColor}|${profile.accentColor}|${profile.skinTone ?? ''}|${profile.hairColor ?? ''}|${profile.stance}`;
    if (nextKey === lastProfileKey) return;
    lastProfileKey = nextKey;
    suitMat.color.set(profile.suitColor);
    accentMat.color.set(profile.accentColor);
    skinMat.color.set(profile.skinTone ?? '#c98e6b');
    hairMat.color.set(profile.hairColor ?? '#1e1916');
    isGoofy = profile.stance === 'Goofy';
  };

  const setFirstPersonMode = (enabled: boolean) => {
    const bodyVisible = !enabled;
    neckMesh.visible = bodyVisible;
    skullMesh.visible = bodyVisible;
    hairMesh.visible = bodyVisible;
    chestMesh.visible = bodyVisible;
    chestBand.visible = bodyVisible;
  };

  const getFirstPersonPose = (
    state: SurferPhysicsState,
    lookYawOffset: number,
    lookPitchOffset: number,
    outEyePos: THREE.Vector3,
    outQuat: THREE.Quaternion
  ) => {
    root.updateMatrixWorld(true);
    eyeAnchor.getWorldPosition(outEyePos);

    if (state.phase === 'paddling' || state.phase === 'duckDive' || state.phase === 'recovering') {
      outEyePos.y += 0.07;
    }

    const fwdX = Math.sin(state.heading);
    const fwdZ = Math.cos(state.heading);

    if (state.phase === 'wipeout') {
      const wt = state.wipeoutTimer;
      const intensity = state.fallIntensity;
      const tumbleWave = Math.sin(wt * 6.5) * 0.45 * intensity;
      const basePitch =
        wt < 1.38
          ? -0.28 + Math.cos(wt * 5.2) * 0.35 * intensity
          : THREE.MathUtils.lerp(-0.24, -0.08, THREE.MathUtils.clamp((wt - 1.38) / 0.65, 0, 1));
      const yaw = state.heading + tumbleWave * 0.45 + lookYawOffset;
      const pitch = THREE.MathUtils.clamp(basePitch + lookPitchOffset, -0.95, 0.95);
      const cosP = Math.cos(pitch);

      _fpFwd
        .set(Math.sin(yaw) * cosP, Math.sin(pitch), Math.cos(yaw) * cosP)
        .normalize();
      _fpUpVec
        .set(Math.sin(tumbleWave) * 0.42 * state.fallDir, 1.0, Math.cos(wt * 4.8) * 0.18)
        .normalize();
      _fpTarget.copy(outEyePos).add(_fpFwd);
      _fpLookMat.lookAt(outEyePos, _fpTarget, _fpUpVec);
      outQuat.setFromRotationMatrix(_fpLookMat);
      return;
    }

    // Standard surfing / walking / paddling / recovering 1P pose + full free-look offset
    let baseYaw = state.heading;
    if (state.phase === 'recovering' && Math.abs(lookYawOffset) < 0.05) {
      const dx = state.boardPos.x - outEyePos.x;
      const dz = state.boardPos.z - outEyePos.z;
      if (Math.hypot(dx, dz) > 0.45) {
        baseYaw = Math.atan2(dx, dz);
      }
    } else if (state.phase === 'riding' || state.phase === 'maneuver' || state.phase === 'barrel') {
      baseYaw = state.heading - state.roll * 0.22;
    }

    const baseDownPitch =
      state.phase === 'beachWalk'
        ? -0.07
        : state.phase === 'duckDive'
          ? -0.18
          : state.phase === 'paddling' || state.phase === 'recovering'
            ? -0.10
            : state.phase === 'barrel'
              ? -0.09
              : state.phase === 'airborne'
                ? -0.18
                : -0.14;

    const viewYaw = baseYaw + lookYawOffset;
    const viewPitch = THREE.MathUtils.clamp(
      baseDownPitch - THREE.MathUtils.clamp(state.pitch * 0.55, -0.22, 0.22) + lookPitchOffset,
      -0.88,
      0.92
    );

    const cosP = Math.cos(viewPitch);
    _fpFwd
      .set(Math.sin(viewYaw) * cosP, Math.sin(viewPitch), Math.cos(viewYaw) * cosP)
      .normalize();

    const bankScale = Math.cos(THREE.MathUtils.clamp(lookYawOffset, -Math.PI * 0.5, Math.PI * 0.5));
    const bankAmount =
      state.phase === 'riding' || state.phase === 'maneuver' || state.phase === 'barrel'
        ? -state.roll * 0.28 * bankScale
        : state.phase === 'airborne'
          ? -state.roll * 0.18 * bankScale
          : 0;
    _fpUpVec.copy(_up).applyQuaternion(_bankQuat.setFromAxisAngle(_fpFwd, bankAmount));

    void fwdX;
    void fwdZ;
    _fpTarget.copy(outEyePos).add(_fpFwd);
    _fpLookMat.lookAt(outEyePos, _fpTarget, _fpUpVec);
    outQuat.setFromRotationMatrix(_fpLookMat);
  };

  const damp = THREE.MathUtils.damp;

  const animate = (state: SurferPhysicsState, time: number, dt: number) => {
    // 1. Position and orient character & surfboard independently when separated
    characterGroup.position.copy(state.position);

    if (state.boardDetached) {
      // Independent surfboard reacts directly to wave swells & curl
      boardContainer.position.copy(state.boardPos);
      _alignQuat.setFromUnitVectors(_up, state.boardNormal);
      _yawQuat.setFromAxisAngle(_yAxis, state.boardHeading);
      _rollQuat.setFromAxisAngle(_zAxis, state.boardRoll);
      _pitchQuat.setFromAxisAngle(_xAxis, state.boardPitch);
      boardContainer.quaternion
        .copy(_alignQuat)
        .multiply(_yawQuat)
        .multiply(_rollQuat)
        .multiply(_pitchQuat);

      // Character swims/tumbles independently by heading
      _yawQuat.setFromAxisAngle(_yAxis, state.heading);
      characterGroup.quaternion.copy(_yawQuat);
    } else {
      boardContainer.position.copy(state.position);
      _alignQuat.setFromUnitVectors(_up, state.boardNormal);
      _yawQuat.setFromAxisAngle(_yAxis, state.heading);
      _rollQuat.setFromAxisAngle(_zAxis, state.roll);
      _pitchQuat.setFromAxisAngle(_xAxis, state.pitch);
      _spinQuat.setFromAxisAngle(_yAxis, state.maneuverSpin);

      boardContainer.quaternion
        .copy(_alignQuat)
        .multiply(_yawQuat)
        .multiply(_spinQuat)
        .multiply(_rollQuat)
        .multiply(_pitchQuat);

      characterGroup.quaternion.copy(boardContainer.quaternion);
    }

    // 2. Procedural body posture per surfing phase
    const stanceSign = isGoofy ? -1 : 1;
    const speedFactor = THREE.MathUtils.clamp(state.speed / 16, 0, 1);

    let hipsY = 0.84;
    let hipsZ = -0.05;
    let hipsRotX = 0;
    let hipsRotY = stanceSign * 1.15;
    let hipsRotZ = 0;
    let torsoRotX = 0.22;
    let torsoRotY = 0;
    let torsoRotZ = 0;
    let headRotY = -hipsRotY * 0.82;
    let headRotX = -0.12;

    let lHipX = -0.45;
    let lKneeX = 0.85;
    let rHipX = -0.55;
    let rKneeX = 0.92;

    let lShX = -0.4;
    let lShZ = -0.55;
    let lElbX = -0.6;
    let rShX = -0.35;
    let rShZ = 0.65;
    let rElbX = -0.5;

    let boardOffsetX = 0;
    let boardOffsetY = 0;
    let boardOffsetZ = 0;
    let boardRotX = 0;
    let boardRotY = 0;
    let boardRotZ = 0;

    if (state.phase === 'beachWalk') {
      // Standing/walking on the beach carrying the surfboard tucked under the right arm
      const walkBlend = THREE.MathUtils.clamp(state.speed / 2.2, 0, 1);
      const stride = Math.sin(state.walkPhase) * walkBlend;
      const strideOpp = Math.sin(state.walkPhase + Math.PI) * walkBlend;

      hipsY = 0.87 + Math.abs(Math.sin(state.walkPhase)) * 0.032 * walkBlend;
      hipsZ = 0;
      hipsRotX = 0.04 * walkBlend;
      hipsRotY = 0;
      torsoRotX = 0.06 * walkBlend;
      torsoRotY = -stride * 0.08;
      torsoRotZ = stride * 0.03;
      headRotY = 0;
      headRotX = -0.04;

      // Alternating walking leg stride
      lHipX = stride * 0.52;
      lKneeX = Math.max(0.08, -stride * 0.45 + 0.22 * walkBlend);
      rHipX = strideOpp * 0.52;
      rKneeX = Math.max(0.08, -strideOpp * 0.45 + 0.22 * walkBlend);

      // Left arm swings naturally while right arm cradles the surfboard at the hip
      lShX = strideOpp * 0.48 - 0.08;
      lShZ = -0.22;
      lElbX = -0.28 - Math.max(0, strideOpp) * 0.25;

      rShX = -0.24;
      rShZ = 0.40;
      rElbX = -1.24;

      // Surfboard tucked edge-on under the surfer's right arm (slightly clear for 1P view)
      boardOffsetX = 0.34;
      boardOffsetY = 0.86 + Math.abs(Math.sin(state.walkPhase)) * 0.025 * walkBlend;
      boardOffsetZ = 0.08;
      boardRotX = 0.14;
      boardRotY = 0.05;
      boardRotZ = -1.34;
    } else if (state.phase === 'paddling') {
      // Prone on the board paddling with alternating crawl strokes
      hipsY = 0.14;
      hipsZ = -0.18;
      hipsRotX = 1.48;
      hipsRotY = 0;
      torsoRotX = -0.28; // chest arched up looking forward
      headRotY = 0;
      headRotX = -0.55;

      lHipX = 0.08;
      lKneeX = 0.12;
      rHipX = 0.08;
      rKneeX = 0.12;

      const stroke = state.paddleStrokePhase;
      lShX = -2.2 + Math.sin(stroke) * 1.25;
      lShZ = -0.38;
      lElbX = -0.35 - Math.max(0, Math.cos(stroke)) * 0.7;

      rShX = -2.2 + Math.sin(stroke + Math.PI) * 1.25;
      rShZ = 0.38;
      rElbX = -0.35 - Math.max(0, Math.cos(stroke + Math.PI)) * 0.7;
      torsoRotZ = Math.sin(stroke) * 0.14;
    } else if (state.phase === 'duckDive') {
      // Compact submerged duck dive: arms gripping forward rails, rear knee pressing tail
      const t = THREE.MathUtils.clamp(state.duckDiveTimer / 1.1, 0, 1);
      const pushPulse = Math.sin(t * Math.PI);
      hipsY = 0.15;
      hipsZ = -0.14;
      hipsRotX = 1.46;
      hipsRotY = 0;
      torsoRotX = 0.14 - (1 - pushPulse) * 0.22;
      headRotY = 0;
      headRotX = -0.35;

      lHipX = 0.06;
      lKneeX = 0.12;
      rHipX = -0.62 * pushPulse + 0.08 * (1 - pushPulse);
      rKneeX = 1.24 * pushPulse + 0.12 * (1 - pushPulse);

      lShX = -2.35;
      lShZ = -0.28;
      lElbX = -0.45;
      rShX = -2.35;
      rShZ = 0.28;
      rElbX = -0.45;
    } else if (state.phase === 'takeoff') {
      // Dynamic pop-up transition from prone to crouched surf stance
      const p = THREE.MathUtils.clamp(state.takeoffTimer / 0.42, 0, 1);
      hipsY = THREE.MathUtils.lerp(0.24, 0.72, p);
      hipsRotX = THREE.MathUtils.lerp(1.15, 0.15, p);
      torsoRotX = 0.48;
      lHipX = -0.95;
      lKneeX = 1.55;
      rHipX = -0.85;
      rKneeX = 1.45;
      lShX = -0.85;
      rShX = -0.85;
    } else if (state.phase === 'barrel') {
      // Compact low crouch inside the curling tube, trailing hand brushing the water wall
      hipsY = 0.63;
      hipsRotX = 0.25;
      torsoRotX = 0.56;
      torsoRotZ = state.roll * 0.35;
      lHipX = -1.05;
      lKneeX = 1.72;
      rHipX = -0.95;
      rKneeX = 1.62;
      lShX = -0.55;
      lShZ = -0.95;
      lElbX = -0.25;
      rShX = -0.85;
      rShZ = 0.45;
      rElbX = -0.9;
    } else if (state.phase === 'maneuver') {
      const mProgress = THREE.MathUtils.clamp(state.maneuverTimer / state.maneuverDuration, 0, 1);
      if (state.activeManeuver === 'bottomTurn') {
        const comp = Math.sin(mProgress * Math.PI);
        hipsY = 0.78 - comp * 0.18;
        torsoRotX = 0.35 + comp * 0.35;
        torsoRotZ = -state.roll * 0.45;
        lHipX = -0.8 - comp * 0.3;
        lKneeX = 1.3 + comp * 0.45;
        rHipX = -0.75 - comp * 0.3;
        rKneeX = 1.25 + comp * 0.45;
        rShX = -0.2;
        rShZ = 1.15 * comp + 0.4;
        lShX = -1.1;
        lShZ = -0.85;
      } else if (state.activeManeuver === 'cutback') {
        const whip = Math.sin(mProgress * Math.PI);
        hipsY = 0.74;
        torsoRotY = -stanceSign * whip * 0.95;
        torsoRotX = 0.42;
        headRotY = -hipsRotY * 0.6 - torsoRotY * 0.5;
        lShX = -0.75;
        lShZ = -1.25;
        rShX = -0.55;
        rShZ = 1.15;
      } else if (state.activeManeuver === 'floater') {
        hipsY = 0.72;
        torsoRotX = 0.48;
        lHipX = -0.92;
        lKneeX = 1.55;
        rHipX = -0.92;
        rKneeX = 1.55;
        lShX = -0.65;
        lShZ = -1.1;
        rShX = -0.65;
        rShZ = 1.1;
      }
    } else if (state.phase === 'airborne') {
      // Mid-air tucked grab pose
      hipsY = 0.70;
      torsoRotX = 0.58;
      lHipX = -1.15;
      lKneeX = 1.85;
      rHipX = -1.05;
      rKneeX = 1.75;
      lShX = -1.1;
      lShZ = -0.35;
      lElbX = -0.55;
      rShX = -0.6;
      rShZ = 1.2;
      rElbX = -0.4;
    } else if (state.phase === 'wipeout') {
      // Directional fall, water entry tumble, and resurfacing animations
      const wt = state.wipeoutTimer;
      const inten = state.fallIntensity;
      const dir = state.fallDir;

      if (wt < 0.46) {
        // Phase A: Losing balance / thrown off board depending on fall type
        const eject = wt / 0.46;
        hipsY = 0.62 - eject * 0.25;
        hipsZ = 0;

        if (state.fallType === 'forward') {
          hipsRotX = 0.65 + eject * 1.45;
          torsoRotX = 0.65;
          headRotX = -0.25;
          lShX = -1.9;
          rShX = -1.9;
          lShZ = -0.65;
          rShZ = 0.65;
          lHipX = 0.25;
          rHipX = 0.15;
        } else if (state.fallType === 'backward') {
          hipsRotX = -0.75 - eject * 1.15;
          torsoRotX = -0.45;
          headRotX = 0.25;
          lShX = -2.35;
          rShX = -2.25;
          lShZ = -0.8;
          rShZ = 0.8;
          lHipX = -0.95;
          rHipX = -0.75;
        } else if (state.fallType === 'lipSlam' || state.fallType === 'barrelPinch') {
          hipsRotX = -0.4 + Math.sin(wt * 12) * 1.1 * inten;
          hipsRotZ = dir * (0.95 + eject * 1.3);
          hipsRotY = stanceSign * 0.6 + dir * wt * 4.2;
          torsoRotZ = dir * 0.55;
          lShX = -1.8 + Math.sin(wt * 15) * 0.8;
          rShX = -1.6 + Math.cos(wt * 14) * 0.8;
          lShZ = -1.1;
          rShZ = 1.1;
          lHipX = -0.4;
          rHipX = -0.9;
        } else {
          // 'sideways'
          hipsRotZ = dir * (0.65 + eject * 1.15);
          torsoRotZ = dir * 0.42;
          hipsRotX = 0.35;
          lShX = -1.5;
          rShX = -1.5;
          lShZ = -1.2;
          rShZ = 1.2;
          lHipX = -0.5;
          rHipX = -0.8;
        }
      } else if (wt < 1.38) {
        // Phase B: Submerged tumble under breaking wave turbulence
        const underP = wt - 0.46;
        hipsY = 0.22;
        hipsZ = 0;
        hipsRotX = 0.8 + Math.sin(underP * 6.5) * 1.15 * inten;
        hipsRotY = dir * underP * 2.4;
        hipsRotZ = Math.cos(underP * 5.8) * 1.25 * inten;
        torsoRotX = Math.sin(underP * 7.2) * 0.45;
        torsoRotZ = Math.cos(underP * 6.4) * 0.55;
        headRotY = 0;
        headRotX = 0.1;
        lShX = -1.4 + Math.sin(underP * 11) * 0.9;
        rShX = -1.4 + Math.cos(underP * 10) * 0.9;
        lShZ = -0.75;
        rShZ = 0.75;
        lHipX = -0.35 + Math.sin(underP * 9) * 0.45;
        rHipX = -0.45 + Math.cos(underP * 9) * 0.45;
      } else {
        // Phase C: Resurfacing kick back to ocean surface
        const surfP = THREE.MathUtils.clamp((wt - 1.38) / 0.65, 0, 1);
        hipsY = THREE.MathUtils.lerp(0.2, 0.16, surfP);
        hipsZ = 0;
        hipsRotX = THREE.MathUtils.lerp(0.75, 1.15, surfP);
        hipsRotY = 0;
        hipsRotZ = 0;
        torsoRotX = -0.25;
        headRotY = 0;
        headRotX = -0.45;
        lShX = -1.35 + Math.sin(time * 9) * 0.55;
        rShX = -1.35 + Math.cos(time * 9) * 0.55;
        lShZ = -0.55;
        rShZ = 0.55;
        lHipX = Math.sin(time * 12) * 0.35;
        rHipX = Math.sin(time * 12 + Math.PI) * 0.35;
      }
    } else if (state.phase === 'recovering') {
      // Freestyle swimming back to floating surfboard
      const stroke = state.paddleStrokePhase;
      const swimActive = THREE.MathUtils.clamp(state.speed / 1.8, 0.25, 1.0);
      hipsY = 0.08;
      hipsZ = -0.05;
      hipsRotX = 1.44;
      hipsRotY = 0;
      hipsRotZ = Math.sin(stroke) * 0.12 * swimActive;
      torsoRotX = -0.24;
      torsoRotZ = Math.sin(stroke) * 0.18 * swimActive;
      headRotY = 0;
      headRotX = -0.55;

      // Flutter kick
      lHipX = Math.sin(stroke * 2.1) * 0.34 * swimActive;
      lKneeX = 0.18 + Math.max(0, -Math.sin(stroke * 2.1)) * 0.28 * swimActive;
      rHipX = Math.sin(stroke * 2.1 + Math.PI) * 0.34 * swimActive;
      rKneeX = 0.18 + Math.max(0, -Math.sin(stroke * 2.1 + Math.PI)) * 0.28 * swimActive;

      // Alternating crawl arms
      lShX = -2.1 + Math.sin(stroke) * 1.25 * swimActive;
      lShZ = -0.35;
      lElbX = -0.3 - Math.max(0, Math.cos(stroke)) * 0.65 * swimActive;

      rShX = -2.1 + Math.sin(stroke + Math.PI) * 1.25 * swimActive;
      rShZ = 0.35;
      rElbX = -0.3 - Math.max(0, Math.cos(stroke + Math.PI)) * 0.65 * swimActive;
    } else {
      // Active 'riding' stance with organic weight shifting & balance counter-lean
      const breathe = Math.sin(time * 2.4) * 0.025;
      hipsY = 0.80 - speedFactor * 0.07 + breathe;
      torsoRotX = 0.24 + speedFactor * 0.14;
      torsoRotZ = -state.roll * 0.45 + state.balance * 0.32;
      hipsRotZ = state.balance * 0.18;

      lShZ = -0.65 - state.balance * 0.55 + Math.sin(time * 2.1) * 0.06;
      rShZ = 0.65 - state.balance * 0.55 - Math.sin(time * 2.1) * 0.06;
      lShX = -0.45 - state.roll * 0.35;
      rShX = -0.45 + state.roll * 0.35;
    }

    const animLambda = state.phase === 'wipeout' ? 11 : 14;
    const boardCarryLambda = state.phase === 'beachWalk' ? 12 : 18;
    boardMesh.position.x = damp(boardMesh.position.x, boardOffsetX, boardCarryLambda, dt);
    boardMesh.position.y = damp(boardMesh.position.y, boardOffsetY, boardCarryLambda, dt);
    boardMesh.position.z = damp(boardMesh.position.z, boardOffsetZ, boardCarryLambda, dt);
    boardMesh.rotation.x = damp(boardMesh.rotation.x, boardRotX, boardCarryLambda, dt);
    boardMesh.rotation.y = damp(boardMesh.rotation.y, boardRotY, boardCarryLambda, dt);
    boardMesh.rotation.z = damp(boardMesh.rotation.z, boardRotZ, boardCarryLambda, dt);

    hips.position.y = damp(hips.position.y, hipsY, animLambda, dt);
    hips.position.z = damp(hips.position.z, hipsZ, animLambda, dt);
    hips.rotation.x = damp(hips.rotation.x, hipsRotX, animLambda, dt);
    hips.rotation.y = damp(hips.rotation.y, hipsRotY, animLambda, dt);
    hips.rotation.z = damp(hips.rotation.z, hipsRotZ, animLambda, dt);

    torso.rotation.x = damp(torso.rotation.x, torsoRotX, animLambda, dt);
    torso.rotation.y = damp(torso.rotation.y, torsoRotY, animLambda, dt);
    torso.rotation.z = damp(torso.rotation.z, torsoRotZ, animLambda, dt);

    head.rotation.x = damp(head.rotation.x, headRotX, animLambda, dt);
    head.rotation.y = damp(head.rotation.y, headRotY, animLambda, dt);

    leftHip.rotation.x = damp(leftHip.rotation.x, lHipX, animLambda, dt);
    leftKnee.rotation.x = damp(leftKnee.rotation.x, lKneeX, animLambda, dt);
    rightHip.rotation.x = damp(rightHip.rotation.x, rHipX, animLambda, dt);
    rightKnee.rotation.x = damp(rightKnee.rotation.x, rKneeX, animLambda, dt);

    leftShoulder.rotation.x = damp(leftShoulder.rotation.x, lShX, animLambda, dt);
    leftShoulder.rotation.z = damp(leftShoulder.rotation.z, lShZ, animLambda, dt);
    leftElbow.rotation.x = damp(leftElbow.rotation.x, lElbX, animLambda, dt);

    rightShoulder.rotation.x = damp(rightShoulder.rotation.x, rShX, animLambda, dt);
    rightShoulder.rotation.z = damp(rightShoulder.rotation.z, rShZ, animLambda, dt);
    rightElbow.rotation.x = damp(rightElbow.rotation.x, rElbX, animLambda, dt);
  };

  return {
    root,
    characterGroup,
    boardContainer,
    hips,
    torso,
    head,
    leftShoulder,
    leftElbow,
    rightShoulder,
    rightElbow,
    leftHip,
    leftKnee,
    rightHip,
    rightKnee,
    updateBoard,
    updateProfile,
    setFirstPersonMode,
    getFirstPersonPose,
    animate,
    dispose: () => {
      root.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
          else child.material.dispose();
        }
      });
      suitMat.dispose();
      accentMat.dispose();
      skinMat.dispose();
      hairMat.dispose();
    },
  };
}
