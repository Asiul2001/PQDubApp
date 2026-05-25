import { getTimestampMs } from "./quizTiming.js";

export function getTiebreakerSubmission(lobbyData, teamId) {
  return lobbyData?.tiebreakerSubmissions?.[teamId] || null;
}

export function getTiebreakerParticipant(lobbyData, teamId) {
  return lobbyData?.tiebreakerParticipants?.[teamId] || null;
}

export function getEstimateValue(lobbyData, teamId) {
  const rawEstimate = getTiebreakerSubmission(lobbyData, teamId)?.estimate;
  const estimate = Number(rawEstimate);

  return Number.isFinite(estimate) ? estimate : null;
}

function getTiebreakerSubmittedMs(lobbyData, teamId) {
  return getTimestampMs(getTiebreakerSubmission(lobbyData, teamId)?.submittedAt);
}

export function getTiebreakerDistance(lobbyData, teamId) {
  const answer = Number(lobbyData?.tiebreakerAnswer);
  const estimate = getEstimateValue(lobbyData, teamId);

  if (!Number.isFinite(answer) || estimate === null) return null;

  return Math.abs(estimate - answer);
}

function getRemainingPotentialPoints(team, finalRound, questionPointsById = {}) {
  return finalRound.questionIds.reduce((sum, questionId) => {
    const savedText = team?.answers?.[questionId]?.text;
    const answered = typeof savedText === "string" && savedText.trim().length > 0;

    if (answered) return sum;

    return sum + (Number(questionPointsById?.[questionId]) || 0);
  }, 0);
}

export function getMaximumPossiblePoints(team, finalRound, questionPointsById = {}) {
  return (
    (Number(team?.totalPoints) || 0) +
    getRemainingPotentialPoints(team, finalRound, questionPointsById)
  );
}

export function getDailyRankingWithTiebreakers(teams, lobbyData) {
  const pointGroups = new Map();

  teams.forEach((team) => {
    const points = team.totalPoints || 0;
    pointGroups.set(points, [...(pointGroups.get(points) || []), team]);
  });

  const sortedPointGroups = Array.from(pointGroups.entries()).sort(
    ([pointsA], [pointsB]) => pointsB - pointsA,
  );
  const ranking = [];
  const tieGroups = [];

  sortedPointGroups.forEach(([points, pointGroup]) => {
    const sortedGroup = [...pointGroup].sort((a, b) => {
      const answer = Number(lobbyData?.tiebreakerAnswer);
      const exactA =
        Number.isFinite(answer) && getEstimateValue(lobbyData, a.id) === answer;
      const exactB =
        Number.isFinite(answer) && getEstimateValue(lobbyData, b.id) === answer;

      if (exactA !== exactB) return exactA ? -1 : 1;

      const distanceA = getTiebreakerDistance(lobbyData, a.id);
      const distanceB = getTiebreakerDistance(lobbyData, b.id);

      if (distanceA !== null && distanceB !== null && distanceA !== distanceB) {
        return distanceA - distanceB;
      }

      if (distanceA !== null && distanceB === null) return -1;
      if (distanceA === null && distanceB !== null) return 1;

      const submittedA = getTiebreakerSubmittedMs(lobbyData, a.id);
      const submittedB = getTiebreakerSubmittedMs(lobbyData, b.id);

      if (submittedA && submittedB && submittedA !== submittedB) {
        return submittedA - submittedB;
      }

      if (submittedA && !submittedB) return -1;
      if (!submittedA && submittedB) return 1;

      const estimateA = getEstimateValue(lobbyData, a.id);
      const estimateB = getEstimateValue(lobbyData, b.id);

      if (estimateA !== null && estimateB !== null && estimateA !== estimateB) {
        return estimateA - estimateB;
      }

      return a.teamName.localeCompare(b.teamName);
    });
    const startIndex = ranking.length;

    ranking.push(...sortedGroup);

    if (
      pointGroup.length > 1 &&
      startIndex < 3 &&
      startIndex + pointGroup.length > 0
    ) {
      tieGroups.push({
        points,
        teams: sortedGroup,
        affectsPodium: startIndex < 3,
      });
    }
  });

  return {
    ranking,
    tieGroups,
  };
}

export function getTiebreakerState({
  teams,
  lobbyData,
  finalRound,
  now,
  isRoundFinished,
  quizRounds = [],
  questionPointsById = {},
}) {
  const excludedTeamIds = new Set(
    Object.entries(lobbyData?.tiebreakerExcludedTeams || {})
      .filter(([, value]) => Boolean(value?.active))
      .map(([teamId]) => teamId),
  );
  const eligibleTeams = teams.filter((team) => !excludedTeamIds.has(team.id));
  const dailyRanking = getDailyRankingWithTiebreakers(teams, lobbyData);
  const podiumCutoffIndex = Math.min(2, Math.max(eligibleTeams.length - 1, 0));
  const podiumCutoffPoints =
    getDailyRankingWithTiebreakers(eligibleTeams, lobbyData).ranking[podiumCutoffIndex]?.totalPoints ??
    getDailyRankingWithTiebreakers(eligibleTeams, lobbyData).ranking[
      getDailyRankingWithTiebreakers(eligibleTeams, lobbyData).ranking.length - 1
    ]?.totalPoints ??
    0;
  const relevantTeams = eligibleTeams.filter((team) => {
    if (isRoundFinished(team, finalRound, now, lobbyData, quizRounds)) return true;

    return (
      getMaximumPossiblePoints(team, finalRound, questionPointsById) >=
      podiumCutoffPoints
    );
  });
  const relevantTeamIds = relevantTeams.map((team) => team.id);
  const allRelevantTeamsFinishedFinalRound =
    relevantTeams.length > 0 &&
    relevantTeams.every((team) => isRoundFinished(team, finalRound, now, lobbyData, quizRounds));
  const relevantRanking = getDailyRankingWithTiebreakers(relevantTeams, lobbyData);
  const podiumTieGroups = relevantRanking.tieGroups.filter((group) => group.affectsPodium);
  const tiedTeams = Array.from(
    new Map(
      podiumTieGroups.flatMap((group) => group.teams).map((team) => [team.id, team]),
    ).values(),
  );
  const hasPodiumTie = tiedTeams.length > 0;
  const allTiedTeamsReady =
    tiedTeams.length > 0 &&
    tiedTeams.every((team) => Boolean(lobbyData?.tiebreakerReady?.[team.id]));
  const allTiedTeamsSubmitted =
    tiedTeams.length > 0 &&
    tiedTeams.every((team) => Boolean(lobbyData?.tiebreakerSubmissions?.[team.id]));
  const isActive = lobbyData?.tiebreakerStatus === "active";

  let status = "not-needed";
  if (hasPodiumTie) {
    if (!allRelevantTeamsFinishedFinalRound) {
      status = "waiting-for-relevant-teams";
    } else if (isActive && allTiedTeamsSubmitted) {
      status = "completed";
    } else if (isActive) {
      status = "active";
    } else if (!allTiedTeamsReady) {
      status = "waiting-for-tied-teams-ready";
    } else {
      status = "ready-to-start";
    }
  }

  return {
    allRelevantTeamsFinishedFinalRound,
    allTiedTeamsReady,
    allTiedTeamsSubmitted,
    dailyRanking,
    excludedTeamIds: Array.from(excludedTeamIds),
    hasPodiumTie,
    isActive,
    podiumCutoffPoints,
    podiumTieGroups,
    relevantTeamIds,
    relevantTeams,
    relevantRanking,
    status,
    tiedTeamIds: tiedTeams.map((team) => team.id),
    tiedTeams,
  };
}
