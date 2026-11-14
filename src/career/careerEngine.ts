import {
  buildRivalDialogue,
  CAREER_BOARD_CATALOG,
  CAREER_TIERS,
  createInitialOpponents,
  SPONSOR_BRANDS,
  TIER_EVENT_TEMPLATES,
  TIER_MAP,
} from '../data/careerData';
import { BEACH_SPOTS, SURFBOARDS } from '../data/surfData';
import {
  ActiveTournamentState,
  AISurfer,
  CareerEvent,
  CareerEventResult,
  CareerSaveState,
  CareerSurferCustomization,
  CareerTierId,
  HeatCompetitor,
  HeatMatch,
  HeatRoundType,
  HeatWaveRecord,
  LiveCareerHeatHUD,
  RivalryNotification,
  RivalryRecord,
  RoundSummary,
  SeasonSummary,
  SponsorBrand,
  SponsorContract,
} from '../types/career';
import { CompletedWaveTelemetry, SurferProfile } from '../types/game';

const CAREER_STORAGE_KEY = 'flow_career_save_v1';
const TIER_ORDER: CareerTierId[] = ['amador', 'regional', 'acesso', 'mundial'];

export function loadCareerSave(): CareerSaveState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CAREER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CareerSaveState;
    if (!parsed || parsed.version !== 1 || !parsed.surfer || !parsed.calendar) {
      return null;
    }
    return {
      ...parsed,
      rivalries: Array.isArray(parsed.rivalries) ? parsed.rivalries : [],
      rivalryNotifications: Array.isArray(parsed.rivalryNotifications)
        ? parsed.rivalryNotifications
        : [],
    };
  } catch {
    return null;
  }
}

export function saveCareerState(state: CareerSaveState): void {
  if (typeof window === 'undefined') return;
  try {
    const next: CareerSaveState = {
      ...state,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(CAREER_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
}

export function clearCareerSave(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(CAREER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function careerCustomizationToSurferProfile(
  surfer: CareerSurferCustomization
): SurferProfile {
  return {
    id: `career-${surfer.baseSurferId}`,
    name: surfer.name,
    origin: surfer.nationality,
    nationality: surfer.nationality,
    stance: surfer.stance,
    style: surfer.style,
    suitColor: surfer.suitColor,
    accentColor: surfer.accentColor,
    skinTone: surfer.skinTone,
    hairColor: surfer.hairColor,
  };
}

export function getTierOrderIndex(tier: CareerTierId): number {
  return TIER_ORDER.indexOf(tier);
}

export function getNextTier(tier: CareerTierId): CareerTierId {
  const idx = TIER_ORDER.indexOf(tier);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return tier;
  return TIER_ORDER[idx + 1];
}

export function generateSeasonCalendar(tier: CareerTierId, season: number): CareerEvent[] {
  const tierInfo = TIER_MAP[tier];
  const templates = TIER_EVENT_TEMPLATES[tier];
  const deadlines = [
    'Etapa de Abertura',
    'Prazo: Semana 4',
    'Prazo: Semana 8',
    'Prazo: Semana 12',
    'Prazo: Semana 16',
    'Decisão da Temporada',
  ];

  return templates.slice(0, tierInfo.seasonEventsCount).map((tpl, index) => {
    const scale = 1 + index * 0.12 + (season - 1) * 0.08;
    return {
      id: `s${season}-${tier}-e${index + 1}`,
      season,
      orderIndex: index,
      tier,
      name: tpl.name,
      location: tpl.location,
      beachId: tpl.beachId,
      weather: tpl.weather,
      waveHeightLabel: tpl.waveHeightLabel,
      swellConditions: tpl.swellConditions,
      deadlineLabel: deadlines[index] ?? `Semana ${index * 4 + 1}`,
      prizePool: Math.round((tierInfo.prizePoolBase * scale) / 50) * 50,
      pointsFirst: tierInfo.pointsFirst,
      photoKey: tpl.photoKey,
      status: index === 0 ? 'next' : 'upcoming',
    };
  });
}

function evaluateSponsorInvitations(
  tier: CareerTierId,
  reputation: number,
  existing: SponsorContract[]
): SponsorContract[] {
  const tierIdx = getTierOrderIndex(tier);
  const next = [...existing];
  for (const brand of SPONSOR_BRANDS) {
    const alreadyHas = next.some(
      (c) =>
        c.brandId === brand.id &&
        (c.status === 'active' || c.status === 'invited' || c.status === 'completed')
    );
    if (alreadyHas) continue;
    if (tierIdx >= getTierOrderIndex(brand.minTier) && reputation >= brand.minReputation) {
      next.push({
        brandId: brand.id,
        status: 'invited',
        eventsRemaining: brand.durationEvents,
        eventsTotal: brand.durationEvents,
        progress: 0,
        target: brand.objectiveTarget,
        signedSeason: 1,
      });
    }
  }
  return next;
}

export function createNewCareer(
  surfer: CareerSurferCustomization,
  startingBoardId: string
): CareerSaveState {
  const validBoard = SURFBOARDS.some((b) => b.id === startingBoardId)
    ? startingBoardId
    : 'vortex-pro';
  const now = new Date().toISOString();
  const initialSponsors = evaluateSponsorInvitations('amador', 10, []);

  const state: CareerSaveState = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    surfer,
    equippedBoardId: validBoard,
    unlockedBoardIds: ['vortex-pro', 'keel-fish', 'pacific-mid'],
    tier: 'amador',
    season: 1,
    seasonPoints: 0,
    careerPoints: 0,
    previousRank: 8,
    recentResults: [],
    wins: 0,
    podiums: 0,
    bestWave: 0,
    prizeBalance: 250,
    totalCareerEarnings: 250,
    reputation: 15,
    calendar: generateSeasonCalendar('amador', 1),
    opponents: createInitialOpponents(),
    sponsors: initialSponsors,
    history: [],
    seasonSummaries: [],
    activeTournament: null,
    pendingSeasonSummary: null,
    rivalries: [],
    rivalryNotifications: [],
  };

  saveCareerState(state);
  return state;
}

/**
 * Converts real gameplay score/maneuvers/barrel seconds into an authentic 0.0 - 10.0 WSL wave score.
 */
export function convertRawWavePointsToScore(
  rawPoints: number,
  barrelTime: number,
  maneuvers: number
): number {
  if (rawPoints <= 0 && barrelTime < 0.15 && maneuvers === 0) return 0;
  const effectivePts = Math.max(0, rawPoints + barrelTime * 110 + maneuvers * 45);
  const rawScore = 10 * (1 - Math.exp(-effectivePts / 1380));
  const clamped = Math.max(0.4, Math.min(10.0, rawScore));
  return Math.round(clamped * 10) / 10;
}

export function computeBestTwoTotal(waves: Array<{ score: number }>): number {
  if (waves.length === 0) return 0;
  const sorted = [...waves].sort((a, b) => b.score - a.score);
  const top1 = sorted[0]?.score ?? 0;
  const top2 = sorted[1]?.score ?? 0;
  return Math.round((top1 + top2) * 10) / 10;
}

function roundToTenth(val: number): number {
  return Math.round(val * 10) / 10;
}

function generateAiScheduledWaves(
  ai: AISurfer,
  durationSec: number,
  tier: CareerTierId
): Array<{ atElapsedSec: number; score: number; bestManeuver: string }> {
  const tierFactor =
    tier === 'mundial' ? 1.0 : tier === 'acesso' ? 0.92 : tier === 'regional' ? 0.82 : 0.72;
  const skillNorm = (ai.skillLevel - 40) / 60; // ~0.13 .. 0.95
  const waveCount = 3 + (Math.random() < ai.consistency ? 1 : 0);
  const maneuversPool = [
    ai.barrelSkill > 0.75 ? 'Tubo Profundo' : 'Bottom Turn',
    ai.airSkill > 0.72 ? 'Aerial 360' : 'Cutback',
    'Floater',
    'Snap no Lip',
  ];

  const waves: Array<{ atElapsedSec: number; score: number; bestManeuver: string }> = [];
  for (let i = 0; i < waveCount; i++) {
    const slotBase = ((i + 0.45) / waveCount) * (durationSec - 10);
    const atElapsedSec = Math.max(
      8,
      Math.min(durationSec - 4, Math.round(slotBase + (Math.random() - 0.5) * 10))
    );
    const variance = (Math.random() - 0.44) * (1 - ai.consistency * 0.48) * 3.1;
    const baseScore = (3.4 + skillNorm * 5.2) * tierFactor + variance;
    const score = roundToTenth(Math.max(1.8, Math.min(9.8, baseScore)));
    const bestManeuver = maneuversPool[Math.floor(Math.random() * maneuversPool.length)];
    waves.push({ atElapsedSec, score, bestManeuver });
  }
  waves.sort((a, b) => a.atElapsedSec - b.atElapsedSec);
  return waves;
}

function buildCompetitorFromPlayer(career: CareerSaveState): HeatCompetitor {
  return {
    id: 'player',
    name: career.surfer.name,
    nationalityCode: career.surfer.nationalityCode,
    isPlayer: true,
    skillLevel: Math.min(98, 52 + Math.round(career.reputation / 10)),
    style: career.surfer.style,
    suitColor: career.surfer.suitColor,
    accentColor: career.surfer.accentColor,
    waves: [],
    bestTwoTotal: 0,
    heatRank: 1,
    advanced: false,
  };
}

function buildCompetitorFromAI(
  ai: AISurfer,
  durationSec: number,
  tier: CareerTierId
): HeatCompetitor {
  return {
    id: ai.id,
    name: ai.name,
    nationalityCode: ai.nationalityCode,
    isPlayer: false,
    skillLevel: ai.skillLevel,
    style: ai.style,
    suitColor: ai.suitColor,
    accentColor: ai.accentColor,
    waves: [],
    bestTwoTotal: 0,
    heatRank: 1,
    advanced: false,
    scheduledAiWaves: generateAiScheduledWaves(ai, durationSec, tier),
  };
}

function rankHeatCompetitors(
  competitors: HeatCompetitor[],
  advancingCount: number
): HeatCompetitor[] {
  const sorted = [...competitors].sort((a, b) => {
    if (b.bestTwoTotal !== a.bestTwoTotal) return b.bestTwoTotal - a.bestTwoTotal;
    const bestA = Math.max(0, ...a.waves.map((w) => w.score));
    const bestB = Math.max(0, ...b.waves.map((w) => w.score));
    if (bestB !== bestA) return bestB - bestA;
    return a.isPlayer ? -1 : b.isPlayer ? 1 : 0;
  });

  const rankMap = new Map<string, { rank: number; advanced: boolean }>();
  sorted.forEach((c, idx) => {
    rankMap.set(c.id, { rank: idx + 1, advanced: idx < advancingCount });
  });

  return competitors.map((c) => {
    const info = rankMap.get(c.id)!;
    return {
      ...c,
      heatRank: info.rank,
      advanced: info.advanced,
    };
  });
}

function getRoundLabel(round: HeatRoundType): string {
  if (round === 'quartas') return 'Quartas de Final';
  if (round === 'semifinal') return 'Semifinal';
  return 'Final';
}

export function getHeadToHeadStakes(tier: CareerTierId): { prize: number; rep: number } {
  switch (tier) {
    case 'mundial':
      return { prize: 4800, rep: 120 };
    case 'acesso':
      return { prize: 2100, rep: 80 };
    case 'regional':
      return { prize: 950, rep: 50 };
    default:
      return { prize: 350, rep: 30 };
  }
}

export function startChampionshipTournament(
  career: CareerSaveState,
  eventId: string
): CareerSaveState {
  const event = career.calendar.find((e) => e.id === eventId);
  if (!event || event.status === 'completed') return career;

  const tierInfo = TIER_MAP[career.tier];
  const tierOpponents = career.opponents
    .filter((o) => o.tier === career.tier)
    .sort((a, b) => b.seasonPoints - a.seasonPoints || b.skillLevel - a.skillLevel)
    .slice(0, 7);

  // Check if there is an active Head-to-Head rivalry in the current tier
  const activeRivalry = (career.rivalries ?? []).find(
    (r) => r.activeChallenge && tierOpponents.some((o) => o.id === r.rivalId)
  );
  const headToHeadRivalId = activeRivalry?.rivalId;

  const playerComp = buildCompetitorFromPlayer(career);
  const aiComps = tierOpponents.map((ai) =>
    buildCompetitorFromAI(ai, tierInfo.heatDurationSeconds, career.tier)
  );

  let currentRound: HeatRoundType = 'quartas';
  let heats: HeatMatch[] = [];

  if (tierInfo.roundsCount === 2) {
    // Amador: 2 Semifinals of 4 surfers (Top 2 advance to 4-surfer Final)
    currentRound = 'semifinal';
    if (headToHeadRivalId) {
      const rivalComp = aiComps.find((c) => c.id === headToHeadRivalId);
      const others = aiComps.filter((c) => c.id !== headToHeadRivalId);
      const heatA = rivalComp
        ? [playerComp, rivalComp, others[2], others[4]].filter(Boolean)
        : [playerComp, aiComps[2], aiComps[4], aiComps[6]];
      const heatB = rivalComp
        ? [others[0], others[1], others[3], others[5]].filter(Boolean)
        : [aiComps[0], aiComps[1], aiComps[3], aiComps[5]];
      heats = [
        { heatId: 'sf-1', label: 'Semifinal · Duelo Head-to-Head', competitors: heatA, completed: false },
        { heatId: 'sf-2', label: 'Semifinal · Bateria 2', competitors: heatB, completed: false },
      ];
    } else {
      const heatA = [playerComp, aiComps[2], aiComps[4], aiComps[6]];
      const heatB = [aiComps[0], aiComps[1], aiComps[3], aiComps[5]];
      heats = [
        { heatId: 'sf-1', label: 'Semifinal · Bateria 1', competitors: heatA, completed: false },
        { heatId: 'sf-2', label: 'Semifinal · Bateria 2', competitors: heatB, completed: false },
      ];
    }
  } else {
    // Regional / Acesso / Mundial: 4 Quarterfinals of 2 surfers (1v1) -> 2 Semis -> 1 Final
    currentRound = 'quartas';
    if (headToHeadRivalId) {
      const rivalComp = aiComps.find((c) => c.id === headToHeadRivalId);
      const others = aiComps.filter((c) => c.id !== headToHeadRivalId);
      const pairs: HeatCompetitor[][] = rivalComp
        ? [
            [playerComp, rivalComp],
            [others[2], others[5]].filter(Boolean),
            [others[1], others[4]].filter(Boolean),
            [others[0], others[3]].filter(Boolean),
          ]
        : [
            [playerComp, aiComps[6]],
            [aiComps[2], aiComps[5]],
            [aiComps[1], aiComps[4]],
            [aiComps[0], aiComps[3]],
          ];
      heats = pairs.map((pair, i) => ({
        heatId: `qf-${i + 1}`,
        label: i === 0 && rivalComp ? 'Quartas · Duelo Head-to-Head' : `Quartas · Bateria ${i + 1}`,
        competitors: pair,
        completed: false,
      }));
    } else {
      const pairs: HeatCompetitor[][] = [
        [playerComp, aiComps[6]],
        [aiComps[2], aiComps[5]],
        [aiComps[1], aiComps[4]],
        [aiComps[0], aiComps[3]],
      ];
      heats = pairs.map((pair, i) => ({
        heatId: `qf-${i + 1}`,
        label: `Quartas · Bateria ${i + 1}`,
        competitors: pair,
        completed: false,
      }));
    }
  }

  const tournament: ActiveTournamentState = {
    eventId: event.id,
    tier: career.tier,
    currentRound,
    roundLabel: getRoundLabel(currentRound),
    heats,
    playerHeatIndex: 0,
    completedRounds: [],
    participantIds: ['player', ...tierOpponents.map((o) => o.id)],
    heatCompletedAwaitingNext: false,
    eventFinished: false,
    headToHeadRivalId,
    headToHeadSettledInEvent: false,
  };

  const next: CareerSaveState = {
    ...career,
    activeTournament: tournament,
  };
  saveCareerState(next);
  return next;
}

export function buildHeatCompetitorWavesFromTelemetry(
  completedWaves: CompletedWaveTelemetry[],
  currentWavePoints: number,
  currentWaveBarrelTime: number,
  currentWaveManeuvers: number,
  currentWaveBestManeuver: string,
  currentWaveNumber: number,
  elapsedSec: number
): HeatWaveRecord[] {
  const records: HeatWaveRecord[] = completedWaves
    .map((w) => ({
      waveNumber: w.waveNumber,
      score: convertRawWavePointsToScore(w.points, w.barrelTime, w.maneuvers),
      rawPoints: w.points,
      barrelTime: w.barrelTime,
      maneuvers: w.maneuvers,
      bestManeuver: w.bestManeuver || 'Linha Limpa',
      timestampSec: Math.round(elapsedSec),
    }))
    .filter((w) => w.score > 0);

  if (currentWavePoints > 0 || currentWaveBarrelTime > 0.25 || currentWaveManeuvers > 0) {
    const curScore = convertRawWavePointsToScore(
      currentWavePoints,
      currentWaveBarrelTime,
      currentWaveManeuvers
    );
    if (curScore > 0) {
      records.push({
        waveNumber: currentWaveNumber,
        score: curScore,
        rawPoints: currentWavePoints,
        barrelTime: currentWaveBarrelTime,
        maneuvers: currentWaveManeuvers,
        bestManeuver: currentWaveBestManeuver || 'Em Andamento',
        timestampSec: Math.round(elapsedSec),
      });
    }
  }

  return records;
}

export function computeLiveHeatHUD(
  career: CareerSaveState,
  playerWaves: HeatWaveRecord[],
  elapsedSec: number,
  totalDurationSec: number
): LiveCareerHeatHUD | null {
  const t = career.activeTournament;
  if (!t || t.playerHeatIndex < 0) return null;
  const event = career.calendar.find((e) => e.id === t.eventId);
  const heat = t.heats[t.playerHeatIndex];
  if (!event || !heat) return null;

  const advancingCount = heat.competitors.length >= 4 ? 2 : 1;
  const liveCompetitors: HeatCompetitor[] = heat.competitors.map((comp) => {
    if (comp.isPlayer) {
      return {
        ...comp,
        waves: playerWaves,
        bestTwoTotal: computeBestTwoWaves(playerWaves),
      };
    }
    const aiWaves: HeatWaveRecord[] = (comp.scheduledAiWaves ?? [])
      .filter((sw) => sw.atElapsedSec <= elapsedSec)
      .map((sw, idx) => ({
        waveNumber: idx + 1,
        score: sw.score,
        rawPoints: Math.round(sw.score * 240),
        barrelTime: 0,
        maneuvers: 2,
        bestManeuver: sw.bestManeuver,
        timestampSec: sw.atElapsedSec,
      }));
    return {
      ...comp,
      waves: aiWaves,
      bestTwoTotal: computeBestTwoWaves(aiWaves),
    };
  });

  const ranked = rankHeatCompetitors(liveCompetitors, advancingCount);
  const playerEntry = ranked.find((c) => c.isPlayer);
  const rivals = ranked.filter((c) => !c.isPlayer).sort((a, b) => b.bestTwoTotal - a.bestTwoTotal);
  const topRival = rivals[0];

  const sortedPlayerWaves = [...playerWaves].sort((a, b) => b.score - a.score);
  const h2hComp = t.headToHeadRivalId && !t.headToHeadSettledInEvent
    ? ranked.find((c) => c.id === t.headToHeadRivalId)
    : undefined;

  return {
    eventName: event.name,
    roundLabel: t.roundLabel,
    timeRemainingSec: Math.max(0, Math.ceil(totalDurationSec - elapsedSec)),
    totalDurationSec,
    playerTotal: playerEntry?.bestTwoTotal ?? 0,
    playerWaves: sortedPlayerWaves.slice(0, 2).map((w) => w.score),
    playerRank: playerEntry?.heatRank ?? 1,
    totalInHeat: ranked.length,
    topRivalName: h2hComp?.name ?? topRival?.name ?? 'Adversário',
    topRivalTotal: h2hComp?.bestTwoTotal ?? topRival?.bestTwoTotal ?? 0,
    advancingCount,
    isHeadToHeadDuel: Boolean(h2hComp),
    rivalNameInHeat: h2hComp?.name,
  };
}

function computeBestTwoWaves(waves: HeatWaveRecord[]): number {
  return computeBestTwoTotal(waves);
}

function finalizeCompetitorAtEnd(
  comp: HeatCompetitor,
  playerFinalWaves?: HeatWaveRecord[]
): HeatCompetitor {
  if (comp.isPlayer) {
    const waves = playerFinalWaves ?? comp.waves;
    return {
      ...comp,
      waves,
      bestTwoTotal: computeBestTwoTotal(waves),
    };
  }
  const aiWaves: HeatWaveRecord[] = (comp.scheduledAiWaves ?? []).map((sw, idx) => ({
    waveNumber: idx + 1,
    score: sw.score,
    rawPoints: Math.round(sw.score * 240),
    barrelTime: sw.bestManeuver === 'Tubo Profundo' ? 1.4 : 0,
    maneuvers: 2,
    bestManeuver: sw.bestManeuver,
    timestampSec: sw.atElapsedSec,
  }));
  return {
    ...comp,
    waves: aiWaves,
    bestTwoTotal: computeBestTwoTotal(aiWaves),
  };
}

function buildNextRoundHeats(
  completedHeats: HeatMatch[],
  prevRound: HeatRoundType,
  tier: CareerTierId,
  opponents: AISurfer[]
): { nextRound: HeatRoundType; heats: HeatMatch[] } {
  const tierInfo = TIER_MAP[tier];
  const advancers: HeatCompetitor[] = [];
  for (const h of completedHeats) {
    for (const c of h.competitors) {
      if (c.advanced) {
        if (c.isPlayer) {
          advancers.push({
            ...c,
            waves: [],
            bestTwoTotal: 0,
            heatRank: 1,
            advanced: false,
          });
        } else {
          const aiObj = opponents.find((o) => o.id === c.id);
          advancers.push(
            aiObj
              ? buildCompetitorFromAI(aiObj, tierInfo.heatDurationSeconds, tier)
              : {
                  ...c,
                  waves: [],
                  bestTwoTotal: 0,
                  heatRank: 1,
                  advanced: false,
                  scheduledAiWaves: c.scheduledAiWaves,
                }
          );
        }
      }
    }
  }

  if (prevRound === 'quartas') {
    // 4 advancers -> 2 Semifinals (1v1)
    return {
      nextRound: 'semifinal',
      heats: [
        {
          heatId: 'sf-1',
          label: 'Semifinal · Bateria 1',
          competitors: [advancers[0], advancers[1]].filter(Boolean),
          completed: false,
        },
        {
          heatId: 'sf-2',
          label: 'Semifinal · Bateria 2',
          competitors: [advancers[2], advancers[3]].filter(Boolean),
          completed: false,
        },
      ],
    };
  }

  // Semifinal -> Final
  return {
    nextRound: 'final',
    heats: [
      {
        heatId: 'final-1',
        label: 'Final do Campeonato',
        competitors: advancers,
        completed: false,
      },
    ],
  };
}

function pointsForPlacement(pointsFirst: number, placement: number): number {
  const ratios: Record<number, number> = {
    1: 1.0,
    2: 0.78,
    3: 0.61,
    4: 0.52,
    5: 0.38,
    6: 0.34,
    7: 0.3,
    8: 0.26,
  };
  return Math.round(pointsFirst * (ratios[placement] ?? 0.2));
}

function prizeForPlacement(prizePool: number, placement: number): number {
  const shares: Record<number, number> = {
    1: 0.38,
    2: 0.22,
    3: 0.13,
    4: 0.1,
    5: 0.05,
    6: 0.045,
    7: 0.04,
    8: 0.035,
  };
  return Math.round((prizePool * (shares[placement] ?? 0.03)) / 10) * 10;
}

function settleTournamentAndUpdateCareer(
  career: CareerSaveState,
  event: CareerEvent,
  allCompletedRounds: RoundSummary[]
): CareerSaveState {
  // Determine final placement 1..8 across all 8 participants
  const finalRound = allCompletedRounds[allCompletedRounds.length - 1];
  const finalHeat = finalRound.heats[0];
  const assigned = new Map<string, { placement: number; bestHeatTotal: number; bestWave: number }>();

  // 1st..N from Final
  const finalSorted = [...finalHeat.competitors].sort((a, b) => a.heatRank - b.heatRank);
  finalSorted.forEach((c, idx) => {
    assigned.set(c.id, {
      placement: idx + 1,
      bestHeatTotal: c.bestTwoTotal,
      bestWave: Math.max(0, ...c.waves.map((w) => w.score)),
    });
  });

  // Remaining competitors ranked backwards by round eliminated + heat score
  let nextPlacement = finalSorted.length + 1;
  for (let rIdx = allCompletedRounds.length - 2; rIdx >= 0; rIdx--) {
    const losers: HeatCompetitor[] = [];
    for (const h of allCompletedRounds[rIdx].heats) {
      for (const c of h.competitors) {
        if (!assigned.has(c.id)) losers.push(c);
      }
    }
    losers.sort((a, b) => b.bestTwoTotal - a.bestTwoTotal);
    for (const loser of losers) {
      assigned.set(loser.id, {
        placement: nextPlacement++,
        bestHeatTotal: loser.bestTwoTotal,
        bestWave: Math.max(0, ...loser.waves.map((w) => w.score)),
      });
    }
  }

  // Player best metrics across ALL rounds played in this event
  let playerBestHeat = 0;
  let playerBestWave = 0;
  let playerManeuvers = 0;
  for (const r of allCompletedRounds) {
    for (const h of r.heats) {
      const p = h.competitors.find((c) => c.isPlayer);
      if (p) {
        playerBestHeat = Math.max(playerBestHeat, p.bestTwoTotal);
        for (const w of p.waves) {
          playerBestWave = Math.max(playerBestWave, w.score);
          playerManeuvers += w.maneuvers;
        }
      }
    }
  }

  const playerAssigned = assigned.get('player');
  const playerPlacement = playerAssigned?.placement ?? 8;
  const playerPointsEarned = pointsForPlacement(event.pointsFirst, playerPlacement);
  const basePrize = prizeForPlacement(event.prizePool, playerPlacement);

  // Sponsor evaluation & payouts
  let activeMultiplier = 0;
  let sponsorStipendAndBonuses = 0;
  let sponsorRepBonus = 0;
  const newlyUnlockedBoards = new Set(career.unlockedBoardIds);

  const updatedSponsors: SponsorContract[] = career.sponsors.map((contract) => {
    if (contract.status !== 'active') return contract;
    const brand = SPONSOR_BRANDS.find((b) => b.id === contract.brandId);
    if (!brand) return contract;

    activeMultiplier += brand.prizeMultiplierBonus;
    sponsorStipendAndBonuses += brand.stipendPerEvent;

    let metThisEvent = false;
    if (brand.objectiveType === 'semis' && playerPlacement <= 4) metThisEvent = true;
    if (brand.objectiveType === 'podiums' && playerPlacement <= 3) metThisEvent = true;
    if (brand.objectiveType === 'win' && playerPlacement === 1) metThisEvent = true;
    if (brand.objectiveType === 'highWave' && playerBestWave >= 7.5) metThisEvent = true;
    if (brand.objectiveType === 'events') metThisEvent = true;

    const nextProgress = Math.min(contract.target, contract.progress + (metThisEvent ? 1 : 0));
    const nextRemaining = Math.max(0, contract.eventsRemaining - 1);

    if (nextProgress >= contract.target) {
      sponsorStipendAndBonuses += brand.completionBonus;
      sponsorRepBonus += brand.repBonus;
      if (brand.rewardBoardId) {
        newlyUnlockedBoards.add(brand.rewardBoardId);
      }
      return {
        ...contract,
        status: 'completed',
        progress: nextProgress,
        eventsRemaining: nextRemaining,
      };
    }

    if (nextRemaining <= 0) {
      return {
        ...contract,
        status: 'expired',
        progress: nextProgress,
        eventsRemaining: 0,
      };
    }

    return {
      ...contract,
      progress: nextProgress,
      eventsRemaining: nextRemaining,
    };
  });

  const totalPlayerPrize =
    Math.round(basePrize * (1 + activeMultiplier)) + sponsorStipendAndBonuses;

  // Previous rank snapshot before applying new points
  const preStandings = computeTierStandings(career, career.tier);
  const prevPlayerRank = preStandings.find((r) => r.isPlayer)?.rank ?? career.previousRank;
  const prevAiRankMap = new Map<string, number>();
  preStandings.forEach((r) => {
    if (!r.isPlayer) prevAiRankMap.set(r.id, r.rank);
  });

  // Update AI opponents' seasonPoints, wins, podiums, recentResults
  const updatedOpponents: AISurfer[] = career.opponents.map((ai) => {
    const res = assigned.get(ai.id);
    if (!res) return ai;
    const pts = pointsForPlacement(event.pointsFirst, res.placement);
    return {
      ...ai,
      seasonPoints: ai.seasonPoints + pts,
      careerPoints: ai.careerPoints + pts,
      previousRank: prevAiRankMap.get(ai.id) ?? ai.previousRank,
      recentResults: [res.placement, ...ai.recentResults].slice(0, 5),
      wins: ai.wins + (res.placement === 1 ? 1 : 0),
      podiums: ai.podiums + (res.placement <= 3 ? 1 : 0),
      bestWave: Math.max(ai.bestWave, res.bestWave),
    };
  });

  const topStandings = Array.from(assigned.entries())
    .map(([id, info]) => {
      const isPlayer = id === 'player';
      const ai = !isPlayer ? career.opponents.find((o) => o.id === id) : undefined;
      return {
        competitorId: id,
        name: isPlayer ? career.surfer.name : ai?.name ?? 'Surfista',
        nationalityCode: isPlayer ? career.surfer.nationalityCode : ai?.nationalityCode ?? 'INT',
        isPlayer,
        placement: info.placement,
        bestHeatTotal: info.bestHeatTotal,
        pointsEarned: pointsForPlacement(event.pointsFirst, info.placement),
      };
    })
    .sort((a, b) => a.placement - b.placement);

  const championName = topStandings[0]?.name ?? career.surfer.name;

  const eventResult: CareerEventResult = {
    placement: playerPlacement,
    bestHeatTotal: roundToTenth(playerBestHeat),
    bestWave: roundToTenth(playerBestWave),
    pointsEarned: playerPointsEarned,
    prizeEarned: totalPlayerPrize,
    sponsorBonusEarned: sponsorStipendAndBonuses,
    maneuversLanded: playerManeuvers,
    championName,
    topStandings,
  };

  // Advance calendar event statuses
  let assignedNext = false;
  const updatedCalendar: CareerEvent[] = career.calendar.map((ev) => {
    if (ev.id === event.id) {
      return {
        ...ev,
        status: 'completed',
        result: eventResult,
      };
    }
    if (ev.status === 'upcoming' && !assignedNext) {
      assignedNext = true;
      return { ...ev, status: 'next' };
    }
    return ev;
  });

  const repFromPlacement =
    playerPlacement === 1 ? 45 : playerPlacement === 2 ? 32 : playerPlacement <= 4 ? 22 : 12;
  const newReputation = career.reputation + repFromPlacement + sponsorRepBonus;
  const finalSponsors = evaluateSponsorInvitations(career.tier, newReputation, updatedSponsors);

  const beachName =
    BEACH_SPOTS.find((b) => b.id === event.beachId)?.name ?? event.location;

  // Check close-finish / Head-to-Head rivalries at tournament end
  const rivalryUpdate = processRivalriesForTournament(
    career,
    event,
    allCompletedRounds,
    assigned,
    playerPlacement
  );

  // Check if entire season is completed!
  const allCompleted = updatedCalendar.every((e) => e.status === 'completed');

  const nextState: CareerSaveState = {
    ...career,
    seasonPoints: career.seasonPoints + playerPointsEarned,
    careerPoints: career.careerPoints + playerPointsEarned,
    previousRank: prevPlayerRank,
    recentResults: [playerPlacement, ...career.recentResults].slice(0, 5),
    wins: career.wins + (playerPlacement === 1 ? 1 : 0),
    podiums: career.podiums + (playerPlacement <= 3 ? 1 : 0),
    bestWave: Math.max(career.bestWave, roundToTenth(playerBestWave)),
    prizeBalance: career.prizeBalance + totalPlayerPrize + rivalryUpdate.bonusPrize,
    totalCareerEarnings:
      career.totalCareerEarnings + totalPlayerPrize + rivalryUpdate.bonusPrize,
    reputation: newReputation + rivalryUpdate.bonusRep,
    unlockedBoardIds: Array.from(newlyUnlockedBoards),
    calendar: updatedCalendar,
    opponents: updatedOpponents,
    sponsors: finalSponsors,
    rivalries: rivalryUpdate.rivalries,
    rivalryNotifications: rivalryUpdate.notifications,
    history: [
      {
        season: career.season,
        tier: career.tier,
        eventId: event.id,
        eventName: event.name,
        beachName,
        placement: playerPlacement,
        bestHeatTotal: roundToTenth(playerBestHeat),
        bestWave: roundToTenth(playerBestWave),
        pointsEarned: playerPointsEarned,
        prizeEarned: totalPlayerPrize + rivalryUpdate.bonusPrize,
        maneuversLanded: playerManeuvers,
      },
      ...career.history,
    ],
    activeTournament: {
      ...career.activeTournament!,
      completedRounds: allCompletedRounds,
      heatCompletedAwaitingNext: false,
      eventFinished: true,
      finalResult: {
        ...eventResult,
        prizeEarned: totalPlayerPrize + rivalryUpdate.bonusPrize,
      },
      headToHeadSettledInEvent:
        career.activeTournament?.headToHeadSettledInEvent || rivalryUpdate.settledHeadToHead,
    },
  };

  if (allCompleted) {
    const standings = computeTierStandings(nextState, nextState.tier);
    const playerStanding = standings.find((r) => r.isPlayer);
    const finalRank = playerStanding?.rank ?? 8;
    const tierInfo = TIER_MAP[nextState.tier];
    const isTopTier = nextState.tier === 'mundial';
    const promoted = !isTopTier && finalRank <= tierInfo.promoteTopN;
    const wonWorldTitle = isTopTier && finalRank === 1;
    const seasonPrize = nextState.history
      .filter((h) => h.season === nextState.season)
      .reduce((acc, h) => acc + h.prizeEarned, 0);

    const summary: SeasonSummary = {
      season: nextState.season,
      tier: nextState.tier,
      nextTier: promoted ? getNextTier(nextState.tier) : nextState.tier,
      finalRank,
      totalPoints: nextState.seasonPoints,
      promoted,
      wonWorldTitle,
      championName: standings[0]?.name ?? nextState.surfer.name,
      wins: nextState.history.filter((h) => h.season === nextState.season && h.placement === 1)
        .length,
      podiums: nextState.history.filter((h) => h.season === nextState.season && h.placement <= 3)
        .length,
      prizeEarned: seasonPrize,
    };

    nextState.pendingSeasonSummary = summary;
  }

  saveCareerState(nextState);
  return nextState;
}

function isHighSkillContender(career: CareerSaveState, ai: AISurfer): boolean {
  const tierInfo = TIER_MAP[career.tier];
  const [minSkill, maxSkill] = tierInfo.aiSkillRange;
  const threshold = minSkill + Math.round((maxSkill - minSkill) * 0.45);
  if (ai.skillLevel >= threshold) return true;
  const top3Ids = career.opponents
    .filter((o) => o.tier === career.tier)
    .sort((a, b) => b.seasonPoints - a.seasonPoints || b.skillLevel - a.skillLevel)
    .slice(0, 3)
    .map((o) => o.id);
  return top3Ids.includes(ai.id);
}

function createRivalryNotificationObj(
  ai: AISurfer,
  kind: RivalryNotification['kind'],
  playerWonExchange: boolean,
  eventName: string,
  marginPts: number,
  contextLabel: string,
  stakes?: { prize: number; rep: number }
): RivalryNotification {
  const title =
    kind === 'head_to_head_challenge'
      ? `Desafio Head-to-Head vs ${ai.name}`
      : kind === 'duel_won'
        ? `Duelo Vencido contra ${ai.name}`
        : kind === 'duel_lost'
          ? `Reviravolta de ${ai.name}`
          : `Rivalidade em Alta com ${ai.name}`;

  const rewardLabel =
    kind === 'head_to_head_challenge' && stakes
      ? `Duelo 1v1 garantido na próxima etapa · Bônus +$${stakes.prize.toLocaleString()} e +${stakes.rep} Rep.`
      : kind === 'duel_won' && stakes
        ? `Bônus Head-to-Head conquistado: +$${stakes.prize.toLocaleString()} e +${stakes.rep} Rep.`
        : undefined;

  return {
    id: `riv-${ai.id}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    rivalId: ai.id,
    rivalName: ai.name,
    rivalNationalityCode: ai.nationalityCode,
    rivalSkillLevel: ai.skillLevel,
    rivalStyle: ai.style,
    rivalSuitColor: ai.suitColor,
    rivalAccentColor: ai.accentColor,
    rivalSkinTone: ai.skinTone,
    rivalHairColor: ai.hairColor,
    kind,
    title,
    dialogue: buildRivalDialogue(ai, kind, playerWonExchange, eventName, marginPts),
    contextLabel,
    marginLabel: `Margem: ${marginPts.toFixed(1)} pts`,
    rewardLabel,
    eventName,
    seen: false,
  };
}

function processPlayerHeatRivalry(
  career: CareerSaveState,
  event: CareerEvent,
  playerHeat: HeatMatch
): {
  rivalries: RivalryRecord[];
  notifications: RivalryNotification[];
  bonusPrize: number;
  bonusRep: number;
  settledHeadToHead: boolean;
} {
  let rivalries = [...(career.rivalries ?? [])];
  let notifications = [...(career.rivalryNotifications ?? [])];
  let bonusPrize = 0;
  let bonusRep = 0;
  let settledHeadToHead = false;

  const t = career.activeTournament;
  const playerComp = playerHeat.competitors.find((c) => c.isPlayer);
  if (!playerComp) {
    return { rivalries, notifications, bonusPrize, bonusRep, settledHeadToHead };
  }

  // 1. Settle active Head-to-Head duel if that rival was in this heat
  if (t?.headToHeadRivalId && !t.headToHeadSettledInEvent) {
    const h2hComp = playerHeat.competitors.find((c) => c.id === t.headToHeadRivalId);
    const aiObj = career.opponents.find((o) => o.id === t.headToHeadRivalId);
    if (h2hComp && aiObj) {
      settledHeadToHead = true;
      const playerWon = playerComp.heatRank < h2hComp.heatRank;
      const margin = roundToTenth(Math.abs(playerComp.bestTwoTotal - h2hComp.bestTwoTotal));
      const existing = rivalries.find((r) => r.rivalId === aiObj.id);
      const stakes = existing
        ? { prize: existing.challengeBonusPrize, rep: existing.challengeBonusRep }
        : getHeadToHeadStakes(career.tier);

      if (playerWon) {
        bonusPrize += stakes.prize;
        bonusRep += stakes.rep;
      }

      const nextRecord: RivalryRecord = existing
        ? {
            ...existing,
            heatMeetings: existing.heatMeetings + 1,
            playerWins: existing.playerWins + (playerWon ? 1 : 0),
            rivalWins: existing.rivalWins + (playerWon ? 0 : 1),
            lastEventId: event.id,
            lastEventName: event.name,
            lastMarginPts: margin,
            activeChallenge: false,
          }
        : {
            rivalId: aiObj.id,
            intensity: 2,
            heatMeetings: 1,
            closeFinishes: 1,
            playerWins: playerWon ? 1 : 0,
            rivalWins: playerWon ? 0 : 1,
            lastEventId: event.id,
            lastEventName: event.name,
            lastMarginPts: margin,
            activeChallenge: false,
            challengeBonusPrize: stakes.prize,
            challengeBonusRep: stakes.rep,
          };

      rivalries = [...rivalries.filter((r) => r.rivalId !== aiObj.id), nextRecord];
      notifications = [
        createRivalryNotificationObj(
          aiObj,
          playerWon ? 'duel_won' : 'duel_lost',
          playerWon,
          event.name,
          margin,
          `${t.roundLabel} · Duelo Head-to-Head (${playerComp.bestTwoTotal.toFixed(1)} × ${h2hComp.bestTwoTotal.toFixed(1)})`,
          stakes
        ),
        ...notifications,
      ].slice(0, 12);
    }
  }

  // 2. Check close heat finishes against high-skill AI competitors in this heat
  const candidates = playerHeat.competitors
    .filter((c) => !c.isPlayer && c.id !== (settledHeadToHead ? t?.headToHeadRivalId : ''))
    .map((c) => ({
      comp: c,
      ai: career.opponents.find((o) => o.id === c.id),
      margin: roundToTenth(Math.abs(playerComp.bestTwoTotal - c.bestTwoTotal)),
    }))
    .filter(
      (item): item is { comp: HeatCompetitor; ai: AISurfer; margin: number } =>
        Boolean(item.ai) && isHighSkillContender(career, item.ai!) && item.margin <= 2.1
    )
    .sort((a, b) => a.margin - b.margin);

  if (candidates.length > 0) {
    const top = candidates[0];
    const playerWon = playerComp.heatRank < top.comp.heatRank;
    const existing = rivalries.find((r) => r.rivalId === top.ai.id);
    const nextCloseFinishes = (existing?.closeFinishes ?? 0) + 1;
    const triggerChallenge =
      !existing?.activeChallenge && (top.margin <= 1.2 || nextCloseFinishes >= 2);
    const stakes = getHeadToHeadStakes(career.tier);
    const nextIntensity = Math.min(3, (existing?.intensity ?? 0) + 1) as 1 | 2 | 3;

    const updatedRecord: RivalryRecord = {
      rivalId: top.ai.id,
      intensity: triggerChallenge ? (Math.max(2, nextIntensity) as 1 | 2 | 3) : nextIntensity,
      heatMeetings: (existing?.heatMeetings ?? 0) + 1,
      closeFinishes: nextCloseFinishes,
      playerWins: (existing?.playerWins ?? 0) + (playerWon ? 1 : 0),
      rivalWins: (existing?.rivalWins ?? 0) + (playerWon ? 0 : 1),
      lastEventId: event.id,
      lastEventName: event.name,
      lastMarginPts: top.margin,
      activeChallenge: existing?.activeChallenge || triggerChallenge,
      challengeBonusPrize: stakes.prize,
      challengeBonusRep: stakes.rep,
    };

    rivalries = [...rivalries.filter((r) => r.rivalId !== top.ai.id), updatedRecord];
    notifications = [
      createRivalryNotificationObj(
        top.ai,
        triggerChallenge ? 'head_to_head_challenge' : 'close_finish',
        playerWon,
        event.name,
        top.margin,
        `${t?.roundLabel ?? 'Bateria'} · ${playerComp.bestTwoTotal.toFixed(1)} × ${top.comp.bestTwoTotal.toFixed(1)} pts`,
        stakes
      ),
      ...notifications,
    ].slice(0, 12);
  }

  return { rivalries, notifications, bonusPrize, bonusRep, settledHeadToHead };
}

function processRivalriesForTournament(
  career: CareerSaveState,
  event: CareerEvent,
  allCompletedRounds: RoundSummary[],
  assigned: Map<string, { placement: number; bestHeatTotal: number; bestWave: number }>,
  playerPlacement: number
): {
  rivalries: RivalryRecord[];
  notifications: RivalryNotification[];
  bonusPrize: number;
  bonusRep: number;
  settledHeadToHead: boolean;
} {
  let rivalries = [...(career.rivalries ?? [])];
  let notifications = [...(career.rivalryNotifications ?? [])];
  let bonusPrize = 0;
  let bonusRep = 0;
  let settledHeadToHead = career.activeTournament?.headToHeadSettledInEvent ?? false;

  // Check if player had a close final event placement with a high-skill AI not already notified in this event
  const notifiedThisEvent = new Set(
    notifications.filter((n) => n.eventName === event.name).map((n) => n.rivalId)
  );

  // If H2H rival wasn't met in a direct heat (e.g. player eliminated earlier), settle via event placement
  const t = career.activeTournament;
  if (t?.headToHeadRivalId && !settledHeadToHead) {
    const aiObj = career.opponents.find((o) => o.id === t.headToHeadRivalId);
    const aiPlace = assigned.get(t.headToHeadRivalId);
    const pPlace = assigned.get('player');
    if (aiObj && aiPlace && pPlace) {
      settledHeadToHead = true;
      const playerWon = pPlace.placement < aiPlace.placement;
      const margin = roundToTenth(Math.abs(pPlace.bestHeatTotal - aiPlace.bestHeatTotal));
      const existing = rivalries.find((r) => r.rivalId === aiObj.id);
      const stakes = existing
        ? { prize: existing.challengeBonusPrize, rep: existing.challengeBonusRep }
        : getHeadToHeadStakes(career.tier);

      if (playerWon) {
        bonusPrize += stakes.prize;
        bonusRep += stakes.rep;
      }

      const nextRecord: RivalryRecord = {
        rivalId: aiObj.id,
        intensity: (existing?.intensity ?? 2) as 1 | 2 | 3,
        heatMeetings: (existing?.heatMeetings ?? 0) + 1,
        closeFinishes: existing?.closeFinishes ?? 1,
        playerWins: (existing?.playerWins ?? 0) + (playerWon ? 1 : 0),
        rivalWins: (existing?.rivalWins ?? 0) + (playerWon ? 0 : 1),
        lastEventId: event.id,
        lastEventName: event.name,
        lastMarginPts: margin,
        activeChallenge: false,
        challengeBonusPrize: stakes.prize,
        challengeBonusRep: stakes.rep,
      };
      rivalries = [...rivalries.filter((r) => r.rivalId !== aiObj.id), nextRecord];
      notifications = [
        createRivalryNotificationObj(
          aiObj,
          playerWon ? 'duel_won' : 'duel_lost',
          playerWon,
          event.name,
          margin,
          `Classificação Final (${pPlace.placement}º × ${aiPlace.placement}º)`,
          stakes
        ),
        ...notifications,
      ].slice(0, 12);
      notifiedThisEvent.add(aiObj.id);
    }
  }

  // Also check adjacent Top 4 placement finish in the tournament
  const closeStandingCandidates: Array<{ ai: AISurfer; placement: number; margin: number }> = [];
  for (const [id, info] of assigned.entries()) {
    if (id === 'player' || notifiedThisEvent.has(id)) continue;
    const ai = career.opponents.find((o) => o.id === id);
    if (!ai || !isHighSkillContender(career, ai)) continue;
    const placeDiff = Math.abs(info.placement - playerPlacement);
    const scoreMargin = roundToTenth(
      Math.abs((assigned.get('player')?.bestHeatTotal ?? 0) - info.bestHeatTotal)
    );
    if ((placeDiff === 1 && Math.min(info.placement, playerPlacement) <= 4) || scoreMargin <= 1.5) {
      closeStandingCandidates.push({ ai, placement: info.placement, margin: scoreMargin });
    }
  }

  // Check also last player heat for close encounter if missed
  const lastRound = allCompletedRounds[allCompletedRounds.length - 1];
  const lastPlayerHeat = lastRound?.heats.find((h) => h.competitors.some((c) => c.isPlayer));
  if (closeStandingCandidates.length === 0 && lastPlayerHeat) {
    const pComp = lastPlayerHeat.competitors.find((c) => c.isPlayer);
    if (pComp) {
      for (const c of lastPlayerHeat.competitors) {
        if (c.isPlayer || notifiedThisEvent.has(c.id)) continue;
        const ai = career.opponents.find((o) => o.id === c.id);
        if (!ai || !isHighSkillContender(career, ai)) continue;
        const margin = roundToTenth(Math.abs(pComp.bestTwoTotal - c.bestTwoTotal));
        if (margin <= 2.1) {
          closeStandingCandidates.push({
            ai,
            placement: assigned.get(ai.id)?.placement ?? 4,
            margin,
          });
        }
      }
    }
  }

  if (closeStandingCandidates.length > 0) {
    closeStandingCandidates.sort((a, b) => a.margin - b.margin);
    const chosen = closeStandingCandidates[0];
    const playerWon = playerPlacement < chosen.placement;
    const existing = rivalries.find((r) => r.rivalId === chosen.ai.id);
    const nextCloseFinishes = (existing?.closeFinishes ?? 0) + 1;
    const triggerChallenge =
      !existing?.activeChallenge && (chosen.margin <= 1.2 || nextCloseFinishes >= 2);
    const stakes = getHeadToHeadStakes(career.tier);
    const nextIntensity = Math.min(3, (existing?.intensity ?? 0) + 1) as 1 | 2 | 3;

    const updatedRecord: RivalryRecord = {
      rivalId: chosen.ai.id,
      intensity: triggerChallenge ? (Math.max(2, nextIntensity) as 1 | 2 | 3) : nextIntensity,
      heatMeetings: (existing?.heatMeetings ?? 0) + 1,
      closeFinishes: nextCloseFinishes,
      playerWins: (existing?.playerWins ?? 0) + (playerWon ? 1 : 0),
      rivalWins: (existing?.rivalWins ?? 0) + (playerWon ? 0 : 1),
      lastEventId: event.id,
      lastEventName: event.name,
      lastMarginPts: chosen.margin,
      activeChallenge: existing?.activeChallenge || triggerChallenge,
      challengeBonusPrize: stakes.prize,
      challengeBonusRep: stakes.rep,
    };

    rivalries = [...rivalries.filter((r) => r.rivalId !== chosen.ai.id), updatedRecord];
    notifications = [
      createRivalryNotificationObj(
        chosen.ai,
        triggerChallenge ? 'head_to_head_challenge' : 'close_finish',
        playerWon,
        event.name,
        chosen.margin,
        `Finalização lado a lado (${playerPlacement}º × ${chosen.placement}º lugar)`,
        stakes
      ),
      ...notifications,
    ].slice(0, 12);
  }

  return { rivalries, notifications, bonusPrize, bonusRep, settledHeadToHead };
}

export function finalizePlayerHeat(
  career: CareerSaveState,
  playerFinalWaves: HeatWaveRecord[]
): CareerSaveState {
  const t = career.activeTournament;
  if (!t) return career;
  const event = career.calendar.find((e) => e.id === t.eventId);
  if (!event) return career;

  const finishedHeats: HeatMatch[] = t.heats.map((heat, idx) => {
    const advCount = heat.competitors.length >= 4 ? 2 : 1;
    const settled = heat.competitors.map((c) =>
      finalizeCompetitorAtEnd(c, idx === t.playerHeatIndex ? playerFinalWaves : undefined)
    );
    return {
      ...heat,
      competitors: rankHeatCompetitors(settled, advCount),
      completed: true,
    };
  });

  const completedRoundEntry: RoundSummary = {
    round: t.currentRound,
    roundLabel: t.roundLabel,
    heats: finishedHeats,
  };
  const allCompletedRounds = [...t.completedRounds, completedRoundEntry];

  const playerHeat = finishedHeats[t.playerHeatIndex];
  const playerAdvanced = playerHeat?.competitors.find((c) => c.isPlayer)?.advanced ?? false;

  // Evaluate direct heat rivalry & Head-to-Head duel right after this heat finishes
  const heatRivalry = playerHeat
    ? processPlayerHeatRivalry(career, event, playerHeat)
    : {
        rivalries: career.rivalries ?? [],
        notifications: career.rivalryNotifications ?? [],
        bonusPrize: 0,
        bonusRep: 0,
        settledHeadToHead: false,
      };

  const careerWithHeatRivalry: CareerSaveState = {
    ...career,
    prizeBalance: career.prizeBalance + heatRivalry.bonusPrize,
    totalCareerEarnings: career.totalCareerEarnings + heatRivalry.bonusPrize,
    reputation: career.reputation + heatRivalry.bonusRep,
    rivalries: heatRivalry.rivalries,
    rivalryNotifications: heatRivalry.notifications,
    activeTournament: {
      ...t,
      headToHeadSettledInEvent: t.headToHeadSettledInEvent || heatRivalry.settledHeadToHead,
    },
  };

  // If this was the Final OR player was eliminated -> simulate any remaining AI rounds and settle event!
  if (t.currentRound === 'final' || !playerAdvanced) {
    let simRound = t.currentRound;
    let simHeats = finishedHeats;
    const accumulatedRounds = [...allCompletedRounds];

    while (simRound !== 'final') {
      const built = buildNextRoundHeats(
        simHeats,
        simRound,
        careerWithHeatRivalry.tier,
        careerWithHeatRivalry.opponents
      );
      const nextSettledHeats: HeatMatch[] = built.heats.map((h) => {
        const advCount = h.competitors.length >= 4 ? 2 : 1;
        const settled = h.competitors.map((c) => finalizeCompetitorAtEnd(c));
        return {
          ...h,
          competitors: rankHeatCompetitors(settled, advCount),
          completed: true,
        };
      });
      accumulatedRounds.push({
        round: built.nextRound,
        roundLabel: getRoundLabel(built.nextRound),
        heats: nextSettledHeats,
      });
      simRound = built.nextRound;
      simHeats = nextSettledHeats;
    }

    const withTournament: CareerSaveState = {
      ...careerWithHeatRivalry,
      activeTournament: {
        ...careerWithHeatRivalry.activeTournament!,
        heats: finishedHeats,
        completedRounds: accumulatedRounds,
      },
    };
    return settleTournamentAndUpdateCareer(withTournament, event, accumulatedRounds);
  }

  // Player advanced and there's a next round to play!
  const nextState: CareerSaveState = {
    ...careerWithHeatRivalry,
    activeTournament: {
      ...careerWithHeatRivalry.activeTournament!,
      heats: finishedHeats,
      completedRounds: allCompletedRounds,
      heatCompletedAwaitingNext: true,
      eventFinished: false,
    },
  };
  saveCareerState(nextState);
  return nextState;
}

export function advanceTournamentToNextRound(career: CareerSaveState): CareerSaveState {
  const t = career.activeTournament;
  if (!t || !t.heatCompletedAwaitingNext) return career;

  const built = buildNextRoundHeats(t.heats, t.currentRound, career.tier, career.opponents);
  const playerHeatIndex = Math.max(
    0,
    built.heats.findIndex((h) => h.competitors.some((c) => c.isPlayer))
  );

  const nextState: CareerSaveState = {
    ...career,
    activeTournament: {
      ...t,
      currentRound: built.nextRound,
      roundLabel: getRoundLabel(built.nextRound),
      heats: built.heats,
      playerHeatIndex,
      heatCompletedAwaitingNext: false,
      eventFinished: false,
    },
  };
  saveCareerState(nextState);
  return nextState;
}

export function dismissFinishedTournament(career: CareerSaveState): CareerSaveState {
  const next: CareerSaveState = {
    ...career,
    activeTournament: null,
  };
  saveCareerState(next);
  return next;
}

export function advanceToNextSeason(career: CareerSaveState): CareerSaveState {
  const summary = career.pendingSeasonSummary;
  if (!summary) return career;

  const nextTier = summary.promoted ? summary.nextTier : career.tier;
  const nextSeason = career.season + 1;

  const nextOpponents = career.opponents.map((o) =>
    o.tier === career.tier ? { ...o, seasonPoints: 0, previousRank: 1 } : o
  );

  const nextSponsors = evaluateSponsorInvitations(
    nextTier,
    career.reputation,
    career.sponsors
  );

  const nextRivalries = summary.promoted
    ? (career.rivalries ?? []).map((r) => {
        const opp = career.opponents.find((o) => o.id === r.rivalId);
        return opp && opp.tier !== nextTier ? { ...r, activeChallenge: false } : r;
      })
    : career.rivalries ?? [];

  const next: CareerSaveState = {
    ...career,
    tier: nextTier,
    season: nextSeason,
    seasonPoints: 0,
    previousRank: 8,
    calendar: generateSeasonCalendar(nextTier, nextSeason),
    opponents: nextOpponents,
    sponsors: nextSponsors,
    rivalries: nextRivalries,
    seasonSummaries: [summary, ...career.seasonSummaries],
    activeTournament: null,
    pendingSeasonSummary: null,
  };
  saveCareerState(next);
  return next;
}

export interface RankedCircuitEntry {
  id: string;
  name: string;
  nationalityCode: string;
  nationality: string;
  isPlayer: boolean;
  tier: CareerTierId;
  rank: number;
  delta: number; // positive = moved up
  points: number;
  careerPoints: number;
  recentResults: number[];
  wins: number;
  podiums: number;
  bestWave: number;
  style: string;
  gapToLeader: number;
  aiProfile?: AISurfer;
}

export function computeTierStandings(
  career: CareerSaveState,
  tier: CareerTierId
): RankedCircuitEntry[] {
  const tierOpponents = career.opponents.filter((o) => o.tier === tier);
  const rows: Omit<RankedCircuitEntry, 'rank' | 'delta' | 'gapToLeader'>[] = tierOpponents.map(
    (ai) => ({
      id: ai.id,
      name: ai.name,
      nationalityCode: ai.nationalityCode,
      nationality: ai.nationality,
      isPlayer: false,
      tier: ai.tier,
      points: ai.seasonPoints,
      careerPoints: ai.careerPoints,
      recentResults: ai.recentResults,
      wins: ai.wins,
      podiums: ai.podiums,
      bestWave: ai.bestWave,
      style: ai.style,
      aiProfile: ai,
    })
  );

  if (career.tier === tier) {
    rows.push({
      id: 'player',
      name: career.surfer.name,
      nationalityCode: career.surfer.nationalityCode,
      nationality: career.surfer.nationality,
      isPlayer: true,
      tier: career.tier,
      points: career.seasonPoints,
      careerPoints: career.careerPoints,
      recentResults: career.recentResults,
      wins: career.wins,
      podiums: career.podiums,
      bestWave: career.bestWave,
      style: career.surfer.style,
    });
  }

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.bestWave !== a.bestWave) return b.bestWave - a.bestWave;
    return b.careerPoints - a.careerPoints;
  });

  const leaderPts = rows[0]?.points ?? 0;

  return rows.map((row, idx) => {
    const rank = idx + 1;
    const prevRank = row.isPlayer
      ? career.previousRank
      : row.aiProfile?.previousRank ?? rank;
    return {
      ...row,
      rank,
      delta: prevRank - rank,
      gapToLeader: Math.max(0, leaderPts - row.points),
    };
  });
}

export function computeGlobalWorldRanking(career: CareerSaveState): RankedCircuitEntry[] {
  const tierWeight: Record<CareerTierId, number> = {
    mundial: 4000,
    acesso: 2000,
    regional: 800,
    amador: 0,
  };

  const all: Omit<RankedCircuitEntry, 'rank' | 'delta' | 'gapToLeader'>[] = [
    ...career.opponents.map((ai) => ({
      id: ai.id,
      name: ai.name,
      nationalityCode: ai.nationalityCode,
      nationality: ai.nationality,
      isPlayer: false,
      tier: ai.tier,
      points: ai.careerPoints + tierWeight[ai.tier],
      careerPoints: ai.careerPoints,
      recentResults: ai.recentResults,
      wins: ai.wins,
      podiums: ai.podiums,
      bestWave: ai.bestWave,
      style: ai.style,
      aiProfile: ai,
    })),
    {
      id: 'player',
      name: career.surfer.name,
      nationalityCode: career.surfer.nationalityCode,
      nationality: career.surfer.nationality,
      isPlayer: true,
      tier: career.tier,
      points: career.careerPoints + tierWeight[career.tier],
      careerPoints: career.careerPoints,
      recentResults: career.recentResults,
      wins: career.wins,
      podiums: career.podiums,
      bestWave: career.bestWave,
      style: career.surfer.style,
    },
  ];

  all.sort((a, b) => b.points - a.points || b.wins - a.wins);
  const leaderPts = all[0]?.points ?? 0;

  return all.map((row, idx) => ({
    ...row,
    rank: idx + 1,
    delta: 0,
    gapToLeader: Math.max(0, leaderPts - row.points),
  }));
}

export function acceptSponsorInvite(career: CareerSaveState, brandId: string): CareerSaveState {
  const next: CareerSaveState = {
    ...career,
    sponsors: career.sponsors.map((c) =>
      c.brandId === brandId && c.status === 'invited'
        ? { ...c, status: 'active', signedSeason: career.season }
        : c
    ),
  };
  saveCareerState(next);
  return next;
}

export function declineSponsorInvite(career: CareerSaveState, brandId: string): CareerSaveState {
  const next: CareerSaveState = {
    ...career,
    sponsors: career.sponsors.filter((c) => !(c.brandId === brandId && c.status === 'invited')),
  };
  saveCareerState(next);
  return next;
}

export function buyCareerBoard(career: CareerSaveState, boardId: string): CareerSaveState {
  if (career.unlockedBoardIds.includes(boardId)) return career;
  const item = CAREER_BOARD_CATALOG.find((b) => b.id === boardId);
  if (!item) return career;
  if (getTierOrderIndex(career.tier) < getTierOrderIndex(item.tierRequired)) return career;
  if (career.prizeBalance < item.price) return career;

  const next: CareerSaveState = {
    ...career,
    prizeBalance: career.prizeBalance - item.price,
    unlockedBoardIds: [...career.unlockedBoardIds, boardId],
    equippedBoardId: boardId,
  };
  saveCareerState(next);
  return next;
}

export function equipCareerBoard(career: CareerSaveState, boardId: string): CareerSaveState {
  if (!career.unlockedBoardIds.includes(boardId)) return career;
  const next: CareerSaveState = {
    ...career,
    equippedBoardId: boardId,
  };
  saveCareerState(next);
  return next;
}

export function updateCareerCustomization(
  career: CareerSaveState,
  patch: Partial<CareerSurferCustomization>
): CareerSaveState {
  const next: CareerSaveState = {
    ...career,
    surfer: {
      ...career.surfer,
      ...patch,
    },
  };
  saveCareerState(next);
  return next;
}

export function getBrandById(brandId: string): SponsorBrand | undefined {
  return SPONSOR_BRANDS.find((b) => b.id === brandId);
}

export function getAvailableTierInfo(tier: CareerTierId) {
  return TIER_MAP[tier];
}

export function getAllTiers() {
  return CAREER_TIERS;
}

export function dismissRivalryNotification(
  career: CareerSaveState,
  notificationId: string
): CareerSaveState {
  const next: CareerSaveState = {
    ...career,
    rivalryNotifications: (career.rivalryNotifications ?? []).map((n) =>
      n.id === notificationId ? { ...n, seen: true } : n
    ),
  };
  saveCareerState(next);
  return next;
}

export function getTopRivalry(career: CareerSaveState): {
  record: RivalryRecord;
  ai: AISurfer;
} | null {
  const list = career.rivalries ?? [];
  if (list.length === 0) return null;
  const sorted = [...list].sort(
    (a, b) =>
      Number(b.activeChallenge) - Number(a.activeChallenge) ||
      b.intensity - a.intensity ||
      b.closeFinishes - a.closeFinishes
  );
  for (const r of sorted) {
    const ai = career.opponents.find((o) => o.id === r.rivalId);
    if (ai && ai.tier === career.tier) {
      return { record: r, ai };
    }
  }
  const fallback = sorted[0];
  const ai = career.opponents.find((o) => o.id === fallback.rivalId);
  return ai ? { record: fallback, ai } : null;
}

