export const DEFAULT_ROUND_START_WINDOW_MS = 10 * 60 * 1000;

export function getTimestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function getManualRoundStartMs(sessionData, roundId) {
  const startedAt = sessionData?.roundStarts?.[roundId];
  const startedAtMs = getTimestampMs(startedAt);

  return startedAtMs || null;
}

export function getRoundUnlockMs(lobbyData, roundId) {
  const unlockMs = getTimestampMs(lobbyData?.roundStarts?.[roundId]);

  return unlockMs || null;
}

function getSessionEntryMs(sessionData) {
  return (
    getTimestampMs(sessionData?.createdAt) ||
    getTimestampMs(sessionData?.lastSeenAt) ||
    getTimestampMs(sessionData?.updatedAt) ||
    null
  );
}

function areAllRoundAnswersPresent(sessionData, round) {
  return round.questionIds.every((questionId) => {
    const savedText = sessionData?.answers?.[questionId]?.text;

    return typeof savedText === "string" && savedText.trim().length > 0;
  });
}

function getAnsweredRoundCompletionMs(sessionData, round, now = Date.now()) {
  if (!areAllRoundAnswersPresent(sessionData, round)) return null;

  const answerUpdatedMs = round.questionIds
    .map((questionId) => getTimestampMs(sessionData?.answers?.[questionId]?.updatedAt))
    .filter(Boolean);

  return (
    Math.max(...answerUpdatedMs, 0) ||
    getTimestampMs(sessionData?.updatedAt) ||
    getTimestampMs(sessionData?.lastSeenAt) ||
    now
  );
}

export function getRoundCompletionMs(
  sessionData,
  round,
  now,
  lobbyData,
  quizRounds = [],
  roundStartWindowMs = DEFAULT_ROUND_START_WINDOW_MS,
) {
  const answeredCompletionMs = getAnsweredRoundCompletionMs(sessionData, round, now);

  if (answeredCompletionMs) return answeredCompletionMs;

  const startMs = getEffectiveRoundStartMs(
    sessionData,
    lobbyData,
    round.id,
    now,
    quizRounds,
    roundStartWindowMs,
  );

  if (startMs === null) return null;

  const durationMs = getRoundDurationMs(round, lobbyData);
  const timedCompletionMs = startMs + durationMs;

  return timedCompletionMs <= now ? timedCompletionMs : null;
}

export function getRoundEligibilityMs(
  sessionData,
  lobbyData,
  roundId,
  now = Date.now(),
  quizRounds = [],
  roundStartWindowMs = DEFAULT_ROUND_START_WINDOW_MS,
) {
  const unlockMs = getRoundUnlockMs(lobbyData, roundId);
  const roundIndex = quizRounds.findIndex((round) => round.id === roundId);

  if (roundIndex <= 0) {
    const entryMs = getSessionEntryMs(sessionData);
    if (!unlockMs && !entryMs) return null;
    return Math.max(unlockMs || 0, entryMs || 0) || null;
  }

  const previousRound = quizRounds[roundIndex - 1];
  if (!previousRound) return unlockMs;

  const previousCompletionMs = getRoundCompletionMs(
    sessionData,
    previousRound,
    now,
    lobbyData,
    quizRounds,
    roundStartWindowMs,
  );

  if (!previousCompletionMs && !unlockMs) return null;
  if (!previousCompletionMs) return null;

  return Math.max(unlockMs || 0, previousCompletionMs) || null;
}

export function getEffectiveRoundStartMs(
  sessionData,
  lobbyData,
  roundId,
  now = Date.now(),
  quizRounds = [],
  roundStartWindowMs = DEFAULT_ROUND_START_WINDOW_MS,
) {
  const manualStartMs = getManualRoundStartMs(sessionData, roundId);

  if (manualStartMs !== null) return manualStartMs;

  const eligibilityMs = getRoundEligibilityMs(
    sessionData,
    lobbyData,
    roundId,
    now,
    quizRounds,
    roundStartWindowMs,
  );
  const autoStartMs = eligibilityMs ? eligibilityMs + roundStartWindowMs : null;

  if (autoStartMs && now >= autoStartMs) {
    return autoStartMs;
  }

  return null;
}

export function getRoundExtraMinutes(lobbyData, roundId) {
  const rawValue = Number(lobbyData?.roundExtraMinutes?.[roundId]);

  return Number.isFinite(rawValue) ? Math.max(0, Math.min(30, rawValue)) : 0;
}

export function getRoundDurationMs(round, lobbyData) {
  const baseDurationMs = (round?.durationMinutes || 0) * 60 * 1000;
  const extraDurationMs = getRoundExtraMinutes(lobbyData, round?.id) * 60 * 1000;

  return baseDurationMs + extraDurationMs;
}

export function isRoundFinished(
  team,
  round,
  now,
  lobbyData,
  quizRounds = [],
  roundStartWindowMs = DEFAULT_ROUND_START_WINDOW_MS,
) {
  if (areAllRoundAnswersPresent(team, round)) return true;

  const startMs = getEffectiveRoundStartMs(
    team,
    lobbyData,
    round.id,
    now,
    quizRounds,
    roundStartWindowMs,
  );

  if (startMs === null) return false;

  const durationMs = getRoundDurationMs(round, lobbyData);
  return startMs + durationMs <= now;
}
