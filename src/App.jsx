import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "./firebase";
import {
  arrayUnion,
  writeBatch,
  collection,
  collectionGroup,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { checkAnswer } from "./answerChecker";
import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import {
  hintBudgets,
  latestQuizId,
  questions as defaultQuestions,
  quizRounds as defaultQuizRounds,
} from "./quiz";
import {
  DEFAULT_ROUND_START_WINDOW_MS,
  getEffectiveRoundStartMs,
  getManualRoundStartMs,
  getRoundEligibilityMs,
  getRoundDurationMs,
  getRoundExtraMinutes,
  getRoundUnlockMs,
  getTimestampMs,
  isRoundFinished,
} from "./quizTiming";
import {
  getDailyRankingWithTiebreakers,
  getEstimateValue,
  getTiebreakerDistance,
  getTiebreakerParticipant,
  getTiebreakerState,
  getTiebreakerSubmission,
} from "./tiebreaker";

const pageStyle = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at top, rgba(34,197,94,0.12), transparent 24%), linear-gradient(180deg, #081120 0%, #0f172a 42%, #111827 100%)",
  color: "#e5e7eb",
  fontFamily: '"Avenir Next", "Trebuchet MS", "Segoe UI", sans-serif',
  padding: "80px 20px 24px",
  boxSizing: "border-box",
};

const inputStyle = {
  width: "100%",
  padding: 14,
  borderRadius: 16,
  border: "1px solid rgba(148, 163, 184, 0.24)",
  background: "rgba(8, 15, 30, 0.92)",
  color: "#f8fafc",
  fontSize: 18,
  boxSizing: "border-box",
  outline: "none",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
};

const pointMessages = [
  "Stark, der Punkt sitzt!",
  "Sehr schön, weiter so!",
  "Treffer! Genau so.",
  "Sauber gelöst!",
  "Jawoll, Punkt geholt!",
  "Das Team läuft warm!",
  "Richtig gut kombiniert!",
  "Schöner Treffer!",
  "Ihr seid auf Kurs!",
  "Klasse, nächster Punkt!",
  "Das war souverän!",
  "Sehr stabil!",
  "Genau ins Schwarze!",
  "Weiter so, das sieht gut aus!",
  "Fein gemacht!",
  "Richtig stark gespielt!",
  "Da kommt Quiz-Magie auf!",
  "Punkt eingesackt!",
];

const ANSWER_WINDOW_MS = 5 * 60 * 60 * 1000;
const ROUND_START_WINDOW_MS = DEFAULT_ROUND_START_WINDOW_MS;
const EMERGENCY_JOIN_WINDOW_MS = 5 * 60 * 1000;
const HIDDEN_YEARLY_RANKING_TEAM_IDS = new Set(["asiul"]);
const RECENT_MANAGER_SESSION_KEY = "pqRecentManagerSession";
const RECENT_PLAYER_SESSION_KEY = "pqRecentPlayerSession";
const RECENT_PLAYER_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeTeamName(name) {
  return name
    .toLowerCase()
    .replace(/\b(the|der|die|das)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeManagerKey(key) {
  return key.replace(/[^a-z0-9_-]/gi, "").toLowerCase().slice(0, 32);
}

function normalizeLobbyCode(code) {
  return code.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 5);
}

function normalizeQuizCode(code) {
  return code.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6);
}

function normalizeRankingPassword(password) {
  return password.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 4);
}

function isHiddenFromYearlyRanking(teamIdOrName = "") {
  const normalized = normalizeTeamName(teamIdOrName);
  return HIDDEN_YEARLY_RANKING_TEAM_IDS.has(normalized);
}

function getInitialQuizCode() {
  if (typeof window === "undefined") return "";

  const params = new URLSearchParams(window.location.search);

  return normalizeQuizCode(
    params.get("quiz") || params.get("code") || params.get("pq") || "",
  );
}

function createQuizStartUrl(quizCode) {
  if (typeof window === "undefined" || !quizCode) return "";

  const url = new URL(window.location.href);

  url.searchParams.set("quiz", normalizeQuizCode(quizCode));
  url.hash = "";

  return url.toString();
}

function createQuizCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  return Array.from({ length: 6 }, () =>
    alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join("");
}

function createRankingPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  return Array.from({ length: 4 }, () =>
    alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join("");
}

function getLobbyId(code) {
  return `${latestQuizId}__${code}`;
}

function getEventId(code) {
  return `${latestQuizId}__${normalizeQuizCode(code)}`;
}

function getTeamId(name) {
  return normalizeTeamName(name);
}

function getTeammateId(name) {
  return normalizePersonName(name);
}

function getLastQuizRound(quizRounds) {
  return quizRounds?.[quizRounds.length - 1] || defaultQuizRounds[defaultQuizRounds.length - 1];
}

function getQuestionDefaultPoints(questionIndex) {
  return questionIndex === 5 ? 2 : 1;
}

function createManagerRecord({
  key,
  name,
  password,
  active = true,
  createdAt,
  headManager = false,
  canEditScores = headManager,
}) {
  return {
    key,
    name: name || key,
    password,
    active,
    canEditScores,
    headManager,
    createdAt: createdAt || serverTimestamp(),
    lastLoginAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function getEventRef(code) {
  return doc(db, "quizEvents", getEventId(code));
}

function getTeamRef(teamId) {
  return doc(db, "teams", teamId);
}

function getTeamSessionRef(code, teamId) {
  return doc(db, "quizEvents", getEventId(code), "teamSessions", teamId);
}

function getEventVoucherRef(eventId, voucherId) {
  return doc(db, "quizEvents", eventId, "vouchers", voucherId);
}

function getTeammateRef(teamId, teammateId) {
  return doc(db, "teams", teamId, "teammates", teammateId);
}

function getEmergencyJoinWindowEndsMs(lobbyData) {
  return getTimestampMs(lobbyData?.emergencyJoinWindowEndsAt);
}

function isEmergencyJoinWindowActive(lobbyData, now = Date.now()) {
  const endsAtMs = getEmergencyJoinWindowEndsMs(lobbyData);
  return Boolean(endsAtMs && endsAtMs > now);
}

function isNewTeamJoinClosed(lobbyData, now = Date.now()) {
  const closedAtMs = getTimestampMs(lobbyData?.closedAt);
  return Boolean(closedAtMs && !isEmergencyJoinWindowActive(lobbyData, now));
}

function isRoundUnlocked(lobbyData, roundId) {
  return Boolean(
    lobbyData?.unlockedRounds?.[roundId] || lobbyData?.roundStarts?.[roundId],
  );
}

function isRoundAnswersRevealed(lobbyData, roundId) {
  return Boolean(lobbyData?.revealedAnswers?.[roundId]);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function repairMojibake(value) {
  if (typeof value !== "string") return value;

  return value
    .replace(/ÃƒÂ¤/g, "ä")
    .replace(/ÃƒÂ¶/g, "ö")
    .replace(/ÃƒÂ¼/g, "ü")
    .replace(/ÃƒÂ„/g, "Ä")
    .replace(/ÃƒÂ–/g, "Ö")
    .replace(/ÃƒÂœ/g, "Ü")
    .replace(/ÃƒÂŸ/g, "ß")
    .replace(/Ã¤/g, "ä")
    .replace(/Ã¶/g, "ö")
    .replace(/Ã¼/g, "ü")
    .replace(/Ã„/g, "Ä")
    .replace(/Ã–/g, "Ö")
    .replace(/Ãœ/g, "Ü")
    .replace(/ÃŸ/g, "ß");
}

const weekdayLabels = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function formatCompletionDate(value) {
  const ms = getTimestampMs(value);

  if (!ms) return "offen";

  const date = new Date(ms);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");

  return `${weekdayLabels[date.getDay()]}, ${day}.${month}.${date.getFullYear()}`;
}

function getCompletionValue(session) {
  return (
    session?.completedAt ||
    session?.updatedAt ||
    session?.lastSeenAt ||
    session?.createdAt
  );
}

function createSessionRecord({
  cleanedCode,
  cleanedName,
  displayName,
  normalized,
  rankingOptIn,
}) {
  return {
    id: normalized,
    eventId: getEventId(cleanedCode),
    quizId: latestQuizId,
    lobbyCode: cleanedCode,
    quizCode: cleanedCode,
    quizVersion: 1,
    teamId: normalized,
    teamName: cleanedName,
    teamNameNormalized: normalized,
    playerName: displayName,
    playerNames: displayName === "Anonym" ? [] : [displayName],
    normalizedPlayerNames:
      displayName === "Anonym" ? [] : [normalizePersonName(displayName)],
    rankingOptIn,
    yearlyRankingOptInAtTime: rankingOptIn,
    totalPoints: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  };
}

function getRoundPublicTitle(round, roundIndex, lobbyData) {
  if (!round) return `Runde ${roundIndex + 1}`;

  return isRoundUnlocked(lobbyData, round.id)
    ? getRoundDisplayTitle(round, roundIndex)
    : `Runde ${roundIndex + 1}`;
}

function createTeamRecord({ cleanedName, normalized, rankingOptIn }) {
  return {
    id: normalized,
    name: cleanedName,
    normalizedName: normalized,
    currentDisplayName: cleanedName,
    teamName: cleanedName,
    teamNameNormalized: normalized,
    yearlyRankingOptIn: rankingOptIn,
    rankingOptIn,
    gamesPlayed: 0,
    totalDailyPoints: 0,
    totalGlobalPoints: 0,
    totalPodiumBonusPoints: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function getPodiumBonusForRank(rankIndex) {
  if (rankIndex === 0) return 1.5;
  if (rankIndex === 1) return 1;
  if (rankIndex === 2) return 0.5;
  return 0;
}

function getSessionGlobalPoints(session) {
  const basePoints = Number(session?.totalPoints) || 0;
  const savedFinalPoints = Number(session?.finalDailyPointsForGlobal);

  if (Number.isFinite(savedFinalPoints)) {
    return savedFinalPoints;
  }

  return basePoints + (Number(session?.podiumBonusPoints) || 0);
}

function isAnswerWindowClosed(lobbyData, now) {
  const endsAtMs = getTimestampMs(lobbyData?.answerWindowEndsAt);

  return Boolean(endsAtMs && now > endsAtMs);
}


function canManageManagerRecords(activeManager, managers) {
  if (!activeManager) return false;
  if (activeManager.headManager) return true;

  return !managers.some((manager) => manager.headManager);
}

function canManagerEditScores(activeManager) {
  return Boolean(activeManager?.canEditScores || activeManager?.headManager);
}

function useIsNarrowScreen(breakpoint = 760) {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth <= breakpoint,
  );

  useEffect(() => {
    const updateWidth = () => setIsNarrow(window.innerWidth <= breakpoint);

    updateWidth();
    window.addEventListener("resize", updateWidth);

    return () => window.removeEventListener("resize", updateWidth);
  }, [breakpoint]);

  return isNarrow;
}

function getClientId() {
  const storageKey = "pqAppClientId";
  const existingId = window.localStorage.getItem(storageKey);

  if (existingId) return existingId;

  const nextId =
    window.crypto?.randomUUID?.() ||
    `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  window.localStorage.setItem(storageKey, nextId);

  return nextId;
}

function readRecentPlayerSession() {
  if (typeof window === "undefined") return null;

  try {
    const rawValue = window.localStorage.getItem(RECENT_PLAYER_SESSION_KEY);

    if (!rawValue) return null;

    const parsed = JSON.parse(rawValue);
    const savedAt = Number(parsed?.savedAt);

    if (
      !parsed ||
      !parsed.sessionId ||
      !parsed.lobbyCode ||
      !Number.isFinite(savedAt) ||
      Date.now() - savedAt > RECENT_PLAYER_SESSION_MAX_AGE_MS
    ) {
      window.localStorage.removeItem(RECENT_PLAYER_SESSION_KEY);
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn("RECENT PLAYER SESSION READ ERROR:", error);
    window.localStorage.removeItem(RECENT_PLAYER_SESSION_KEY);
    return null;
  }
}

function saveRecentPlayerSession(session) {
  if (typeof window === "undefined" || !session?.sessionId || !session?.lobbyCode) return;

  const bootstrapSession = {
    id: session.sessionId,
    lobbyCode: normalizeQuizCode(session.lobbyCode),
    managerOnly: false,
    playerName: session.playerName || "",
    quizCode: normalizeQuizCode(session.lobbyCode),
    rankingOptIn: Boolean(session.rankingOptIn),
    teamId: session.teamId || session.sessionId,
    teamName: session.teamName || "",
    teamNameNormalized:
      session.teamNameNormalized ||
      normalizeTeamName(session.teamName || session.teamId || session.sessionId || ""),
    totalPoints: Number(session.totalPoints) || 0,
  };

  window.localStorage.setItem(
    RECENT_PLAYER_SESSION_KEY,
    JSON.stringify({
      bootstrapSession,
      cachedSession: session.cachedSession || null,
      lobbyCode: normalizeQuizCode(session.lobbyCode),
      playerName: session.playerName || "",
      rankingOptIn: Boolean(session.rankingOptIn),
      savedAt: Date.now(),
      sessionId: session.sessionId,
      teamName: session.teamName || "",
    }),
  );
}

function clearRecentPlayerSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(RECENT_PLAYER_SESSION_KEY);
}

function readRecentManagerSession() {
  if (typeof window === "undefined") return null;

  try {
    const rawValue = window.localStorage.getItem(RECENT_MANAGER_SESSION_KEY);

    if (!rawValue) return null;

    const parsed = JSON.parse(rawValue);
    const savedAt = Number(parsed?.savedAt);

    if (
      !parsed ||
      !parsed.manager?.id ||
      !Number.isFinite(savedAt) ||
      Date.now() - savedAt > RECENT_PLAYER_SESSION_MAX_AGE_MS
    ) {
      window.localStorage.removeItem(RECENT_MANAGER_SESSION_KEY);
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn("RECENT MANAGER SESSION READ ERROR:", error);
    window.localStorage.removeItem(RECENT_MANAGER_SESSION_KEY);
    return null;
  }
}

function saveRecentManagerSession({ lobbyCode = "", manager }) {
  if (typeof window === "undefined" || !manager?.id) return;

  window.localStorage.setItem(
    RECENT_MANAGER_SESSION_KEY,
    JSON.stringify({
      lobbyCode: normalizeQuizCode(lobbyCode || ""),
      manager: {
        active: manager.active !== false,
        canEditScores: Boolean(manager.canEditScores ?? manager.headManager),
        headManager: Boolean(manager.headManager),
        id: manager.id,
        key: manager.key || manager.id,
        name: manager.name || manager.id,
      },
      savedAt: Date.now(),
    }),
  );
}

function clearRecentManagerSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(RECENT_MANAGER_SESSION_KEY);
}

function formatStopwatch(ms) {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = safeMs % 1000;

  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(
    milliseconds,
  ).padStart(3, "0")}`;
}

function getSessionDateKey(session) {
  const ms = getTimestampMs(getCompletionValue(session));

  if (!ms) return "unknown-date";

  return new Date(ms).toISOString().slice(0, 10);
}

function getParticipationKey(session) {
  const teamKey =
    session?.teamNameNormalized ||
    session?.teamId ||
    session?.id ||
    normalizeTeamName(session?.teamName || "");
  const eventKey =
    session?.eventId ||
    getEventId(session?.lobbyCode || session?.quizCode || "") ||
    getSessionDateKey(session);

  return `${teamKey}__${eventKey}`;
}

function mergeSessionParticipation(sessions = []) {
  const grouped = new Map();

  sessions.forEach((session) => {
    const key = getParticipationKey(session);
    const current = grouped.get(key);

    if (!current) {
      grouped.set(key, {
        ...session,
        playerNames: Array.from(new Set((session.playerNames || []).filter(Boolean))),
        normalizedPlayerNames: Array.from(
          new Set((session.normalizedPlayerNames || []).filter(Boolean)),
        ),
      });
      return;
    }

    const currentPoints = Number(current.totalPoints) || 0;
    const sessionPoints = Number(session.totalPoints) || 0;
    const currentMs = getTimestampMs(getCompletionValue(current));
    const sessionMs = getTimestampMs(getCompletionValue(session));
    const preferred =
      sessionPoints > currentPoints
        ? session
        : sessionPoints < currentPoints
          ? current
          : sessionMs >= currentMs
            ? session
            : current;

    grouped.set(key, {
      ...current,
      ...preferred,
      playerNames: Array.from(
        new Set([
          ...(current.playerNames || []),
          ...(session.playerNames || []),
          current.playerName,
          session.playerName,
        ].filter(Boolean)),
      ),
      normalizedPlayerNames: Array.from(
        new Set([
          ...(current.normalizedPlayerNames || []),
          ...(session.normalizedPlayerNames || []),
          normalizePersonName(current.playerName || ""),
          normalizePersonName(session.playerName || ""),
        ].filter(Boolean)),
      ),
      totalPoints: Math.max(Number(current.totalPoints) || 0, Number(session.totalPoints) || 0),
      podiumBonusPoints: Math.max(
        Number(current.podiumBonusPoints) || 0,
        Number(session.podiumBonusPoints) || 0,
      ),
      finalDailyPointsForGlobal: Math.max(
        Number(current.finalDailyPointsForGlobal) || 0,
        Number(session.finalDailyPointsForGlobal) || 0,
      ),
      rankDaily:
        [Number(current.rankDaily) || 0, Number(session.rankDaily) || 0]
          .filter((value) => value > 0)
          .sort((a, b) => a - b)[0] || undefined,
      scoreAdjustment: session.scoreAdjustment?.active
        ? session.scoreAdjustment
        : current.scoreAdjustment,
    });
  });

  return Array.from(grouped.values()).sort((a, b) => {
    const timeDifference =
      getTimestampMs(getCompletionValue(b)) - getTimestampMs(getCompletionValue(a));
    return timeDifference || (a.teamName || "").localeCompare(b.teamName || "");
  });
}

function aggregateYearlyRanking(teams) {
  const mergedTeams = mergeSessionParticipation(teams);
  const groupedTeams = new Map();
  const lobbyGroups = new Map();
  const rankingTeamKeys = new Set();

  mergedTeams.forEach((team) => {
    const key = team.teamNameNormalized || normalizeTeamName(team.teamName || "");
    if (team.rankingOptIn && key) rankingTeamKeys.add(key);
  });

  mergedTeams
    .filter((team) =>
      rankingTeamKeys.has(team.teamNameNormalized || normalizeTeamName(team.teamName || "")),
    )
    .forEach((team) => {
      const lobbyCode = team.lobbyCode || "unknown";
      lobbyGroups.set(lobbyCode, [...(lobbyGroups.get(lobbyCode) || []), team]);
    });

  lobbyGroups.forEach((lobbyTeams) => {
    lobbyTeams.forEach((team) => {
      const key = team.teamNameNormalized || normalizeTeamName(team.teamName || "");
      if (!key) return;
      const quizPoints = Number(team.totalPoints) || 0;
      const globalPoints = getSessionGlobalPoints(team);

      const current = groupedTeams.get(key) || {
        id: key,
        teamName: team.teamName || key,
        teamNameNormalized: key,
        podiums: 0,
        totalQuizPoints: 0,
        totalPoints: 0,
        sessions: 0,
        playerNames: [],
        normalizedPlayerNames: [],
      };

      groupedTeams.set(key, {
        ...current,
        totalQuizPoints: current.totalQuizPoints + quizPoints,
        totalPoints: current.totalPoints + globalPoints,
        sessions: current.sessions + 1,
        playerNames: Array.from(
          new Set([
            ...current.playerNames,
            ...(team.playerNames || []),
            team.playerName,
          ].filter(Boolean)),
        ),
        normalizedPlayerNames: Array.from(
          new Set([
            ...current.normalizedPlayerNames,
            ...(team.normalizedPlayerNames || []),
            normalizePersonName(team.playerName || ""),
          ].filter(Boolean)),
        ),
      });
    });
  });

  return Array.from(groupedTeams.values()).sort(
    (a, b) => b.totalPoints - a.totalPoints || a.teamName.localeCompare(b.teamName),
  );
}

function aggregateTeamDirectory(teams, teamProfiles = []) {
  const groupedTeams = new Map();
  const profileMap = new Map(
    teamProfiles.map((teamProfile) => [
      teamProfile.teamNameNormalized || teamProfile.normalizedName || teamProfile.id,
      teamProfile,
    ]),
  );
  const mergedSessions = mergeSessionParticipation(teams);

  teamProfiles.forEach((teamProfile) => {
    const key =
      teamProfile.teamNameNormalized ||
      teamProfile.normalizedName ||
      normalizeTeamName(teamProfile.teamName || teamProfile.name || "");
    if (!key) return;

    groupedTeams.set(key, {
      id: key,
      normalizedPlayerNames: Array.from(
        new Set((teamProfile.normalizedPlayerNames || []).filter(Boolean)),
      ),
      playerNames: Array.from(new Set((teamProfile.playerNames || []).filter(Boolean))),
      rankingPassword: teamProfile.rankingPassword || "",
      rankingOptIn: Boolean(teamProfile.rankingOptIn || teamProfile.yearlyRankingOptIn),
      sessions: [],
      teamName: teamProfile.teamName || teamProfile.name || key,
      teamNameNormalized: key,
      totalPoints:
        Number(teamProfile.totalGlobalPoints) ||
        Number(teamProfile.totalDailyPoints) ||
        0,
    });
  });

  mergedSessions.forEach((team) => {
    const key = team.teamNameNormalized || normalizeTeamName(team.teamName || "");
    if (!key) return;
    const profile = profileMap.get(key);

    const current = groupedTeams.get(key) || {
      id: key,
      normalizedPlayerNames: [],
      playerNames: [],
      rankingPassword: profile?.rankingPassword || "",
      rankingOptIn: Boolean(profile?.rankingOptIn || profile?.yearlyRankingOptIn),
      sessions: [],
      teamName: team.teamName || key,
      teamNameNormalized: key,
      totalPoints: 0,
    };

    groupedTeams.set(key, {
      ...current,
      normalizedPlayerNames: Array.from(
        new Set([
          ...current.normalizedPlayerNames,
          ...(team.normalizedPlayerNames || []),
          normalizePersonName(team.playerName || ""),
        ].filter(Boolean)),
      ),
      playerNames: Array.from(
        new Set([
          ...current.playerNames,
          ...(team.playerNames || []),
          team.playerName,
        ].filter(Boolean)),
      ),
      rankingPassword: current.rankingPassword || profile?.rankingPassword || "",
      rankingOptIn:
        current.rankingOptIn ||
        Boolean(team.rankingOptIn || profile?.rankingOptIn || profile?.yearlyRankingOptIn),
      sessions: [...current.sessions, team].sort(
        (a, b) => getTimestampMs(getCompletionValue(b)) - getTimestampMs(getCompletionValue(a)),
      ),
      totalPoints: current.totalPoints + (team.totalPoints || 0),
    });
  });

  return Array.from(groupedTeams.values()).sort(
    (a, b) => b.totalPoints - a.totalPoints || a.teamName.localeCompare(b.teamName),
  );
}

function getQuestionAnswerText(team, questionId) {
  return team?.answers?.[questionId]?.text?.trim() || "";
}

function getAnsweredQuestionCount(team, questionIds = []) {
  return questionIds.filter((questionId) => getQuestionAnswerText(team, questionId)).length;
}

function getAnswerPointsTotal(answers = {}) {
  return Object.values(answers || {}).reduce(
    (sum, answer) => sum + (Number(answer?.pointsAwarded) || 0),
    0,
  );
}

function areMatchedSegmentsEqual(left = [], right = []) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

function buildAuditedAnswers(answers = {}, quizQuestions = {}) {
  const nextAnswers = {};
  let correctedQuestionCount = 0;

  Object.entries(answers || {}).forEach(([questionId, currentAnswer]) => {
    const quizQuestion = quizQuestions?.[questionId];

    if (!quizQuestion || currentAnswer?.manualOverride?.active) {
      nextAnswers[questionId] = currentAnswer;
      return;
    }

    const result = checkAnswer(
      currentAnswer?.text ?? "",
      quizQuestion.acceptedAnswers || [],
      quizQuestion.points || 0,
    );
    const nextAnswer = {
      ...currentAnswer,
      locked:
        result.result === "correct"
          ? true
          : Boolean(currentAnswer?.locked),
      matchedSegments: result.matchedSegments,
      pointsAwarded: result.result === "correct" ? result.pointsAwarded : 0,
      result: result.result,
    };
    const changed =
      (currentAnswer?.result || "") !== nextAnswer.result ||
      Boolean(currentAnswer?.locked) !== Boolean(nextAnswer.locked) ||
      (Number(currentAnswer?.pointsAwarded) || 0) !== nextAnswer.pointsAwarded ||
      !areMatchedSegmentsEqual(
        currentAnswer?.matchedSegments || [],
        nextAnswer.matchedSegments || [],
      );

    if (changed) correctedQuestionCount += 1;
    nextAnswers[questionId] = nextAnswer;
  });

  return {
    correctedQuestionCount,
    nextAnswers,
    nextTotalPoints: getAnswerPointsTotal(nextAnswers),
  };
}

function getNormalizedSessionQuizCode(session) {
  const eventCode =
    typeof session?.eventId === "string" ? session.eventId.split("__").pop() || "" : "";

  return normalizeQuizCode(session?.quizCode || session?.lobbyCode || eventCode || "");
}

function findPubQuizForSession(session, pubQuizzes = []) {
  const normalizedQuizCode = getNormalizedSessionQuizCode(session);
  const storedQuizId =
    session?.quizId && session.quizId !== latestQuizId ? String(session.quizId) : "";

  return pubQuizzes.find((quiz) => {
    const quizCodeMatches =
      normalizedQuizCode &&
      normalizeQuizCode(quiz?.quizCode || "") === normalizedQuizCode;

    const quizIdMatches = storedQuizId && String(quiz?.id || "") === storedQuizId;

    return quizCodeMatches || quizIdMatches;
  });
}

function getQuizLabelForSession(session, pubQuizzes = []) {
  const matchingQuiz = findPubQuizForSession(session, pubQuizzes);

  return (
    matchingQuiz?.title ||
    getNormalizedSessionQuizCode(session) ||
    session?.quizCode ||
    session?.lobbyCode ||
    "Pubquiz"
  );
}

function getRoundDisplayTitle(round, roundIndex = 0) {
  const rawTitle = String(round?.title || "").trim();
  const rawCategory = String(round?.category || "").trim();
  const genericTitle = rawTitle.match(/^runde\s*\d+$/i);

  if (rawTitle && rawCategory && genericTitle) {
    return `Runde ${roundIndex + 1}: ${rawCategory}`;
  }

  if (rawTitle) return rawTitle;
  if (rawCategory) return `Runde ${roundIndex + 1}: ${rawCategory}`;

  return `Runde ${roundIndex + 1}`;
}

function getVoucherReward(rank) {
  if (rank === 1) {
    return {
      title: "1. Platz Gutschein",
      description: "50 Euro Gutschein Verzehr bei uns (ganz einloesbar)",
    };
  }

  if (rank === 2) {
    return {
      title: "2. Platz Gutschein",
      description: "6 Getraenke, Fassbier oder Softdrinks",
    };
  }

  if (rank === 3) {
    return {
      title: "3. Platz Gutschein",
      description: "6 Schnaepse",
    };
  }

  return null;
}

function buildDailyRankingRows(registeredTeams = [], lobbyData = null) {
  return getDailyRankingWithTiebreakers(registeredTeams, lobbyData).ranking.map(
    (team, index) => ({
      rank: index + 1,
      teamId: team.teamId || team.teamNameNormalized || team.id,
      teamName: team.teamName,
      totalPoints: team.totalPoints || 0,
      tiebreakerEstimate: getEstimateValue(lobbyData, team.id),
      tiebreakerDistance: getTiebreakerDistance(lobbyData, team.id),
      podiumBonusPoints: getPodiumBonusForRank(index),
    }),
  );
}

function buildHistoricalEventRankingRows(teams = [], savedRows = []) {
  const baseRows = [...teams]
    .sort((a, b) => {
      const rankDifference =
        (Number(a.rankDaily) || Number.MAX_SAFE_INTEGER) -
        (Number(b.rankDaily) || Number.MAX_SAFE_INTEGER);

      if (rankDifference !== 0) return rankDifference;

      return (
        (Number(b.totalPoints) || 0) - (Number(a.totalPoints) || 0) ||
        (a.teamName || "").localeCompare(b.teamName || "")
      );
    })
    .map((team, index) => ({
      rank: Number(team.rankDaily) || index + 1,
      teamId: team.teamId || team.id || "",
      teamName: team.teamName || "",
      totalPoints: Number(team.totalPoints) || 0,
      sourceSessionId: team.id || team.teamId || "",
      podiumBonusPoints:
        Number(team.podiumBonusPoints) || getPodiumBonusForRank(index),
    }))
    .filter((row) => Boolean(row.teamId));

  if (!savedRows.length) {
    return baseRows.map((row, index) => ({
      ...row,
      rank: index + 1,
      podiumBonusPoints: getPodiumBonusForRank(index),
    }));
  }

  return applyManualRankingOrder(
    baseRows,
    savedRows.map((row) => row.teamId).filter(Boolean),
  );
}

function normalizeManualRankingOrder(teamIds = [], rows = []) {
  const seen = new Set();
  const validTeamIds = rows
    .map((row) => row.teamId)
    .filter((teamId) => Boolean(teamId));
  const validTeamIdSet = new Set(validTeamIds);
  const normalizedOrder = [];

  teamIds.forEach((teamId) => {
    if (!validTeamIdSet.has(teamId) || seen.has(teamId)) return;
    seen.add(teamId);
    normalizedOrder.push(teamId);
  });

  validTeamIds.forEach((teamId) => {
    if (seen.has(teamId)) return;
    seen.add(teamId);
    normalizedOrder.push(teamId);
  });

  return normalizedOrder;
}

function applyManualRankingOrder(rows = [], teamIds = []) {
  const normalizedOrder = normalizeManualRankingOrder(teamIds, rows);
  const rowMap = new Map(rows.map((row) => [row.teamId, row]));

  return normalizedOrder
    .map((teamId, index) => {
      const row = rowMap.get(teamId);
      if (!row) return null;

      return {
        ...row,
        rank: index + 1,
        podiumBonusPoints: getPodiumBonusForRank(index),
      };
    })
    .filter(Boolean);
}

function getVoucherIdForSession(session) {
  const rank = Number(session?.rankDaily);
  const eventId = session?.eventId || getEventId(session?.lobbyCode || session?.quizCode || "");
  const teamId = session?.teamId || session?.id || session?.teamNameNormalized;

  if (!eventId || !teamId || ![1, 2, 3].includes(rank)) return "";

  return `${eventId}__${teamId}__rank${rank}`;
}

function getVoucherEventRankKey(entry) {
  const eventId = entry?.eventId || getEventId(entry?.lobbyCode || entry?.quizCode || "");
  const rank = Number(entry?.rank ?? entry?.rankDaily);

  if (!eventId || ![1, 2, 3].includes(rank)) return "";

  return `${eventId}__rank${rank}`;
}

function getVoucherIdentityKey(entry) {
  const eventId = entry?.eventId || getEventId(entry?.lobbyCode || entry?.quizCode || "");
  const teamId = entry?.teamId || entry?.id || entry?.teamNameNormalized || "";
  const sourceSessionId = entry?.sourceSessionId || entry?.id || "";

  if (!eventId || !teamId || !sourceSessionId) return "";

  return `${eventId}__${teamId}__${sourceSessionId}`;
}

function mergeVoucherDocs(primaryDocs = [], fallbackDocs = []) {
  const mergedById = new Map();

  fallbackDocs.forEach((voucher) => {
    mergedById.set(voucher.id, voucher);
  });

  primaryDocs.forEach((voucher) => {
    mergedById.set(voucher.id, {
      ...mergedById.get(voucher.id),
      ...voucher,
    });
  });

  return [...mergedById.values()];
}

async function mirrorLegacyVouchersToEventStore(legacyVouchers = []) {
  const vouchersToMirror = legacyVouchers.filter((voucher) => {
    const eventId = voucher.eventId || getEventId(voucher.quizCode || "");
    return Boolean(eventId && voucher.id);
  });

  if (vouchersToMirror.length === 0) return;

  await Promise.all(
    vouchersToMirror.map((voucher) => {
      const eventId = voucher.eventId || getEventId(voucher.quizCode || "");
      const { storageSource, ...voucherData } = voucher;

      return setDoc(getEventVoucherRef(eventId, voucher.id), voucherData, {
        merge: true,
      });
    }),
  );
}

async function loadVoucherDocsForEvent({
  eventId,
  teamIds = [],
}) {
  if (!eventId) return [];

  const [eventSnapshot, ...teamSnapshots] = await Promise.all([
    getDocs(collection(db, "quizEvents", eventId, "vouchers")),
    ...teamIds
      .filter(Boolean)
      .map((teamId) => getDocs(collection(db, "teams", teamId, "vouchers"))),
  ]);

  const eventDocs = eventSnapshot.docs.map((voucherDoc) => ({
    id: voucherDoc.id,
    ...voucherDoc.data(),
    storageSource: "event",
  }));
  const teamDocs = teamSnapshots.flatMap((snapshot) =>
    snapshot.docs
      .map((voucherDoc) => ({
        id: voucherDoc.id,
        ...voucherDoc.data(),
        storageSource: "team",
      }))
      .filter((voucher) => voucher.eventId === eventId),
  );

  return mergeVoucherDocs(eventDocs, teamDocs);
}

async function loadVoucherDocsForTeam(teamId) {
  if (!teamId) return [];

  const teamSnapshot = await getDocs(collection(db, "teams", teamId, "vouchers"));
  const teamDocs = teamSnapshot.docs.map((voucherDoc) => ({
    id: voucherDoc.id,
    ...voucherDoc.data(),
    storageSource: "team",
  }));

  return mergeVoucherDocs([], teamDocs);
}

async function loadAllVoucherDocsFromFirestore(allSessions = [], teamProfiles = []) {
  const eventIds = Array.from(
    new Set(allSessions.map((session) => session.eventId).filter(Boolean)),
  );
  const teamIds = Array.from(
    new Set(
      [
        ...allSessions.map((session) => session.teamId || session.id),
        ...teamProfiles.map((profile) => profile.id),
      ].filter(Boolean),
    ),
  );

  const [eventSnapshots, teamSnapshots] = await Promise.all([
    Promise.all(
      eventIds.map((eventId) => getDocs(collection(db, "quizEvents", eventId, "vouchers"))),
    ),
    Promise.all(
      teamIds.map((teamId) => getDocs(collection(db, "teams", teamId, "vouchers"))),
    ),
  ]);

  const eventDocs = eventSnapshots.flatMap((snapshot) =>
    snapshot.docs.map((voucherDoc) => ({
      id: voucherDoc.id,
      ...voucherDoc.data(),
      storageSource: "event",
    })),
  );
  const teamDocs = teamSnapshots.flatMap((snapshot) =>
    snapshot.docs.map((voucherDoc) => ({
      id: voucherDoc.id,
      ...voucherDoc.data(),
      storageSource: "team",
    })),
  );

  return mergeVoucherDocs(eventDocs, teamDocs);
}

function normalizeScopedVoucherDocs(voucherDocs = []) {
  const primaryDocs = [];
  const fallbackDocs = [];

  voucherDocs.forEach((voucherDoc) => {
    const rootCollectionId = voucherDoc.ref.parent.parent?.parent?.id;
    const normalizedVoucher = {
      id: voucherDoc.id,
      ...voucherDoc.data(),
      storageSource: rootCollectionId === "quizEvents" ? "event" : "team",
    };

    if (rootCollectionId === "quizEvents") {
      primaryDocs.push(normalizedVoucher);
      return;
    }

    if (rootCollectionId === "teams") {
      fallbackDocs.push(normalizedVoucher);
    }
  });

  return mergeVoucherDocs(primaryDocs, fallbackDocs);
}

function normalizeStoredVoucher(voucher, pubQuizzes = []) {
  return {
    id: voucher.id,
    eventId: voucher.eventId || null,
    quizCode: voucher.quizCode || "",
    quizLabel: voucher.quizLabel || getQuizLabelForSession(voucher, pubQuizzes),
    awardedAt: voucher.awardedAt || voucher.createdAt || null,
    rank: Number(voucher.rank) || 0,
    title: voucher.title || "Gutschein",
    description: voucher.description || "",
    status: voucher.status || "earned",
    requestedAt: voucher.requestedAt || null,
    redeemedAt: voucher.redeemedAt || null,
    sourceSessionId: voucher.sourceSessionId || "",
    teamId: voucher.teamId || "",
    teamName: voucher.teamName || "",
    totalPoints: Number(voucher.totalPoints) || 0,
    isManualAssignment: Boolean(voucher.manualAssignment),
    isStored: true,
  };
}

function buildVoucherEntries(_sessions = [], voucherDocs = [], pubQuizzes = [], options = {}) {
  const { visibleTeamId = null } = options;

  return voucherDocs
    .filter((voucher) => !voucher.deleted && (!visibleTeamId || voucher.teamId === visibleTeamId))
    .map((voucher) => normalizeStoredVoucher(voucher, pubQuizzes))
    .sort((a, b) => getTimestampMs(b.awardedAt) - getTimestampMs(a.awardedAt));
}

function buildAllVoucherEntries(_allSessions = [], voucherDocs = [], pubQuizzes = []) {
  return voucherDocs
    .filter((voucher) => !voucher.deleted)
    .map((voucher) => normalizeStoredVoucher(voucher, pubQuizzes))
    .sort((a, b) => getTimestampMs(b.awardedAt) - getTimestampMs(a.awardedAt));
}

function createEmptyPubQuizQuestion(roundIndex, questionIndex) {
  return {
    id: `r${roundIndex + 1}q${questionIndex + 1}`,
    title: `Frage ${questionIndex + 1}`,
    prompt: "",
    hint: questionIndex === 5 ? "" : "",
    answersText: "",
    points: getQuestionDefaultPoints(questionIndex),
    images: [],
    imagesRemoved: false,
    mediaNote: questionIndex === 4 ? "Bildfrage oder Bildserie" : "",
  };
}

function createBlankPubQuizDraft() {
  return {
    id: "",
    quizCode: "",
    title: "",
    description: "",
    tiebreakerAnswer: "",
    tiebreakerQuestion: "",
    rounds: [30, 40, 45].map((durationMinutes, roundIndex) => ({
      id: `round${roundIndex + 1}`,
      title: `Runde ${roundIndex + 1}`,
      category: "",
      durationMinutes,
      questions: Array.from({ length: 6 }, (_, questionIndex) =>
        createEmptyPubQuizQuestion(roundIndex, questionIndex),
      ),
    })),
  };
}

function createPubQuizDraftFromData(data) {
  if (!data) return createBlankPubQuizDraft();

  const blank = createBlankPubQuizDraft();

  return {
    ...blank,
    ...data,
    tiebreakerAnswer:
      data.tiebreakerAnswer === null || data.tiebreakerAnswer === undefined
        ? ""
        : String(data.tiebreakerAnswer),
    tiebreakerQuestion: data.tiebreakerQuestion || data.description || "",
    rounds: blank.rounds.map((blankRound, roundIndex) => {
      const savedRound = data.rounds?.[roundIndex] || {};

      return {
        ...blankRound,
        ...savedRound,
        questions: blankRound.questions.map((blankQuestion, questionIndex) => {
          const savedQuestion = savedRound.questions?.[questionIndex] || {};

          return {
            ...blankQuestion,
            ...savedQuestion,
            answersText: Array.isArray(savedQuestion.acceptedAnswers)
              ? savedQuestion.acceptedAnswers.join("\n")
              : savedQuestion.answersText || "",
            points:
              questionIndex === 5
                ? 2
                : Number(savedQuestion.points) || blankQuestion.points,
            images: savedQuestion.images || [],
            imagesRemoved: false,
          };
        }),
      };
    }),
  };
}

function sanitizePubQuizDraft(draft, { includeImages = true } = {}) {
  return {
    title: draft.title.trim() || "Unbenanntes Pubquiz",
    description: draft.description.trim(),
    quizCode: normalizeQuizCode(draft.quizCode || ""),
    tiebreakerAnswer: Number.isFinite(Number(draft.tiebreakerAnswer))
      ? Number(draft.tiebreakerAnswer)
      : null,
    tiebreakerQuestion: draft.tiebreakerQuestion.trim(),
    rounds: draft.rounds.map((round) => ({
      id: round.id,
      title: round.title,
      category: round.category.trim(),
      durationMinutes: Number(round.durationMinutes) || 30,
      questions: round.questions.map((question, questionIndex) => ({
        id: question.id,
        title: question.title,
        prompt: question.prompt.trim(),
        hint: questionIndex === 5 ? "" : question.hint.trim(),
        acceptedAnswers: question.answersText
          .split("\n")
          .map((answer) => answer.trim())
          .filter(Boolean),
        points:
          questionIndex === 5
            ? 2
            : Number(question.points) || getQuestionDefaultPoints(questionIndex),
        images: includeImages ? question.images || [] : [],
        mediaNote: question.mediaNote.trim(),
      })),
    })),
  };
}

function getPubQuizImageStorageEstimate(draft) {
  return draft.rounds.reduce(
    (total, round) =>
      total +
      round.questions.reduce(
        (questionTotal, question) =>
          questionTotal +
          (question.images || []).reduce(
            (imageTotal, image) => imageTotal + String(image.src || "").length,
            0,
          ),
        0,
      ),
    0,
  );
}

function preserveExistingPubQuizImages(payload, existingData, draft) {
  if (!existingData?.rounds?.length) return payload;

  return {
    ...payload,
    rounds: payload.rounds.map((round, roundIndex) => ({
      ...round,
      questions: round.questions.map((question, questionIndex) => {
        const draftQuestion = draft.rounds?.[roundIndex]?.questions?.[questionIndex];
        const existingImages =
          existingData.rounds?.[roundIndex]?.questions?.[questionIndex]?.images || [];

        if (
          question.images?.length ||
          !existingImages.length ||
          draftQuestion?.imagesRemoved
        ) {
          return question;
        }

        return {
          ...question,
          images: existingImages,
        };
      }),
    })),
  };
}

function createPubQuizTestTemplate() {
  const rounds = [
    {
      title: "Runde 1: Im Nachtclub",
      durationMinutes: 30,
      category: "Im Nachtclub",
      questions: [
        {
          prompt:
            "Gebraucht fürs Online-Banking, trifft die 2 auf ihr sehr ähnlich ausschauendes Geschwisterkind und berechnet ein zweidimensionales Objekt.",
          answer: "Tanzfläche",
          hint:
            "3 - eine Zahl, 1 - Buchstabe sieht wie 2 aus, 6 - ein Koordinatensystem flach gelegt ist eine...?",
          points: 1,
        },
        {
          prompt:
            "Mach mal etwas mit den Karten, aber don't push the door gegen Tesla.",
          answer: "Mischpult",
          hint:
            "5 - bevor man Karten spielt, was macht man mit den Karten?, 3 - wenn man eine Tür nicht schiebt, sondern zieht, 1 - Logo von Tesla",
          points: 1,
        },
        {
          prompt:
            "Ist so ein Ding jetzt gesund oder nicht? fragte sich die Niederland auf ihrem Hinterteil.",
          answer: "Einlass",
          hint:
            '2 - Man fragt sich ob das Lebensmittel gesund ist, 1 - Abkürzung Niederland, 4 - Synonym beginnend mit "l"',
          points: 1,
        },
        {
          prompt: "In der Mall in der Nähe wird ein bestimmter Arzt aufgesucht.",
          answer: "Techno",
          hint:
            "3 - Wenn man in Erfurt zur Mall geht, 3 - Wo geht man wenn es im Ohr weh tut?",
          points: 1,
        },
        {
          prompt: "Bildfrage",
          answer: "Keta",
          hint: '4 - bekannte Droge für Pferde beginnend mit "K"',
          mediaNote: "BITTE_BILD_URL_R1_5_EINFUEGEN",
          points: 1,
        },
        {
          prompt:
            "Im extrem bekannten Piraten-Anime wird die Hälfte vergessen, zu diesem Zeitpunkt verwandelt sich der Wehrwolf und das kann nicht jeder mit den Händen.",
          answer: "One Night Stand",
          hint: "",
          points: 2,
        },
      ],
    },
    {
      title: "Runde 2: Auf der Leinwand",
      durationMinutes: 35,
      category: "Auf der Leinwand",
      questions: [
        {
          prompt: "Was reimt sich dumm und spielt auf der Leinwand?",
          answer: "Stummfilm",
          hint: '5 - mit "st" am Anfang, 4 - Synonym für Movie',
          points: 1,
        },
        {
          prompt:
            "Wir gönnen uns etwas mit Gurken und haben wirklich keinen Schimmer, was auf uns zukommt.",
          answer: "Spannung",
          hint:
            '3 - geht man um sich zu ausruhen und vllt um eine Massage zu bekommen, 5 - Synonym für Schimmer in diesem Kontext "keinen Plan"',
          points: 1,
        },
        {
          prompt:
            "Von einer überregionalen Tageszeitung holt sich ein Sachse am Kiosk ein Exemplar.",
          answer: "Szene",
          hint: '2 - Abkürzung regionale Tageszeitung, 3 - sächsische Aussprache für "eine"',
          points: 1,
        },
        {
          prompt:
            "Wenn ich nicht rangehe, sprech mir etwas drauf! sagt sie beim Fixieren von etwas am Fahrrad mit einem Gurt.",
          answer: "Abspann",
          hint:
            "2 - Anrufbeantworter, 5 - Was macht man mit dem Gurt wenn man festzieht?",
          points: 1,
        },
        {
          prompt: "Bildfrage",
          answer: "Cliffhanger",
          hint: "BITTE_HINWEIS_EINFÜGEN_2_5",
          mediaNote: "BITTE_BILD_URL_R2_5_EINFUEGEN",
          points: 1,
        },
        {
          prompt:
            "Ein Tischler zählt mit einer Hand bis zu welchem Platz? fragt sich auch des Zauberers Stab.",
          answer: "Vierte Wand",
          hint: "",
          points: 2,
        },
      ],
    },
    {
      title: "Runde 3: Beim Sport",
      durationMinutes: 45,
      category: "Beim Sport",
      questions: [
        {
          prompt:
            "Wir verabschieden uns im Nachbarland, steigen in den Regionalzug, begrüßen jemanden den wir gut kennen und den Rest findet ihr selbst raus.",
          answer: "Adrenalin",
          points: 1,
        },
        {
          prompt:
            "Im Sport sollte man wie spielen? fragen wir uns in Leipzig während die Säure etwas tut.",
          answer: "Verletzung",
          points: 1,
        },
        {
          prompt:
            "Im Debattierclub wird dir eine Seite zugeteilt, etwas im Schwarztee macht dich was und zu Metro Stations Song kann man mit dem Arsch nur was machen?",
          answer: "Protein Shake",
          points: 1,
        },
        {
          prompt:
            "Das Getränk der Unabhängigkeit brummt zustimmend, als es anfängt zu spuken.",
          answer: "Teamgeist",
          points: 1,
        },
        {
          prompt: "Bildfrage",
          answer: "Schweiß",
          mediaNote: "BITTE_BILD_URL_R3_5_EINFUEGEN",
          points: 1,
        },
        {
          prompt:
            "Außer dort magst du es nicht gehauen zu werden und auf dem Kopf hast du nix mehr.",
          answer: "Pokal",
          points: 2,
        },
      ],
    },
    [
      "Wie viele Punkte sind pro Quiz moeglich?",
      "Es gibt 3 Runden mit je 6 Fragen. Fragen 1 bis 5 zaehlen normalerweise 1 Punkt, Frage 6 zaehlt 2 Punkte. Damit sind 21 Punkte moeglich.",
    ],
    [
      "Was passiert bei Gleichstand?",
      "Wenn ein Gleichstand die Plaetze 1 bis 3 betrifft, kann eine Schaetzfrage gestartet werden. Nur die betroffenen Teams sehen und spielen diese Schaetzfrage.",
    ],
    [
      "Sind Hinweise immer verfuegbar?",
      "Nein. Jede Runde hat zwar ein Hinweisbudget, aber nicht jede Frage hat automatisch einen eingepflegten Tipp.",
    ],
  ];
  const draft = createBlankPubQuizDraft();

  return {
    ...draft,
    title: "Test-Pubquiz",
    description: "Vorlage zum Testen des Team-PDFs.",
    tiebreakerAnswer: "237",
    tiebreakerQuestion: "Wie viele Kronkorken sind im Glas?",
    rounds: draft.rounds.map((round, roundIndex) => ({
      ...round,
      title: rounds[roundIndex].title,
      category: rounds[roundIndex].category,
      durationMinutes: rounds[roundIndex].durationMinutes,
      questions: round.questions.map((question, questionIndex) => {
        const templateQuestion = rounds[roundIndex].questions[questionIndex];

        return {
          ...question,
          prompt: templateQuestion.prompt,
          hint: questionIndex === 5 ? "" : templateQuestion.hint || "",
          answersText: templateQuestion.answer,
          points: templateQuestion.points,
          mediaNote: templateQuestion.mediaNote || question.mediaNote,
        };
      }),
    })),
  };
}

function createRuntimeQuizFromPubQuiz(pubQuiz) {
  if (!pubQuiz) {
    return {
      questions: defaultQuestions,
      quizRounds: defaultQuizRounds,
    };
  }

  const nextQuestions = {};
  const nextRounds = (pubQuiz.rounds || []).map((round, roundIndex) => {
    const roundId = round.id || `round${roundIndex + 1}`;
    const questionIds = (round.questions || []).map((question, questionIndex) => {
      const questionId = question.id || `${roundId}q${questionIndex + 1}`;
      const acceptedAnswers = Array.isArray(question.acceptedAnswers)
        ? question.acceptedAnswers
        : String(question.answersText || "")
            .split("\n")
            .map((answer) => answer.trim())
            .filter(Boolean);

      nextQuestions[questionId] = {
        id: questionId,
        title: question.title || `Frage ${questionIndex + 1}`,
        prompt: question.prompt || "",
        acceptedAnswers,
        points:
          questionIndex === 5
            ? 2
            : Number(question.points) || getQuestionDefaultPoints(questionIndex),
        hint: question.hint || "",
        media:
          question.images?.length > 0
            ? {
                type: "image",
                images: question.images,
              }
            : undefined,
      };

      return questionId;
    });

    return {
      id: roundId,
      title: getRoundDisplayTitle(round, roundIndex),
      category: round.category || "",
      durationMinutes: Number(round.durationMinutes) || 30,
      questionIds,
    };
  });

  return {
    questions: nextQuestions,
    quizRounds: nextRounds.length ? nextRounds : defaultQuizRounds,
  };
}

function readFilesAsImages(files) {
  return Promise.all(
    Array.from(files).map(
      (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();

          reader.onload = () =>
            resolve({
              alt: file.name,
              name: file.name,
              src: reader.result,
            });
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        }),
    ),
  );
}

function getImageFormat(src) {
  const match = String(src || "").match(/^data:image\/([^;]+)/i);
  const format = match?.[1]?.toUpperCase();

  if (format === "JPG") return "JPEG";
  if (format === "JPEG" || format === "PNG" || format === "WEBP") return format;

  return "PNG";
}

function readImageSize(src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve({ width: 1, height: 1 });
      return;
    }

    const image = new Image();

    image.onload = () =>
      resolve({
        width: image.naturalWidth || image.width || 1,
        height: image.naturalHeight || image.height || 1,
      });
    image.onerror = () => resolve({ width: 4, height: 3 });
    image.src = src;
  });
}

function buildImageLayouts(images, imageSizes, imageMax, contentWidth, gap) {
  const layouts = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  images.forEach((image, index) => {
    const size = imageSizes.get(image.src) || { width: 4, height: 3 };
    const ratio = size.width / Math.max(size.height, 1);
    let width = imageMax;
    let height = width / Math.max(ratio, 0.1);

    if (height > imageMax) {
      height = imageMax;
      width = height * ratio;
    }

    if (cursorX > 0 && cursorX + width > contentWidth) {
      cursorX = 0;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }

    layouts.push({
      height,
      image,
      width,
      x: cursorX,
      y: cursorY,
    });

    cursorX += width + gap;
    rowHeight = Math.max(rowHeight, height);
  });

  return {
    height: layouts.length ? cursorY + rowHeight : 0,
    layouts,
  };
}

function measurePrintableCopy(doc, round, imageSizes, scale, contentWidth) {
  const gap = 1 * scale;
  const titleSize = 6.4 * scale;
  const metaSize = 7.2 * scale;
  const categorySize = 9.4 * scale;
  const questionSize = 8.4 * scale;
  const promptSize = 8.8 * scale;
  const noteSize = 7 * scale;
  const imageMax = 56 * scale;
  const questionBlockPadding = 1.4 * scale;
  let height =
    titleSize * 0.42 +
    0.9 * scale +
    metaSize * 0.36 +
    1.3 * scale +
    categorySize * 0.42 +
    2 * scale;

  (round.questions || []).forEach((question, index) => {
    const questionTitle = `Frage ${index + 1}${
      Number(question.points) > 1 ? ` (${question.points} Punkte)` : ""
    }:`;

    height += questionBlockPadding;

    doc.setFontSize(questionSize);
    const titleLines = doc.splitTextToSize(questionTitle, contentWidth);
    height += titleLines.length * questionSize * 0.38;

    doc.setFontSize(promptSize);
    const promptLines = doc.splitTextToSize(
      question.prompt || "Noch keine Frage eingetragen.",
      contentWidth,
    );
    height += promptLines.length * promptSize * 0.42;

    if (question.mediaNote) {
      doc.setFontSize(noteSize);
      height += doc.splitTextToSize(`Bildnotiz: ${question.mediaNote}`, contentWidth).length *
        noteSize *
        0.4;
    }

    if (question.images?.length) {
      const imageLayout = buildImageLayouts(
        question.images,
        imageSizes,
        imageMax,
        contentWidth,
        gap,
      );
      height += imageLayout.height + 1.5 * scale;
    }

    height += questionBlockPadding + gap;
  });

  return height;
}

function findPrintableScale(doc, round, imageSizes, contentWidth, maxHeight) {
  const scales = [1.14, 1.1, 1.06, 1.02, 0.98, 0.94, 0.9, 0.86, 0.82, 0.78, 0.74];

  return (
    scales.find(
      (scale) =>
        measurePrintableCopy(doc, round, imageSizes, scale, contentWidth) <= maxHeight,
    ) || scales[scales.length - 1]
  );
}

function drawPrintableCopy(doc, round, quizTitle, copyLabel, x, y, width, height, imageSizes) {
  const outerPadding = 4.2;
  const contentWidth = width - outerPadding * 2;
  const contentHeight = height - outerPadding * 2;
  const scale = findPrintableScale(doc, round, imageSizes, contentWidth, contentHeight);
  const gap = 1 * scale;
  const titleSize = 6.4 * scale;
  const metaSize = 7.2 * scale;
  const categorySize = 9.4 * scale;
  const questionSize = 8.4 * scale;
  const promptSize = 8.8 * scale;
  const noteSize = 7 * scale;
  const imageMax = 56 * scale;
  const questionBlockPadding = 1.4 * scale;
  const category = round.category || round.title;
  const roundNumber = round.id?.match(/\d+/)?.[0] || round.title.match(/\d+/)?.[0] || "";
  const innerX = x + outerPadding;
  let cursorY = y + outerPadding;

  doc.setDrawColor(148, 163, 184);
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(x, y, width, height, 3.5, 3.5, "FD");

  doc.setDrawColor(203, 213, 225);
  doc.setFillColor(241, 245, 249);
  doc.roundedRect(x + 1.5, y + 1.5, width - 3, 17, 2.8, 2.8, "FD");

  doc.setTextColor(107, 114, 128);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(titleSize);
  doc.text(quizTitle || "Pubquiz", innerX, cursorY);
  cursorY += titleSize * 0.42 + 1 * scale;

  doc.setTextColor(71, 85, 105);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(metaSize);
  doc.text(`${copyLabel}  |  Zum Mitspielen und Abgeben`, innerX, cursorY);
  cursorY += metaSize * 0.36 + 1.6 * scale;

  doc.setTextColor(17, 24, 39);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(categorySize);
  doc.text(`Runde ${roundNumber}: ${category}`, innerX, cursorY);
  cursorY += categorySize * 0.42 + 2 * scale;

  (round.questions || []).forEach((question, index) => {
    const questionTitle = `Frage ${index + 1}${
      Number(question.points) > 1 ? ` (${question.points} Punkte)` : ""
    }:`;

    const titleLines = doc.splitTextToSize(questionTitle, contentWidth);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(questionSize);
    const promptLines = doc.splitTextToSize(
      question.prompt || "Noch keine Frage eingetragen.",
      contentWidth,
    );
    const noteLines = question.mediaNote
      ? doc.splitTextToSize(`Bildnotiz: ${question.mediaNote}`, contentWidth)
      : [];
    const imageLayout = question.images?.length
      ? buildImageLayouts(question.images, imageSizes, imageMax, contentWidth, gap)
      : { height: 0, layouts: [] };
    const questionHeight =
      questionBlockPadding * 2 +
      titleLines.length * questionSize * 0.38 +
      promptLines.length * promptSize * 0.42 +
      noteLines.length * noteSize * 0.4 +
      (imageLayout.height ? imageLayout.height + 1.5 * scale : 0);

    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(
      innerX - 1.5,
      cursorY - 2,
      contentWidth + 3,
      questionHeight + 2.2,
      2.2,
      2.2,
      "FD",
    );

    cursorY += questionBlockPadding;

    doc.setTextColor(15, 23, 42);
    doc.text(titleLines, innerX, cursorY);
    cursorY += titleLines.length * questionSize * 0.38;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(promptSize);
    doc.text(promptLines, innerX, cursorY);
    cursorY += promptLines.length * promptSize * 0.42;

    if (question.mediaNote) {
      doc.setTextColor(55, 65, 81);
      doc.setFontSize(noteSize);
      doc.text(noteLines, innerX, cursorY);
      cursorY += noteLines.length * noteSize * 0.4;
    }

    if (question.images?.length) {
      imageLayout.layouts.forEach((layout) => {
        try {
          doc.addImage(
            layout.image.src,
            getImageFormat(layout.image.src),
            innerX + layout.x,
            cursorY + 1.2 * scale + layout.y,
            layout.width,
            layout.height,
          );
        } catch (error) {
          console.warn("PDF IMAGE ERROR:", error);
        }
      });

      cursorY += imageLayout.height + 1.5 * scale;
    }

    cursorY += questionBlockPadding + gap;
  });
}

async function createPrintableTeamQuizPdf(draft) {
  const quiz = sanitizePubQuizDraft(draft);
  const pdfWindow = window.open("", "_blank");

  if (!pdfWindow) return;

  pdfWindow.document.write(
    "<!doctype html><title>PDF wird erstellt</title><p style='font-family: Arial, sans-serif'>PDF wird erstellt...</p>",
  );

  const doc = new jsPDF({
    format: "a4",
    orientation: "portrait",
    unit: "mm",
  });
  const imageSources = Array.from(
    new Set(
      quiz.rounds.flatMap((round) =>
        round.questions.flatMap((question) =>
          (question.images || []).map((image) => image.src).filter(Boolean),
        ),
      ),
    ),
  );
  const imageSizeEntries = await Promise.all(
    imageSources.map(async (src) => [src, await readImageSize(src)]),
  );
  const imageSizes = new Map(imageSizeEntries);
  const pageWidth = 210;
  const pageHeight = 297;
  const marginX = 10;
  const marginY = 9;
  const gap = 4;
  const copyWidth = pageWidth - marginX * 2;
  const copyHeight = (pageHeight - marginY * 2 - gap) / 2;

  quiz.rounds.forEach((round, index) => {
    if (index > 0) doc.addPage();

    drawPrintableCopy(
      doc,
      round,
      quiz.title,
      "Exemplar 1",
      marginX,
      marginY,
      copyWidth,
      copyHeight,
      imageSizes,
    );
    drawPrintableCopy(
      doc,
      round,
      quiz.title,
      "Exemplar 2",
      marginX,
      marginY + copyHeight + gap,
      copyWidth,
      copyHeight,
      imageSizes,
    );
  });

  const pdfUrl = doc.output("bloburl");
  pdfWindow.location.href = pdfUrl;
}

function App() {
  const [clientId] = useState(() => getClientId());
  const [recentManagerCandidate] = useState(() => readRecentManagerSession());
  const [recentSessionCandidate] = useState(() => readRecentPlayerSession());
  const initialCachedSession =
    recentSessionCandidate?.bootstrapSession ||
    recentSessionCandidate?.cachedSession ||
    null;
  const [activePubQuiz, setActivePubQuiz] = useState(null);
  const runtimeQuiz = useMemo(
    () => createRuntimeQuizFromPubQuiz(activePubQuiz),
    [activePubQuiz],
  );
  const questions = runtimeQuiz.questions;
  const quizRounds = runtimeQuiz.quizRounds;
  const [activeRoundId, setActiveRoundId] = useState(defaultQuizRounds[0].id);
  const activeRound =
    quizRounds.find((round) => round.id === activeRoundId) || quizRounds[0];
  const [lobbyCode, setLobbyCode] = useState(
    () =>
      getInitialQuizCode() ||
      recentManagerCandidate?.lobbyCode ||
      recentSessionCandidate?.lobbyCode ||
      "",
  );
  const [teamName, setTeamName] = useState(
    () => initialCachedSession?.teamName || recentSessionCandidate?.teamName || "",
  );
  const [playerName, setPlayerName] = useState(
    () => initialCachedSession?.playerName || recentSessionCandidate?.playerName || "",
  );
  const [isAdmin, setIsAdmin] = useState(() => Boolean(recentManagerCandidate?.manager));
  const [entryMode, setEntryMode] = useState(() =>
    recentSessionCandidate ? "known" : "picker",
  );
  const [knownTeamMode, setKnownTeamMode] = useState("registered");
  const [managerKey, setManagerKey] = useState("");
  const [managerPassword, setManagerPassword] = useState("");
  const [teamPassword, setTeamPassword] = useState("");
  const [activeManager, setActiveManager] = useState(() => recentManagerCandidate?.manager || null);
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState(() => recentSessionCandidate?.sessionId || null);
  const [sessionData, setSessionData] = useState(() =>
    recentManagerCandidate?.manager
      ? {
          lobbyCode: recentManagerCandidate.lobbyCode || "",
          managerOnly: true,
          playerName:
            recentManagerCandidate.manager.name || recentManagerCandidate.manager.id,
          rankingOptIn: false,
          teamName:
            recentManagerCandidate.manager.name || recentManagerCandidate.manager.id,
          totalPoints: 0,
        }
      : initialCachedSession
      ? {
          ...initialCachedSession,
          id: recentSessionCandidate?.sessionId || initialCachedSession.id,
          lobbyCode:
            initialCachedSession.lobbyCode || recentSessionCandidate?.lobbyCode || "",
        }
      : null,
  );
  const [lobbyData, setLobbyData] = useState(null);
  const [registeredTeams, setRegisteredTeams] = useState([]);
  const [allTeams, setAllTeams] = useState([]);
  const [allTeamSessions, setAllTeamSessions] = useState([]);
  const [teamHistorySessions, setTeamHistorySessions] = useState([]);
  const [allVoucherDocs, setAllVoucherDocs] = useState([]);
  const [dailyRankingRows, setDailyRankingRows] = useState([]);
  const [dailyRankingManualOrder, setDailyRankingManualOrder] = useState([]);
  const [historicalDailyRankingDocs, setHistoricalDailyRankingDocs] = useState([]);
  const [globalRankingRows, setGlobalRankingRows] = useState([]);
  const [teamProfiles, setTeamProfiles] = useState([]);
  const [managers, setManagers] = useState([]);
  const [feedbackEntries, setFeedbackEntries] = useState([]);
  const [answerDrafts, setAnswerDrafts] = useState({});
  const [now, setNow] = useState(() => Date.now());
  const [pendingTeamCreate, setPendingTeamCreate] = useState(null);
  const [appView, setAppView] = useState("main");
  const [adminTab, setAdminTab] = useState("live");
  const [isRestoringSession, setIsRestoringSession] = useState(() =>
    Boolean(recentSessionCandidate),
  );
  const [pointToast, setPointToast] = useState(null);
  const [pubQuizzes, setPubQuizzes] = useState([]);
  const [quizManagerMessage, setQuizManagerMessage] = useState("");
  const [issuedTeamPassword, setIssuedTeamPassword] = useState(null);
  const syncedAnswerDraftsRef = useRef({});
  const hasHydratedLobbyRoundRef = useRef(false);
  const lastLobbyActiveRoundRef = useRef(null);
  const shouldLoadArchiveData = Boolean(
    activeManager &&
      appView === "admin" &&
      (adminTab === "teams" || adminTab === "vouchers"),
  );
  const shouldLoadGlobalTeamIndex = Boolean(appView === "ranking");

  useEffect(() => {
    if (sessionId && sessionData?.lobbyCode && !sessionData?.managerOnly) {
      saveRecentPlayerSession({
        cachedSession: {
          ...sessionData,
          id: sessionId,
        },
        lobbyCode: sessionData.lobbyCode,
        playerName: sessionData.playerName,
        rankingOptIn: sessionData.rankingOptIn,
        sessionId,
        teamId: sessionData.teamId,
        teamName: sessionData.teamName,
        teamNameNormalized: sessionData.teamNameNormalized,
        totalPoints: sessionData.totalPoints,
      });
    }
  }, [
    sessionData?.lobbyCode,
    sessionData?.managerOnly,
    sessionData?.playerName,
    sessionData?.rankingOptIn,
    sessionData?.teamName,
    sessionId,
  ]);

  useEffect(() => {
    if (isAdmin && activeManager) {
      saveRecentManagerSession({
        lobbyCode: sessionData?.lobbyCode || lobbyCode,
        manager: activeManager,
      });
      return;
    }

    if (!isAdmin) {
      clearRecentManagerSession();
    }
  }, [activeManager, isAdmin, lobbyCode, sessionData?.lobbyCode]);

  useEffect(() => {
    if (activeManager || sessionData?.managerOnly) return undefined;

    const recentSession = recentSessionCandidate || readRecentPlayerSession();

    if (!recentSession) {
      setIsRestoringSession(false);
      return undefined;
    }

    const bootstrapSession =
      recentSession.bootstrapSession || recentSession.cachedSession || null;

    if (bootstrapSession && !sessionData && !sessionId) {
      setLobbyCode(recentSession.lobbyCode);
      setTeamName(bootstrapSession.teamName || recentSession.teamName || "");
      setPlayerName(bootstrapSession.playerName || recentSession.playerName || "");
      setSessionId(recentSession.sessionId);
      setSessionData({
        ...bootstrapSession,
        id: recentSession.sessionId,
        lobbyCode: recentSession.lobbyCode,
      });
      setEntryMode("known");
      setAppView("main");
    }

    let cancelled = false;

    async function restoreRecentSession() {
      try {
        const sessionRef = getTeamSessionRef(recentSession.lobbyCode, recentSession.sessionId);
        const sessionSnapshot = await getDoc(sessionRef);

        if (!sessionSnapshot.exists()) {
          clearRecentPlayerSession();
          if (!cancelled) setIsRestoringSession(false);
          return;
        }

        const restoredSession = sessionSnapshot.data();

        if (cancelled || restoredSession?.managerOnly) {
          if (!cancelled) setIsRestoringSession(false);
          return;
        }

        setLobbyCode(recentSession.lobbyCode);
        setTeamName(restoredSession.teamName || recentSession.teamName || "");
        setPlayerName(restoredSession.playerName || recentSession.playerName || "");
        setSessionId(recentSession.sessionId);
        setSessionData({
          id: recentSession.sessionId,
          ...restoredSession,
          lobbyCode: recentSession.lobbyCode,
        });
        setEntryMode("known");
        setAppView("main");
        setIsRestoringSession(false);
      } catch (error) {
        console.error("RECENT PLAYER SESSION RESTORE ERROR:", error);
        if (!cancelled) setIsRestoringSession(false);
      }
    }

    restoreRecentSession();

    return () => {
      cancelled = true;
    };
  }, [activeManager, sessionData?.managerOnly, sessionId]);

  useEffect(() => {
    const managersRef = collection(db, "managers");

    return onSnapshot(managersRef, (snapshot) => {
      const nextManagers = snapshot.docs
        .map((managerDoc) => ({ id: managerDoc.id, ...managerDoc.data() }))
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

      setManagers(nextManagers);
    });
  }, []);

  useEffect(() => {
    if (quizRounds.some((round) => round.id === activeRoundId)) return;

    setActiveRoundId(quizRounds[0]?.id || defaultQuizRounds[0].id);
  }, [activeRoundId, quizRounds]);

  useEffect(() => {
    const lobbyRoundId = lobbyData?.activeRoundId;

    if (!lobbyRoundId) return;
    if (!quizRounds.some((round) => round.id === lobbyRoundId)) return;
    if (!hasHydratedLobbyRoundRef.current) {
      hasHydratedLobbyRoundRef.current = true;
      lastLobbyActiveRoundRef.current = lobbyRoundId;
      if (lobbyRoundId !== activeRoundId) {
        setActiveRoundId(lobbyRoundId);
      }
      return;
    }

    const previousLobbyRoundId = lastLobbyActiveRoundRef.current;
    const shouldFollowLobbyRound =
      previousLobbyRoundId && activeRoundId === previousLobbyRoundId;

    lastLobbyActiveRoundRef.current = lobbyRoundId;

    if (shouldFollowLobbyRound && lobbyRoundId !== activeRoundId) {
      setActiveRoundId(lobbyRoundId);
    }
  }, [activeRoundId, lobbyData?.activeRoundId, quizRounds]);

  useEffect(() => {
    hasHydratedLobbyRoundRef.current = false;
    lastLobbyActiveRoundRef.current = null;
  }, [sessionData?.lobbyCode]);

  useEffect(() => {
    if (!sessionId || !sessionData?.lobbyCode) return undefined;

    const sessionRef = getTeamSessionRef(sessionData.lobbyCode, sessionId);

    return onSnapshot(sessionRef, (snapshot) => {
      if (!snapshot.exists()) return;

      const data = snapshot.data();
      setSessionData((currentSession) => ({
        ...(currentSession || {}),
        id: snapshot.id,
        ...data,
        lobbyCode:
          data?.lobbyCode ||
          currentSession?.lobbyCode ||
          recentSessionCandidate?.lobbyCode ||
          "",
      }));
      setAnswerDrafts((currentDrafts) => {
        const nextDrafts = { ...currentDrafts };
        const previousSyncedDrafts = syncedAnswerDraftsRef.current || {};

        Object.entries(data?.answers || {}).forEach(([questionId, savedAnswer]) => {
          const serverText = savedAnswer?.text ?? "";
          const currentDraft = currentDrafts[questionId];
          const previousSyncedDraft = previousSyncedDrafts[questionId];
          const shouldHydrateDraft =
            currentDraft === undefined || currentDraft === previousSyncedDraft;

          if (shouldHydrateDraft) {
            nextDrafts[questionId] = serverText;
          }
        });

        syncedAnswerDraftsRef.current = Object.fromEntries(
          Object.entries(data?.answers || {}).map(([questionId, savedAnswer]) => [
            questionId,
            savedAnswer?.text ?? "",
          ]),
        );

        return nextDrafts;
      });
    });
  }, [sessionData?.lobbyCode, sessionId]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!pointToast) return undefined;

    const timeoutId = window.setTimeout(() => setPointToast(null), 4200);

    return () => window.clearTimeout(timeoutId);
  }, [pointToast]);

  useEffect(() => {
    if (!sessionData?.lobbyCode) return undefined;

    const lobbyRef = getEventRef(sessionData.lobbyCode);

    return onSnapshot(lobbyRef, (snapshot) => {
      setLobbyData(snapshot.exists() ? snapshot.data() : null);
    });
  }, [sessionData?.lobbyCode]);

  useEffect(() => {
    const activeQuizCode = normalizeQuizCode(activePubQuiz?.quizCode || "");
    const targetLobbyCode = normalizeQuizCode(sessionData?.lobbyCode || "");

    if (!targetLobbyCode) return undefined;
    if (activeQuizCode === targetLobbyCode) return undefined;

    let cancelled = false;

    async function loadQuizForSession() {
      const quizzesQuery = query(
        collection(db, "pubQuizzes"),
        where("quizCode", "==", targetLobbyCode),
      );
      const quizSnapshot = await getDocs(quizzesQuery);
      const matchingQuiz = quizSnapshot.docs[0];

      if (!matchingQuiz || cancelled) return;

      const selectedPubQuiz = {
        id: matchingQuiz.id,
        ...matchingQuiz.data(),
      };

      setActivePubQuiz(selectedPubQuiz);
      setActiveRoundId(
        selectedPubQuiz.rounds?.[0]?.id || defaultQuizRounds[0].id,
      );
    }

    loadQuizForSession().catch((error) => {
      console.error("QUIZ LOAD ERROR:", error);
    });

    return () => {
      cancelled = true;
    };
  }, [activePubQuiz?.quizCode, sessionData?.lobbyCode]);

  useEffect(() => {
    if (!activeManager) return undefined;

    const quizzesRef = collection(db, "pubQuizzes");

    return onSnapshot(quizzesRef, (snapshot) => {
      const nextPubQuizzes = snapshot.docs
        .map((quizDoc) => ({ id: quizDoc.id, ...quizDoc.data() }))
        .sort((a, b) => a.title.localeCompare(b.title));

      setPubQuizzes(nextPubQuizzes);
    });
  }, [activeManager]);

  useEffect(() => {
    if (appView !== "vouchers") return undefined;
    if (!sessionData) {
      setTeamHistorySessions([]);
      return undefined;
    }

    let cancelled = false;
    const quizEventsRef = collection(db, "quizEvents");
    const targetTeamId =
      sessionData.teamId || sessionId || sessionData.teamNameNormalized || "";

    async function loadTeamHistorySessions() {
      if (!targetTeamId) {
        if (!cancelled) setTeamHistorySessions([]);
        return;
      }

      try {
        const eventsSnapshot = await getDocs(quizEventsRef);
        const sessionSnapshots = await Promise.all(
          eventsSnapshot.docs.map((eventDoc) =>
            getDoc(doc(db, "quizEvents", eventDoc.id, "teamSessions", targetTeamId)),
          ),
        );

        if (cancelled) return;

        const sessions = sessionSnapshots
          .filter((snapshot) => snapshot.exists())
          .map((snapshot) => {
            const data = snapshot.data();

            return {
              id: snapshot.id,
              sessionKey: `${data.eventId || "event"}__${snapshot.id}`,
              ...data,
            };
          })
          .sort((a, b) => {
            const timeDifference =
              getTimestampMs(getCompletionValue(b)) - getTimestampMs(getCompletionValue(a));
            return timeDifference || a.teamName.localeCompare(b.teamName);
          });

        setTeamHistorySessions(sessions);
      } catch (error) {
        console.error("TEAM HISTORY LOAD ERROR:", error);
      }
    }

    loadTeamHistorySessions();

    return () => {
      cancelled = true;
    };
  }, [appView, sessionData, sessionId]);

  useEffect(() => {
    if (!activeManager) return undefined;

    const feedbackRef = collection(db, "feedback");

    return onSnapshot(feedbackRef, (snapshot) => {
      const entries = snapshot.docs
        .map((feedbackDoc) => ({ id: feedbackDoc.id, ...feedbackDoc.data() }))
        .filter((entry) => entry.quizId === latestQuizId)
        .sort(
          (a, b) =>
            getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt) ||
            (b.dateKey || "").localeCompare(a.dateKey || ""),
        );

      setFeedbackEntries(entries);
    });
  }, [activeManager]);

  useEffect(() => {
    if (!shouldLoadGlobalTeamIndex) return undefined;

    const sessionsRef = collectionGroup(db, "teamSessions");

    return onSnapshot(sessionsRef, (snapshot) => {
      const teams = snapshot.docs
        .map((teamDoc) => ({ id: teamDoc.id, ...teamDoc.data() }))
        .filter((team) => team.quizId === latestQuizId)
        .sort((a, b) => {
          const timeDifference = getTimestampMs(b.updatedAt) - getTimestampMs(a.updatedAt);
          return timeDifference || a.teamName.localeCompare(b.teamName);
        });

      setAllTeams(teams);
    });
  }, [shouldLoadGlobalTeamIndex]);

  useEffect(() => {
    if (!shouldLoadArchiveData && appView !== "vouchers") return undefined;

    const sessionsRef = collectionGroup(db, "teamSessions");

    return onSnapshot(sessionsRef, (snapshot) => {
      const sessions = snapshot.docs
        .map((teamDoc) => {
          const data = teamDoc.data();

          return {
            id: teamDoc.id,
            sessionKey: `${data.eventId || "event"}__${teamDoc.id}`,
            ...data,
          };
        })
        .filter((session) => session.quizId === latestQuizId)
        .sort((a, b) => {
          const timeDifference =
            getTimestampMs(getCompletionValue(b)) - getTimestampMs(getCompletionValue(a));
          return timeDifference || a.teamName.localeCompare(b.teamName);
        });

      setAllTeamSessions(sessions);
    });
  }, [appView, shouldLoadArchiveData]);

  useEffect(() => {
    if (!shouldLoadArchiveData && appView !== "vouchers") return undefined;

    let cancelled = false;
    const quizEventsRef = collection(db, "quizEvents");

    async function loadHistoricalDailyRankings() {
      try {
        const eventsSnapshot = await getDocs(quizEventsRef);
        const rankingSnapshots = await Promise.all(
          eventsSnapshot.docs.map((eventDoc) =>
            getDoc(doc(db, "quizEvents", eventDoc.id, "rankings", "daily")),
          ),
        );

        if (cancelled) return;

        const nextDocs = rankingSnapshots
          .filter((snapshot) => snapshot.exists())
          .map((snapshot) => ({
            eventId: snapshot.data()?.eventId || snapshot.ref.parent.parent?.id || "",
            ...snapshot.data(),
          }))
          .filter((entry) => Boolean(entry.eventId));

        setHistoricalDailyRankingDocs(nextDocs);
      } catch (error) {
        console.error("HISTORICAL DAILY RANKINGS LOAD ERROR:", error);
      }
    }

    loadHistoricalDailyRankings();

    const unsubscribe = onSnapshot(quizEventsRef, () => {
      loadHistoricalDailyRankings();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [appView, shouldLoadArchiveData]);

  useEffect(() => {
    if (!shouldLoadArchiveData && appView !== "vouchers") return undefined;

    const teamsRef = collection(db, "teams");

    return onSnapshot(teamsRef, (snapshot) => {
      const nextProfiles = snapshot.docs
        .map((teamDoc) => ({ id: teamDoc.id, ...teamDoc.data() }))
        .sort((a, b) => (a.teamName || a.name || a.id).localeCompare(b.teamName || b.name || b.id));

      setTeamProfiles(nextProfiles);
    });
  }, [appView, shouldLoadArchiveData]);

  useEffect(() => {
    if (!activeManager && appView !== "ranking") return undefined;

    if (!sessionData?.lobbyCode) return undefined;

    const dailyRankingRef = doc(
      db,
      "quizEvents",
      getEventId(sessionData.lobbyCode),
      "rankings",
      "daily",
    );

    return onSnapshot(dailyRankingRef, (snapshot) => {
      const data = snapshot.exists() ? snapshot.data() : null;
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const manualOrder = Array.isArray(data?.manualOrderTeamIds)
        ? data.manualOrderTeamIds
        : [];

      setDailyRankingRows(rows);
      setDailyRankingManualOrder(manualOrder);
    });
  }, [activeManager, appView, sessionData]);

  useEffect(() => {
    if (!activeManager && appView !== "ranking" && appView !== "vouchers") {
      return undefined;
    }

    const globalRankingRef = doc(db, "rankings", "globalCurrent");

    return onSnapshot(globalRankingRef, (snapshot) => {
      const rows = snapshot.exists() ? snapshot.data()?.rows || [] : [];
      setGlobalRankingRows(Array.isArray(rows) ? rows : []);
    });
  }, [activeManager, appView, sessionData]);

  useEffect(() => {
    if (shouldLoadArchiveData) {
      let cancelled = false;

      async function refreshAllVoucherDocs() {
        try {
          const normalizedDocs = await loadAllVoucherDocsFromFirestore(
            allTeamSessions,
            teamProfiles,
          );

          if (cancelled) return;

          setAllVoucherDocs(normalizedDocs);

          const eventDocs = normalizedDocs.filter(
            (voucher) => voucher.storageSource === "event",
          );
          const teamDocs = normalizedDocs.filter((voucher) => voucher.storageSource === "team");
          const mirroredEventIds = new Set(eventDocs.map((voucher) => voucher.id));
          const missingEventVouchers = teamDocs.filter(
            (voucher) => !mirroredEventIds.has(voucher.id),
          );

          mirrorLegacyVouchersToEventStore(missingEventVouchers).catch((error) => {
            console.error("LEGACY VOUCHER MIRROR ERROR:", error);
          });
        } catch (error) {
          console.error("ALL VOUCHERS LOAD ERROR:", error);
        }
      }

      refreshAllVoucherDocs();

      return () => {
        cancelled = true;
      };
    }

    if (appView !== "vouchers") return undefined;
    if (!sessionData?.lobbyCode) return undefined;

    let cancelled = false;
    const eventId = getEventId(sessionData.lobbyCode);
    const teamVoucherPath =
      sessionData?.teamId || sessionData?.teamNameNormalized || sessionId || null;
    const eventVouchersRef = collection(db, "quizEvents", eventId, "vouchers");

    async function loadTeamEventVouchers() {
      try {
        const [eventSnapshot, legacySnapshot] = await Promise.all([
          getDocs(eventVouchersRef),
          teamVoucherPath
            ? getDocs(collection(db, "teams", teamVoucherPath, "vouchers"))
            : Promise.resolve({ docs: [] }),
        ]);

        if (cancelled) return;

        const normalizedDocs = normalizeScopedVoucherDocs([
          ...eventSnapshot.docs,
          ...legacySnapshot.docs,
        ]);

        setAllVoucherDocs(normalizedDocs);
      } catch (error) {
        console.error("TEAM EVENT VOUCHERS LOAD ERROR:", error);
      }
    }

    loadTeamEventVouchers();

    const unsubscribe = onSnapshot(eventVouchersRef, () => {
      loadTeamEventVouchers();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    allTeamSessions,
    appView,
    sessionData?.lobbyCode,
    sessionData?.teamId,
    sessionData?.teamNameNormalized,
    sessionId,
    shouldLoadArchiveData,
    teamProfiles,
  ]);

  useEffect(() => {
    if (!sessionData?.lobbyCode) return undefined;

    const sessionsRef = collection(
      db,
      "quizEvents",
      getEventId(sessionData.lobbyCode),
      "teamSessions",
    );
    const teamsQuery = query(sessionsRef);

    return onSnapshot(teamsQuery, (snapshot) => {
      const teams = snapshot.docs
        .map((teamDoc) => ({ id: teamDoc.id, ...teamDoc.data() }))
        .filter((team) => team.quizId === latestQuizId)
        .sort((a, b) => a.teamName.localeCompare(b.teamName));

      setRegisteredTeams(teams);
    });
  }, [sessionData?.lobbyCode]);

  async function persistDailyRankingState(rows, options = {}) {
    if (!sessionData?.lobbyCode) {
      return { ok: false, message: "Kein aktives Event fuer das Ranking gefunden." };
    }

    const normalizedRows = rows.map((row, index) => ({
      ...row,
      rank: index + 1,
      podiumBonusPoints: getPodiumBonusForRank(index),
    }));
    const manualOrderTeamIds = normalizeManualRankingOrder(
      options.manualOrderTeamIds || normalizedRows.map((row) => row.teamId),
      normalizedRows,
    );
    const eventId = getEventId(sessionData.lobbyCode);
    const rowsByTeamId = new Map(normalizedRows.map((row) => [row.teamId, row]));
    const teamsForGlobalRanking =
      allTeamSessions.length > 0
        ? allTeamSessions
        : allTeams.length > 0
          ? allTeams
          : registeredTeams;
    const nextAllTeams = teamsForGlobalRanking.map((team) => {
      if (team.lobbyCode !== sessionData.lobbyCode) {
        return team;
      }

      const row = rowsByTeamId.get(team.id);
      if (!row) return team;

      return {
        ...team,
        finalDailyPointsForGlobal: (team.totalPoints || 0) + (row.podiumBonusPoints || 0),
        podiumBonusPoints: row.podiumBonusPoints || 0,
        rankDaily: row.rank,
      };
    });
    const globalRows = aggregateYearlyRanking(nextAllTeams).map((team, index) => ({
      rank: index + 1,
      teamId: team.teamNameNormalized || team.id,
      teamName: team.teamName,
      totalGlobalPoints: team.totalPoints || 0,
      totalDailyPoints: team.totalQuizPoints || 0,
      totalPodiumBonusPoints:
        (team.totalPoints || 0) - (team.totalQuizPoints || 0),
      gamesPlayed: team.sessions || 0,
    }));
    const batch = writeBatch(db);

    batch.set(
      doc(db, "quizEvents", eventId, "rankings", "daily"),
      {
        eventId,
        quizCode: sessionData.lobbyCode,
        rows: normalizedRows,
        manualOrderTeamIds,
        updatedAt: serverTimestamp(),
        ...(options.trackManualChange
          ? {
              manualOrderUpdatedAt: serverTimestamp(),
              manualOrderUpdatedByManagerKey: activeManager?.key || "",
              manualOrderUpdatedByManagerName:
                activeManager?.name || activeManager?.key || "Manager",
            }
          : {}),
      },
      { merge: true },
    );

    normalizedRows.forEach((row) => {
      if (!row.teamId) return;

      const matchingTeam = registeredTeams.find((team) => team.id === row.teamId);
      const totalPoints =
        Number(matchingTeam?.totalPoints) || Number(row.totalPoints) || 0;

      batch.set(
        getTeamSessionRef(sessionData.lobbyCode, row.teamId),
        {
          podiumBonusPoints: row.podiumBonusPoints || 0,
          finalDailyPointsForGlobal: totalPoints + (row.podiumBonusPoints || 0),
          rankDaily: row.rank,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    });

    batch.set(
      doc(db, "rankings", "globalCurrent"),
      {
        rows: globalRows,
        seasonId: "2026",
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    await batch.commit();
    setDailyRankingRows(normalizedRows);
    setDailyRankingManualOrder(manualOrderTeamIds);
    setGlobalRankingRows(globalRows);

    return { ok: true, rows: normalizedRows, globalRows };
  }

  async function persistHistoricalDailyRankingState({
    awardedAt = null,
    eventId,
    quizCode = "",
    rows,
  }) {
    if (!eventId) {
      return { ok: false, message: "Kein Event fuer das Tagesranking gefunden." };
    }

    const normalizedRows = rows.map((row, index) => ({
      ...row,
      rank: index + 1,
      podiumBonusPoints: getPodiumBonusForRank(index),
    }));
    const manualOrderTeamIds = normalizeManualRankingOrder(
      normalizedRows.map((row) => row.teamId),
      normalizedRows,
    );
    const rowsByTeamId = new Map(normalizedRows.map((row) => [row.teamId, row]));
    const nextAllTeamSessions = allTeamSessions.map((session) => {
      if (session.eventId !== eventId) return session;

      const row = rowsByTeamId.get(session.teamId || session.id);
      if (!row) return session;

      return {
        ...session,
        rankDaily: row.rank,
        podiumBonusPoints: row.podiumBonusPoints || 0,
        finalDailyPointsForGlobal:
          (Number(session.totalPoints) || 0) + (row.podiumBonusPoints || 0),
      };
    });
    const globalRows = aggregateYearlyRanking(nextAllTeamSessions).map((team, index) => ({
      rank: index + 1,
      teamId: team.teamNameNormalized || team.id,
      teamName: team.teamName,
      totalGlobalPoints: team.totalPoints || 0,
      totalDailyPoints: team.totalQuizPoints || 0,
      totalPodiumBonusPoints:
        (team.totalPoints || 0) - (team.totalQuizPoints || 0),
      gamesPlayed: team.sessions || 0,
    }));
    const batch = writeBatch(db);

    batch.set(
      doc(db, "quizEvents", eventId, "rankings", "daily"),
      {
        eventId,
        quizCode,
        rows: normalizedRows,
        manualOrderTeamIds,
        updatedAt: serverTimestamp(),
        manualOrderUpdatedAt: serverTimestamp(),
        manualOrderUpdatedByManagerKey: activeManager?.key || "",
        manualOrderUpdatedByManagerName:
          activeManager?.name || activeManager?.key || "Manager",
        ...(awardedAt ? { awardedAt } : {}),
      },
      { merge: true },
    );

    normalizedRows.forEach((row) => {
      if (!row.teamId) return;

      batch.set(
        doc(db, "quizEvents", eventId, "teamSessions", row.teamId),
        {
          rankDaily: row.rank,
          podiumBonusPoints: row.podiumBonusPoints || 0,
          finalDailyPointsForGlobal:
            (Number(row.totalPoints) || 0) + (row.podiumBonusPoints || 0),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    });

    batch.set(
      doc(db, "rankings", "globalCurrent"),
      {
        rows: globalRows,
        seasonId: "2026",
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    await batch.commit();
    setAllTeamSessions(nextAllTeamSessions);
    setHistoricalDailyRankingDocs((currentDocs) => {
      const nextDoc = {
        eventId,
        quizCode,
        rows: normalizedRows,
        manualOrderTeamIds,
        updatedAt: new Date(),
      };

      return [
        ...currentDocs.filter((entry) => entry.eventId !== eventId),
        nextDoc,
      ];
    });
    setGlobalRankingRows(globalRows);

    return { ok: true, rows: normalizedRows, globalRows };
  }

  useEffect(() => {
    if (!activeManager || !sessionData?.lobbyCode) return;

    const computedDailyRows = buildDailyRankingRows(registeredTeams, lobbyData);
    const nextManualOrderTeamIds = normalizeManualRankingOrder(
      dailyRankingManualOrder,
      computedDailyRows,
    );
    const dailyRows = applyManualRankingOrder(
      computedDailyRows,
      nextManualOrderTeamIds,
    );
    const finalRound = getLastQuizRound(quizRounds);
    const eventFinished =
      Boolean(finalRound) &&
      registeredTeams.length > 0 &&
      registeredTeams.every((team) => isRoundFinished(team, finalRound, now, lobbyData, quizRounds));
    const nextAllTeams = allTeams.map((team) => {
      if (!eventFinished || team.lobbyCode !== sessionData.lobbyCode) {
        return team;
      }

      const row = dailyRows.find((dailyRow) => dailyRow.teamId === team.id);
      if (!row) return team;

      return {
        ...team,
        finalDailyPointsForGlobal: (team.totalPoints || 0) + (row.podiumBonusPoints || 0),
        podiumBonusPoints: row.podiumBonusPoints || 0,
        rankDaily: row.rank,
      };
    });
    const globalRows = aggregateYearlyRanking(nextAllTeams).map((team, index) => ({
      rank: index + 1,
      teamId: team.teamNameNormalized || team.id,
      teamName: team.teamName,
      totalGlobalPoints: team.totalPoints || 0,
      totalDailyPoints: team.totalQuizPoints || 0,
      totalPodiumBonusPoints:
        (team.totalPoints || 0) - (team.totalQuizPoints || 0),
      gamesPlayed: team.sessions || 0,
    }));

    setDoc(
      doc(db, "quizEvents", getEventId(sessionData.lobbyCode), "rankings", "daily"),
      {
        eventId: getEventId(sessionData.lobbyCode),
        quizCode: sessionData.lobbyCode,
        rows: dailyRows,
        manualOrderTeamIds: nextManualOrderTeamIds,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    ).catch((error) => console.error("DAILY RANKING SNAPSHOT ERROR:", error));

    setDoc(
      doc(db, "rankings", "globalCurrent"),
      {
        rows: globalRows,
        seasonId: "2026",
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    ).catch((error) => console.error("GLOBAL RANKING SNAPSHOT ERROR:", error));

    if (!eventFinished) return;

    const batch = writeBatch(db);
    let hasBatchWrites = false;

    registeredTeams.forEach((team) => {
      const row = dailyRows.find((dailyRow) => dailyRow.teamId === team.id);
      if (!row) return;

      const nextPodiumBonusPoints = row.podiumBonusPoints || 0;
      const nextFinalDailyPointsForGlobal =
        (team.totalPoints || 0) + nextPodiumBonusPoints;
      const currentPodiumBonusPoints = Number(team.podiumBonusPoints) || 0;
      const currentFinalDailyPointsForGlobal = Number(team.finalDailyPointsForGlobal);
      const currentRankDaily = Number(team.rankDaily);

      if (
        currentPodiumBonusPoints === nextPodiumBonusPoints &&
        currentFinalDailyPointsForGlobal === nextFinalDailyPointsForGlobal &&
        currentRankDaily === row.rank
      ) {
        return;
      }

      batch.set(
        getTeamSessionRef(sessionData.lobbyCode, team.id),
        {
          podiumBonusPoints: nextPodiumBonusPoints,
          finalDailyPointsForGlobal: nextFinalDailyPointsForGlobal,
          rankDaily: row.rank,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      hasBatchWrites = true;
    });

    if (hasBatchWrites) {
      batch.commit().catch((error) =>
        console.error("SESSION BONUS SNAPSHOT ERROR:", error),
      );
    }
  }, [
    activeManager,
    allTeams,
    dailyRankingManualOrder,
    lobbyData,
    now,
    quizRounds,
    registeredTeams,
    sessionData?.lobbyCode,
  ]);

  function updateAnswerDraft(questionId, value) {
    setAnswerDrafts((currentDrafts) => ({
      ...currentDrafts,
      [questionId]: value,
    }));
  }

  async function auditTeamSessionScores({
    lobbyCode = sessionData?.lobbyCode,
    quizQuestions = questions,
    reason = "Admin-Speicherung",
    teamId,
  } = {}) {
    if (!lobbyCode || !quizQuestions) {
      return {
        correctedQuestionCount: 0,
        correctedTeamCount: 0,
        ok: false,
        totalCorrections: 0,
      };
    }

    const eventId = getEventId(lobbyCode);
    const sessionRefs = teamId
      ? [getTeamSessionRef(lobbyCode, teamId)]
      : [];
    const sessionSnapshots = teamId
      ? await Promise.all(sessionRefs.map((ref) => getDoc(ref)))
      : (await getDocs(collection(db, "quizEvents", eventId, "teamSessions"))).docs;
    const batch = writeBatch(db);
    let correctedQuestionCount = 0;
    let correctedTeamCount = 0;
    let totalCorrections = 0;

    sessionSnapshots.forEach((snapshot, index) => {
      if (!snapshot.exists()) return;

      const currentSession = snapshot.data();
      const { correctedQuestionCount: nextQuestionCorrections, nextAnswers, nextTotalPoints } =
        buildAuditedAnswers(currentSession.answers || {}, quizQuestions);
      const previousTotalPoints = Number(currentSession.totalPoints) || 0;
      const totalChanged = nextTotalPoints !== previousTotalPoints;

      if (!nextQuestionCorrections && !totalChanged) return;

      const sessionRef = teamId ? sessionRefs[index] : snapshot.ref;
      const correctionLabel = `${reason} automatisch geprueft`;

      batch.set(
        sessionRef,
        {
          answers: nextAnswers,
          totalPoints: nextTotalPoints,
          scoreAdjustment: currentSession.scoreAdjustment?.active
            ? currentSession.scoreAdjustment
            : {
                active: true,
                adjustedAt: serverTimestamp(),
                adjustedBy: activeManager?.name || activeManager?.id || "Manager",
                adjustedById: activeManager?.id || activeManager?.key || "",
                note: correctionLabel,
                previousPoints: previousTotalPoints,
              },
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      correctedQuestionCount += nextQuestionCorrections;
      correctedTeamCount += 1;
      totalCorrections += nextQuestionCorrections + (totalChanged ? 1 : 0);
    });

    if (totalCorrections > 0) {
      await batch.commit();
    }

    return {
      correctedQuestionCount,
      correctedTeamCount,
      ok: true,
      totalCorrections,
    };
  }

  async function ensureLobby(cleanedCode, { deployForToday = false } = {}) {
    const lobbyRef = getEventRef(cleanedCode);
    const existingLobbySnapshot = await getDoc(lobbyRef);

    if (existingLobbySnapshot.exists()) {
      if (deployForToday) {
        await setDoc(
          doc(db, "settings", "app"),
          {
            activeEventId: getEventId(cleanedCode),
            activeQuizCode: cleanedCode,
            activeSeasonId: "2026",
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      }

      return existingLobbySnapshot.data();
    }

    const deployedAt = new Date();
    const answerWindowEndsAt = new Date(deployedAt.getTime() + ANSWER_WINDOW_MS);

    await setDoc(
      lobbyRef,
      {
        id: getEventId(cleanedCode),
        quizId: latestQuizId,
        lobbyCode: cleanedCode,
        quizCode: cleanedCode,
        seasonId: "2026",
        status: deployForToday ? "active" : "planned",
        ...(deployForToday
          ? {
              answerWindowEndsAt,
              answerWindowStartedAt: deployedAt,
              startedAt: deployedAt,
            }
          : {}),
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      },
      { merge: true },
    );

    if (deployForToday) {
      await setDoc(
        doc(db, "settings", "app"),
        {
          activeEventId: getEventId(cleanedCode),
          activeQuizCode: cleanedCode,
          activeSeasonId: "2026",
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }
  }

  async function saveTeamSession({
    cleanedCode,
    cleanedName,
    displayName,
    normalized,
    rankingOptIn,
    rankingPassword = "",
  }) {
    const teamRef = getTeamRef(normalized);
    const sessionRef = getTeamSessionRef(cleanedCode, normalized);
    const teammateId = getTeammateId(displayName);
    const teamSnapshot = await getDoc(teamRef);

    if (teamSnapshot.exists()) {
      await setDoc(
        teamRef,
        {
          currentDisplayName: cleanedName,
          teamName: cleanedName,
          yearlyRankingOptIn: rankingOptIn,
          rankingOptIn,
          ...(rankingPassword
            ? {
                rankingPassword,
                rankingPasswordCreatedAt: serverTimestamp(),
              }
            : {}),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } else {
      await setDoc(
        teamRef,
        {
          ...createTeamRecord({ cleanedName, normalized, rankingOptIn }),
          ...(rankingPassword
            ? {
                rankingPassword,
                rankingPasswordCreatedAt: serverTimestamp(),
              }
            : {}),
        },
        { merge: true },
      );
    }

    if (displayName !== "Anonym" && teammateId) {
      await setDoc(
        getTeammateRef(normalized, teammateId),
        {
          id: teammateId,
          name: displayName,
          normalizedName: teammateId,
          joinedEventIds: arrayUnion(getEventId(cleanedCode)),
          firstSeenAt: serverTimestamp(),
          lastSeenAt: serverTimestamp(),
        },
        { merge: true },
      );
    } else {
      await setDoc(
        teamRef,
        {
          anonymousJoinCount: increment(1),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }

    await setDoc(
      sessionRef,
      createSessionRecord({
        cleanedCode,
        cleanedName,
        displayName,
        normalized,
        rankingOptIn,
      }),
    );
  }

  async function handleManagerLogin() {
    const cleanedManagerKey = normalizeManagerKey(managerKey || playerName);
    const cleanedManagerPassword = managerPassword.trim();

    if (!cleanedManagerKey || !cleanedManagerPassword) {
      setMessage("Bitte Manager-Key/Name und persönliches Passwort eingeben.");
      return;
    }

    try {
      const managerRef = doc(db, "managers", cleanedManagerKey);
      const managerSnapshot = await getDoc(managerRef);
      let validatedManager = null;

      if (!managerSnapshot.exists()) {
        if (managers.length > 0) {
          setMessage("Manager-Key oder Passwort ist falsch.");
          return;
        }

        validatedManager = {
          id: cleanedManagerKey,
          key: cleanedManagerKey,
          name: playerName.trim() || cleanedManagerKey,
          password: cleanedManagerPassword,
          active: true,
          canEditScores: true,
          headManager: true,
        };

        await setDoc(
          managerRef,
          createManagerRecord({
            ...validatedManager,
            createdAt: serverTimestamp(),
          }),
        );
      } else {
        const managerData = managerSnapshot.data();

        if (!managerData.active || managerData.password !== cleanedManagerPassword) {
          setMessage("Manager-Key oder Passwort ist falsch.");
          return;
        }

        validatedManager = {
          id: managerSnapshot.id,
          ...managerData,
          canEditScores: Boolean(managerData.canEditScores ?? managerData.headManager),
        };

        await setDoc(
          managerRef,
          createManagerRecord({
            active: managerData.active !== false,
            canEditScores: Boolean(managerData.canEditScores ?? managerData.headManager),
            createdAt: managerData.createdAt,
            headManager: Boolean(managerData.headManager),
            key: cleanedManagerKey,
            name: managerData.name || managerSnapshot.id,
            password: managerData.password,
          }),
        );
      }

      setActiveManager(validatedManager);
      setIsAdmin(true);
      setSessionData({
        lobbyCode: "",
        managerOnly: true,
        playerName: validatedManager.name || validatedManager.id,
        rankingOptIn: false,
        teamName: validatedManager.name || validatedManager.id,
        totalPoints: 0,
      });
      saveRecentManagerSession({
        lobbyCode: "",
        manager: validatedManager,
      });
      setSessionId(null);
      setAppView("admin");
      setMessage(`Willkommen, ${validatedManager.name || validatedManager.id}.`);
    } catch (error) {
      console.error("MANAGER LOGIN ERROR:", error);
      setMessage(`Manager-Login fehlgeschlagen: ${error.message}`);
    }
  }

  async function handleJoin(e) {
    e.preventDefault();
    setMessage("");
    setIssuedTeamPassword(null);

    if (entryMode === "first-time") {
      setMessage("Bitte nutzt den Tutorial-Guide oder wechselt danach in den normalen Team-Start.");
      return;
    }

    if (isAdmin) {
      await handleManagerLogin();
      return;
    }

    const cleanedCode = normalizeQuizCode(lobbyCode);
    if (cleanedCode.length !== 6) {
      setMessage("Bitte einen 6-stelligen Quiz-Code eingeben.");
      return;
    }

    const cleanedName = teamName.trim();
    if (!cleanedName) {
      setMessage("Bitte Teamnamen eingeben.");
      return;
    }

    const normalized = normalizeTeamName(cleanedName);
    if (!normalized) {
      setMessage("Teamname ist ungültig.");
      return;
    }

    const displayName = playerName.trim() || "Anonym";
    const cleanedTeamPassword = normalizeRankingPassword(teamPassword);
    const newSessionId = normalized;
    const sessionRef = getTeamSessionRef(cleanedCode, normalized);

    try {
      const quizzesQuery = query(
        collection(db, "pubQuizzes"),
        where("quizCode", "==", cleanedCode),
      );
      const quizSnapshot = await getDocs(quizzesQuery);
      const matchingQuiz = quizSnapshot.docs[0];

      if (!matchingQuiz) {
        setMessage(
          "Sorry, zu diesem Code gibt es noch kein Quiz. Wir sind dabei, neue Quizzes zu machen.",
        );
        return;
      }

      const selectedPubQuiz = {
        id: matchingQuiz.id,
        ...matchingQuiz.data(),
      };

      let validatedManager = null;

      if (isAdmin) {
        const cleanedManagerKey = normalizeManagerKey(managerKey);
        const cleanedManagerPassword = managerPassword.trim();

        if (!cleanedManagerKey || !cleanedManagerPassword) {
          setMessage("Bitte Manager-Key und persönliches Passwort eingeben.");
          return;
        }

        const managerRef = doc(db, "managers", cleanedManagerKey);
        const managerSnapshot = await getDoc(managerRef);

        if (!managerSnapshot.exists()) {
          if (managers.length > 0) {
            setMessage("Manager-Key oder Passwort ist falsch.");
            setIsAdmin(false);
            return;
          }

          validatedManager = {
            id: cleanedManagerKey,
            key: cleanedManagerKey,
            name: cleanedManagerKey,
            password: cleanedManagerPassword,
            active: true,
            canEditScores: true,
          };

          await setDoc(managerRef, {
            ...validatedManager,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          const managerData = managerSnapshot.data();

          if (!managerData.active || managerData.password !== cleanedManagerPassword) {
            setMessage("Manager-Key oder Passwort ist falsch.");
            setIsAdmin(false);
            return;
          }

          validatedManager = {
            id: managerSnapshot.id,
            ...managerData,
            canEditScores: Boolean(managerData.canEditScores ?? managerData.headManager),
          };

          await updateDoc(managerRef, {
            lastLoginAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }

      setActiveManager(validatedManager);
      saveRecentManagerSession({
        lobbyCode: cleanedCode,
        manager: validatedManager,
      });
    } else {
      setActiveManager(null);
      clearRecentManagerSession();
    }

      setActivePubQuiz(selectedPubQuiz);
      setActiveRoundId(
        selectedPubQuiz.rounds?.[0]?.id || defaultQuizRounds[0].id,
      );

      await ensureLobby(cleanedCode);
      const lobbySnapshot = await getDoc(getEventRef(cleanedCode));
      const joinLobbyData = lobbySnapshot.exists() ? lobbySnapshot.data() : null;

      const teamProfileRef = getTeamRef(normalized);
      const teamProfileSnapshot = await getDoc(teamProfileRef);
      const teamProfile = teamProfileSnapshot.exists()
        ? teamProfileSnapshot.data()
        : null;
      const existing = await getDoc(sessionRef);
      const isClosedForNewTeams = isNewTeamJoinClosed(joinLobbyData, now);
      const teamProfileRankingOptIn = Boolean(
        teamProfile?.yearlyRankingOptIn ?? teamProfile?.rankingOptIn,
      );
      const existingSessionRankingOptIn = Boolean(existing.data()?.rankingOptIn);

      if (knownTeamMode === "registered") {
        if (!teamProfileSnapshot.exists()) {
          setMessage("Dieses Team ist noch nicht im Jahresranking registriert. Nutzt bitte 'nur heute'.");
          return;
        }

        if (!teamProfileRankingOptIn) {
          setMessage("Dieses Team hat aktuell keinen Jahresranking-Zugang. Nutzt bitte 'nur heute'.");
          return;
        }

        let assignedPassword = "";
        const savedPassword = normalizeRankingPassword(teamProfile?.rankingPassword || "");

        if (savedPassword) {
          if (!cleanedTeamPassword || cleanedTeamPassword !== savedPassword) {
            setMessage("Teamname oder Team-Passwort ist falsch.");
            return;
          }
        } else {
          assignedPassword = createRankingPassword();
          await setDoc(
            teamProfileRef,
            {
              rankingPassword: assignedPassword,
              rankingPasswordCreatedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        }

        if (existing.exists()) {
          await setDoc(
            sessionRef,
            {
              playerName: displayName,
              ...(displayName !== "Anonym"
                ? {
                    playerNames: arrayUnion(displayName),
                    normalizedPlayerNames: arrayUnion(normalizePersonName(displayName)),
                  }
                : {}),
              rankingOptIn: true,
              yearlyRankingOptInAtTime: true,
              lastSeenAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
          if (displayName !== "Anonym") {
            const teammateId = getTeammateId(displayName);
            if (teammateId) {
              await setDoc(
                getTeammateRef(normalized, teammateId),
                {
                  id: teammateId,
                  name: displayName,
                  normalizedName: teammateId,
                  joinedEventIds: arrayUnion(getEventId(cleanedCode)),
                  lastSeenAt: serverTimestamp(),
                },
                { merge: true },
              );
            }
          }
          setSessionData({
            id: newSessionId,
            ...existing.data(),
            lobbyCode: cleanedCode,
            playerName: displayName,
            rankingOptIn: true,
            yearlyRankingOptInAtTime: true,
          });
          setSessionId(newSessionId);
          if (assignedPassword) {
            setIssuedTeamPassword({
              isLegacy: true,
              password: assignedPassword,
              teamName: teamProfile.teamName || cleanedName,
            });
          }
          setMessage(`Bestehende Session beigetreten: ${existing.data().teamName}`);
          return;
        }

        if (isClosedForNewTeams) {
          setMessage("Neue Teams koennen gerade nicht mehr beitreten. Nur Teams, die schon in dieser Lobby waren.");
          return;
        }

        await saveTeamSession({
          cleanedCode,
          cleanedName,
          displayName,
          normalized,
          rankingOptIn: true,
          rankingPassword: assignedPassword,
        });
        setSessionData({
          ...createSessionRecord({
            cleanedCode,
            cleanedName,
            displayName,
            normalized,
            rankingOptIn: true,
          }),
        });
        setSessionId(newSessionId);
        if (assignedPassword) {
          setIssuedTeamPassword({
            isLegacy: true,
            password: assignedPassword,
            teamName: teamProfile.teamName || cleanedName,
          });
        }
        setMessage(`Team beigetreten: ${cleanedName}`);
        return;
      }

      if (teamProfileRankingOptIn || existingSessionRankingOptIn) {
        setMessage("Dieses Team ist im Jahresranking registriert. Bitte 'Mein Team ist angemeldet' mit Passwort nutzen.");
        return;
      }

      if (existing.exists()) {
        const rankingOptIn =
          teamProfile?.yearlyRankingOptIn ??
          teamProfile?.rankingOptIn ??
          existing.data().rankingOptIn ??
          false;

        if (!teamProfileSnapshot.exists()) {
          await setDoc(teamProfileRef, {
            ...createTeamRecord({
              cleanedName: existing.data().teamName || cleanedName,
              normalized,
              rankingOptIn,
            }),
            updatedAt: serverTimestamp(),
          }, { merge: true });
        }

        await setDoc(sessionRef, {
          playerName: displayName,
          ...(displayName !== "Anonym"
            ? {
                playerNames: arrayUnion(displayName),
                normalizedPlayerNames: arrayUnion(normalizePersonName(displayName)),
              }
            : {}),
          rankingOptIn,
          yearlyRankingOptInAtTime: rankingOptIn,
          lastSeenAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }, { merge: true });
        if (displayName !== "Anonym") {
          const teammateId = getTeammateId(displayName);
          if (teammateId) {
            await setDoc(
              getTeammateRef(normalized, teammateId),
              {
                id: teammateId,
                name: displayName,
                normalizedName: teammateId,
                joinedEventIds: arrayUnion(getEventId(cleanedCode)),
                lastSeenAt: serverTimestamp(),
              },
              { merge: true },
            );
          }
        }
        setSessionData({ id: newSessionId, ...existing.data(), lobbyCode: cleanedCode });
        setSessionId(newSessionId);
        setMessage(`Bestehende Session beigetreten: ${existing.data().teamName}`);
        return;
      }

      if (isClosedForNewTeams) {
        setMessage("Neue Teams koennen gerade nicht mehr beitreten. Nur Teams, die schon in dieser Lobby waren.");
        return;
      }

      if (teamProfileSnapshot.exists()) {
        await setDoc(
          teamProfileRef,
          {
            ...(displayName !== "Anonym"
              ? {
                  playerNames: arrayUnion(displayName),
                  normalizedPlayerNames: arrayUnion(normalizePersonName(displayName)),
                }
              : {
                  anonymousJoinCount: increment(1),
                }),
            yearlyRankingOptIn: Boolean(teamProfile.yearlyRankingOptIn ?? teamProfile.rankingOptIn),
            rankingOptIn: Boolean(teamProfile.yearlyRankingOptIn ?? teamProfile.rankingOptIn),
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
        if (displayName !== "Anonym") {
          const teammateId = getTeammateId(displayName);
          if (teammateId) {
            await setDoc(
              getTeammateRef(normalized, teammateId),
              {
                id: teammateId,
                name: displayName,
                normalizedName: teammateId,
                joinedEventIds: arrayUnion(getEventId(cleanedCode)),
                lastSeenAt: serverTimestamp(),
              },
              { merge: true },
            );
          }
        }
        await saveTeamSession({
          cleanedCode,
          cleanedName,
          displayName,
          normalized,
          rankingOptIn: Boolean(teamProfile.yearlyRankingOptIn ?? teamProfile.rankingOptIn),
        });
        setSessionData({
          ...createSessionRecord({
            cleanedCode,
            cleanedName,
            displayName,
            normalized,
            rankingOptIn: Boolean(teamProfile.yearlyRankingOptIn ?? teamProfile.rankingOptIn),
          }),
        });
        setSessionId(newSessionId);
        setMessage(`Team beigetreten: ${cleanedName}`);
        return;
      }

      setPendingTeamCreate({
        cleanedCode,
        cleanedName,
        displayName,
        newSessionId,
        normalized,
      });
    } catch (error) {
      console.error("JOIN ERROR:", error);
      setMessage(`Fehler beim Beitreten der Session: ${error.message}`);
    }
  }

  async function createNewTeam(rankingOptIn) {
    if (!pendingTeamCreate) return;

    const {
      cleanedCode,
      cleanedName,
      displayName,
      newSessionId,
      normalized,
    } = pendingTeamCreate;
    const rankingPassword = rankingOptIn ? createRankingPassword() : "";

    try {
      const lobbySnapshot = await getDoc(getEventRef(cleanedCode));
      const lobbyForJoin = lobbySnapshot.exists() ? lobbySnapshot.data() : null;

      if (isNewTeamJoinClosed(lobbyForJoin, now)) {
        setMessage("Neue Teams koennen gerade nicht mehr beitreten.");
        setPendingTeamCreate(null);
        return;
      }

      await saveTeamSession({
        cleanedCode,
        cleanedName,
        displayName,
        normalized,
        rankingOptIn,
        rankingPassword,
      });

      setSessionData({
        ...createSessionRecord({
          cleanedCode,
          cleanedName,
          displayName,
          normalized,
          rankingOptIn,
        }),
      });
      setSessionId(newSessionId);
      if (rankingPassword) {
        setIssuedTeamPassword({
          isLegacy: false,
          password: rankingPassword,
          teamName: cleanedName,
        });
      }
      setMessage(`Neue Session erstellt für: ${cleanedName}`);
      setPendingTeamCreate(null);
    } catch (error) {
      console.error("CREATE TEAM ERROR:", error);
      setMessage(`Fehler beim Erstellen der Session: ${error.message}`);
    }
  }

  async function markTeamFinalReady() {
    if (!sessionId || !sessionData?.lobbyCode) return;

    const finalRound = getLastQuizRound(quizRounds);
    if (!finalRound || !isRoundFinished(sessionData, finalRound, now, lobbyData, quizRounds)) return;

    try {
      await updateDoc(getEventRef(sessionData.lobbyCode), {
        [`finalReady.${sessionId}`]: true,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error("FINAL READY ERROR:", error);
    }
  }

  async function checkAndSaveAnswer(question) {
    if (!sessionId) return;

    if (isAnswerWindowClosed(lobbyData, now)) {
      setMessage("Die 5-Stunden-Antwortzeit fuer dieses Quiz ist abgelaufen.");
      return;
    }

    const answer = answerDrafts[question.id] ?? "";
    const result = checkAnswer(answer, question.acceptedAnswers, question.points);

    try {
      const sessionRef = getTeamSessionRef(sessionData.lobbyCode, sessionId);
      const alreadyLocked = sessionData?.answers?.[question.id]?.locked;
      const alreadyAwarded =
        sessionData?.answers?.[question.id]?.pointsAwarded || 0;
      let nextPointToast = null;
      const nextAnswers = {
        ...(sessionData?.answers || {}),
        [question.id]: {
          ...(sessionData?.answers?.[question.id] || {}),
          text: answer,
        },
      };
      const allQuestionIds = quizRounds.flatMap((round) => round.questionIds);
      const quizComplete =
        allQuestionIds.length > 0 &&
        allQuestionIds.every((questionId) => {
          const savedAnswer = nextAnswers[questionId]?.text;

          return typeof savedAnswer === "string" && savedAnswer.trim().length > 0;
        });

      const updatePayload = {
        [`answers.${question.id}.text`]: answer,
        [`answers.${question.id}.result`]: result.result,
        [`answers.${question.id}.matchedSegments`]: result.matchedSegments,
        [`answers.${question.id}.updatedAt`]: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      if (result.result === "correct") {
        updatePayload[`answers.${question.id}.locked`] = true;

        if (!alreadyLocked && alreadyAwarded === 0) {
          const nextTotalPoints =
            (sessionData?.totalPoints || 0) + result.pointsAwarded;

          updatePayload[`answers.${question.id}.pointsAwarded`] =
            result.pointsAwarded;
          updatePayload.totalPoints = nextTotalPoints;
          nextPointToast = {
            id: `${question.id}-${nextTotalPoints}-${Date.now()}`,
            message:
              pointMessages[(nextTotalPoints - 1) % pointMessages.length],
          };
        }
      } else {
        updatePayload[`answers.${question.id}.pointsAwarded`] = 0;
      }

      if (quizComplete && !sessionData?.completedAt) {
        updatePayload.completedAt = serverTimestamp();
      }

      setSessionData((currentSession) => ({
        ...(currentSession || {}),
        answers: {
          ...(currentSession?.answers || {}),
          [question.id]: {
            ...(currentSession?.answers?.[question.id] || {}),
            matchedSegments: result.matchedSegments,
            pointsAwarded:
              result.result === "correct"
                ? currentSession?.answers?.[question.id]?.pointsAwarded ||
                  result.pointsAwarded
                : 0,
            result: result.result,
            text: answer,
            updatedAt: new Date(),
            ...(result.result === "correct" ? { locked: true } : {}),
          },
        },
        ...(nextPointToast
          ? { totalPoints: updatePayload.totalPoints ?? currentSession?.totalPoints ?? 0 }
          : {}),
        ...(quizComplete && !currentSession?.completedAt
          ? { completedAt: new Date() }
          : {}),
        updatedAt: new Date(),
      }));

      await updateDoc(sessionRef, updatePayload);

      if (nextPointToast) {
        setPointToast(nextPointToast);
      }
    } catch (error) {
      console.error("CHECK ERROR:", error);
    }
  }

  async function revealHint(roundId, questionId) {
    if (!sessionId) return;

    try {
      const sessionRef = getTeamSessionRef(sessionData.lobbyCode, sessionId);

      await updateDoc(sessionRef, {
        [`hints.${roundId}.${questionId}`]: true,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error("HINT ERROR:", error);
    }
  }

  async function unlockRound(roundId) {
    if (!sessionData?.lobbyCode) return;

    try {
      const lobbyRef = getEventRef(sessionData.lobbyCode);

      await setDoc(
        lobbyRef,
        {
          quizId: latestQuizId,
          lobbyCode: sessionData.lobbyCode,
          activeRoundId: roundId,
          roundStarts: {
            [roundId]: serverTimestamp(),
          },
          unlockedRounds: {
            [roundId]: true,
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setActiveRoundId(roundId);
    } catch (error) {
      console.error("ROUND UNLOCK ERROR:", error);
    }
  }

  async function closeNewRegistrations() {
    if (!isAdmin || !sessionData?.lobbyCode) return false;

    try {
      await setDoc(
        getEventRef(sessionData.lobbyCode),
        {
          quizId: latestQuizId,
          lobbyCode: sessionData.lobbyCode,
          closedAt: serverTimestamp(),
          emergencyJoinAnnouncement: {
            active: false,
            message: "",
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setQuizManagerMessage("Neue Teams sind jetzt gesperrt. Bereits vorhandene Teams koennen weiter rein.");
      return true;
    } catch (error) {
      console.error("REGISTRATION CLOSE ERROR:", error);
      setQuizManagerMessage?.(`Neue Anmeldungen konnten nicht gesperrt werden: ${error.message}`);
      return false;
    }
  }

  async function reopenNewRegistrationsForFiveMinutes() {
    if (!isAdmin || !sessionData?.lobbyCode) return false;

    try {
      await setDoc(
        getEventRef(sessionData.lobbyCode),
        {
          quizId: latestQuizId,
          lobbyCode: sessionData.lobbyCode,
          closedAt: serverTimestamp(),
          emergencyJoinWindowEndsAt: new Date(Date.now() + EMERGENCY_JOIN_WINDOW_MS),
          emergencyJoinAnnouncement: {
            active: true,
            message: "Neue Anmeldung ist fuer 5 Minuten wieder offen.",
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setQuizManagerMessage("Neue Anmeldung fuer 5 Minuten wieder geoeffnet.");
      return true;
    } catch (error) {
      console.error("REGISTRATION REOPEN ERROR:", error);
      setQuizManagerMessage?.(`Not-Anmeldung konnte nicht geoeffnet werden: ${error.message}`);
      return false;
    }
  }

  async function startTeamRound(roundId) {
    if (!sessionData?.lobbyCode) {
      setMessage("Bitte erst einen Quiz-Code laden.");
      return;
    }

    try {
      let effectiveSessionId = sessionId;
      let effectiveSessionData = sessionData;

      if (!effectiveSessionId) {
        if (!activeManager) {
          setMessage("Bitte erst als Team beitreten.");
          return;
        }

        const cleanedName =
          sessionData.teamName || activeManager.name || activeManager.id;
        const normalized = normalizeTeamName(cleanedName);

        if (!normalized) {
          setMessage("Teamname ist ungueltig.");
          return;
        }

        const displayName =
          sessionData.playerName || activeManager.name || activeManager.id;
        const sessionRef = getTeamSessionRef(sessionData.lobbyCode, normalized);
        const existingSession = await getDoc(sessionRef);

        if (existingSession.exists()) {
          effectiveSessionData = {
            id: normalized,
            ...existingSession.data(),
            lobbyCode: sessionData.lobbyCode,
            managerOnly: false,
          };
        } else {
          effectiveSessionData = {
            ...createSessionRecord({
              cleanedCode: sessionData.lobbyCode,
              cleanedName,
              displayName,
              normalized,
              rankingOptIn: false,
            }),
            createdAt: new Date(),
            lastSeenAt: new Date(),
            managerOnly: false,
            updatedAt: new Date(),
          };
          await setDoc(sessionRef, {
            ...effectiveSessionData,
            createdAt: serverTimestamp(),
            lastSeenAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }, { merge: true });
        }

        effectiveSessionId = normalized;
        setSessionId(effectiveSessionId);
        setSessionData(effectiveSessionData);
      }

      const sessionRef = getTeamSessionRef(
        effectiveSessionData.lobbyCode,
        effectiveSessionId,
      );
      const alreadyStarted = Boolean(
        getEffectiveRoundStartMs(
          effectiveSessionData,
          lobbyData,
          roundId,
          Date.now(),
          quizRounds,
        ),
      );

      if (alreadyStarted) {
        setMessage("Der Timer fuer diese Runde laeuft bereits.");
        return;
      }

      const startedAt = new Date();
      setMessage("");

      setSessionData((currentSession) => ({
        ...(currentSession || {}),
        roundStarts: {
          ...(currentSession?.roundStarts || {}),
          [roundId]: startedAt,
        },
        updatedAt: startedAt,
      }));

      await setDoc(sessionRef, {
        roundStarts: {
          [roundId]: startedAt,
        },
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch (error) {
      console.error("TEAM ROUND START ERROR:", error);
      setMessage(`Timer konnte nicht gestartet werden: ${error.message}`);
    }
  }

  async function revealRoundAnswers(roundId) {
    if (!isAdmin || !sessionData?.lobbyCode) return;

    try {
      const lobbyRef = getEventRef(sessionData.lobbyCode);

      await setDoc(
        lobbyRef,
        {
          quizId: latestQuizId,
          lobbyCode: sessionData.lobbyCode,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      await updateDoc(lobbyRef, {
        [`revealedAnswers.${roundId}`]: true,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error("ANSWER REVEAL ERROR:", error);
    }
  }

  async function addRoundExtraTime(roundId) {
    if (!isAdmin || !sessionData?.lobbyCode) return false;

    try {
      const lobbyRef = getEventRef(sessionData.lobbyCode);

      await runTransaction(db, async (transaction) => {
        const lobbySnapshot = await transaction.get(lobbyRef);
        const currentLobby = lobbySnapshot.exists() ? lobbySnapshot.data() : {};
        const currentExtraMinutes = getRoundExtraMinutes(currentLobby, roundId);

        if (currentExtraMinutes >= 30) {
          throw new Error("Maximal 30 Minuten Zusatzzeit pro Runde erreicht.");
        }

        const nextExtraMinutes = Math.min(30, currentExtraMinutes + 10);
        const grantedMinutes = nextExtraMinutes - currentExtraMinutes;

        transaction.set(
          lobbyRef,
          {
            quizId: latestQuizId,
            lobbyCode: sessionData.lobbyCode,
            roundExtraMinutes: {
              ...(currentLobby.roundExtraMinutes || {}),
              [roundId]: nextExtraMinutes,
            },
            roundExtraAnnouncements: {
              ...(currentLobby.roundExtraAnnouncements || {}),
              [roundId]: {
                grantedMinutes,
                totalMinutes: nextExtraMinutes,
                message:
                  "Sorry, wir haben einen Fehler gemacht. Hier sind ein paar Minuten extra.",
                updatedAt: serverTimestamp(),
              },
            },
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      });

      setQuizManagerMessage(
        `Zusatzzeit fuer ${selectedRound.title}: +10 Minuten vergeben.`,
      );
      return true;
    } catch (error) {
      console.error("ROUND EXTRA TIME ERROR:", error);
      setQuizManagerMessage(`Zusatzzeit konnte nicht vergeben werden: ${error.message}`);
      return false;
    }
  }

  async function updateTeamScore({
    lobbyCode,
    nextTotalPoints,
    note,
    teamId,
    teamName,
  }) {
    const targetLobbyCode = normalizeQuizCode(lobbyCode || sessionData?.lobbyCode || "");

    if (!canManagerEditScores(activeManager) || !targetLobbyCode || !teamId) {
      return { ok: false, message: "Dieser Manager darf keine Punkte korrigieren." };
    }

    const parsedPoints = Number(nextTotalPoints);

    if (!Number.isFinite(parsedPoints) || parsedPoints < 0) {
      return { ok: false, message: "Bitte eine gueltige Punktzahl eingeben." };
    }

    const sessionRef = getTeamSessionRef(targetLobbyCode, teamId);

    try {
      const sessionSnapshot = await getDoc(sessionRef);

      if (!sessionSnapshot.exists()) {
        return { ok: false, message: "Team-Session nicht gefunden." };
      }

      const currentSession = sessionSnapshot.data();
      const auditSummary = await auditTeamSessionScores({
        lobbyCode: targetLobbyCode,
        teamId,
        reason: "Gesamtpunktestand",
      });
      const auditedSnapshot = await getDoc(sessionRef);
      const auditedSession = auditedSnapshot.exists()
        ? auditedSnapshot.data()
        : currentSession;
      const previousPoints = Number(auditedSession.totalPoints) || 0;

      await setDoc(
        sessionRef,
        {
          totalPoints: parsedPoints,
          scoreAdjustment: {
            active: parsedPoints !== previousPoints || Boolean(note?.trim()),
            adjustedAt: serverTimestamp(),
            adjustedBy: activeManager.name || activeManager.id || "Head Manager",
            adjustedById: activeManager.id || activeManager.key || "",
            note: note?.trim() || "",
            previousPoints,
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      const correctedMessage =
        auditSummary.totalCorrections > 0
          ? ` Automatisch korrigiert: ${auditSummary.totalCorrections} Abweichung${
              auditSummary.totalCorrections === 1 ? "" : "en"
            }.`
          : "";
      const refreshedSnapshot = await getDoc(sessionRef);

      if (refreshedSnapshot.exists()) {
        syncCachedTeamSession({
          id: refreshedSnapshot.id,
          ...refreshedSnapshot.data(),
        });
      }

      return {
        ok: true,
        message: `Punktestand fuer ${teamName || currentSession.teamName || teamId} gespeichert.${correctedMessage}`,
      };
    } catch (error) {
      console.error("TEAM SCORE UPDATE ERROR:", error);
      return { ok: false, message: `Punkte konnten nicht gespeichert werden: ${error.message}` };
    }
  }

  function syncCachedTeamSession(targetSession) {
    if (!targetSession?.id) return;

    const nextSession = {
      id: targetSession.id,
      sessionKey: `${targetSession.eventId || "event"}__${targetSession.id}`,
      ...targetSession,
    };

    setAllTeamSessions((currentSessions) =>
      currentSessions.map((session) =>
        (session.eventId || "") === (nextSession.eventId || "") &&
        (session.id || "") === nextSession.id
          ? {
              ...session,
              ...nextSession,
              sessionKey: nextSession.sessionKey,
            }
          : session,
      ),
    );

    setAllTeams((currentTeams) =>
      currentTeams.map((session) =>
        (session.eventId || "") === (nextSession.eventId || "") &&
        (session.id || "") === nextSession.id
          ? {
              ...session,
              ...nextSession,
            }
          : session,
      ),
    );
  }

  async function updateTeamQuestionScore({
    lobbyCode,
    nextPointsAwarded,
    note,
    questionId,
    questionTitle,
    teamId,
    teamName,
  }) {
    const targetLobbyCode = normalizeQuizCode(lobbyCode || sessionData?.lobbyCode || "");

    if (!canManagerEditScores(activeManager) || !targetLobbyCode || !teamId || !questionId) {
      return { ok: false, message: "Dieser Manager darf keine Fragen korrigieren." };
    }

    const parsedPoints = Number(nextPointsAwarded);

    if (!Number.isFinite(parsedPoints) || parsedPoints < 0) {
      return { ok: false, message: "Bitte eine gueltige Punktzahl fuer die Frage eingeben." };
    }

    const sessionRef = getTeamSessionRef(targetLobbyCode, teamId);

    try {
      const sessionSnapshot = await getDoc(sessionRef);

      if (!sessionSnapshot.exists()) {
        return { ok: false, message: "Team-Session nicht gefunden." };
      }

      const currentSession = sessionSnapshot.data();
      const currentAnswers = currentSession.answers || {};
      const currentAnswer = currentAnswers[questionId] || {};
      const previousQuestionPoints = Number(currentAnswer.pointsAwarded) || 0;
      const previousTotalPoints = Number(currentSession.totalPoints) || 0;
      const trimmedNote = note?.trim() || "";
      const nextAnswers = {
        ...currentAnswers,
        [questionId]: {
          ...currentAnswer,
          pointsAwarded: parsedPoints,
        },
      };
      const nextTotalPoints = getAnswerPointsTotal(nextAnswers);
      const manualOverrideActive =
        parsedPoints !== previousQuestionPoints || Boolean(trimmedNote);

      await setDoc(
        sessionRef,
        {
          totalPoints: nextTotalPoints,
          scoreAdjustment: {
            active: nextTotalPoints !== previousTotalPoints || manualOverrideActive,
            adjustedAt: serverTimestamp(),
            adjustedBy: activeManager.name || activeManager.id || "Head Manager",
            adjustedById: activeManager.id || activeManager.key || "",
            note: trimmedNote
              ? `${questionTitle || questionId}: ${trimmedNote}`
              : `${questionTitle || questionId} manuell angepasst`,
            previousPoints: previousTotalPoints,
          },
          answers: {
            [questionId]: {
              ...currentAnswer,
              locked: parsedPoints > 0 ? true : currentAnswer.locked || false,
              manualOverride: {
                active: manualOverrideActive,
                adjustedAt: serverTimestamp(),
                adjustedBy: activeManager.name || activeManager.id || "Head Manager",
                adjustedById: activeManager.id || activeManager.key || "",
                note: trimmedNote,
                previousPointsAwarded: previousQuestionPoints,
              },
              pointsAwarded: parsedPoints,
              updatedAt: serverTimestamp(),
            },
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      const auditSummary = await auditTeamSessionScores({
        lobbyCode: targetLobbyCode,
        teamId,
        reason: questionTitle || questionId,
      });
      const correctedMessage =
        auditSummary.totalCorrections > 0
          ? ` Automatisch korrigiert: ${auditSummary.totalCorrections} Abweichung${
              auditSummary.totalCorrections === 1 ? "" : "en"
            }.`
          : "";
      const refreshedSnapshot = await getDoc(sessionRef);

      if (refreshedSnapshot.exists()) {
        syncCachedTeamSession({
          id: refreshedSnapshot.id,
          ...refreshedSnapshot.data(),
        });
      }

      return {
        ok: true,
        message: `Frage ${questionTitle || questionId} fuer ${teamName || currentSession.teamName || teamId} gespeichert.${correctedMessage}`,
      };
    } catch (error) {
      console.error("TEAM QUESTION SCORE UPDATE ERROR:", error);
      return {
        ok: false,
        message: `Fragenpunkte konnten nicht gespeichert werden: ${error.message}`,
      };
    }
  }

  async function submitManagerAnswerForTeam({
    answerText,
    lobbyCode,
    note,
    question,
    teamId,
    teamName,
  }) {
    const targetLobbyCode = normalizeQuizCode(lobbyCode || sessionData?.lobbyCode || "");

    if (!canManagerEditScores(activeManager) || !targetLobbyCode || !teamId || !question?.id) {
      return { ok: false, message: "Manager-Antwort konnte nicht gespeichert werden." };
    }

    const sessionRef = getTeamSessionRef(targetLobbyCode, teamId);

    try {
      const sessionSnapshot = await getDoc(sessionRef);

      if (!sessionSnapshot.exists()) {
        return { ok: false, message: "Team-Session nicht gefunden." };
      }

      const currentSession = sessionSnapshot.data();
      const currentAnswers = currentSession.answers || {};
      const currentAnswer = currentAnswers[question.id] || {};
      const previousTotalPoints = Number(currentSession.totalPoints) || 0;
      const trimmedAnswer = String(answerText || "").trim();
      const trimmedNote = note?.trim() || "";
      const result = checkAnswer(
        trimmedAnswer,
        question.acceptedAnswers || [],
        question.points || 0,
      );
      const nextAnswer = {
        ...currentAnswer,
        locked: result.result === "correct" ? true : currentAnswer.locked || false,
        managerOverride: {
          active: true,
          adjustedAt: serverTimestamp(),
          adjustedBy: activeManager.name || activeManager.id || "Manager",
          adjustedById: activeManager.id || activeManager.key || "",
          note: trimmedNote,
        },
        matchedSegments: result.matchedSegments,
        pointsAwarded: result.result === "correct" ? result.pointsAwarded : 0,
        result: result.result,
        text: trimmedAnswer,
        updatedAt: serverTimestamp(),
      };
      const nextAnswers = {
        ...currentAnswers,
        [question.id]: nextAnswer,
      };
      const nextTotalPoints = getAnswerPointsTotal(nextAnswers);

      await setDoc(
        sessionRef,
        {
          totalPoints: nextTotalPoints,
          scoreAdjustment: {
            active: nextTotalPoints !== previousTotalPoints || Boolean(trimmedNote),
            adjustedAt: serverTimestamp(),
            adjustedBy: activeManager.name || activeManager.id || "Manager",
            adjustedById: activeManager.id || activeManager.key || "",
            note: trimmedNote
              ? `${question.title}: ${trimmedNote}`
              : `${question.title} nachgetragen`,
            previousPoints: previousTotalPoints,
          },
          answers: {
            [question.id]: nextAnswer,
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      const auditSummary = await auditTeamSessionScores({
        lobbyCode: targetLobbyCode,
        teamId,
        reason: question.title,
      });
      const correctedMessage =
        auditSummary.totalCorrections > 0
          ? ` Automatisch korrigiert: ${auditSummary.totalCorrections} Abweichung${
              auditSummary.totalCorrections === 1 ? "" : "en"
            }.`
          : "";
      const refreshedSnapshot = await getDoc(sessionRef);

      if (refreshedSnapshot.exists()) {
        syncCachedTeamSession({
          id: refreshedSnapshot.id,
          ...refreshedSnapshot.data(),
        });
      }

      return {
        ok: true,
        message: `Antwort fuer ${question.title} bei ${teamName || currentSession.teamName || teamId} gespeichert.${correctedMessage}`,
      };
    } catch (error) {
      console.error("MANAGER ANSWER SUBMIT ERROR:", error);
      return {
        ok: false,
        message: `Antwort konnte nicht gespeichert werden: ${error.message}`,
      };
    }
  }

  async function savePubQuiz(draft) {
    if (!isAdmin) return;

    const quizId =
      draft.id ||
      `pubquiz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const quizRef = doc(db, "pubQuizzes", quizId);
    let payload = sanitizePubQuizDraft(draft, { includeImages: true });
    const imageStorageEstimate = getPubQuizImageStorageEstimate(draft);

    if (imageStorageEstimate > 850000) {
      setQuizManagerMessage(
        "Die Bilder sind zu gross zum Speichern. Bitte kleinere Bilder verwenden oder weniger Bilder hochladen.",
      );
      return null;
    }
    const existingCodes = new Set(
      pubQuizzes
        .filter((pubQuiz) => pubQuiz.id !== quizId)
        .map((pubQuiz) => normalizeQuizCode(pubQuiz.quizCode || ""))
        .filter(Boolean),
    );
    let quizCode = payload.quizCode || createQuizCode();

    while (existingCodes.has(quizCode)) {
      quizCode = createQuizCode();
    }

    try {
      const existingSnapshot = await getDoc(quizRef);

      if (existingSnapshot.exists()) {
        payload = preserveExistingPubQuizImages(
          payload,
          existingSnapshot.data(),
          draft,
        );
      }

      const finalImageStorageEstimate = getPubQuizImageStorageEstimate(payload);

      if (finalImageStorageEstimate > 850000) {
        setQuizManagerMessage(
          "Die gespeicherten Bilder sind zu gross fuer ein Pubquiz. Bitte kleinere Bilder verwenden oder weniger Bilder hochladen.",
        );
        return null;
      }

      await setDoc(quizRef, {
        ...payload,
        id: quizId,
        quizCode,
        updatedAt: serverTimestamp(),
        createdAt:
          existingSnapshot.data()?.createdAt ||
          draft.createdAt ||
          serverTimestamp(),
      });

      if (sessionData?.lobbyCode) {
        await setDoc(
          getEventRef(sessionData.lobbyCode),
          {
            quizId: latestQuizId,
            lobbyCode: sessionData.lobbyCode,
            tiebreakerAnswer: payload.tiebreakerAnswer,
            tiebreakerQuestion: payload.tiebreakerQuestion,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      }

      const savedQuiz = {
        ...payload,
        id: quizId,
        quizCode,
      };
      const isActiveLobbyQuiz =
        normalizeQuizCode(sessionData?.lobbyCode || "") === normalizeQuizCode(quizCode);

      if (isActiveLobbyQuiz) {
        setActivePubQuiz(savedQuiz);
        const runtimeQuiz = createRuntimeQuizFromPubQuiz(savedQuiz);
        const auditSummary = await auditTeamSessionScores({
          lobbyCode: quizCode,
          quizQuestions: runtimeQuiz.questions,
          reason: "Quiz-Speicherung",
        });

        if (auditSummary.totalCorrections > 0) {
          setQuizManagerMessage(
            `"${payload.title}" gespeichert. ${auditSummary.correctedTeamCount} Team${
              auditSummary.correctedTeamCount === 1 ? "" : "s"
            } und ${auditSummary.totalCorrections} Punkteintraege automatisch korrigiert.`,
          );
          return { id: quizId, quizCode };
        }
      }

      setQuizManagerMessage(`"${payload.title}" gespeichert.`);
      return { id: quizId, quizCode };
    } catch (error) {
      console.error("PUBQUIZ SAVE ERROR:", error);
      setQuizManagerMessage(`Speichern fehlgeschlagen: ${error.message}`);
      return null;
    }
  }

  async function deletePubQuiz(quizId) {
    if (!isAdmin) return false;

    if (!activeManager?.headManager) {
      setQuizManagerMessage("Nur du als Head Manager kannst Pubquizzes loeschen.");
      return false;
    }

    const targetQuiz = pubQuizzes.find((pubQuiz) => pubQuiz.id === quizId);

    if (!targetQuiz) {
      setQuizManagerMessage("Dieses Pubquiz wurde bereits geloescht oder nicht gefunden.");
      return false;
    }

    try {
      await deleteDoc(doc(db, "pubQuizzes", quizId));
      setQuizManagerMessage(`"${targetQuiz.title || "Unbenanntes Pubquiz"}" geloescht.`);
      return true;
    } catch (error) {
      console.error("PUBQUIZ DELETE ERROR:", error);
      setQuizManagerMessage(`Loeschen fehlgeschlagen: ${error.message}`);
      return false;
    }
  }

  async function saveManager(managerDraft) {
    if (!activeManager) return;

    if (!canManageManagerRecords(activeManager, managers)) {
      setQuizManagerMessage("Nur Head Manager koennen Manager bearbeiten.");
      return;
    }

    const cleanedKey = normalizeManagerKey(managerDraft.key || managerDraft.id || "");
    const cleanedName = managerDraft.name?.trim() || cleanedKey;
    const cleanedPassword = managerDraft.password?.trim();
    const nextHeadManager = Boolean(managerDraft.headManager);
    const canEditScores = Boolean(managerDraft.canEditScores ?? nextHeadManager);

    if (!cleanedKey || !cleanedPassword) {
      setQuizManagerMessage("Manager-Key und Passwort sind Pflicht.");
      return;
    }

    try {
      await setDoc(
        doc(db, "managers", cleanedKey),
        {
          key: cleanedKey,
          name: cleanedName,
          password: cleanedPassword,
          active: managerDraft.active !== false,
          canEditScores,
          headManager: nextHeadManager,
          updatedAt: serverTimestamp(),
          createdAt: managerDraft.createdAt || serverTimestamp(),
        },
        { merge: true },
      );
      if (normalizeManagerKey(activeManager.key || activeManager.id || "") === cleanedKey) {
        setActiveManager((currentManager) => ({
          ...currentManager,
          active: managerDraft.active !== false,
          canEditScores,
          headManager: nextHeadManager,
          key: cleanedKey,
          name: cleanedName,
          password: cleanedPassword,
        }));
      }
      setQuizManagerMessage(`Manager "${cleanedName}" gespeichert.`);
    } catch (error) {
      console.error("MANAGER SAVE ERROR:", error);
      setQuizManagerMessage(`Manager konnte nicht gespeichert werden: ${error.message}`);
    }
  }

  async function loadPubQuizByCode(quizCodeValue) {
    if (!activeManager) return false;

    const cleanedCode = normalizeQuizCode(quizCodeValue);
    if (cleanedCode.length !== 6) {
      setQuizManagerMessage("Bitte einen 6-stelligen Quiz-Code eingeben.");
      return false;
    }

    try {
      const quizzesQuery = query(
        collection(db, "pubQuizzes"),
        where("quizCode", "==", cleanedCode),
      );
      const quizSnapshot = await getDocs(quizzesQuery);
      const matchingQuiz = quizSnapshot.docs[0];

      if (!matchingQuiz) {
        setQuizManagerMessage(
          "Sorry, zu diesem Code gibt es noch kein Quiz. Wir sind dabei, neue Quizzes zu machen.",
        );
        return false;
      }

      const selectedPubQuiz = {
        id: matchingQuiz.id,
        ...matchingQuiz.data(),
      };

      setActivePubQuiz(selectedPubQuiz);
      setActiveRoundId(
        selectedPubQuiz.rounds?.[0]?.id || defaultQuizRounds[0].id,
      );
      await ensureLobby(cleanedCode, { deployForToday: true });
      setSessionData((currentSession) => ({
        ...(currentSession || {}),
        lobbyCode: cleanedCode,
        managerOnly: true,
        playerName:
          currentSession?.playerName || activeManager.name || activeManager.id,
        rankingOptIn: false,
        teamName:
          currentSession?.teamName || activeManager.name || activeManager.id,
        totalPoints: currentSession?.totalPoints || 0,
      }));
      setQuizManagerMessage(
        `Quiz ${cleanedCode} fuer heute geladen. Antworten sind 5 Stunden offen.`,
      );
      return true;
    } catch (error) {
      console.error("QUIZ CODE LOAD ERROR:", error);
      setQuizManagerMessage(`Quiz konnte nicht geladen werden: ${error.message}`);
      return false;
    }
  }

  async function startTiebreaker() {
    if (!activeManager || !sessionData?.lobbyCode) return;

    const lobbyRef = getEventRef(sessionData.lobbyCode);
    const finalRound = getLastQuizRound(quizRounds);
    const questionPointsById = Object.fromEntries(
      Object.entries(questions).map(([questionId, question]) => [
        questionId,
        Number(question?.points) || 0,
      ]),
    );
    const tiebreakerState = getTiebreakerState({
      teams: registeredTeams,
      lobbyData,
      finalRound,
      now,
      isRoundFinished,
      quizRounds,
      questionPointsById,
    });
    const eligibleTiedTeams = tiebreakerState.tiedTeams;
    const allEligibleReady =
      eligibleTiedTeams.length > 0 &&
      eligibleTiedTeams.every((team) => Boolean(lobbyData?.tiebreakerReady?.[team.id]));

    if (!tiebreakerState.allRelevantTeamsFinishedFinalRound) {
      setQuizManagerMessage("Die Schätzfrage startet erst, wenn alle Teams nach Runde 3 bereit sind.");
      return;
    }

    if (!allEligibleReady) {
      setQuizManagerMessage("Die Schätzfrage startet erst, wenn alle betroffenen Teams bereit sind.");
      return;
    }

    try {
      await setDoc(
        lobbyRef,
        {
          quizId: latestQuizId,
          lobbyCode: sessionData.lobbyCode,
          tiebreakerStatus: "active",
          tiebreakerStartedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setQuizManagerMessage("Schätzfrage gestartet.");
    } catch (error) {
      console.error("TIEBREAKER START ERROR:", error);
      setQuizManagerMessage(`Schätzfrage konnte nicht gestartet werden: ${error.message}`);
    }
  }

  async function markTeamTiebreakerReady() {
    if (!sessionId || !sessionData?.lobbyCode) return;

    const lobbyRef = getEventRef(sessionData.lobbyCode);
    const finalRound = getLastQuizRound(quizRounds);
    const questionPointsById = Object.fromEntries(
      Object.entries(questions).map(([questionId, question]) => [
        questionId,
        Number(question?.points) || 0,
      ]),
    );
    const tiebreakerState = getTiebreakerState({
      teams: registeredTeams,
      lobbyData,
      finalRound,
      now,
      isRoundFinished,
      quizRounds,
      questionPointsById,
    });
    const eligibleIds = new Set(tiebreakerState.tiedTeamIds);
    const nextReadyTeams = {
      ...(lobbyData?.tiebreakerReady || {}),
      [sessionId]: true,
    };
    const allEligibleReady =
      eligibleIds.size > 0 &&
      Array.from(eligibleIds).every((teamId) => nextReadyTeams[teamId]);

    try {
      await runTransaction(db, async (transaction) => {
        const lobbySnapshot = await transaction.get(lobbyRef);
        const currentParticipant =
          lobbySnapshot.data()?.tiebreakerParticipants?.[sessionId];

        if (
          currentParticipant?.clientId &&
          currentParticipant.clientId !== clientId
        ) {
          return;
        }

        transaction.update(lobbyRef, {
          [`tiebreakerParticipants.${sessionId}`]: {
            clientId,
            playerName: sessionData.playerName || "Anonym",
            joinedAt: serverTimestamp(),
          },
          [`tiebreakerReady.${sessionId}`]: true,
          ...(tiebreakerState.allRelevantTeamsFinishedFinalRound && allEligibleReady
            ? {
                tiebreakerStatus: "active",
                tiebreakerStartedAt: serverTimestamp(),
              }
            : {}),
          updatedAt: serverTimestamp(),
        });
      });
    } catch (error) {
      console.error("TIEBREAKER READY ERROR:", error);
    }
  }

  async function updateTeamPodiumExclusion({ teamId, teamName, excluded }) {
    if (!activeManager || !sessionData?.lobbyCode || !teamId) {
      return { ok: false, message: "Team konnte nicht aktualisiert werden." };
    }

    try {
      await setDoc(
        getEventRef(sessionData.lobbyCode),
        {
          tiebreakerExcludedTeams: {
            [teamId]: excluded
              ? {
                  active: true,
                  teamName: teamName || teamId,
                  updatedAt: serverTimestamp(),
                  updatedBy: activeManager.name || activeManager.id || "Manager",
                  updatedById: activeManager.id || activeManager.key || "",
                }
              : {
                  active: false,
                  teamName: teamName || teamId,
                  updatedAt: serverTimestamp(),
                  updatedBy: activeManager.name || activeManager.id || "Manager",
                  updatedById: activeManager.id || activeManager.key || "",
                },
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      return {
        ok: true,
        message: excluded
          ? `${teamName || teamId} blockiert das Podium nicht mehr.`
          : `${teamName || teamId} ist wieder podiumsrelevant.`,
      };
    } catch (error) {
      console.error("PODIUM EXCLUSION UPDATE ERROR:", error);
      return { ok: false, message: `Status konnte nicht gespeichert werden: ${error.message}` };
    }
  }

  async function submitTiebreakerEstimate(estimateValue) {
    if (!sessionId || !sessionData?.lobbyCode) return;
    if (getTiebreakerSubmission(lobbyData, sessionId)) return;

    const estimate = Number(estimateValue);
    if (!Number.isFinite(estimate)) return;

    const lobbyRef = getEventRef(sessionData.lobbyCode);

    try {
      await runTransaction(db, async (transaction) => {
        const lobbySnapshot = await transaction.get(lobbyRef);
        const lobbySnapshotData = lobbySnapshot.data();
        const participant =
          lobbySnapshotData?.tiebreakerParticipants?.[sessionId];
        const currentSubmission =
          lobbySnapshotData?.tiebreakerSubmissions?.[sessionId];

        if (currentSubmission) return;
        if (lobbySnapshotData?.tiebreakerStatus !== "active") return;
        if (!participant || participant.clientId !== clientId) return;

        transaction.update(lobbyRef, {
          [`tiebreakerSubmissions.${sessionId}`]: {
            clientId,
            estimate,
            playerName: sessionData.playerName || "Anonym",
            submittedAt: serverTimestamp(),
          },
          updatedAt: serverTimestamp(),
        });
      });
      setAppView("ranking");
    } catch (error) {
      console.error("TIEBREAKER SUBMIT ERROR:", error);
    }
  }

  async function submitFeedback(feedbackDraft) {
    if (!sessionData?.lobbyCode) return { ok: false, message: "Keine Lobby aktiv." };

    const dateKey = new Date().toISOString().slice(0, 10);
    const feedbackId = `${latestQuizId}__${clientId}__${dateKey}`;
    const feedbackRef = doc(db, "feedback", feedbackId);
    const messageText = feedbackDraft.message?.trim() || "";

    if (!messageText) {
      return { ok: false, message: "Bitte eine Nachricht eingeben." };
    }

    try {
      const existing = await getDoc(feedbackRef);

      if (existing.exists()) {
        return {
          ok: false,
          message: "Heute wurde von diesem Gerät schon eine Nachricht gesendet.",
        };
      }

      await setDoc(feedbackRef, {
        quizId: latestQuizId,
        eventId: getEventId(sessionData.lobbyCode),
        lobbyCode: sessionData.lobbyCode,
        teamId: sessionData.teamId || sessionData.teamNameNormalized || "",
        teamName: sessionData.teamName || "",
        playerName: feedbackDraft.anonymous
          ? "Anonym"
          : feedbackDraft.name?.trim() || sessionData.playerName || "Anonym",
        contact: feedbackDraft.anonymous ? "" : feedbackDraft.contact?.trim() || "",
        category: feedbackDraft.category || "meinung",
        message: messageText,
        anonymous: Boolean(feedbackDraft.anonymous),
        clientId,
        dateKey,
        createdAt: serverTimestamp(),
      });

      return { ok: true, message: "Danke, deine Nachricht ist angekommen." };
    } catch (error) {
      console.error("FEEDBACK ERROR:", error);
      return { ok: false, message: `Senden fehlgeschlagen: ${error.message}` };
    }
  }

  async function updateVoucherStatus({
    voucher,
    nextStatus,
    sourceSession,
    teamId,
    teamName,
  }) {
    const targetTeamId =
      teamId ||
      voucher?.teamId ||
      sessionData?.teamId ||
      sessionId ||
      sessionData?.teamNameNormalized;

    if (!targetTeamId || !voucher?.id) {
      return { ok: false, message: "Gutschein konnte nicht zugeordnet werden." };
    }

    const eventId =
      voucher.eventId ||
      sourceSession?.eventId ||
      getEventId(voucher.quizCode || sourceSession?.lobbyCode || "");

    if (!eventId) {
      return { ok: false, message: "Event fuer Gutschein konnte nicht gefunden werden." };
    }

    const voucherRef = getEventVoucherRef(eventId, voucher.id);
    const nextVoucherData = {
      id: voucher.id,
      eventId,
      quizCode:
        voucher.quizCode || sourceSession?.quizCode || sourceSession?.lobbyCode || "",
      quizLabel:
        voucher.quizLabel || getQuizLabelForSession(sourceSession || voucher, pubQuizzes),
      teamId: targetTeamId,
      teamName:
        teamName ||
        voucher.teamName ||
        sessionData?.teamName ||
        sourceSession?.teamName ||
        "",
      rank: Number(voucher.rank) || Number(sourceSession?.rankDaily) || 0,
      title:
        voucher.title ||
        getVoucherReward(Number(voucher.rank))?.title ||
        "Gutschein",
      description:
        voucher.description ||
        getVoucherReward(Number(voucher.rank))?.description ||
        "Gewinn aus dem Pubquiz",
      totalPoints: Number(voucher.totalPoints) || Number(sourceSession?.totalPoints) || 0,
      sourceSessionId: voucher.sourceSessionId || sourceSession?.id || "",
      awardedAt:
        voucher.awardedAt ||
        getCompletionValue(sourceSession) ||
        sourceSession?.createdAt ||
        new Date(),
      status: nextStatus,
      updatedAt: new Date(),
      ...(nextStatus === "requested"
        ? {
            requestedAt: voucher.requestedAt || new Date(),
            redeemedAt: null,
          }
        : {}),
      ...(nextStatus === "redeemed"
        ? {
            requestedAt: voucher.requestedAt || new Date(),
            redeemedAt: new Date(),
          }
        : {}),
      ...(nextStatus === "earned"
        ? {
            requestedAt: null,
            redeemedAt: null,
          }
        : {}),
    };

    try {
      const persistedVoucherData = {
        ...nextVoucherData,
        updatedAt: serverTimestamp(),
        ...(nextStatus === "requested"
          ? {
            requestedAt: voucher.requestedAt || serverTimestamp(),
              redeemedAt: deleteField(),
            }
          : {}),
        ...(nextStatus === "redeemed"
          ? {
              requestedAt: voucher.requestedAt || serverTimestamp(),
              redeemedAt: serverTimestamp(),
            }
          : {}),
        ...(nextStatus === "earned"
          ? {
              requestedAt: deleteField(),
              redeemedAt: deleteField(),
            }
          : {}),
      };
      const voucherBatch = writeBatch(db);
      voucherBatch.set(voucherRef, persistedVoucherData, { merge: true });
      voucherBatch.set(
        doc(db, "teams", targetTeamId, "vouchers", voucher.id),
        persistedVoucherData,
        { merge: true },
      );
      await voucherBatch.commit();
      setAllVoucherDocs((currentDocs) => {
        const remainingDocs = currentDocs.filter((currentDoc) => currentDoc.id !== voucher.id);
        return [...remainingDocs, nextVoucherData];
      });

      return {
        ok: true,
        message:
          nextStatus === "requested"
            ? "Gutschein zur Einloesung angefragt."
            : nextStatus === "redeemed"
              ? "Gutschein als eingeloest markiert."
              : "Gutschein aktualisiert.",
      };
    } catch (error) {
      console.error("VOUCHER STATUS ERROR:", error);
      return {
        ok: false,
        message: `Gutschein konnte nicht gespeichert werden: ${error.message}`,
      };
    }
  }

  async function createVoucherAssignment({
    awardedAt,
    eventId,
    quizCode,
    quizLabel,
    rank,
    sourceSessionId,
    teamId,
    teamName,
    totalPoints,
  }) {
    if (!isAdmin) {
      return { ok: false, message: "Nur Manager koennen Gutscheine anlegen." };
    }

    if (!activeManager?.headManager) {
      return { ok: false, message: "Nur du als Head Manager kannst Gutscheine anlegen." };
    }

    if (!eventId || !teamId || !teamName || ![1, 2, 3].includes(Number(rank))) {
      return { ok: false, message: "Bitte Event, Team und Platz 1 bis 3 auswaehlen." };
    }

    const normalizedRank = Number(rank);
    const vouchersForEvent = allVoucherDocs.filter(
      (voucher) =>
        !voucher.deleted &&
        (voucher.eventId || getEventId(voucher.quizCode || "")) === eventId &&
        [1, 2, 3].includes(Number(voucher.rank)),
    );
    const existingRankVoucher = vouchersForEvent.find(
      (voucher) => Number(voucher.rank) === normalizedRank,
    );

    if (existingRankVoucher) {
      return {
        ok: false,
        message: `Fuer Platz ${normalizedRank} gibt es bei diesem Event schon einen Gutschein. Bitte zuerst den falschen Gutschein loeschen.`,
      };
    }

    const assignedRanks = new Set(
      vouchersForEvent
        .map((voucher) => Number(voucher.rank))
        .filter((currentRank) => [1, 2, 3].includes(currentRank)),
    );

    if (assignedRanks.size >= 3) {
      return {
        ok: false,
        message: "Pro Event koennen maximal 3 Gutscheine vergeben werden. Bitte erst einen falschen Gutschein loeschen.",
      };
    }

    const reward = getVoucherReward(normalizedRank);
    const voucherId = `${eventId}__${teamId}__manual_rank${normalizedRank}`;
    const nextVoucherData = {
      id: voucherId,
      eventId,
      quizCode: quizCode || "",
      quizLabel: quizLabel || quizCode || "Pubquiz",
      teamId,
      teamName,
      rank: normalizedRank,
      title: reward?.title || `Platz ${normalizedRank} Gutschein`,
      description: reward?.description || "Manuell vergebener Gutschein",
      totalPoints: Number(totalPoints) || 0,
      sourceSessionId: sourceSessionId || "",
      awardedAt: awardedAt || new Date(),
      status: "earned",
      manualAssignment: true,
      createdAt: new Date(),
      createdByManagerKey: activeManager.key || "",
      createdByManagerName: activeManager.name || activeManager.key || "Head Manager",
      updatedAt: new Date(),
    };

    try {
      const persistedVoucherData = {
        ...nextVoucherData,
        awardedAt: awardedAt || serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      const voucherBatch = writeBatch(db);
      voucherBatch.set(getEventVoucherRef(eventId, voucherId), persistedVoucherData, {
        merge: true,
      });
      voucherBatch.set(doc(db, "teams", teamId, "vouchers", voucherId), persistedVoucherData, {
        merge: true,
      });
      await voucherBatch.commit();
      setAllVoucherDocs((currentDocs) => {
        const remainingDocs = currentDocs.filter((currentDoc) => currentDoc.id !== voucherId);
        return [...remainingDocs, nextVoucherData];
      });

      return {
        ok: true,
        message: `${teamName} hat jetzt den Gutschein fuer Platz ${normalizedRank}.`,
      };
    } catch (error) {
      console.error("VOUCHER CREATE ERROR:", error);
      return {
        ok: false,
        message: `Gutschein konnte nicht angelegt werden: ${error.message}`,
      };
    }
  }

  async function deleteVoucherAssignment(voucher) {
    if (!isAdmin) {
      return { ok: false, message: "Nur Manager koennen Gutscheine loeschen." };
    }

    if (!activeManager?.headManager) {
      return { ok: false, message: "Nur du als Head Manager kannst Gutscheine loeschen." };
    }

    if (!voucher?.id || !voucher?.teamId) {
      return { ok: false, message: "Dieser Gutschein kann nicht geloescht werden." };
    }

    try {
      const deletedVoucherData = {
        id: voucher.id,
        eventId: voucher.eventId || getEventId(voucher.quizCode || ""),
        quizCode: voucher.quizCode || "",
        quizLabel: voucher.quizLabel || voucher.quizCode || "Pubquiz",
        teamId: voucher.teamId,
        teamName: voucher.teamName || "",
        rank: Number(voucher.rank) || 0,
        title: voucher.title || "Gutschein",
        description: voucher.description || "",
        totalPoints: Number(voucher.totalPoints) || 0,
        sourceSessionId: voucher.sourceSessionId || "",
        awardedAt: voucher.awardedAt || new Date(),
        status: "deleted",
        deleted: true,
        deletedAt: new Date(),
        deletedByManagerKey: activeManager.key || "",
        deletedByManagerName: activeManager.name || activeManager.key || "Head Manager",
        updatedAt: new Date(),
      };
      const eventId = voucher.eventId || getEventId(voucher.quizCode || "");
      const persistedVoucherData = {
        ...deletedVoucherData,
        awardedAt: voucher.awardedAt || serverTimestamp(),
        deletedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      const voucherBatch = writeBatch(db);
      voucherBatch.set(getEventVoucherRef(eventId, voucher.id), persistedVoucherData, {
        merge: true,
      });
      voucherBatch.set(doc(db, "teams", voucher.teamId, "vouchers", voucher.id), persistedVoucherData, {
        merge: true,
      });
      await voucherBatch.commit();
      setAllVoucherDocs((currentDocs) => {
        const remainingDocs = currentDocs.filter((currentDoc) => currentDoc.id !== voucher.id);
        return [...remainingDocs, deletedVoucherData];
      });
      return {
        ok: true,
        message: `${voucher.title || "Gutschein"} wurde geloescht.`,
      };
    } catch (error) {
      console.error("VOUCHER DELETE ERROR:", error);
      return {
        ok: false,
        message: `Gutschein konnte nicht geloescht werden: ${error.message}`,
      };
    }
  }

  async function saveDailyRankingOrder(teamIds) {
    if (!isAdmin || !activeManager) {
      return { ok: false, message: "Nur Manager koennen das Ranking speichern." };
    }

    const computedRows = buildDailyRankingRows(registeredTeams, lobbyData);
    const orderedRows = applyManualRankingOrder(computedRows, teamIds);

    if (orderedRows.length === 0) {
      return { ok: false, message: "Es gibt kein Ranking zum Speichern." };
    }

    try {
      const persistResult = await persistDailyRankingState(orderedRows, {
        manualOrderTeamIds: teamIds,
        trackManualChange: true,
      });

      return {
        ok: true,
        rows: persistResult.rows,
        message: "Tagesranking gespeichert. Die Reihenfolge bleibt jetzt beim Neuladen erhalten.",
      };
    } catch (error) {
      console.error("SAVE DAILY RANKING ERROR:", error);
      return {
        ok: false,
        message: `Ranking konnte nicht gespeichert werden: ${error.message}`,
      };
    }
  }

  async function saveHistoricalEventRanking({
    awardedAt,
    eventId,
    quizCode,
    rows,
  }) {
    if (!isAdmin || !activeManager) {
      return { ok: false, message: "Nur Manager koennen Tagesrankings speichern." };
    }

    if (!eventId || !rows?.length) {
      return { ok: false, message: "Bitte zuerst ein Event mit Teams auswaehlen." };
    }

    try {
      const persistResult = await persistHistoricalDailyRankingState({
        awardedAt,
        eventId,
        quizCode,
        rows,
      });

      return {
        ok: true,
        rows: persistResult.rows,
        message:
          "Tagesranking fuer dieses Pubquiz gespeichert. Diese Reihenfolge bleibt jetzt fuer das Event erhalten.",
      };
    } catch (error) {
      console.error("SAVE HISTORICAL EVENT RANKING ERROR:", error);
      return {
        ok: false,
        message: `Event-Ranking konnte nicht gespeichert werden: ${error.message}`,
      };
    }
  }

  async function createRankingVouchers(teamIds) {
    if (!isAdmin || !activeManager) {
      return { ok: false, message: "Nur Manager koennen Gutscheine erstellen." };
    }

    const saveResult = await saveDailyRankingOrder(teamIds);
    if (!saveResult.ok) return saveResult;

    const orderedRows = saveResult.rows || applyManualRankingOrder(
      buildDailyRankingRows(registeredTeams, lobbyData),
      teamIds,
    );
    const topRows = orderedRows
      .filter((row) => row?.teamId && [1, 2, 3].includes(Number(row.rank)))
      .slice(0, 3);

    if (topRows.length === 0) {
      return { ok: false, message: "Keine gespeicherten Podiumsplaetze gefunden." };
    }

    const eventId = getEventId(sessionData?.lobbyCode || "");
    const conflictingRanks = [];
    const existingByRank = new Map();

    allVoucherDocs.forEach((voucher) => {
      if (
        voucher.deleted ||
        (voucher.eventId || getEventId(voucher.quizCode || "")) !== eventId
      ) {
        return;
      }

      const voucherRank = Number(voucher.rank);
      if (![1, 2, 3].includes(voucherRank)) return;
      existingByRank.set(voucherRank, voucher);
    });

    topRows.forEach((row) => {
      const existingVoucher = existingByRank.get(Number(row.rank));

      if (existingVoucher && existingVoucher.teamId !== row.teamId) {
        conflictingRanks.push(Number(row.rank));
      }
    });

    if (conflictingRanks.length > 0) {
      return {
        ok: false,
        message:
          `Fuer Platz ${conflictingRanks.join(", ")} gibt es schon Gutscheine mit einem anderen Team. ` +
          "Bitte diese zuerst im Gutschein-Bereich korrigieren oder loeschen.",
      };
    }

    const voucherBatch = writeBatch(db);
    let createdCount = 0;
    const createdVoucherDocs = [];
    const quizLabel = getQuizLabelForSession(
      {
        eventId,
        lobbyCode: sessionData?.lobbyCode || "",
        quizCode: sessionData?.lobbyCode || "",
      },
      pubQuizzes,
    );

    topRows.forEach((row) => {
      const existingVoucher = existingByRank.get(Number(row.rank));
      if (existingVoucher) return;

      const reward = getVoucherReward(Number(row.rank));
      const voucherId = `${eventId}__${row.teamId}__rank${row.rank}`;
      const matchingSession = registeredTeams.find((team) => team.id === row.teamId);
      const nextVoucherData = {
        id: voucherId,
        eventId,
        quizCode: sessionData?.lobbyCode || "",
        quizLabel: quizLabel || sessionData?.lobbyCode || "Pubquiz",
        teamId: row.teamId,
        teamName: row.teamName || "",
        rank: Number(row.rank),
        title: reward?.title || `Platz ${row.rank} Gutschein`,
        description: reward?.description || "Gewinn aus dem Pubquiz",
        totalPoints: Number(row.totalPoints) || 0,
        sourceSessionId: matchingSession?.id || row.teamId,
        awardedAt: getCompletionValue(matchingSession) || new Date(),
        status: "earned",
        autoCreatedFromRanking: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdByManagerKey: activeManager.key || "",
        createdByManagerName: activeManager.name || activeManager.key || "Manager",
      };

      voucherBatch.set(
        getEventVoucherRef(eventId, voucherId),
        {
          ...nextVoucherData,
          awardedAt: getCompletionValue(matchingSession) || serverTimestamp(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      voucherBatch.set(
        doc(db, "teams", row.teamId, "vouchers", voucherId),
        {
          ...nextVoucherData,
          awardedAt: getCompletionValue(matchingSession) || serverTimestamp(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      createdVoucherDocs.push(nextVoucherData);
      createdCount += 1;
    });

    if (createdCount === 0) {
      return {
        ok: true,
        message: "Die Gutscheine fuer dieses Podium existieren bereits.",
      };
    }

    voucherBatch.set(
      doc(db, "quizEvents", eventId, "rankings", "daily"),
      {
        voucherBatchCreatedAt: serverTimestamp(),
        voucherBatchCreatedByManagerKey: activeManager.key || "",
        voucherBatchCreatedByManagerName: activeManager.name || activeManager.key || "Manager",
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    try {
      await voucherBatch.commit();
      setAllVoucherDocs((currentDocs) => {
        const mergedDocs = [...currentDocs];

        createdVoucherDocs.forEach((voucherDoc) => {
          const existingIndex = mergedDocs.findIndex((currentDoc) => currentDoc.id === voucherDoc.id);

          if (existingIndex >= 0) {
            mergedDocs[existingIndex] = voucherDoc;
          } else {
            mergedDocs.push(voucherDoc);
          }
        });

        return mergedDocs;
      });
      return {
        ok: true,
        message: `${createdCount} Gutschein${createdCount === 1 ? "" : "e"} aus dem gespeicherten Ranking erstellt.`,
      };
    } catch (error) {
      console.error("CREATE RANKING VOUCHERS ERROR:", error);
      return {
        ok: false,
        message: `Gutscheine konnten nicht erstellt werden: ${error.message}`,
      };
    }
  }

  if (!sessionData && isRestoringSession) {
    return (
      <main style={pageStyle}>
        <section
          style={{
            width: "min(100%, 520px)",
            margin: "80px auto",
            padding: 28,
            borderRadius: 24,
            border: "1px solid #1f2937",
            background: "#111827",
            textAlign: "center",
          }}
        >
          <p style={{ margin: 0, color: "#93c5fd", fontWeight: 700 }}>
            Letzte Sitzung wird wiederhergestellt...
          </p>
          <p style={{ margin: "12px 0 0", color: "#94a3b8" }}>
            Wir pruefen euren Teamzugang fuer die letzten 24 Stunden.
          </p>
        </section>
      </main>
    );
  }

  if (!sessionData) {
    return (
      <MobileLobbyScreen
        canOpenRanking={false}
        entryMode={entryMode}
        issuedTeamPassword={issuedTeamPassword}
        knownTeamMode={knownTeamMode}
        lobbyCode={lobbyCode}
        isAdmin={isAdmin}
        managerKey={managerKey}
        managerPassword={managerPassword}
        message={message}
        onOpenRanking={() => setAppView("ranking")}
        playerName={playerName}
        teamPassword={teamPassword}
        teamName={teamName}
        onJoin={handleJoin}
        onCloseIssuedTeamPassword={() => setIssuedTeamPassword(null)}
        onAdminChange={(nextIsAdmin) => {
          setIsAdmin(nextIsAdmin);
          if (!nextIsAdmin) {
            setActiveManager(null);
            clearRecentManagerSession();
          }
        }}
        onEntryModeChange={(nextMode) => {
          setEntryMode(nextMode);
          const nextIsAdmin = nextMode === "manager";
          setIsAdmin(nextIsAdmin);
          if (!nextIsAdmin) {
            setActiveManager(null);
            clearRecentManagerSession();
          }
          setMessage("");
        }}
        onKnownTeamModeChange={setKnownTeamMode}
        onLobbyCodeChange={setLobbyCode}
        onManagerKeyChange={setManagerKey}
        onManagerPasswordChange={setManagerPassword}
        onPlayerNameChange={setPlayerName}
        onTeamPasswordChange={(value) => setTeamPassword(normalizeRankingPassword(value))}
        onTeamNameChange={setTeamName}
        pendingTeamCreate={pendingTeamCreate}
        onCancelRankingPrompt={() => setPendingTeamCreate(null)}
        onConfirmRankingPrompt={createNewTeam}
      />
    );
  }

  const anyRoundUnlocked = quizRounds.some((round) =>
    isRoundUnlocked(lobbyData, round.id),
  );
  const finalRound = getLastQuizRound(quizRounds);
  const questionPointsById = Object.fromEntries(
    Object.entries(questions).map(([questionId, question]) => [
      questionId,
      Number(question?.points) || 0,
    ]),
  );
  const tiebreakerState = getTiebreakerState({
    teams: registeredTeams,
    lobbyData,
    finalRound,
    now,
    isRoundFinished,
    quizRounds,
    questionPointsById,
  });
  const currentTeamFinishedFinalRound = isRoundFinished(
    sessionData,
    finalRound,
    now,
    lobbyData,
    quizRounds,
  );
  const allTeamsFinishedFinalRound = tiebreakerState.allRelevantTeamsFinishedFinalRound;
  const allTeamsReadyForRanking = allTeamsFinishedFinalRound;
  const issuedTeamPasswordModal = issuedTeamPassword ? (
    <TeamPasswordModal
      isLegacy={issuedTeamPassword.isLegacy}
      password={issuedTeamPassword.password}
      teamName={issuedTeamPassword.teamName}
      onClose={() => setIssuedTeamPassword(null)}
    />
  ) : null;

  if (appView === "ranking") {
    return (
      <>
        <RankingScreen
          isAdmin={isAdmin}
          allTeams={allTeams.length ? allTeams : registeredTeams}
          dailyRankingRows={dailyRankingRows}
          globalRankingRows={globalRankingRows}
          lobbyData={lobbyData}
          onCreateRankingVouchers={createRankingVouchers}
          onOpenAdmin={() => setAppView("admin")}
          onOpenFaq={() => setAppView("faq")}
          onOpenMain={() => setAppView("main")}
          onOpenVouchers={() => setAppView("vouchers")}
          onSaveDailyRankingOrder={saveDailyRankingOrder}
          registeredTeams={registeredTeams}
          sessionData={sessionData}
          sessionId={sessionId}
        />
        {issuedTeamPasswordModal}
      </>
    );
  }

  if (appView === "vouchers") {
    return (
      <>
        <VoucherScreen
          dailyRankingDocs={historicalDailyRankingDocs}
          allVoucherDocs={allVoucherDocs}
          allTeamSessions={allTeamSessions}
          globalRankingRows={globalRankingRows}
          isAdmin={isAdmin}
          onOpenAdmin={() => setAppView("admin")}
          onOpenFaq={() => setAppView("faq")}
          onOpenMain={() => setAppView("main")}
          onOpenRanking={() => setAppView("ranking")}
          pubQuizzes={pubQuizzes}
          sessionData={sessionData}
          teamHistorySessions={teamHistorySessions}
          teamProfiles={teamProfiles}
          teamSessionId={sessionId}
          onSaveHistoricalEventRanking={saveHistoricalEventRanking}
          onUpdateVoucherStatus={updateVoucherStatus}
        />
        {issuedTeamPasswordModal}
      </>
    );
  }

  if (appView === "faq") {
    return (
      <>
        <FaqScreen
          isAdmin={isAdmin}
          message={message}
          onOpenAdmin={() => setAppView("admin")}
          onOpenMain={() => setAppView("main")}
          onOpenRanking={() => setAppView("ranking")}
          onOpenVouchers={() => setAppView("vouchers")}
          onSubmitFeedback={submitFeedback}
          sessionData={sessionData}
        />
        {issuedTeamPasswordModal}
      </>
    );
  }

  if (appView === "admin" && isAdmin && activeManager) {
    return (
      <>
        <AdminScreen
          adminTab={adminTab}
          activeManager={activeManager}
          allTeams={allTeams}
          allTeamSessions={allTeamSessions}
          allVoucherDocs={allVoucherDocs}
          historicalDailyRankingDocs={historicalDailyRankingDocs}
          globalRankingRows={globalRankingRows}
          lobbyData={lobbyData}
          now={now}
          onAddRoundExtraTime={addRoundExtraTime}
          onChangeAdminTab={setAdminTab}
          onCloseNewRegistrations={closeNewRegistrations}
          onCreateVoucherAssignment={createVoucherAssignment}
          onDeletePubQuiz={deletePubQuiz}
          onDeleteVoucherAssignment={deleteVoucherAssignment}
          onOpenAdmin={() => setAppView("admin")}
          onOpenMain={() => setAppView("main")}
          onOpenFaq={() => setAppView("faq")}
          onOpenRanking={() => setAppView("ranking")}
          onLoadPubQuizByCode={loadPubQuizByCode}
          onRevealRoundAnswers={revealRoundAnswers}
          onReopenNewRegistrations={reopenNewRegistrationsForFiveMinutes}
          onSaveManager={saveManager}
          onSaveHistoricalEventRanking={saveHistoricalEventRanking}
          onSavePubQuiz={savePubQuiz}
          onSubmitManagerAnswerForTeam={submitManagerAnswerForTeam}
          onUpdateTeamPodiumExclusion={updateTeamPodiumExclusion}
          onUpdateTeamQuestionScore={updateTeamQuestionScore}
          onUpdateTeamScore={updateTeamScore}
          onStartTiebreaker={startTiebreaker}
          onRoundChange={setActiveRoundId}
          onUnlockRound={unlockRound}
          pubQuizzes={pubQuizzes}
          quizManagerMessage={quizManagerMessage}
          questions={questions}
          quizRounds={quizRounds}
          registeredTeams={registeredTeams}
          feedbackEntries={feedbackEntries}
          managers={managers}
          selectedRound={activeRound}
          sessionData={sessionData}
          teamProfiles={teamProfiles}
          onUpdateVoucherStatus={updateVoucherStatus}
        />
        {issuedTeamPasswordModal}
      </>
    );
  }

  if (!anyRoundUnlocked) {
    return (
      <>
        <WaitingRoomScreen
          canOpenRanking
          isAdmin={isAdmin}
          lobbyCode={sessionData.lobbyCode}
          onOpenAdmin={() => setAppView("admin")}
          onOpenFaq={() => setAppView("faq")}
          onOpenMain={() => setAppView("main")}
          onOpenRanking={() => setAppView("ranking")}
          onOpenVouchers={() => setAppView("vouchers")}
          onRoundChange={setActiveRoundId}
          onUnlockRound={unlockRound}
          quizRounds={quizRounds}
          registeredTeams={registeredTeams}
          selectedRound={activeRound}
          sessionData={sessionData}
        />
        {issuedTeamPasswordModal}
      </>
    );
  }

  return (
    <>
      <QuizScreen
        activeRound={activeRound}
        answerDrafts={answerDrafts}
        allTeamsFinishedFinalRound={allTeamsFinishedFinalRound}
        allTeamsReadyForRanking={allTeamsReadyForRanking}
        lobbyData={lobbyData}
        now={now}
        onAnswerChange={updateAnswerDraft}
        onCheckAnswer={checkAndSaveAnswer}
        onFinalReady={markTeamFinalReady}
        onOpenAdmin={() => setAppView("admin")}
        onOpenFaq={() => setAppView("faq")}
        onOpenMain={() => setAppView("main")}
        onRevealHint={revealHint}
        onOpenRanking={() => setAppView("ranking")}
        onOpenVouchers={() => setAppView("vouchers")}
        onRoundChange={setActiveRoundId}
        onStartTeamRound={startTeamRound}
        onTiebreakerReady={markTeamTiebreakerReady}
        onTiebreakerSubmit={submitTiebreakerEstimate}
        onUnlockRound={unlockRound}
        pointToast={pointToast}
        questions={questions}
        quizRounds={quizRounds}
        isAdmin={isAdmin}
        canOpenRanking
        message={message}
        sessionData={sessionData}
        sessionId={sessionId}
        teamFinalReady={Boolean(lobbyData?.finalReady?.[sessionId])}
        tiebreakerClientId={clientId}
        tiebreakerEligible={tiebreakerState.tiedTeamIds.includes(sessionId)}
        tiebreakerFinalRoundFinished={currentTeamFinishedFinalRound}
      />
      {issuedTeamPasswordModal}
    </>
  );
}

function LobbyScreen({
  canOpenRanking,
  entryMode,
  issuedTeamPassword,
  knownTeamMode,
  isAdmin,
  lobbyCode,
  managerKey,
  managerPassword,
  message,
  onOpenRanking,
  playerName,
  teamPassword,
  teamName,
  onAdminChange,
  onCloseIssuedTeamPassword,
  onEntryModeChange,
  onKnownTeamModeChange,
  onCancelRankingPrompt,
  onConfirmRankingPrompt,
  onJoin,
  onLobbyCodeChange,
  onManagerKeyChange,
  onManagerPasswordChange,
  onPlayerNameChange,
  onTeamPasswordChange,
  onTeamNameChange,
  pendingTeamCreate,
}) {
  const optionCardStyle = (selected) => ({
    padding: 16,
    border: `1px solid ${selected ? "#38bdf8" : "#334155"}`,
    borderRadius: 14,
    background: selected ? "#082f49" : "#0b1220",
    color: "#e5e7eb",
    cursor: "pointer",
    textAlign: "left",
  });

  return (
    <main style={pageStyle}>
      <AppMenu
        canOpenRanking={canOpenRanking}
        isAdmin={isAdmin}
        onOpenRanking={onOpenRanking}
      />
      <section
        style={{
          maxWidth: 560,
          margin: "48px auto",
          padding: 28,
          border: "1px solid #1f2937",
          borderRadius: 16,
          background: "#111827",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 56, textAlign: "center" }}>
          PQDubApp
        </h1>
        <p style={{ color: "#94a3b8", textAlign: "center", fontSize: 18 }}>
          Einstieg wählen, Quiz-Code eingeben und dann entspannt loslegen.
        </p>

        <div style={{ display: "grid", gap: 12, marginTop: 24 }}>
          <button
            type="button"
            onClick={() => {
              onEntryModeChange("manager");
              onAdminChange(true);
            }}
            style={optionCardStyle(entryMode === "manager")}
          >
            <strong style={{ display: "block", fontSize: 20 }}>Manager access</strong>
            <span style={{ color: "#cbd5e1" }}>
              Login für Personal mit Username und Passwort.
            </span>
          </button>

          <div
            style={optionCardStyle(entryMode === "known")}
            onClick={() => {
              onEntryModeChange("known");
              onAdminChange(false);
            }}
          >
            <strong style={{ display: "block", fontSize: 20 }}>Ich kenne mich aus</strong>
            <span style={{ color: "#cbd5e1", display: "block", marginTop: 4 }}>
              Direkter Einstieg für Teams mit oder ohne Jahresranking.
            </span>
            <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
              {[
                ["registered", "Mein Team ist angemeldet", "Mit Teamname und Team-Passwort einloggen."],
                ["guest", "Nur heute", "Tagesteam oder neues Team. Beim ersten Ranking-Opt-in wird ein Passwort erzeugt."],
              ].map(([modeId, title, copy]) => (
                <button
                  key={modeId}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEntryModeChange("known");
                    onAdminChange(false);
                    onKnownTeamModeChange(modeId);
                  }}
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    border: `1px solid ${knownTeamMode === modeId && entryMode === "known" ? "#22c55e" : "#334155"}`,
                    background:
                      knownTeamMode === modeId && entryMode === "known" ? "#052e1a" : "#020617",
                    color: "#e5e7eb",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <strong style={{ display: "block" }}>{title}</strong>
                  <span style={{ color: "#94a3b8" }}>{copy}</span>
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              onEntryModeChange("first-time");
              onAdminChange(false);
            }}
            style={optionCardStyle(entryMode === "first-time")}
          >
            <strong style={{ display: "block", fontSize: 20 }}>Ist mein erstes Mal</strong>
            <span style={{ color: "#cbd5e1" }}>
              App-Tour für neue Teams mit Regeln, Beispielen und Klick-Hinweisen.
            </span>
          </button>
        </div>

        {entryMode === "first-time" && (
          <TutorialGuide
            onSkip={() => {
              onAdminChange(false);
              onEntryModeChange("known");
              onKnownTeamModeChange("guest");
            }}
            onStart={() => {
              onAdminChange(false);
              onEntryModeChange("known");
              onKnownTeamModeChange("guest");
            }}
          />
        )}

        {entryMode !== "first-time" && (
        <form onSubmit={onJoin} style={{ display: "grid", gap: 14, marginTop: 24 }}>
          {entryMode !== "first-time" && !isAdmin && (
            <>
          <label style={{ display: "grid", gap: 8, fontSize: 18 }}>
            Quiz-Code
            <input
              type="text"
              value={lobbyCode}
              onChange={(e) => onLobbyCodeChange(normalizeQuizCode(e.target.value))}
              placeholder="ABC123"
              maxLength={6}
              style={{
                ...inputStyle,
                letterSpacing: 2,
                textTransform: "uppercase",
              }}
            />
          </label>

          <label style={{ display: "grid", gap: 8, fontSize: 18 }}>
            Teamname
            <input
              type="text"
              value={teamName}
              onChange={(e) => onTeamNameChange(e.target.value)}
              placeholder="z. B. Veggie Hack"
              style={inputStyle}
            />
          </label>

          {knownTeamMode === "registered" && (
            <label style={{ display: "grid", gap: 8, fontSize: 18 }}>
              Team-Passwort
              <input
                type="password"
                value={teamPassword}
                onChange={(e) => onTeamPasswordChange(e.target.value)}
                placeholder="4-stellig alfanumerisch"
                maxLength={4}
                style={{
                  ...inputStyle,
                  letterSpacing: 4,
                  textTransform: "uppercase",
                }}
              />
            </label>
          )}

          <label style={{ display: "grid", gap: 8, fontSize: 18 }}>
            Name optional
            <input
              type="text"
              value={playerName}
              onChange={(e) => onPlayerNameChange(e.target.value)}
          placeholder="Leer lassen für Anonym"
              style={inputStyle}
            />
          </label>
            </>
          )}

          {isAdmin && (
            <div
              style={{
                display: "grid",
                gap: 12,
                padding: 14,
                border: "1px solid #334155",
                borderRadius: 12,
                background: "#0b1220",
              }}
            >
              <label style={{ display: "grid", gap: 8, fontSize: 18 }}>
                Name
                <input
                  type="text"
                  value={managerKey}
                  onChange={(e) =>
                    onManagerKeyChange(normalizeManagerKey(e.target.value))
                  }
                  placeholder="z. B. Lea"
                  style={inputStyle}
                />
              </label>
              <label style={{ display: "grid", gap: 8, fontSize: 18 }}>
                Persönliches Passwort
                <input
                  type="password"
                  value={managerPassword}
                  onChange={(e) => onManagerPasswordChange(e.target.value)}
                  placeholder="Manager-Passwort"
                  style={inputStyle}
                />
              </label>
            </div>
          )}

          <button
            type="submit"
            disabled={entryMode === "first-time"}
            style={{
              padding: 14,
              borderRadius: 12,
              border: "none",
              background: entryMode === "first-time" ? "#334155" : "#22c55e",
              color: entryMode === "first-time" ? "#94a3b8" : "#0b1220",
              fontWeight: 700,
              fontSize: 18,
              cursor: entryMode === "first-time" ? "not-allowed" : "pointer",
            }}
          >
            {isAdmin
              ? "Manager einloggen"
              : knownTeamMode === "registered"
              ? "Mit Passwort einloggen"
              : "Team beitreten"}
          </button>
        </form>
        )}

        {message && (
          <p
            style={{
              marginTop: 20,
              color: "#93c5fd",
              textAlign: "center",
              fontSize: 18,
            }}
          >
            {message}
          </p>
        )}

        {pendingTeamCreate && (
          <RankingPromptModal
            teamName={pendingTeamCreate.cleanedName}
            onCancel={onCancelRankingPrompt}
            onSelect={onConfirmRankingPrompt}
          />
        )}

        {issuedTeamPassword && (
          <TeamPasswordModal
            isLegacy={issuedTeamPassword.isLegacy}
            password={issuedTeamPassword.password}
            teamName={issuedTeamPassword.teamName}
            onClose={onCloseIssuedTeamPassword}
          />
        )}
      </section>
    </main>
  );
}

function MobileLobbyScreen({
  canOpenRanking,
  entryMode,
  issuedTeamPassword,
  knownTeamMode,
  isAdmin,
  lobbyCode,
  managerKey,
  managerPassword,
  message,
  onOpenRanking,
  playerName,
  teamPassword,
  teamName,
  onAdminChange,
  onCloseIssuedTeamPassword,
  onEntryModeChange,
  onKnownTeamModeChange,
  onCancelRankingPrompt,
  onConfirmRankingPrompt,
  onJoin,
  onLobbyCodeChange,
  onManagerKeyChange,
  onManagerPasswordChange,
  onPlayerNameChange,
  onTeamPasswordChange,
  onTeamNameChange,
  pendingTeamCreate,
}) {
  const cardStyle = (accent) => ({
    padding: 18,
    borderRadius: 22,
    border: `1px solid ${accent}`,
    background: "rgba(8, 15, 30, 0.78)",
    color: "#f8fafc",
    textAlign: "left",
    cursor: "pointer",
  });
  const screenStyle = {
    width: "min(100%, 460px)",
    margin: "0 auto",
    padding: 24,
    borderRadius: 28,
    border: "1px solid rgba(148, 163, 184, 0.18)",
    background:
      "linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(17, 24, 39, 0.98))",
    boxShadow: "0 30px 80px rgba(2, 6, 23, 0.42)",
  };
  const secondaryButtonStyle = {
    minHeight: 46,
    padding: "12px 14px",
    borderRadius: 16,
    border: "1px solid rgba(148, 163, 184, 0.2)",
    background: "rgba(8, 15, 30, 0.7)",
    color: "#cbd5e1",
    fontWeight: 700,
    cursor: "pointer",
  };
  const primaryButtonStyle = {
    width: "100%",
    minHeight: 56,
    padding: "14px 18px",
    borderRadius: 18,
    border: "none",
    background: "linear-gradient(135deg, #22c55e, #14b8a6)",
    color: "#04111f",
    fontWeight: 800,
    fontSize: 18,
    cursor: "pointer",
  };
  const titleStyle = {
    margin: 0,
    fontSize: 48,
    lineHeight: 0.96,
    letterSpacing: "-0.045em",
    textAlign: "left",
  };
  const selectedKnownCopy =
    knownTeamMode === "registered"
      ? {
          eyebrow: "Jahresranking",
          title: "Mein Team ist angemeldet",
          description:
            "Mit Teamname und 4-stelligem Passwort einloggen. Schnell, klar und ohne unnötige Extras.",
          submitLabel: "Mit Passwort einloggen",
        }
      : {
          eyebrow: "Tagesmodus",
          title: "Nur heute",
          description:
            "Für Teams ohne Jahresranking oder für neue Teams. Wenn ihr später mitmacht, wird euer Team-Passwort automatisch erstellt.",
          submitLabel: "Als Team starten",
        };
  const showPicker = entryMode === "picker";

  return (
    <main style={pageStyle}>
      <AppMenu
        canOpenRanking={canOpenRanking}
        isAdmin={isAdmin}
        onOpenRanking={onOpenRanking}
      />

      <section style={{ width: "100%", maxWidth: 520, margin: "0 auto" }}>
        <div style={{ marginBottom: 18, padding: "0 6px", textAlign: "left" }}>
          <p
            style={{
              marginBottom: 10,
              color: "#86efac",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Dublin Pub Quiz
          </p>
          <h1 style={titleStyle}>PQDubApp</h1>
          <p style={{ marginTop: 10, color: "#cbd5e1", fontSize: 18, lineHeight: 1.45 }}>
            Ruhiger Start, klare Schritte und genug Platz für Handybildschirme.
          </p>
        </div>

        <section style={screenStyle}>
          {showPicker ? (
            <>
              <p style={{ margin: 0, color: "#93c5fd", fontWeight: 700 }}>Start</p>
              <h2 style={{ marginTop: 8, fontSize: 30 }}>Wie möchtet ihr starten?</h2>
              <p style={{ color: "#94a3b8", lineHeight: 1.5 }}>
                Jede Option öffnet danach einen eigenen, einfachen Bildschirm.
              </p>

              <div style={{ display: "grid", gap: 14, marginTop: 22 }}>
                <button
                  type="button"
                  onClick={() => {
                    onEntryModeChange("known");
                    onAdminChange(false);
                    onKnownTeamModeChange("registered");
                  }}
                  style={cardStyle("rgba(56, 189, 248, 0.28)")}
                >
                  <span style={{ display: "block", color: "#7dd3fc", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                    Teams
                  </span>
                  <strong style={{ display: "block", marginTop: 8, fontSize: 24 }}>
                    Ich kenne mich aus
                  </strong>
                  <span style={{ display: "block", marginTop: 8, color: "#cbd5e1", lineHeight: 1.45 }}>
                    {repairMojibake(
                      "Für Teams mit Jahresranking oder Teams, die nur heute mitmachen.",
                    )}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onEntryModeChange("manager");
                    onAdminChange(true);
                  }}
                  style={cardStyle("rgba(245, 158, 11, 0.28)")}
                >
                  <span style={{ display: "block", color: "#fcd34d", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                    Personal
                  </span>
                  <strong style={{ display: "block", marginTop: 8, fontSize: 24 }}>
                    Manager access
                  </strong>
                  <span style={{ display: "block", marginTop: 8, color: "#cbd5e1", lineHeight: 1.45 }}>
                    {repairMojibake("Login für Personal mit Username und Passwort.")}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onEntryModeChange("first-time");
                    onAdminChange(false);
                  }}
                  style={cardStyle("rgba(167, 139, 250, 0.28)")}
                >
                  <span style={{ display: "block", color: "#c4b5fd", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                    Neu dabei
                  </span>
                  <strong style={{ display: "block", marginTop: 8, fontSize: 24 }}>
                    Ist mein erstes Mal
                  </strong>
                  <span style={{ display: "block", marginTop: 8, color: "#cbd5e1", lineHeight: 1.45 }}>
                    App-Tour für neue Teams mit Regeln, Beispielen und Klick-Hinweisen.
                  </span>
                </button>
              </div>
            </>
          ) : entryMode === "manager" ? (
            <>
              <button type="button" onClick={() => onEntryModeChange("picker")} style={secondaryButtonStyle}>
                Zurück
              </button>
              <p style={{ margin: "18px 0 0", color: "#fcd34d", fontWeight: 700 }}>Personal</p>
              <h2 style={{ marginTop: 8, fontSize: 30 }}>Manager access</h2>
              <p style={{ color: "#94a3b8", lineHeight: 1.5 }}>
                {repairMojibake("Nur die beiden Felder, die das Personal wirklich braucht.")}
              </p>
              <form onSubmit={onJoin} style={{ display: "grid", gap: 14, marginTop: 22 }}>
                <label style={{ display: "grid", gap: 8, fontSize: 15, color: "#cbd5e1" }}>
                  Username
                  <input
                    type="text"
                    value={managerKey}
                    onChange={(e) => onManagerKeyChange(normalizeManagerKey(e.target.value))}
                    placeholder="z. B. lea"
                    style={inputStyle}
                  />
                </label>
                <label style={{ display: "grid", gap: 8, fontSize: 15, color: "#cbd5e1" }}>
                  {repairMojibake("Persönliches Passwort")}
                  <input
                    type="password"
                    value={managerPassword}
                    onChange={(e) => onManagerPasswordChange(e.target.value)}
                    placeholder="Manager-Passwort"
                    style={inputStyle}
                  />
                </label>
                <button type="submit" style={primaryButtonStyle}>
                  Manager einloggen
                </button>
              </form>
            </>
          ) : entryMode === "first-time" ? (
            <>
              <button type="button" onClick={() => onEntryModeChange("picker")} style={secondaryButtonStyle}>
                Zurück
              </button>
              <p style={{ margin: "18px 0 0", color: "#c4b5fd", fontWeight: 700 }}>Neu dabei</p>
              <h2 style={{ marginTop: 8, fontSize: 30 }}>Tutorial-Modus</h2>
              <p style={{ color: "#cbd5e1", lineHeight: 1.6 }}>
                Eine kleine Tour durch die App: wo du drückst, was du wo findest und welche Regeln wichtig sind.
              </p>
              <TutorialGuide
                compact
                onSkip={() => {
                  onEntryModeChange("known");
                  onKnownTeamModeChange("guest");
                }}
                onStart={() => {
                  onEntryModeChange("known");
                  onKnownTeamModeChange("guest");
                }}
              />
            </>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
                <button type="button" onClick={() => onEntryModeChange("picker")} style={secondaryButtonStyle}>
                  Zurück
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onKnownTeamModeChange(knownTeamMode === "registered" ? "guest" : "registered")
                  }
                  style={secondaryButtonStyle}
                >
                  {knownTeamMode === "registered" ? "Zu Nur heute" : "Zu Mein Team ist angemeldet"}
                </button>
              </div>

              <p style={{ margin: 0, color: "#7dd3fc", fontWeight: 700 }}>
                {selectedKnownCopy.eyebrow}
              </p>
              <h2 style={{ marginTop: 8, fontSize: 30 }}>
                {repairMojibake(selectedKnownCopy.title)}
              </h2>
              <p style={{ color: "#94a3b8", lineHeight: 1.55 }}>
                {repairMojibake(selectedKnownCopy.description)}
              </p>

              <form onSubmit={onJoin} style={{ display: "grid", gap: 14, marginTop: 22 }}>
                <label style={{ display: "grid", gap: 8, fontSize: 15, color: "#cbd5e1" }}>
                  Quiz-Code
                  <input
                    type="text"
                    value={lobbyCode}
                    onChange={(e) => onLobbyCodeChange(normalizeQuizCode(e.target.value))}
                    placeholder="ABC123"
                    maxLength={6}
                    style={{ ...inputStyle, letterSpacing: 2, textTransform: "uppercase" }}
                  />
                </label>

                <label style={{ display: "grid", gap: 8, fontSize: 15, color: "#cbd5e1" }}>
                  Teamname
                  <input
                    type="text"
                    value={teamName}
                    onChange={(e) => onTeamNameChange(e.target.value)}
                    placeholder="z. B. Veggie Hack"
                    style={inputStyle}
                  />
                </label>

                {knownTeamMode === "registered" && (
                  <label style={{ display: "grid", gap: 8, fontSize: 15, color: "#cbd5e1" }}>
                    {repairMojibake("Team-Passwort")}
                    <input
                      type="password"
                      value={teamPassword}
                      onChange={(e) => onTeamPasswordChange(e.target.value)}
                      placeholder="4-stellig alfanumerisch"
                      maxLength={4}
                      style={{ ...inputStyle, letterSpacing: 4, textTransform: "uppercase" }}
                    />
                  </label>
                )}

                <label style={{ display: "grid", gap: 8, fontSize: 15, color: "#cbd5e1" }}>
                  Dein Name
                  <input
                    type="text"
                    value={playerName}
                    onChange={(e) => onPlayerNameChange(e.target.value)}
                    placeholder="Optional, sonst anonym"
                    style={inputStyle}
                  />
                </label>

                <button type="submit" style={primaryButtonStyle}>
                  {repairMojibake(selectedKnownCopy.submitLabel)}
                </button>
              </form>
            </>
          )}

          {message && (
            <div
              style={{
                marginTop: 18,
                padding: 14,
                borderRadius: 16,
                border: "1px solid rgba(125, 211, 252, 0.28)",
                background: "rgba(8, 47, 73, 0.42)",
                color: "#dbeafe",
                lineHeight: 1.5,
              }}
            >
              {repairMojibake(message)}
            </div>
          )}
        </section>

        {pendingTeamCreate && (
          <RankingPromptModal
            teamName={pendingTeamCreate.cleanedName}
            onCancel={onCancelRankingPrompt}
            onSelect={onConfirmRankingPrompt}
          />
        )}

        {issuedTeamPassword && (
          <TeamPasswordModal
            isLegacy={issuedTeamPassword.isLegacy}
            password={issuedTeamPassword.password}
            teamName={issuedTeamPassword.teamName}
            onClose={onCloseIssuedTeamPassword}
          />
        )}
      </section>
    </main>
  );
}

function RankingPromptModal({ teamName, onCancel, onSelect }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10,
        display: "grid",
        placeItems: "center",
        padding: 20,
        background: "rgba(2, 6, 23, 0.78)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ranking-prompt-title"
        style={{
          width: "min(440px, 100%)",
          padding: 22,
          border: "1px solid #334155",
          borderRadius: 16,
          background: "#111827",
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.45)",
        }}
      >
        <h2 id="ranking-prompt-title" style={{ margin: 0, fontSize: 24 }}>
          Jahresranking?
        </h2>
        <p style={{ color: "#cbd5e1", fontSize: 17, lineHeight: 1.45 }}>
          Das Team "{teamName}" ist noch nicht registriert. Möchtet ihr am
          globalen Jahresranking teilnehmen?
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 20,
            flexWrap: "wrap",
          }}
        >
          <button onClick={onCancel}>Abbrechen</button>
          <button onClick={() => onSelect(false)}>Nein</button>
          <button
            onClick={() => onSelect(true)}
            style={{
              background: "#22c55e",
              border: "none",
              color: "#0b1220",
              fontWeight: 700,
              padding: "8px 12px",
            }}
          >
            Ja, mitmachen
          </button>
        </div>
      </div>
    </div>
  );
}

function TeamPasswordModal({ isLegacy, password, teamName, onClose }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(password || "");
      setCopied(true);
    } catch (error) {
      console.error("COPY TEAM PASSWORD ERROR:", error);
      setCopied(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 12,
        display: "grid",
        placeItems: "center",
        padding: 20,
        background: "rgba(2, 6, 23, 0.82)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(420px, 100%)",
          padding: 24,
          border: "1px solid #22c55e",
          borderRadius: 16,
          background: "#052e1a",
          color: "#dcfce7",
        }}
      >
        <h2 style={{ marginTop: 0 }}>
          {isLegacy ? "Neues Team-Passwort" : "Team-Passwort sichern"}
        </h2>
        <p style={{ lineHeight: 1.5 }}>
          {teamName} {isLegacy
            ? "war schon im Jahresranking. Ab jetzt meldet ihr euch mit diesem Passwort an:"
            : "ist jetzt im Jahresranking. Dieses Passwort braucht ihr ab dem nächsten Login:"}
        </p>
        <div
          style={{
            marginTop: 14,
            padding: "14px 16px",
            borderRadius: 14,
            border: "1px solid #86efac",
            background: "#022c22",
            color: "#f0fdf4",
            fontSize: 30,
            fontWeight: 800,
            letterSpacing: 8,
            textAlign: "center",
          }}
        >
          {password}
        </div>
        <p style={{ margin: "12px 0 0", color: "#bbf7d0", lineHeight: 1.45 }}>
          Bitte jetzt direkt sichern. Dieses Passwort wird fuer spaetere Logins im
          Jahresranking gebraucht.
        </p>
        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            marginTop: 18,
          }}
        >
          <button
            type="button"
            onClick={handleCopy}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid #86efac",
              background: "#022c22",
              color: "#dcfce7",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {copied ? "Kopiert" : "Passwort kopieren"}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "none",
              background: "#22c55e",
              color: "#052e1a",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Verstanden
          </button>
        </div>
      </div>
    </div>
  );
}

const tutorialSteps = [
  {
    eyebrow: "Startbildschirm",
    title: "Hier wählst du deinen Einstieg",
    body:
      "Auf dem ersten Bildschirm siehst du drei Wege: Team-Login, Manager access und den Einsteiger-Modus. Als neues Team gehst du später meist über „Nur heute“ weiter.",
    bullets: [
      "Tippe auf „Ist mein erstes Mal“, wenn du diese Tour sehen willst.",
      "Tippe auf „Ich kenne mich aus“, wenn du direkt spielen willst.",
      "Manager access ist nur für das Personal.",
    ],
    mockup: "entry",
  },
  {
    eyebrow: "Anmeldung",
    title: "So füllst du den Team-Login aus",
    body:
      "Danach gibst du Quiz-Code, Teamname und optional deinen Namen ein. Ranking-Teams sehen zusätzlich ein Feld für das Team-Passwort.",
    bullets: [
      "Neue Teams starten am einfachsten über „Nur heute“.",
      "Bestehende Jahresranking-Teams nehmen „Mein Team ist angemeldet“.",
      "Wenn ihr neu ins Jahresranking geht, bekommt ihr später ein Passwort angezeigt.",
    ],
    mockup: "login",
  },
  {
    eyebrow: "Lobby",
    title: "Hier wartest du auf die Freischaltung",
    body:
      "Nach dem Join landet ihr in der Lobby. Dort seht ihr euer Team, die Runden und später die Buttons zum Starten.",
    bullets: [
      "Das Personal schaltet jede Runde frei.",
      "Erst dann kannst du deinen Team-Timer starten.",
      "Das Ranking und die FAQ findest du auch über das Menü links oben.",
    ],
    mockup: "lobby",
  },
  {
    eyebrow: "Runde spielen",
    title: "Hier drückst du zum Starten und Antworten",
    body:
      "Sobald eine Runde freigeschaltet ist, startet euer Team die Runde selbst. Wenn ihr nicht startet, läuft die Zeit nach 10 Minuten automatisch los.",
    bullets: [
      "Jedes Team hat seinen eigenen Timer.",
      "Fragen 1 bis 5 geben normalerweise 1 Punkt, Frage 6 gibt 2 Punkte.",
      "Richtige Antworten werden gespeichert und dann gesperrt.",
    ],
    mockup: "quiz",
  },
  {
    eyebrow: "Hinweise & Ranking",
    title: "Wichtige Regeln während des Abends",
    body:
      "Hinweise sind begrenzt und nicht jede Frage hat einen eingepflegten Tipp. Das Tagesranking zeigt alle Teams des Abends, das Jahresranking nur Teams mit Opt-in.",
    bullets: [
      "Frage 6 hat keinen Hinweis.",
      "Maximal sind 21 Punkte im Quiz möglich.",
      "Die Schätzfrage erscheint nur bei Gleichstand um Platz 1 bis 3.",
    ],
    mockup: "ranking",
  },
  {
    eyebrow: "Los geht's",
    title: "Jetzt findest du dich in der App zurecht",
    body:
      "Du kannst dieses Tutorial jederzeit überspringen. Danach landest du direkt im normalen Team-Start und kannst mit dem Quiz-Code loslegen.",
    bullets: [
      "Am einfachsten startest du zuerst über „Nur heute“.",
      "Alles Wichtige kannst du später auch wieder in der FAQ nachlesen.",
      "Wenn ihr ins Jahresranking wollt, bekommt ihr euer Team-Passwort direkt angezeigt.",
    ],
    mockup: "finish",
  },
];

function TutorialMockup({ type }) {
  const frameStyle = {
    padding: 14,
    borderRadius: 18,
    border: "1px solid rgba(148, 163, 184, 0.18)",
    background: "linear-gradient(180deg, rgba(15, 23, 42, 0.94), rgba(2, 6, 23, 0.96))",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
  };
  const chipStyle = (active = false) => ({
    padding: "8px 10px",
    borderRadius: 999,
    border: `1px solid ${active ? "#38bdf8" : "#334155"}`,
    background: active ? "#082f49" : "#020617",
    color: active ? "#e0f2fe" : "#cbd5e1",
    fontWeight: 700,
    fontSize: 12,
  });
  const cardStyle = (accent) => ({
    padding: 12,
    borderRadius: 14,
    border: `1px solid ${accent}`,
    background: "rgba(8, 15, 30, 0.82)",
  });

  if (type === "entry") {
    return (
      <div style={frameStyle}>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={cardStyle("rgba(56, 189, 248, 0.3)")}>
            <strong>Ich kenne mich aus</strong>
            <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 13 }}>
              Für Teams mit oder ohne Jahresranking
            </p>
          </div>
          <div style={cardStyle("rgba(245, 158, 11, 0.3)")}>
            <strong>Manager access</strong>
            <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 13 }}>
              Nur für das Personal
            </p>
          </div>
          <div style={cardStyle("rgba(196, 181, 253, 0.34)")}>
            <strong>Ist mein erstes Mal</strong>
            <p style={{ margin: "6px 0 0", color: "#cbd5e1", fontSize: 13 }}>
              Hier tippen für die Tour
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (type === "login") {
    return (
      <div style={frameStyle}>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ ...cardStyle("rgba(148, 163, 184, 0.2)"), color: "#cbd5e1" }}>Quiz-Code: `ABC123`</div>
          <div style={{ ...cardStyle("rgba(148, 163, 184, 0.2)"), color: "#cbd5e1" }}>Teamname: `Quizzer`</div>
          <div style={{ ...cardStyle("rgba(34, 197, 94, 0.28)"), color: "#dcfce7" }}>Button: `Als Team starten`</div>
        </div>
      </div>
    );
  }

  if (type === "lobby") {
    return (
      <div style={frameStyle}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <span style={chipStyle(true)}>Runde 1</span>
          <span style={chipStyle(false)}>Runde 2</span>
          <span style={chipStyle(false)}>Runde 3</span>
        </div>
        <div style={cardStyle("rgba(56, 189, 248, 0.24)")}>
          <strong>Lobby</strong>
          <p style={{ margin: "8px 0 0", color: "#cbd5e1", fontSize: 13 }}>
            Hier wartet ihr, bis das Personal die Runde freischaltet.
          </p>
        </div>
      </div>
    );
  }

  if (type === "quiz") {
    return (
      <div style={frameStyle}>
        <div style={{ ...cardStyle("rgba(34, 197, 94, 0.24)"), marginBottom: 10 }}>
          <strong>Runde 1: Im Nachtclub</strong>
          <p style={{ margin: "8px 0 0", color: "#cbd5e1", fontSize: 13 }}>
            Hier drückst du auf `Runde starten`.
          </p>
        </div>
        <div style={{ ...cardStyle("rgba(148, 163, 184, 0.2)"), color: "#cbd5e1" }}>
          Frage 1
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "#94a3b8" }}>
            Antwort eingeben → prüfen → speichern
          </p>
        </div>
      </div>
    );
  }

  if (type === "ranking") {
    return (
      <div style={frameStyle}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <span style={chipStyle(true)}>Tagesranking</span>
          <span style={chipStyle(false)}>Jahresranking</span>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={cardStyle("rgba(148, 163, 184, 0.18)")}>1. Team A — 21 Pkt.</div>
          <div style={cardStyle("rgba(148, 163, 184, 0.18)")}>2. Team B — 21 Pkt.</div>
          <div style={cardStyle("rgba(148, 163, 184, 0.18)")}>3. Team C — 20 Pkt.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={frameStyle}>
      <div style={{ ...cardStyle("rgba(34, 197, 94, 0.24)"), color: "#dcfce7" }}>
        <strong>Bereit zum Start</strong>
        <p style={{ margin: "8px 0 0", color: "#cbd5e1", fontSize: 13 }}>
          Danach wechselst du direkt in den normalen Team-Start.
        </p>
      </div>
    </div>
  );
}

function TutorialGuide({
  compact = false,
  onSkip,
  onStart,
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const step = tutorialSteps[stepIndex];
  const isLastStep = stepIndex === tutorialSteps.length - 1;

  return (
    <div
      style={{
        display: "grid",
        gap: compact ? 16 : 18,
        marginTop: compact ? 18 : 24,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            color: "#c4b5fd",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontSize: 12,
          }}
        >
          {step.eyebrow}
        </span>
        <span style={{ color: "#94a3b8", fontSize: 14 }}>
          Schritt {stepIndex + 1} / {tutorialSteps.length}
        </span>
      </div>

      <div
        style={{
          padding: compact ? 16 : 18,
          borderRadius: compact ? 18 : 16,
          border: "1px solid rgba(196, 181, 253, 0.28)",
          background: compact ? "rgba(76, 29, 149, 0.18)" : "#0b1220",
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: 10, fontSize: compact ? 24 : 28 }}>
          {step.title}
        </h3>
        <p style={{ marginTop: 0, color: "#d1d5db", lineHeight: 1.6 }}>
          {step.body}
        </p>
        <TutorialMockup type={step.mockup} />
        <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
          {step.bullets.map((bullet) => (
            <div
              key={bullet}
              style={{
                display: "grid",
                gridTemplateColumns: "18px 1fr",
                gap: 10,
                alignItems: "start",
                color: "#cbd5e1",
              }}
            >
              <span style={{ color: "#86efac", fontWeight: 800 }}>•</span>
              <span style={{ lineHeight: 1.5 }}>{bullet}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
          disabled={stepIndex === 0}
          style={{
            padding: "10px 14px",
            borderRadius: 14,
            border: "1px solid #334155",
            background: stepIndex === 0 ? "#111827" : "#020617",
            color: stepIndex === 0 ? "#64748b" : "#cbd5e1",
            fontWeight: 700,
            cursor: stepIndex === 0 ? "not-allowed" : "pointer",
          }}
        >
          Zurück
        </button>
        <button
          type="button"
          onClick={() =>
            isLastStep
              ? onStart?.()
              : setStepIndex((current) => Math.min(tutorialSteps.length - 1, current + 1))
          }
          style={{
            padding: "10px 14px",
            borderRadius: 14,
            border: "none",
            background: "linear-gradient(135deg, #22c55e, #14b8a6)",
            color: "#04111f",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          {isLastStep ? "Jetzt starten" : "Weiter"}
        </button>
        <button
          type="button"
          onClick={onSkip}
          style={{
            padding: "10px 14px",
            borderRadius: 14,
            border: "1px solid rgba(148, 163, 184, 0.24)",
            background: "transparent",
            color: "#94a3b8",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Tutorial überspringen
        </button>
      </div>
    </div>
  );
}

function AppMenu({
  canOpenRanking = true,
  isAdmin = false,
  onOpenAdmin,
  onOpenFaq,
  onOpenMain,
  onOpenRanking,
  onOpenVouchers,
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        left: 16,
        zIndex: 20,
      }}
    >
      <button
        aria-label="Menü öffnen"
        onClick={() => setOpen((current) => !current)}
        style={{
          width: 40,
          height: 40,
          display: "grid",
          placeItems: "center",
          borderRadius: 10,
          border: "1px solid #334155",
          background: "#111827",
          color: "#e5e7eb",
          fontSize: 22,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        <span
          style={{
            display: "grid",
            gap: 4,
            justifyContent: "center",
          }}
        >
          <span style={{ width: 18, height: 2, background: "currentColor" }} />
          <span style={{ width: 18, height: 2, background: "currentColor" }} />
          <span style={{ width: 18, height: 2, background: "currentColor" }} />
        </span>
      </button>

      {open && (
        <div
          style={{
            minWidth: 180,
            marginTop: 8,
            padding: 8,
            border: "1px solid #334155",
            borderRadius: 12,
            background: "#111827",
            boxShadow: "0 18px 48px rgba(0, 0, 0, 0.35)",
          }}
        >
          {onOpenMain && (
            <button
              onClick={() => {
                setOpen(false);
                onOpenMain();
              }}
              style={{
                width: "100%",
                padding: "10px 12px",
                border: "none",
                borderRadius: 8,
                background: "#0b1220",
                color: "#e5e7eb",
                fontWeight: 700,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              Quiz
            </button>
          )}
          <button
            disabled={!canOpenRanking}
            onClick={() => {
              if (!canOpenRanking) return;
              setOpen(false);
              onOpenRanking();
            }}
            style={{
              width: "100%",
              padding: "10px 12px",
              border: "none",
              borderRadius: 8,
              background: "#0b1220",
              color: canOpenRanking ? "#e5e7eb" : "#64748b",
              fontWeight: 700,
              textAlign: "left",
              cursor: canOpenRanking ? "pointer" : "not-allowed",
              marginTop: onOpenMain ? 8 : 0,
            }}
          >
            Ranking
          </button>
          {onOpenVouchers && (
            <button
              onClick={() => {
                setOpen(false);
                onOpenVouchers();
              }}
              style={{
                width: "100%",
                padding: "10px 12px",
                border: "none",
                borderRadius: 8,
                background: "#0b1220",
                color: "#e5e7eb",
                fontWeight: 700,
                textAlign: "left",
                cursor: "pointer",
                marginTop: 8,
              }}
            >
              Gutscheine
            </button>
          )}
          {onOpenFaq && (
            <button
              onClick={() => {
                setOpen(false);
                onOpenFaq();
              }}
              style={{
                width: "100%",
                padding: "10px 12px",
                border: "none",
                borderRadius: 8,
                background: "#0b1220",
                color: "#e5e7eb",
                fontWeight: 700,
                textAlign: "left",
                cursor: "pointer",
                marginTop: 8,
              }}
            >
              FAQ
            </button>
          )}
          {isAdmin && onOpenAdmin && (
            <button
              onClick={() => {
                setOpen(false);
                onOpenAdmin?.();
              }}
              style={{
                width: "100%",
                padding: "10px 12px",
                border: "none",
                borderRadius: 8,
                background: "#0b1220",
                color: "#e5e7eb",
                fontWeight: 700,
                textAlign: "left",
                cursor: "pointer",
                marginTop: 8,
              }}
            >
              Personal
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RankingScreen({
  allTeams,
  dailyRankingRows,
  globalRankingRows,
  isAdmin,
  lobbyData,
  onCreateRankingVouchers,
  onOpenAdmin,
  onOpenFaq,
  onOpenMain,
  onOpenVouchers,
  onSaveDailyRankingOrder,
  registeredTeams,
  sessionData,
  sessionId,
}) {
  const [rankingTab, setRankingTab] = useState("daily");
  const [draftDailyOrderTeamIds, setDraftDailyOrderTeamIds] = useState([]);
  const [rankingMessage, setRankingMessage] = useState("");
  const [rankingActionBusy, setRankingActionBusy] = useState(false);
  const isNarrow = useIsNarrowScreen();
  const dailyRanking = getDailyRankingWithTiebreakers(registeredTeams, lobbyData);
  const fallbackDailyRows = useMemo(
    () => buildDailyRankingRows(registeredTeams, lobbyData),
    [registeredTeams, lobbyData],
  );
  const persistedDailyRows = useMemo(
    () => (dailyRankingRows?.length > 0 ? dailyRankingRows : fallbackDailyRows),
    [dailyRankingRows, fallbackDailyRows],
  );
  const yearlyTeams =
    globalRankingRows?.length > 0
      ? globalRankingRows.map((row) => ({
          id: row.teamId,
          teamName: row.teamName,
          totalPoints: row.totalGlobalPoints || 0,
          totalQuizPoints: row.totalDailyPoints || 0,
          sessions: row.gamesPlayed || 0,
        }))
      : aggregateYearlyRanking(allTeams || registeredTeams);
  const persistedDailyOrderTeamIds = useMemo(
    () => persistedDailyRows.map((row) => row.teamId),
    [persistedDailyRows],
  );
  const editableDailyRows = useMemo(
    () =>
      draftDailyOrderTeamIds.length > 0
        ? applyManualRankingOrder(persistedDailyRows, draftDailyOrderTeamIds)
        : persistedDailyRows,
    [draftDailyOrderTeamIds, persistedDailyRows],
  );
  const dailyTeams = useMemo(
    () =>
      editableDailyRows.map((row) => ({
        id: row.teamId,
        teamId: row.teamId,
        teamName: row.teamName,
        totalPoints: Number(row.totalPoints) || 0,
        tiebreakerEstimate:
          row.tiebreakerEstimate ?? getEstimateValue(lobbyData, row.teamId),
        tiebreakerDistance:
          row.tiebreakerDistance ?? getTiebreakerDistance(lobbyData, row.teamId),
      })),
    [editableDailyRows, lobbyData],
  );
  const visibleYearlyTeams = yearlyTeams.filter(
    (team) => !isHiddenFromYearlyRanking(team.id || team.teamName),
  );
  const rankingTeams = rankingTab === "daily" ? dailyTeams : visibleYearlyTeams;
  const hasUnsavedDailyOrder =
    editableDailyRows.map((row) => row.teamId).join("|") !==
    persistedDailyOrderTeamIds.join("|");
  const hasDailyPodiumTie = dailyRanking.tieGroups.length > 0;
  const currentTeamIsTiebreakerEligible = dailyRanking.tieGroups.some((group) =>
    group.teams.some((team) => team.id === sessionId),
  );
  const hasTiebreakerAnswer = Number.isFinite(Number(lobbyData?.tiebreakerAnswer));
  const currentTeamRank =
    dailyTeams.findIndex((team) => team.id === sessionId) + 1;
  const currentTeamSubmission = getTiebreakerSubmission(lobbyData, sessionId);

  function moveDailyTeam(teamId, direction) {
    setDraftDailyOrderTeamIds((currentDraft) => {
      const currentOrder =
        currentDraft.length > 0 ? [...currentDraft] : [...persistedDailyOrderTeamIds];
      const currentIndex = currentOrder.findIndex((currentTeamId) => currentTeamId === teamId);
      if (currentIndex === -1) return currentDraft;

      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= currentOrder.length) return currentDraft;

      const [movedTeamId] = currentOrder.splice(currentIndex, 1);
      currentOrder.splice(nextIndex, 0, movedTeamId);

      return currentOrder;
    });
  }

  async function handleSaveDailyRankingOrder() {
    if (!onSaveDailyRankingOrder) return;

    setRankingActionBusy(true);
    const result = await onSaveDailyRankingOrder(
      editableDailyRows.map((row) => row.teamId),
    );
    setRankingActionBusy(false);
    if (result.ok) {
      setDraftDailyOrderTeamIds([]);
    }
    setRankingMessage(result.message || "");
  }

  async function handleCreateRankingVouchers() {
    if (!onCreateRankingVouchers) return;

    setRankingActionBusy(true);
    const result = await onCreateRankingVouchers(
      editableDailyRows.map((row) => row.teamId),
    );
    setRankingActionBusy(false);
    if (result.ok) {
      setDraftDailyOrderTeamIds([]);
    }
    setRankingMessage(result.message || "");
  }

  return (
    <main style={pageStyle}>
      <style>{`
        @keyframes pq-confetti-fall {
          0% { transform: translateY(-20px) rotate(0deg); opacity: 1; }
          100% { transform: translateY(130px) rotate(280deg); opacity: 0; }
        }
      `}</style>
      <AppMenu
        canOpenRanking
        isAdmin={isAdmin}
        onOpenAdmin={onOpenAdmin}
        onOpenFaq={onOpenFaq}
        onOpenMain={onOpenMain}
        onOpenRanking={() => {}}
        onOpenVouchers={onOpenVouchers}
      />
      <section
        style={{
          maxWidth: 760,
          margin: "40px auto",
          padding: 28,
          border: "1px solid #1f2937",
          borderRadius: 16,
          background: "#111827",
        }}
      >
        <p style={{ marginTop: 22, color: "#93c5fd", fontWeight: 700 }}>
          Lobby {sessionData.lobbyCode}
        </p>
        <h1 style={{ margin: "8px 0 16px", fontSize: 42 }}>Ranking</h1>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
          {[
            ["daily", "Tagesranking"],
            ["yearly", "Jahresranking"],
          ].map(([tabId, label]) => {
            const isSelected = rankingTab === tabId;

            return (
              <button
                key={tabId}
                onClick={() => setRankingTab(tabId)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 999,
                  border: `1px solid ${isSelected ? "#38bdf8" : "#334155"}`,
                  background: isSelected ? "#082f49" : "#020617",
                  color: isSelected ? "#e0f2fe" : "#cbd5e1",
                  fontWeight: 700,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {isAdmin && rankingTab === "daily" && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "center",
              marginBottom: 18,
            }}
          >
            <button
              onClick={handleSaveDailyRankingOrder}
              disabled={rankingActionBusy || !hasUnsavedDailyOrder}
              style={{
                padding: "10px 14px",
                borderRadius: 12,
                border: "1px solid #0f766e",
                background:
                  rankingActionBusy || !hasUnsavedDailyOrder ? "#0f172a" : "#134e4a",
                color: rankingActionBusy || !hasUnsavedDailyOrder ? "#64748b" : "#ccfbf1",
                fontWeight: 700,
                cursor:
                  rankingActionBusy || !hasUnsavedDailyOrder ? "not-allowed" : "pointer",
              }}
            >
              Reihenfolge speichern
            </button>
            <button
              onClick={handleCreateRankingVouchers}
              disabled={rankingActionBusy || editableDailyRows.length === 0}
              style={{
                padding: "10px 14px",
                borderRadius: 12,
                border: "1px solid #2563eb",
                background:
                  rankingActionBusy || editableDailyRows.length === 0
                    ? "#0f172a"
                    : "#1d4ed8",
                color:
                  rankingActionBusy || editableDailyRows.length === 0
                    ? "#64748b"
                    : "#dbeafe",
                fontWeight: 700,
                cursor:
                  rankingActionBusy || editableDailyRows.length === 0
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              Gutscheine erstellen
            </button>
            <span style={{ color: "#94a3b8", fontSize: 13 }}>
              Alle Manager koennen hier die Tagesreihenfolge speichern. Der
              Head Manager behaelt weiterhin die Sonderrechte im Gutschein-Bereich.
            </span>
          </div>
        )}

        {rankingMessage && (
          <p style={{ marginTop: 0, marginBottom: 18, color: "#93c5fd" }}>
            {rankingMessage}
          </p>
        )}

        {rankingTab === "daily" && currentTeamSubmission && (
          <div
            style={{
              position: "relative",
              overflow: "hidden",
              marginBottom: 18,
              padding: 18,
              border: "1px solid #22c55e",
              borderRadius: 14,
              background: "#052e1a",
              color: "#bbf7d0",
            }}
          >
            {Array.from({ length: 18 }, (_, index) => (
              <span
                key={index}
                style={{
                  position: "absolute",
                  top: -12,
                  left: `${8 + ((index * 17) % 84)}%`,
                  width: 8,
                  height: 14,
                  background: ["#22c55e", "#38bdf8", "#f59e0b", "#f43f5e"][
                    index % 4
                  ],
                  animation: `pq-confetti-fall ${1.2 + (index % 4) * 0.18}s ease-out ${index * 0.04}s both`,
                }}
              />
            ))}
            <strong style={{ fontSize: 22 }}>
              Glückwunsch, ihr habt Platz {currentTeamRank || "?"} gewonnen!
            </strong>
            <p style={{ margin: "8px 0 0" }}>
              Richtige Antwort: {lobbyData?.tiebreakerAnswer ?? "noch offen"} -
              eure Schätzung: {currentTeamSubmission.estimate}
            </p>
          </div>
        )}

        {rankingTeams.length === 0 ? (
          <p style={{ color: "#94a3b8", fontSize: 18 }}>
            {rankingTab === "daily"
              ? "Noch kein Team ist im Tagesranking."
              : "Noch kein Team nimmt am Jahresranking teil."}
          </p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {rankingTab === "daily" && hasDailyPodiumTie && currentTeamIsTiebreakerEligible && (
              <div
                style={{
                  padding: 14,
                  border: "1px solid #f59e0b",
                  borderRadius: 12,
                  background: "#451a03",
                  color: "#fde68a",
                }}
              >
                <strong>Schätzfrage für die Top 3</strong>
                <p style={{ margin: "6px 0 0" }}>
                  {hasTiebreakerAnswer
                    ? "Gleichstände auf dem Podium werden nach der nächsten Schätzung sortiert."
                    : "Es gibt einen Gleichstand für Platz 1, 2 oder 3. Das Personal kann die Schätzfrage im Personal-Bereich eintragen."}
                </p>
                {lobbyData?.tiebreakerQuestion && (
                  <p style={{ margin: "8px 0 0" }}>
                    {lobbyData.tiebreakerQuestion}
                  </p>
                )}
              </div>
            )}
            {rankingTeams.map((team, index) => (
              <div
                key={team.id}
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    isAdmin && rankingTab === "daily"
                      ? "52px minmax(0, 1fr) auto auto"
                      : "52px minmax(0, 1fr) auto",
                  gap: isNarrow ? 8 : 14,
                  alignItems: "center",
                  padding: isNarrow ? "13px 12px" : "14px 16px",
                  border: "1px solid #1f2937",
                  borderRadius: 12,
                  background: "#0b1220",
                }}
              >
                <strong
                  style={{
                    color: "#93c5fd",
                    fontSize: isNarrow ? 18 : 20,
                  }}
                >
                  {index + 1}.
                </strong>
                <div style={{ minWidth: 0, textAlign: "left" }}>
                  <strong
                    style={{
                      display: "block",
                      color: "#f8fafc",
                      fontSize: isNarrow ? 18 : 20,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {team.teamName}
                  </strong>
                  <span style={{ display: "block", marginTop: 3, color: "#94a3b8", fontSize: 13 }}>
                  {rankingTab === "yearly" && team.podiums > 0
                    ? `${team.podiums} Podien`
                    : ""}
                  {rankingTab === "yearly"
                    ? `${team.podiums > 0 ? " · " : ""}${team.totalQuizPoints || 0} Tagespunkte`
                    : ""}
                  {rankingTab === "daily" &&
                  hasTiebreakerAnswer &&
                  getEstimateValue(lobbyData, team.id) !== null
                    ? `Schätzung ${getEstimateValue(lobbyData, team.id)}`
                    : ""}
                  </span>
                </div>
                <strong
                  style={{
                    justifySelf: "end",
                    color: "#f8fafc",
                    fontSize: isNarrow ? 18 : 20,
                    textAlign: "right",
                    whiteSpace: "nowrap",
                  }}
                >
                  {team.totalPoints || 0}
                  <span style={{ marginLeft: 4, color: "#94a3b8", fontSize: 13 }}>
                    Pkt.
                  </span>
                </strong>
                {isAdmin && rankingTab === "daily" && (
                  <div
                    style={{
                      display: "grid",
                      gap: 6,
                      justifyItems: "end",
                    }}
                  >
                    <button
                      onClick={() => moveDailyTeam(team.teamId || team.id, -1)}
                      disabled={rankingActionBusy || index === 0}
                      style={{
                        minWidth: 44,
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid #334155",
                        background:
                          rankingActionBusy || index === 0 ? "#0f172a" : "#1e293b",
                        color:
                          rankingActionBusy || index === 0 ? "#64748b" : "#e2e8f0",
                        fontWeight: 700,
                        cursor:
                          rankingActionBusy || index === 0 ? "not-allowed" : "pointer",
                      }}
                    >
                      Hoch
                    </button>
                    <button
                      onClick={() => moveDailyTeam(team.teamId || team.id, 1)}
                      disabled={rankingActionBusy || index === rankingTeams.length - 1}
                      style={{
                        minWidth: 44,
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: "1px solid #334155",
                        background:
                          rankingActionBusy || index === rankingTeams.length - 1
                            ? "#0f172a"
                            : "#1e293b",
                        color:
                          rankingActionBusy || index === rankingTeams.length - 1
                            ? "#64748b"
                            : "#e2e8f0",
                        fontWeight: 700,
                        cursor:
                          rankingActionBusy || index === rankingTeams.length - 1
                            ? "not-allowed"
                            : "pointer",
                      }}
                    >
                      Runter
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function FaqScreen({
  isAdmin,
  onOpenAdmin,
  onOpenMain,
  onOpenRanking,
  onOpenVouchers,
  onSubmitFeedback,
  sessionData,
}) {
  const isNarrow = useIsNarrowScreen();
  const [feedbackDraft, setFeedbackDraft] = useState({
    anonymous: true,
    category: "meinung",
    contact: "",
    message: "",
    name: "",
  });
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const faqItems = [
    [
      "Wie starte ich als neues Team am einfachsten?",
      "Am leichtesten startet ihr über 'Nur heute'. Wenn ihr später dauerhaft im Jahresranking mitmachen wollt, bekommt ihr bei der ersten Registrierung ein Team-Passwort.",
    ],
    [
      "Wann startet meine Runde?",
      "Sobald das Personal eine Runde freischaltet, kann euer Team den Timer selbst starten. Wenn ihr nicht startet, beginnt er nach 10 Minuten automatisch.",
    ],
    [
      "Wie funktioniert das Tagesranking?",
      "Alle Teams in der aktuellen Lobby werden nach Punkten sortiert. Teams ohne Jahresranking-Opt-in sind hier trotzdem dabei.",
    ],
    [
      "Wie funktioniert das Jahresranking?",
      "Nur Teams mit Opt-in sammeln Jahrespunkte: 1. Platz 1,5, 2. Platz 1,0 und 3. Platz 0,5 pro Quizabend.",
    ],
    [
      "Wann erscheint die Schätzfrage?",
      "Nur wenn ein Gleichstand die Plätze 1 bis 3 betrifft und euer Team die dritte Runde fertig hat.",
    ],
    [
      "Kann mehr als ein Handy pro Team schätzen?",
      "Nein. Das erste Gerät, das für das Team bereit klickt, bekommt die Abgabe. Danach ist die Team-Abgabe gesperrt.",
    ],
    [
      "Kann man eine Antwort ändern?",
      "Normale Quizantworten werden nach einer richtigen Wertung gesperrt. Die Schätzfrage ist immer genau eine Abgabe.",
    ],
    [
      "Wann sehe ich die Lösungen?",
      "Sobald das Personal die Lösungen freigibt und eure eigene Rundenzeit abgelaufen ist.",
    ],
    [
      "Sind Hinweise begrenzt?",
      "Ja. Jede Runde hat ein eigenes Hinweisbudget, und Frage 6 hat keinen Hinweis.",
    ],
  ];

  async function handleFeedbackSubmit(e) {
    e.preventDefault();
    const result = await onSubmitFeedback(feedbackDraft);

    setFeedbackMessage(result.message);
    if (result.ok) {
      setFeedbackDraft({
        anonymous: true,
        category: "meinung",
        contact: "",
        message: "",
        name: "",
      });
    }
  }

  return (
    <main style={pageStyle}>
      <AppMenu
        canOpenRanking
        isAdmin={isAdmin}
        onOpenAdmin={onOpenAdmin}
        onOpenMain={onOpenMain}
        onOpenRanking={onOpenRanking}
        onOpenVouchers={onOpenVouchers}
      />
      <section
        style={{
          maxWidth: 900,
          margin: "40px auto",
          padding: 28,
          border: "1px solid #1f2937",
          borderRadius: 16,
          background: "#111827",
        }}
      >
        <p style={{ marginTop: 0, color: "#93c5fd", fontWeight: 700 }}>
          Lobby {sessionData.lobbyCode}
        </p>
        <h1 style={{ margin: "8px 0 20px", fontSize: 42 }}>FAQ</h1>

        <div style={{ display: "grid", gap: 12 }}>
          {faqItems.map(([question, answer]) => (
            <details
              key={question}
              style={{
                padding: 14,
                border: "1px solid #334155",
                borderRadius: 12,
                background: "#0b1220",
              }}
            >
              <summary style={{ cursor: "pointer", fontWeight: 700 }}>
                {repairMojibake(question)}
              </summary>
              <p style={{ color: "#cbd5e1", lineHeight: 1.5 }}>
                {repairMojibake(answer)}
              </p>
            </details>
          ))}
        </div>

        <section style={{ marginTop: 28 }}>
          <h2>Sag uns deine Meinung</h2>
          <form
            onSubmit={handleFeedbackSubmit}
            style={{
              display: "grid",
              gap: 12,
              padding: 16,
              border: "1px solid #334155",
              borderRadius: 14,
              background: "#0b1220",
            }}
          >
            <label style={{ display: "grid", gap: 8 }}>
              Art
              <select
                value={feedbackDraft.category}
                onChange={(e) =>
                  setFeedbackDraft((current) => ({
                    ...current,
                    category: e.target.value,
                  }))
                }
                style={inputStyle}
              >
                <option value="meinung">Meinung</option>
                <option value="beschwerde">Beschwerde</option>
                <option value="idee">Idee</option>
                <option value="bug">Problem</option>
                <option value="wichtig">Wichtig</option>
              </select>
            </label>

            <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={feedbackDraft.anonymous}
                onChange={(e) =>
                  setFeedbackDraft((current) => ({
                    ...current,
                    anonymous: e.target.checked,
                  }))
                }
              />
              Anonym senden
            </label>

            {!feedbackDraft.anonymous && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isNarrow ? "1fr" : "1fr 1fr",
                  gap: 12,
                }}
              >
                <label style={{ display: "grid", gap: 8 }}>
                  Name
                  <input
                    value={feedbackDraft.name}
                    onChange={(e) =>
                      setFeedbackDraft((current) => ({
                        ...current,
                        name: e.target.value,
                      }))
                    }
                    placeholder={sessionData.playerName || "Name"}
                    style={inputStyle}
                  />
                </label>
                <label style={{ display: "grid", gap: 8 }}>
                  Kontakt optional
                  <input
                    value={feedbackDraft.contact}
                    onChange={(e) =>
                      setFeedbackDraft((current) => ({
                        ...current,
                        contact: e.target.value,
                      }))
                    }
                    placeholder="Instagram, Mail, Nummer..."
                    style={inputStyle}
                  />
                </label>
              </div>
            )}

            <label style={{ display: "grid", gap: 8 }}>
              Nachricht
              <textarea
                value={feedbackDraft.message}
                onChange={(e) =>
                  setFeedbackDraft((current) => ({
                    ...current,
                    message: e.target.value.slice(0, 1000),
                  }))
                }
                placeholder="Was sollen wir wissen?"
                rows={5}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </label>

            <button
              type="submit"
              style={{
                justifySelf: "start",
                padding: "10px 14px",
                borderRadius: 12,
                border: "none",
                background: "#22c55e",
                color: "#0b1220",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Absenden
            </button>
            {feedbackMessage && (
              <p style={{ margin: 0, color: "#93c5fd" }}>{feedbackMessage}</p>
            )}
          </form>
        </section>
      </section>
    </main>
  );
}

function VoucherScreen({
  allVoucherDocs = [],
  allTeamSessions,
  globalRankingRows,
  isAdmin,
  onOpenAdmin,
  onOpenFaq,
  onOpenMain,
  onOpenRanking,
  pubQuizzes,
  sessionData,
  teamHistorySessions,
  teamProfiles,
  teamSessionId,
  onUpdateVoucherStatus,
}) {
  const [voucherMessage, setVoucherMessage] = useState("");
  const [scopedVoucherDocs, setScopedVoucherDocs] = useState([]);
  const isNarrow = useIsNarrowScreen();
  const teamId =
    sessionData?.teamId || teamSessionId || sessionData?.teamNameNormalized || "";
  const teamProfile = teamProfiles.find((profile) => profile.id === teamId);
  const teamName = sessionData?.teamName || teamProfile?.teamName || teamProfile?.name || "";
  const effectiveVoucherDocs = scopedVoucherDocs.length > 0 ? scopedVoucherDocs : allVoucherDocs;
  const vouchers = buildVoucherEntries(teamHistorySessions, effectiveVoucherDocs, pubQuizzes, {
    visibleTeamId: teamId || null,
  });
  const wonVoucherCount = vouchers.length;
  const redeemedVoucherCount = vouchers.filter(
    (voucher) => voucher.status === "redeemed",
  ).length;
  const totalPoints =
    globalRankingRows.find((row) => row.teamId === teamId)?.totalGlobalPoints ||
    teamProfile?.totalGlobalPoints ||
    0;

  useEffect(() => {
    if (!teamId) {
      setScopedVoucherDocs([]);
      return undefined;
    }

    let cancelled = false;

    async function refreshTeamVouchers() {
      try {
        const voucherDocs = await loadVoucherDocsForTeam(teamId);
        if (!cancelled) {
          setScopedVoucherDocs(voucherDocs);
        }
      } catch (error) {
        console.error("TEAM VOUCHERS LOAD ERROR:", error);
      }
    }

    refreshTeamVouchers();

    const unsubscribe = onSnapshot(collection(db, "teams", teamId, "vouchers"), () => {
      refreshTeamVouchers();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [teamId]);

  return (
    <main style={pageStyle}>
      <AppMenu
        canOpenRanking
        isAdmin={isAdmin}
        onOpenAdmin={onOpenAdmin}
        onOpenFaq={onOpenFaq}
        onOpenMain={onOpenMain}
        onOpenRanking={onOpenRanking}
        onOpenVouchers={() => {}}
      />
      <section
        style={{
          maxWidth: 820,
          margin: "40px auto",
          padding: 28,
          border: "1px solid #1f2937",
          borderRadius: 16,
          background: "#111827",
        }}
      >
        <p style={{ marginTop: 0, color: "#93c5fd", fontWeight: 700 }}>Gutscheine</p>
        <h1 style={{ margin: "8px 0 10px", fontSize: 42 }}>Eure Gewinne</h1>
        <p style={{ color: "#94a3b8", maxWidth: 660 }}>
          Gewonnene Gutscheine bleiben hier als Verlauf sichtbar. Das Team kann eine
          Einloesung anfragen, und das Personal markiert sie spaeter vor Ort als
          eingeloest.
        </p>

        {sessionData?.managerOnly ? (
          <div
            style={{
              marginTop: 18,
              padding: 16,
              border: "1px solid #334155",
              borderRadius: 14,
              background: "#0b1220",
              color: "#cbd5e1",
            }}
          >
            Fuer den Personal-Zugang ist dieser Bereich nur als Erklaerung sichtbar.
            Team-Gutscheine seht und bearbeitet ihr im `Teamarchiv`.
          </div>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isNarrow ? "1fr" : "repeat(3, 1fr)",
                gap: 12,
                marginTop: 18,
              }}
            >
              <div style={{ padding: 16, borderRadius: 14, background: "#0b1220", border: "1px solid #1f2937" }}>
                <strong style={{ display: "block", color: "#93c5fd" }}>Team</strong>
                <span>{teamName || "nicht erkannt"}</span>
              </div>
              <div style={{ padding: 16, borderRadius: 14, background: "#0b1220", border: "1px solid #1f2937" }}>
                <strong style={{ display: "block", color: "#93c5fd" }}>Gewonnene Gutscheine</strong>
                <span>{wonVoucherCount}</span>
              </div>
              <div style={{ padding: 16, borderRadius: 14, background: "#0b1220", border: "1px solid #1f2937" }}>
                <strong style={{ display: "block", color: "#93c5fd" }}>Jahrespunkte</strong>
                <span>{totalPoints}</span>
              </div>
            </div>

            <div style={{ display: "grid", gap: 12, marginTop: 22 }}>
              {vouchers.length === 0 ? (
                <div
                  style={{
                    padding: 18,
                    borderRadius: 14,
                    border: "1px solid #1f2937",
                    background: "#0b1220",
                    color: "#94a3b8",
                  }}
                >
                  Dieses Team hat bisher noch keinen Gutschein gewonnen.
                </div>
              ) : (
                vouchers.map((voucher) => {
                  const sourceSession = teamHistorySessions.find(
                    (session) => getVoucherIdForSession(session) === voucher.id,
                  );

                  return (
                    <article
                      key={voucher.id}
                      style={{
                        padding: 18,
                        borderRadius: 14,
                        border: "1px solid #1f2937",
                        background: "#0b1220",
                      }}
                    >
                      <strong style={{ display: "block", fontSize: 20 }}>
                        {voucher.title}
                      </strong>
                      <span style={{ display: "block", marginTop: 6, color: "#cbd5e1" }}>
                        {voucher.description}
                      </span>
                      <span style={{ display: "block", marginTop: 8, color: "#94a3b8" }}>
                        {voucher.quizLabel} - Platz {voucher.rank} - {voucher.totalPoints} Punkte
                      </span>
                      <span style={{ display: "block", marginTop: 4, color: "#94a3b8" }}>
                        Status:{" "}
                        <strong>
                          {voucher.status === "redeemed"
                            ? "eingeloest"
                            : voucher.status === "requested"
                              ? "angefragt"
                              : "verfuegbar"}
                        </strong>
                        {voucher.status === "redeemed" && voucher.redeemedAt
                          ? ` seit ${formatCompletionDate(voucher.redeemedAt)}`
                          : ""}
                      </span>
                      {voucher.status === "earned" && onUpdateVoucherStatus && (
                        <button
                          onClick={async () => {
                            const result = await onUpdateVoucherStatus({
                              voucher,
                              nextStatus: "requested",
                              sourceSession,
                              teamId,
                              teamName,
                            });
                            setVoucherMessage(result.message);
                          }}
                          style={{ marginTop: 12 }}
                        >
                          Einloesung anfragen
                        </button>
                      )}
                    </article>
                  );
                })
              )}
            </div>

            <p style={{ color: "#94a3b8", marginTop: 18 }}>
              Bereits eingeloest: <strong>{redeemedVoucherCount}</strong>
            </p>
            {voucherMessage && <p style={{ color: "#93c5fd" }}>{voucherMessage}</p>}
          </>
        )}
      </section>
    </main>
  );
}

function AdminScreen({
  adminTab,
  activeManager,
  allTeams,
  allTeamSessions,
  allVoucherDocs,
  feedbackEntries,
  historicalDailyRankingDocs,
  globalRankingRows,
  lobbyData,
  managers,
  now,
  onAddRoundExtraTime,
  onChangeAdminTab,
  onCloseNewRegistrations,
  onCreateVoucherAssignment,
  onDeletePubQuiz,
  onDeleteVoucherAssignment,
  onOpenAdmin,
  onOpenFaq,
  onOpenMain,
  onOpenRanking,
  onOpenVouchers,
  onLoadPubQuizByCode,
  onRevealRoundAnswers,
  onReopenNewRegistrations,
  onSaveManager,
  onSaveHistoricalEventRanking,
  onSavePubQuiz,
  onRoundChange,
  onSubmitManagerAnswerForTeam,
  onUpdateTeamPodiumExclusion,
  onUpdateTeamQuestionScore,
  onUpdateTeamScore,
  onUnlockRound,
  onUpdateVoucherStatus,
  pubQuizzes,
  quizManagerMessage,
  questions,
  quizRounds,
  registeredTeams,
  selectedRound,
  sessionData,
  teamProfiles,
}) {
  const canManageManagers = canManageManagerRecords(activeManager, managers);
  const isNarrow = useIsNarrowScreen();
  const selectedQuestions = selectedRound.questionIds
    .map((questionId) => questions[questionId])
    .filter(Boolean);
  const roundUnlocked = isRoundUnlocked(lobbyData, selectedRound.id);
  const answersRevealed = isRoundAnswersRevealed(lobbyData, selectedRound.id);
  const teamStatuses = registeredTeams.map((team) => {
    const startMs = getEffectiveRoundStartMs(
      team,
      lobbyData,
      selectedRound.id,
      now,
      quizRounds,
    );
    const durationMs = getRoundDurationMs(selectedRound, lobbyData);
    const remainingMs = startMs === null ? null : startMs + durationMs - now;
    const expired = startMs !== null && remainingMs <= 0;

    return {
      ...team,
      expired,
      podiumExcluded: Boolean(lobbyData?.tiebreakerExcludedTeams?.[team.id]?.active),
      remainingMs,
      started: startMs !== null,
    };
  });
  const canRevealAnswers = roundUnlocked && !answersRevealed;
  const tabs = [
    ["live", "Live-Steuerung"],
    ["teams", "Teamarchiv"],
    ["vouchers", "Alle Gutscheine"],
    ["feedback", "Meinungen"],
    ...(canManageManagers ? [["managers", "Manager"]] : []),
    ["quizzes", "Pubquizzes"],
  ];

  useEffect(() => {
    if (adminTab === "managers" && !canManageManagers) {
      onChangeAdminTab?.("live");
    }
  }, [adminTab, canManageManagers, onChangeAdminTab]);

  return (
    <main style={pageStyle}>
      <AppMenu
        canOpenRanking
        isAdmin={true}
        onOpenAdmin={onOpenAdmin}
        onOpenFaq={onOpenFaq}
        onOpenMain={onOpenMain}
        onOpenRanking={onOpenRanking}
        onOpenVouchers={onOpenVouchers}
      />
      <section
        style={{
          maxWidth: 980,
          margin: isNarrow ? "18px auto" : "40px auto",
          padding: isNarrow ? 14 : 28,
          border: "1px solid #1f2937",
          borderRadius: 16,
          background: "#111827",
          overflow: "hidden",
        }}
      >
        <p style={{ marginTop: 0, color: "#93c5fd", fontWeight: 700 }}>
          Lobby {sessionData.lobbyCode}
        </p>
        <h1 style={{ margin: "8px 0 8px", fontSize: 42 }}>Personal</h1>
        <p style={{ margin: 0, color: "#94a3b8", fontSize: 18 }}>
          Admin-Bereich für Rundensteuerung, Teamstatus und Lösungen.
        </p>

        <p style={{ margin: "8px 0 0", color: "#93c5fd", fontWeight: 700 }}>
          {activeManager.headManager ? "Head Manager" : "Manager"}
        </p>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 24 }}>
          {tabs.map(([tabId, label]) => {
            const isSelected = adminTab === tabId;

            return (
              <button
                key={tabId}
                onClick={() => onChangeAdminTab?.(tabId)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 999,
                  border: `1px solid ${isSelected ? "#38bdf8" : "#334155"}`,
                  background: isSelected ? "#082f49" : "#020617",
                  color: isSelected ? "#e0f2fe" : "#cbd5e1",
                  fontWeight: 700,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {adminTab === "live" ? (
          <LiveControlPanel
            activeManager={activeManager}
            answersRevealed={answersRevealed}
            canRevealAnswers={canRevealAnswers}
            lobbyData={lobbyData}
            now={now}
            onAddRoundExtraTime={onAddRoundExtraTime}
            onCloseNewRegistrations={onCloseNewRegistrations}
            onRevealRoundAnswers={onRevealRoundAnswers}
            onReopenNewRegistrations={onReopenNewRegistrations}
            onRoundChange={onRoundChange}
            onSubmitManagerAnswerForTeam={onSubmitManagerAnswerForTeam}
            onUpdateTeamPodiumExclusion={onUpdateTeamPodiumExclusion}
            onUpdateTeamQuestionScore={onUpdateTeamQuestionScore}
            onUpdateTeamScore={onUpdateTeamScore}
            onUnlockRound={onUnlockRound}
            quizRounds={quizRounds}
            selectedQuestions={selectedQuestions}
            selectedRound={selectedRound}
            teamStatuses={teamStatuses}
          />
        ) : adminTab === "teams" ? (
          <TeamDirectory
            activeManager={activeManager}
            allVoucherDocs={allVoucherDocs}
            globalRankingRows={globalRankingRows}
            onSubmitManagerAnswerForTeam={onSubmitManagerAnswerForTeam}
            onUpdateTeamQuestionScore={onUpdateTeamQuestionScore}
            onUpdateTeamScore={onUpdateTeamScore}
            pubQuizzes={pubQuizzes}
            teamProfiles={teamProfiles}
            teams={allTeamSessions.length ? allTeamSessions : allTeams}
          />
        ) : adminTab === "feedback" ? (
          <FeedbackInbox entries={feedbackEntries} />
        ) : adminTab === "vouchers" ? (
          <VoucherDirectory
            activeManager={activeManager}
            allTeamSessions={allTeamSessions}
            allVoucherDocs={allVoucherDocs}
            dailyRankingDocs={historicalDailyRankingDocs}
            onCreateVoucherAssignment={onCreateVoucherAssignment}
            onDeleteVoucherAssignment={onDeleteVoucherAssignment}
            onSaveEventRanking={onSaveHistoricalEventRanking}
            onUpdateVoucherStatus={onUpdateVoucherStatus}
            pubQuizzes={pubQuizzes}
            teamProfiles={teamProfiles}
          />
        ) : adminTab === "managers" && canManageManagers ? (
          <ManagerDirectory
            activeManager={activeManager}
            managers={managers}
            message={quizManagerMessage}
            onSaveManager={onSaveManager}
          />
        ) : (
          <PubQuizManager
            activeManager={activeManager}
            message={quizManagerMessage}
            onDeletePubQuiz={onDeletePubQuiz}
            onLoadPubQuizByCode={onLoadPubQuizByCode}
            onSavePubQuiz={onSavePubQuiz}
            pubQuizzes={pubQuizzes}
          />
        )}
      </section>
    </main>
  );
}

function FeedbackInbox({ entries }) {
  return (
    <section style={{ marginTop: 24 }}>
      <h2>Meinungen</h2>
      {entries.length === 0 ? (
        <p style={{ color: "#94a3b8" }}>Noch keine Nachrichten eingegangen.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {entries.map((entry) => (
            <article
              key={entry.id}
              style={{
                padding: 14,
                border: "1px solid #1f2937",
                borderRadius: 12,
                background: "#0b1220",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <strong>{entry.category || "meinung"}</strong>
                <span style={{ color: "#94a3b8" }}>
                  {getTimestampMs(entry.createdAt)
                    ? new Date(getTimestampMs(entry.createdAt)).toLocaleString()
                    : entry.dateKey}
                </span>
              </div>
              <p style={{ color: "#e5e7eb", whiteSpace: "pre-wrap" }}>
                {entry.message}
              </p>
              <p style={{ marginBottom: 0, color: "#94a3b8" }}>
                {entry.anonymous ? "Anonym" : entry.playerName || "Anonym"} - Team{" "}
                {entry.teamName || "unbekannt"} - Lobby {entry.lobbyCode || "?"}
                {entry.contact ? ` - Kontakt: ${entry.contact}` : ""}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function TiebreakerPanel({
  lobbyData,
  message,
  onStart,
  teams,
}) {
  const isNarrow = useIsNarrowScreen();
  const dailyRanking = getDailyRankingWithTiebreakers(teams, lobbyData);
  const tiedTeams = dailyRanking.tieGroups.flatMap((group) => group.teams);
  const uniqueTiedTeams = Array.from(
    new Map(tiedTeams.map((team) => [team.id, team])).values(),
  );
  return (
    <section style={{ marginTop: 24 }}>
      <h2>Schätzfrage</h2>
      <p style={{ color: "#94a3b8" }}>
        Wird nur im Tagesranking benutzt, wenn ein Gleichstand Platz 1, 2 oder 3
        betrifft.
      </p>

      <div
        style={{
          display: "grid",
          gap: 12,
          padding: 16,
          border: "1px solid #334155",
          borderRadius: 14,
          background: "#0b1220",
        }}
      >
        <div
          style={{
            padding: 12,
            border: "1px solid #1f2937",
            borderRadius: 12,
            background: "#020617",
          }}
        >
          <strong>Schätzfrage</strong>
          <p style={{ margin: "8px 0 0", color: "#cbd5e1" }}>
            {lobbyData?.tiebreakerQuestion ||
              "Noch keine Schätzfrage gesetzt. Bitte im Pubquiz-Tab eintragen und speichern."}
          </p>
        </div>
        <div
          style={{
            padding: 12,
            border: "1px solid #1f2937",
            borderRadius: 12,
            background: "#020617",
          }}
        >
          <strong>Richtige Antwort</strong>
          <p style={{ margin: "8px 0 0", color: "#cbd5e1" }}>
            {lobbyData?.tiebreakerAnswer ?? "Noch nicht gesetzt. Bitte im Pubquiz-Tab eintragen und speichern."}
          </p>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
        <button
          disabled={uniqueTiedTeams.length === 0}
          onClick={onStart}
          style={{
            padding: "10px 14px",
            borderRadius: 12,
            border: "none",
            background: uniqueTiedTeams.length ? "#f59e0b" : "#334155",
            color: uniqueTiedTeams.length ? "#111827" : "#94a3b8",
            fontWeight: 700,
            cursor: uniqueTiedTeams.length ? "pointer" : "not-allowed",
          }}
        >
          Schätzfrage starten
        </button>
        <span style={{ alignSelf: "center", color: "#94a3b8" }}>
          Status: {lobbyData?.tiebreakerStatus === "active" ? "aktiv" : "wartet"}
        </span>
      </div>

      <section style={{ marginTop: 22 }}>
        <h3>Betroffene Teams</h3>
        {uniqueTiedTeams.length === 0 ? (
          <p style={{ color: "#94a3b8" }}>
            Aktuell gibt es keinen Gleichstand, der die Top 3 betrifft.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {uniqueTiedTeams.map((team) => {
              const distance = getTiebreakerDistance(lobbyData, team.id);

              return (
                <div
                  key={team.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: isNarrow ? "1fr" : "1fr auto auto",
                    gap: 10,
                    alignItems: "center",
                    padding: 12,
                    border: "1px solid #1f2937",
                    borderRadius: 12,
                    background: "#0b1220",
                  }}
                >
                  <span>
                    <strong>{team.teamName}</strong>
                    <br />
                    <span style={{ color: "#94a3b8" }}>
                      {team.totalPoints || 0} Punkte
                      {distance !== null ? ` - Abstand ${distance}` : ""}
                    </span>
                  </span>
                  <span style={{ color: lobbyData?.tiebreakerReady?.[team.id] ? "#86efac" : "#fde68a" }}>
                    {lobbyData?.tiebreakerReady?.[team.id] ? "bereit" : "nicht bereit"}
                  </span>
                  <span style={{ color: getTiebreakerSubmission(lobbyData, team.id) ? "#86efac" : "#94a3b8" }}>
                    {getTiebreakerSubmission(lobbyData, team.id)
                      ? `Schätzung ${getTiebreakerSubmission(lobbyData, team.id).estimate}`
                      : "offen"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {message && <p style={{ color: "#93c5fd" }}>{message}</p>}
    </section>
  );
}

function VoucherDirectory({
  activeManager,
  allTeamSessions = [],
  allVoucherDocs = [],
  dailyRankingDocs = [],
  onCreateVoucherAssignment,
  onDeleteVoucherAssignment,
  onSaveEventRanking,
  onUpdateVoucherStatus,
  pubQuizzes = [],
  teamProfiles = [],
}) {
  const [viewMode, setViewMode] = useState("event");
  const [draftEventOrders, setDraftEventOrders] = useState({});
  const [eventRankingBusy, setEventRankingBusy] = useState(false);
  const [selectedEventVoucherDocs, setSelectedEventVoucherDocs] = useState([]);
  const [selectedTeamVoucherDocs, setSelectedTeamVoucherDocs] = useState([]);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [selectedTeamId, setSelectedTeamId] = useState(null);
  const [selectedCreateRank, setSelectedCreateRank] = useState("1");
  const [selectedCreateTeamId, setSelectedCreateTeamId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [voucherMessage, setVoucherMessage] = useState("");
  const isNarrow = useIsNarrowScreen();
  const canEditEventRankings = Boolean(activeManager && onSaveEventRanking);
  const canEditVouchers = Boolean(activeManager?.headManager);
  const canRedeemVouchers = Boolean(activeManager && onUpdateVoucherStatus);
  const allEffectiveVouchers = buildAllVoucherEntries(
    allTeamSessions,
    allVoucherDocs,
    pubQuizzes,
  );
  const voucherLatestPlayedByTeam = new Map();

  allEffectiveVouchers.forEach((voucher) => {
    if (!voucher.teamId) return;

    const currentMs = voucherLatestPlayedByTeam.get(voucher.teamId) || 0;
    const voucherMs = getTimestampMs(voucher.awardedAt);

    if (voucherMs > currentMs) {
      voucherLatestPlayedByTeam.set(voucher.teamId, voucherMs);
    }
  });

  const teamDirectory = aggregateTeamDirectory(allTeamSessions, teamProfiles).sort((a, b) => {
    const voucherDifference =
      (voucherLatestPlayedByTeam.get(b.id) || 0) - (voucherLatestPlayedByTeam.get(a.id) || 0);

    if (voucherDifference !== 0) return voucherDifference;

    const sessionDifference =
      getTimestampMs(getCompletionValue((b.sessions || [])[0])) -
      getTimestampMs(getCompletionValue((a.sessions || [])[0]));

    if (sessionDifference !== 0) return sessionDifference;

    return (a.teamName || "").localeCompare(b.teamName || "");
  });
  const normalizedSearchTerm = normalizeTeamName(searchTerm || "");
  const eventSummaries = Array.from(
    [...allTeamSessions, ...allVoucherDocs].reduce((map, entry) => {
      const eventId = entry.eventId || getEventId(entry.quizCode || entry.lobbyCode || "");

      if (!eventId) return map;

      const current = map.get(eventId) || {
        eventId,
        quizCode: entry.quizCode || entry.lobbyCode || "",
        quizLabel: getQuizLabelForSession(entry, pubQuizzes),
        awardedAt: entry.awardedAt || getCompletionValue(entry) || entry.createdAt || null,
      };
      const nextAwardedAt =
        getTimestampMs(entry.awardedAt || getCompletionValue(entry) || entry.createdAt) >
        getTimestampMs(current.awardedAt)
          ? entry.awardedAt || getCompletionValue(entry) || entry.createdAt || null
          : current.awardedAt;

      map.set(eventId, {
        ...current,
        quizCode: current.quizCode || entry.quizCode || entry.lobbyCode || "",
        quizLabel: current.quizLabel || getQuizLabelForSession(entry, pubQuizzes),
        awardedAt: nextAwardedAt,
      });

      return map;
    }, new Map()).values(),
  ).sort((a, b) => getTimestampMs(b.awardedAt) - getTimestampMs(a.awardedAt));
  const sessionCountByEvent = new Map();

  allTeamSessions.forEach((session) => {
    if (!session.eventId) return;

    sessionCountByEvent.set(
      session.eventId,
      (sessionCountByEvent.get(session.eventId) || 0) + 1,
    );
  });
  const visibleEventSummaries = eventSummaries.filter((event) => {
    const voucherCount = allEffectiveVouchers.filter(
      (voucher) => voucher.eventId === event.eventId,
    ).length;
    const sessionCount = sessionCountByEvent.get(event.eventId) || 0;

    if (voucherCount === 0 && sessionCount === 0) return false;
    if (!normalizedSearchTerm) return true;

    return normalizeTeamName(
      `${event.quizLabel || ""} ${event.quizCode || ""} ${formatCompletionDate(event.awardedAt)}`,
    ).includes(normalizedSearchTerm);
  });
  const selectedEvent =
    visibleEventSummaries.find((event) => event.eventId === selectedEventId) ||
    visibleEventSummaries[0] ||
    null;
  const rankingDocByEventId = new Map(
    dailyRankingDocs.map((entry) => [entry.eventId, entry]),
  );
  const selectedEventRankingDoc = rankingDocByEventId.get(selectedEvent?.eventId || "");
  const selectedEventMergedSessions = mergeSessionParticipation(
    allTeamSessions.filter((session) => session.eventId === selectedEvent?.eventId),
  );
  const selectedEventBaseRows = buildHistoricalEventRankingRows(
    selectedEventMergedSessions,
    selectedEventRankingDoc?.rows || [],
  );
  const selectedEventDraftOrder = draftEventOrders[selectedEvent?.eventId || ""] || [];
  const selectedEventRankingRows =
    selectedEventDraftOrder.length > 0
      ? applyManualRankingOrder(selectedEventBaseRows, selectedEventDraftOrder)
      : selectedEventBaseRows;
  const selectedEventSessions = selectedEventRankingRows.map((row) => {
    const matchingSession = selectedEventMergedSessions.find(
      (session) => (session.teamId || session.id) === row.teamId,
    );

    return {
      ...matchingSession,
      id: matchingSession?.id || row.sourceSessionId || row.teamId,
      teamId: row.teamId,
      teamName: row.teamName,
      totalPoints: Number(row.totalPoints) || 0,
      rankDaily: row.rank,
      podiumBonusPoints: row.podiumBonusPoints || 0,
    };
  });
  const selectedEventTeamIds = Array.from(
    new Set(selectedEventSessions.map((session) => session.teamId || session.id).filter(Boolean)),
  );
  const selectedEventTeamKey = selectedEventTeamIds.join("|");
  const persistedSelectedEventOrder =
    selectedEventBaseRows.map((row) => row.teamId).join("|");
  const draftSelectedEventOrder =
    selectedEventRankingRows.map((row) => row.teamId).join("|");
  const hasUnsavedEventRankingOrder =
    draftSelectedEventOrder !== persistedSelectedEventOrder;
  const selectedEventEffectiveVouchers =
    selectedEventVoucherDocs.length > 0
      ? buildAllVoucherEntries(selectedEventSessions, selectedEventVoucherDocs, pubQuizzes)
      : allEffectiveVouchers;
  const selectedEventVouchers = selectedEventEffectiveVouchers
    .filter((voucher) => !voucher.deleted && voucher.eventId === selectedEvent?.eventId)
    .sort(
      (a, b) =>
        getTimestampMs(b.awardedAt) - getTimestampMs(a.awardedAt) ||
        (Number(a.rank) || Number.MAX_SAFE_INTEGER) -
          (Number(b.rank) || Number.MAX_SAFE_INTEGER) ||
        (a.teamName || "").localeCompare(b.teamName || ""),
    );
  const visibleVoucherTeams = teamDirectory.filter((team) => {
    const voucherCount = allEffectiveVouchers.filter(
      (voucher) => voucher.teamId === team.id,
    ).length;

    if (voucherCount === 0) return false;
    if (!normalizedSearchTerm) return true;

    return normalizeTeamName(team.teamName || "").includes(normalizedSearchTerm);
  });
  const selectedTeam =
    visibleVoucherTeams.find((team) => team.id === selectedTeamId) ||
    visibleVoucherTeams[0] ||
    null;
  const selectedTeamEffectiveVouchers =
    selectedTeamVoucherDocs.length > 0 ? selectedTeamVoucherDocs : allVoucherDocs;
  const selectedTeamVouchers = selectedTeam
    ? buildVoucherEntries(
        selectedTeam.sessions || [],
        selectedTeamEffectiveVouchers,
        pubQuizzes,
        { visibleTeamId: selectedTeam.id },
      )
    : [];

  useEffect(() => {
    if (!visibleEventSummaries.some((event) => event.eventId === selectedEventId)) {
      setSelectedEventId(visibleEventSummaries[0]?.eventId || null);
    }
  }, [selectedEventId, visibleEventSummaries]);

  useEffect(() => {
    if (!visibleVoucherTeams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(visibleVoucherTeams[0]?.id || null);
    }
  }, [selectedTeamId, visibleVoucherTeams]);

  useEffect(() => {
    if (!selectedEventSessions.some((team) => (team.teamId || team.id) === selectedCreateTeamId)) {
      setSelectedCreateTeamId(selectedEventSessions[0]?.teamId || selectedEventSessions[0]?.id || "");
    }
  }, [selectedCreateTeamId, selectedEventSessions]);

  useEffect(() => {
    if (!selectedEvent?.eventId) {
      setSelectedEventVoucherDocs([]);
      return undefined;
    }

    let cancelled = false;
    async function refreshSelectedEventVouchers() {
      try {
        const normalizedDocs = await loadVoucherDocsForEvent({
          eventId: selectedEvent.eventId,
          teamIds: selectedEventTeamIds,
        });

        if (cancelled) return;

        setSelectedEventVoucherDocs(normalizedDocs);

        const mirroredEventIds = new Set(
          normalizedDocs
            .filter((voucher) => voucher.storageSource === "event")
            .map((voucher) => voucher.id),
        );
        const missingEventVouchers = normalizedDocs.filter(
          (voucher) => voucher.storageSource === "team" && !mirroredEventIds.has(voucher.id),
        );

        mirrorLegacyVouchersToEventStore(missingEventVouchers).catch((error) => {
          console.error("SELECTED EVENT VOUCHER MIRROR ERROR:", error);
        });
      } catch (error) {
        console.error("SELECTED EVENT VOUCHERS LOAD ERROR:", error);
      }
    }

    refreshSelectedEventVouchers();

    const unsubscribeFns = [
      onSnapshot(collection(db, "quizEvents", selectedEvent.eventId, "vouchers"), () => {
        refreshSelectedEventVouchers();
      }),
      ...selectedEventTeamIds.map((teamId) =>
        onSnapshot(collection(db, "teams", teamId, "vouchers"), () => {
          refreshSelectedEventVouchers();
        }),
      ),
    ];

    return () => {
      cancelled = true;
      unsubscribeFns.forEach((unsubscribe) => unsubscribe());
    };
  }, [selectedEvent?.eventId, selectedEventTeamKey]);

  useEffect(() => {
    if (!selectedTeam?.id) {
      setSelectedTeamVoucherDocs([]);
      return undefined;
    }

    let cancelled = false;

    async function refreshSelectedTeamVouchers() {
      try {
        const voucherDocs = await loadVoucherDocsForTeam(selectedTeam.id);
        if (!cancelled) {
          setSelectedTeamVoucherDocs(voucherDocs);
        }
      } catch (error) {
        console.error("SELECTED TEAM VOUCHERS LOAD ERROR:", error);
      }
    }

    refreshSelectedTeamVouchers();

    const unsubscribe = onSnapshot(
      collection(db, "teams", selectedTeam.id, "vouchers"),
      () => {
        refreshSelectedTeamVouchers();
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedTeam?.id]);

  function moveSelectedEventTeam(teamId, direction) {
    if (!selectedEvent?.eventId) return;

    setDraftEventOrders((currentDrafts) => {
      const eventKey = selectedEvent.eventId;
      const currentOrder = currentDrafts[eventKey]?.length
        ? [...currentDrafts[eventKey]]
        : [...selectedEventBaseRows.map((row) => row.teamId)];
      const currentIndex = currentOrder.findIndex((currentTeamId) => currentTeamId === teamId);

      if (currentIndex === -1) return currentDrafts;

      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= currentOrder.length) return currentDrafts;

      const [movedTeamId] = currentOrder.splice(currentIndex, 1);
      currentOrder.splice(nextIndex, 0, movedTeamId);

      return {
        ...currentDrafts,
        [eventKey]: currentOrder,
      };
    });
  }

  async function handleSaveSelectedEventRanking() {
    if (!selectedEvent || !onSaveEventRanking) return;

    setEventRankingBusy(true);
    const result = await onSaveEventRanking({
      awardedAt: selectedEvent.awardedAt || null,
      eventId: selectedEvent.eventId,
      quizCode: selectedEvent.quizCode || "",
      rows: selectedEventRankingRows,
    });
    setEventRankingBusy(false);
    if (result?.ok) {
      setDraftEventOrders((currentDrafts) => {
        const nextDrafts = { ...currentDrafts };
        delete nextDrafts[selectedEvent.eventId];
        return nextDrafts;
      });
    }
    setVoucherMessage(result?.message || "");
  }

  async function handleCreateVoucher() {
    const targetTeam = selectedEventSessions.find(
      (team) => (team.teamId || team.id) === selectedCreateTeamId,
    );

    if (!selectedEvent || !targetTeam) {
      setVoucherMessage("Bitte zuerst ein Event und ein Team auswaehlen.");
      return;
    }

    const result = await onCreateVoucherAssignment?.({
      awardedAt:
        getCompletionValue(targetTeam) ||
        selectedEvent.awardedAt ||
        serverTimestamp(),
      eventId: selectedEvent.eventId,
      quizCode: selectedEvent.quizCode,
      quizLabel: selectedEvent.quizLabel,
      rank: Number(selectedCreateRank),
      sourceSessionId: targetTeam.id || "",
      teamId: targetTeam.teamId || targetTeam.id || "",
      teamName: targetTeam.teamName || "",
      totalPoints: Number(targetTeam.totalPoints) || 0,
    });

    if (result?.message) {
      setVoucherMessage(result.message);
    }
  }

  function renderVoucherActions(voucher, sourceSession) {
    if (!canRedeemVouchers && !canEditVouchers) return null;

    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        {voucher.status !== "redeemed" && canRedeemVouchers && (
          <button
            type="button"
            onClick={async () => {
              const result = await onUpdateVoucherStatus({
                voucher,
                nextStatus: "redeemed",
                sourceSession,
                teamId: voucher.teamId,
                teamName: voucher.teamName,
              });
              setVoucherMessage(result.message);
            }}
          >
            Als eingeloest markieren
          </button>
        )}
        {voucher.status === "redeemed" && canRedeemVouchers && (
          <button
            type="button"
            onClick={async () => {
              const result = await onUpdateVoucherStatus({
                voucher,
                nextStatus: "earned",
                sourceSession,
                teamId: voucher.teamId,
                teamName: voucher.teamName,
              });
              setVoucherMessage(result.message);
            }}
            style={{ background: "#1e293b", color: "#e2e8f0" }}
          >
            Einloesung zuruecknehmen
          </button>
        )}
        {canEditVouchers && onDeleteVoucherAssignment && (
          <button
            type="button"
            onClick={async () => {
              const result = await onDeleteVoucherAssignment(voucher);
              setVoucherMessage(result.message);
            }}
            style={{
              border: "1px solid rgba(248, 113, 113, 0.45)",
              background: "rgba(127, 29, 29, 0.35)",
              color: "#fecaca",
            }}
          >
            Gutschein loeschen
          </button>
        )}
      </div>
    );
  }

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Alle Gutscheine</h2>
      <p style={{ marginTop: 0, color: "#94a3b8" }}>
        Alle Podiums-Gutscheine im Ueberblick, sortiert nach Event oder Team. Nur der
        Head Manager kann Gutscheine anlegen, loeschen oder den Status aendern. Das
        Tagesranking eines ausgewaehlten Events kann aber jeder Admin hier direkt
        korrigieren und speichern.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        {[
          ["event", "Pro Event"],
          ["team", "Pro Team"],
        ].map(([mode, label]) => {
          const isSelected = viewMode === mode;

          return (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              style={{
                padding: "10px 14px",
                borderRadius: 999,
                border: `1px solid ${isSelected ? "#38bdf8" : "#334155"}`,
                background: isSelected ? "#082f49" : "#020617",
                color: isSelected ? "#e0f2fe" : "#cbd5e1",
                fontWeight: 700,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <label style={{ display: "grid", gap: 8, marginBottom: 16 }}>
        <span style={{ color: "#cbd5e1", fontWeight: 700 }}>
          {viewMode === "event" ? "Event suchen" : "Team suchen"}
        </span>
        <input
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder={viewMode === "event" ? "Nach Quizname, Code oder Datum suchen" : "Nach Teamname suchen"}
          style={inputStyle}
        />
      </label>

      {viewMode === "event" ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isNarrow ? "1fr" : "minmax(260px, 0.95fr) minmax(0, 1.45fr)",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div style={{ display: "grid", gap: 10 }}>
            {visibleEventSummaries.length === 0 ? (
              <p style={{ color: "#94a3b8" }}>
                Kein Gutschein-Event zu dieser Suche gefunden.
              </p>
            ) : (
              visibleEventSummaries.map((event) => {
                const isSelected = selectedEvent?.eventId === event.eventId;
                const voucherCount = allEffectiveVouchers.filter(
                  (voucher) => voucher.eventId === event.eventId,
                ).length;

                return (
                  <button
                    key={event.eventId}
                    type="button"
                    onClick={() => setSelectedEventId(event.eventId)}
                    style={{
                      padding: 12,
                      border: `1px solid ${isSelected ? "#38bdf8" : "#1f2937"}`,
                      borderRadius: 12,
                      background: isSelected ? "#082f49" : "#0b1220",
                      color: "#e5e7eb",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <strong>{event.quizLabel || event.quizCode || event.eventId}</strong>
                    <span
                      style={{
                        display: "block",
                        marginTop: 6,
                        color: "#bfdbfe",
                        fontSize: 13,
                        fontWeight: 700,
                      }}
                    >
                      Gespielt am {formatCompletionDate(event.awardedAt)}
                    </span>
                    <span style={{ display: "block", marginTop: 4, color: "#94a3b8" }}>
                      {voucherCount}/3 Gutscheine - {sessionCountByEvent.get(event.eventId) || 0} Teams
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {selectedEvent && (
            <div
              style={{
                padding: 16,
                border: "1px solid #334155",
                borderRadius: 14,
                background: "#0b1220",
              }}
            >
              <h3 style={{ marginTop: 0 }}>{selectedEvent.quizLabel || "Pubquiz"}</h3>
              <p style={{ color: "#cbd5e1" }}>
                Code <strong>{selectedEvent.quizCode || "?"}</strong>
              </p>
              <p
                style={{
                  marginTop: 8,
                  marginBottom: 0,
                  color: "#bfdbfe",
                  fontWeight: 700,
                  fontSize: 16,
                }}
              >
                Gespielt am {formatCompletionDate(selectedEvent.awardedAt)}
              </p>

              {canEditEventRankings && (
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                    marginTop: 16,
                    marginBottom: 18,
                  }}
                >
                  <button
                    type="button"
                    onClick={handleSaveSelectedEventRanking}
                    disabled={eventRankingBusy || !selectedEventSessions.length || !hasUnsavedEventRankingOrder}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 12,
                      border: "1px solid #0f766e",
                      background:
                        eventRankingBusy || !selectedEventSessions.length || !hasUnsavedEventRankingOrder
                          ? "#0f172a"
                          : "#134e4a",
                      color:
                        eventRankingBusy || !selectedEventSessions.length || !hasUnsavedEventRankingOrder
                          ? "#64748b"
                          : "#ccfbf1",
                      fontWeight: 700,
                      cursor:
                        eventRankingBusy || !selectedEventSessions.length || !hasUnsavedEventRankingOrder
                          ? "not-allowed"
                          : "pointer",
                    }}
                  >
                    Tagesranking speichern
                  </button>
                  <span style={{ color: "#94a3b8", fontSize: 13 }}>
                    Jeder Admin kann hier das gespeicherte Tagesranking fuer dieses
                    Pubquiz direkt korrigieren.
                  </span>
                </div>
              )}

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isNarrow ? "1fr" : "1fr 120px auto",
                  gap: 10,
                  marginTop: 16,
                  padding: 14,
                  border: "1px solid #1f2937",
                  borderRadius: 12,
                  background: "#020617",
                }}
              >
                <label style={{ display: "grid", gap: 6 }}>
                  <span>Team fuer Gutschein</span>
                  <select
                    disabled={!canEditVouchers}
                    value={selectedCreateTeamId}
                    onChange={(event) => setSelectedCreateTeamId(event.target.value)}
                    style={inputStyle}
                  >
                    {selectedEventSessions.map((team) => (
                      <option key={team.teamId || team.id} value={team.teamId || team.id}>
                        {team.teamName} - {team.totalPoints || 0} Punkte
                        {team.rankDaily ? ` - Platz ${team.rankDaily}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6 }}>
                  <span>Platz</span>
                  <select
                    disabled={!canEditVouchers}
                    value={selectedCreateRank}
                    onChange={(event) => setSelectedCreateRank(event.target.value)}
                    style={inputStyle}
                  >
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!canEditVouchers || !selectedEventSessions.length}
                  onClick={handleCreateVoucher}
                  style={{
                    alignSelf: "end",
                    padding: "12px 16px",
                    border: "none",
                    borderRadius: 12,
                    background:
                      canEditVouchers && selectedEventSessions.length ? "#22c55e" : "#334155",
                    color:
                      canEditVouchers && selectedEventSessions.length ? "#0b1220" : "#94a3b8",
                    fontWeight: 700,
                    cursor:
                      canEditVouchers && selectedEventSessions.length ? "pointer" : "not-allowed",
                  }}
                >
                  Gutschein anlegen
                </button>
              </div>

              <h4 style={{ marginBottom: 10 }}>Aktuelle Gutscheine</h4>
              {selectedEventVouchers.length === 0 ? (
                <p style={{ color: "#94a3b8" }}>
                  Fuer dieses Event wurden noch keine Gutscheine erfasst.
                </p>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {selectedEventVouchers.map((voucher) => {
                    const sourceSession = selectedEventSessions.find(
                      (session) => (session.teamId || session.id) === voucher.teamId,
                    );

                    return (
                      <article
                        key={voucher.id}
                        style={{
                          padding: 12,
                          border: "1px solid #1f2937",
                          borderRadius: 12,
                          background: "#020617",
                        }}
                      >
                        <strong>
                          Platz {voucher.rank}: {voucher.teamName}
                        </strong>
                        <span style={{ display: "block", marginTop: 6, color: "#cbd5e1" }}>
                          {voucher.title} - {voucher.description}
                        </span>
                        <span
                          style={{
                            display: "block",
                            marginTop: 6,
                            color: "#bfdbfe",
                            fontWeight: 700,
                          }}
                        >
                          Gespielt am {formatCompletionDate(voucher.awardedAt)}
                        </span>
                        <span style={{ display: "block", marginTop: 6, color: "#94a3b8" }}>
                          {voucher.totalPoints || 0} Punkte - Status{" "}
                          <strong>
                            {voucher.status === "redeemed"
                              ? "eingeloest"
                              : voucher.status === "requested"
                                ? "angefragt"
                                : "offen"}
                          </strong>
                          {voucher.isManualAssignment
                            ? " - manuell gesetzt"
                            : " - gespeichert"}
                        </span>
                        {renderVoucherActions(voucher, sourceSession)}
                      </article>
                    );
                  })}
                </div>
              )}

              <h4 style={{ marginBottom: 10, marginTop: 18 }}>Event-Teams</h4>
              {selectedEventSessions.length === 0 ? (
                <p style={{ color: "#94a3b8" }}>
                  Zu diesem Event wurden noch keine Teams gefunden.
                </p>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {selectedEventSessions.map((team) => (
                    <div
                      key={team.teamId || team.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          canEditEventRankings
                            ? isNarrow
                              ? "1fr"
                              : "1fr auto auto auto"
                            : isNarrow
                              ? "1fr"
                              : "1fr auto auto",
                        gap: 10,
                        padding: 10,
                        border: "1px solid #1f2937",
                        borderRadius: 10,
                        background: "#020617",
                      }}
                    >
                      <strong>{team.teamName}</strong>
                      <span style={{ color: "#cbd5e1" }}>{team.totalPoints || 0} Punkte</span>
                      <span style={{ color: "#94a3b8" }}>
                        {team.rankDaily ? `Platz ${team.rankDaily}` : "ohne Platz"}
                      </span>
                      {canEditEventRankings && (
                        <div
                          style={{
                            display: "grid",
                            gap: 6,
                            justifyItems: "end",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => moveSelectedEventTeam(team.teamId || team.id, -1)}
                            disabled={
                              eventRankingBusy ||
                              (selectedEventSessions[0]?.teamId || selectedEventSessions[0]?.id) ===
                                (team.teamId || team.id)
                            }
                            style={{
                              minWidth: 44,
                              padding: "8px 10px",
                              borderRadius: 10,
                              border: "1px solid #334155",
                              background: "#1e293b",
                              color: "#e2e8f0",
                              fontWeight: 700,
                              cursor: "pointer",
                            }}
                          >
                            Hoch
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSelectedEventTeam(team.teamId || team.id, 1)}
                            disabled={
                              eventRankingBusy ||
                              (selectedEventSessions[selectedEventSessions.length - 1]?.teamId ||
                                selectedEventSessions[selectedEventSessions.length - 1]?.id) ===
                                (team.teamId || team.id)
                            }
                            style={{
                              minWidth: 44,
                              padding: "8px 10px",
                              borderRadius: 10,
                              border: "1px solid #334155",
                              background: "#1e293b",
                              color: "#e2e8f0",
                              fontWeight: 700,
                              cursor: "pointer",
                            }}
                          >
                            Runter
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isNarrow ? "1fr" : "minmax(260px, 0.95fr) minmax(0, 1.45fr)",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div style={{ display: "grid", gap: 10 }}>
            {visibleVoucherTeams.length === 0 ? (
              <p style={{ color: "#94a3b8" }}>
                Kein Team mit Gutscheinen zu dieser Suche gefunden.
              </p>
            ) : (
              visibleVoucherTeams.map((team) => {
                const isSelected = selectedTeam?.id === team.id;
                const voucherCount = allEffectiveVouchers.filter(
                  (voucher) => voucher.teamId === team.id,
                ).length;

                return (
                  <button
                    key={team.id}
                    type="button"
                    onClick={() => setSelectedTeamId(team.id)}
                    style={{
                      padding: 12,
                      border: `1px solid ${isSelected ? "#38bdf8" : "#1f2937"}`,
                      borderRadius: 12,
                      background: isSelected ? "#082f49" : "#0b1220",
                      color: "#e5e7eb",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <strong>{team.teamName}</strong>
                    <span
                      style={{
                        display: "block",
                        marginTop: 6,
                        color: "#bfdbfe",
                        fontSize: 13,
                        fontWeight: 700,
                      }}
                    >
                      Letzter Gewinn:{" "}
                      {voucherLatestPlayedByTeam.get(team.id)
                        ? formatCompletionDate(voucherLatestPlayedByTeam.get(team.id))
                        : "unbekannt"}
                    </span>
                    <span style={{ display: "block", marginTop: 4, color: "#94a3b8" }}>
                      {voucherCount} Gutschein{voucherCount === 1 ? "" : "e"} -{" "}
                      {(team.gamesPlayed ?? team.sessions.length)} Teilnahmen
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {selectedTeam && (
            <div
              style={{
                padding: 16,
                border: "1px solid #334155",
                borderRadius: 14,
                background: "#0b1220",
              }}
            >
              <h3 style={{ marginTop: 0 }}>{selectedTeam.teamName}</h3>
              <p style={{ color: "#cbd5e1" }}>
                Teilnahmen <strong>{selectedTeam.gamesPlayed ?? selectedTeam.sessions.length}</strong>
              </p>
              <p
                style={{
                  marginTop: 8,
                  marginBottom: 0,
                  color: "#bfdbfe",
                  fontWeight: 700,
                  fontSize: 16,
                }}
              >
                Letzter Gewinn:{" "}
                {voucherLatestPlayedByTeam.get(selectedTeam.id)
                  ? formatCompletionDate(voucherLatestPlayedByTeam.get(selectedTeam.id))
                  : "unbekannt"}
              </p>
              {selectedTeamVouchers.length === 0 ? (
                <p style={{ color: "#94a3b8" }}>Dieses Team hat bisher keinen Gutschein.</p>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {selectedTeamVouchers.map((voucher) => {
                    const sourceSession = (selectedTeam.sessions || []).find(
                      (session) =>
                        session.id === voucher.sourceSessionId ||
                        getVoucherIdForSession(session) === voucher.id,
                    );

                    return (
                      <article
                        key={voucher.id}
                        style={{
                          padding: 12,
                          border: "1px solid #1f2937",
                          borderRadius: 12,
                          background: "#020617",
                        }}
                      >
                        <strong>
                          {voucher.quizLabel} - Platz {voucher.rank}
                        </strong>
                        <span style={{ display: "block", marginTop: 6, color: "#cbd5e1" }}>
                          {voucher.title}
                        </span>
                        <span
                          style={{
                            display: "block",
                            marginTop: 6,
                            color: "#bfdbfe",
                            fontWeight: 700,
                          }}
                        >
                          Gespielt am {formatCompletionDate(voucher.awardedAt)}
                        </span>
                        <span style={{ display: "block", marginTop: 6, color: "#94a3b8" }}>
                          {voucher.totalPoints || 0} Punkte - Status{" "}
                          <strong>
                            {voucher.status === "redeemed"
                              ? "eingeloest"
                              : voucher.status === "requested"
                                ? "angefragt"
                                : "offen"}
                          </strong>
                        </span>
                        {renderVoucherActions(voucher, sourceSession)}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {voucherMessage && <p style={{ color: "#93c5fd", marginTop: 14 }}>{voucherMessage}</p>}
    </section>
  );
}

function TeamDirectory({
  activeManager,
  allVoucherDocs = [],
  globalRankingRows = [],
  onSubmitManagerAnswerForTeam,
  onUpdateTeamQuestionScore,
  onUpdateTeamScore,
  onUpdateVoucherStatus,
  pubQuizzes,
  teamProfiles,
  teams,
}) {
  const [selectedTeamId, setSelectedTeamId] = useState(null);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [selectedAnswerRoundId, setSelectedAnswerRoundId] = useState(null);
  const [selectedTeamHistorySessions, setSelectedTeamHistorySessions] = useState([]);
  const [teamSearch, setTeamSearch] = useState("");
  const [voucherMessage, setVoucherMessage] = useState("");
  const [scoreMessage, setScoreMessage] = useState("");
  const [questionMessages, setQuestionMessages] = useState({});
  const [editingSession, setEditingSession] = useState(null);
  const scoreInputRef = useRef(null);
  const scoreNoteInputRef = useRef(null);
  const questionAnswerInputRefs = useRef({});
  const questionScoreInputRefs = useRef({});
  const questionNoteInputRefs = useRef({});
  const isNarrow = useIsNarrowScreen();
  const globalRankingMap = useMemo(
    () => new Map(globalRankingRows.map((row) => [row.teamId, row])),
    [globalRankingRows],
  );
  const teamVoucherMap = new Map();

  allVoucherDocs.forEach((voucher) => {
    const voucherTeamId = voucher.teamId;
    if (!voucherTeamId) return;
    teamVoucherMap.set(voucherTeamId, [
      ...(teamVoucherMap.get(voucherTeamId) || []),
      voucher,
    ]);
  });

  const sortedTeams = useMemo(
    () =>
      aggregateTeamDirectory(teams, teamProfiles)
        .filter((team) => {
          if (team.rankingOptIn || team.rankingPassword) return true;

          const derivedVouchers = buildVoucherEntries(
            team.sessions || [],
            allVoucherDocs,
            pubQuizzes,
            { visibleTeamId: team.id },
          );

          if (derivedVouchers.length === 0) return false;

          return derivedVouchers.some((voucher) => voucher.status !== "redeemed");
        })
        .map((team) => {
          const globalRow = globalRankingMap.get(team.teamNameNormalized || team.id);

          if (!globalRow) return team;

          return {
            ...team,
            sessions: team.sessions || [],
            totalPoints: Number(globalRow.totalGlobalPoints) || team.totalPoints || 0,
            totalDailyPoints: Number(globalRow.totalDailyPoints) || 0,
            gamesPlayed: Number(globalRow.gamesPlayed) || team.sessions.length || 0,
          };
        }),
    [allVoucherDocs, globalRankingMap, pubQuizzes, teamProfiles, teams],
  );
  const normalizedTeamSearch = normalizeTeamName(teamSearch || "");
  const visibleTeams = useMemo(
    () =>
      sortedTeams.filter((team) => {
        if (!normalizedTeamSearch) return true;

        return (
          normalizeTeamName(team.teamName || "").includes(normalizedTeamSearch) ||
          (team.teamNameNormalized || "").includes(normalizedTeamSearch)
        );
      }),
    [normalizedTeamSearch, sortedTeams],
  );
  const selectedTeam = useMemo(
    () => visibleTeams.find((team) => team.id === selectedTeamId) || visibleTeams[0],
    [selectedTeamId, visibleTeams],
  );
  const selectedSessions = useMemo(
    () =>
      selectedTeamHistorySessions.length > 0
        ? selectedTeamHistorySessions
        : selectedTeam?.sessions || [],
    [selectedTeam?.sessions, selectedTeamHistorySessions],
  );
  const selectedTeamVouchers = useMemo(
    () =>
      buildVoucherEntries(selectedSessions, allVoucherDocs, pubQuizzes, {
        visibleTeamId: selectedTeam?.id || null,
      }),
    [allVoucherDocs, pubQuizzes, selectedSessions, selectedTeam?.id],
  );
  const selectedSession = useMemo(
    () =>
      selectedSessions.find((session) => session.sessionKey === selectedSessionId) ||
      selectedSessions[0],
    [selectedSessionId, selectedSessions],
  );
  const selectedSessionKey = selectedSession?.sessionKey || selectedSession?.id || "";
  const editingSessionKey = editingSession?.sessionKey || editingSession?.id || "";
  const activeSession = editingSessionKey === selectedSessionKey ? editingSession : selectedSession;
  const selectedPubQuiz = useMemo(
    () => findPubQuizForSession(activeSession, pubQuizzes),
    [activeSession, pubQuizzes],
  );
  const selectedQuiz = useMemo(
    () => createRuntimeQuizFromPubQuiz(selectedPubQuiz),
    [selectedPubQuiz],
  );
  const selectedQuizQuestionsByRound = useMemo(
    () =>
      selectedQuiz.quizRounds.map((round) => ({
        ...round,
        questions: round.questionIds
          .map((questionId) => {
            const question = selectedQuiz.questions[questionId];

            if (!question) return null;

            return {
              ...question,
              roundId: round.id,
              roundTitle: round.title,
            };
          })
          .filter(Boolean),
      })),
    [selectedQuiz],
  );
  const selectedQuestionRound = useMemo(
    () =>
      selectedQuizQuestionsByRound.find((round) => round.id === selectedAnswerRoundId) ||
      selectedQuizQuestionsByRound[0] ||
      null,
    [selectedAnswerRoundId, selectedQuizQuestionsByRound],
  );
  const selectedQuizQuestions = useMemo(
    () => selectedQuestionRound?.questions || [],
    [selectedQuestionRound],
  );
  const canEditScores = Boolean(canManagerEditScores(activeManager) && onUpdateTeamScore);

  useEffect(() => {
    if (!visibleTeams.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(visibleTeams[0]?.id || null);
      setSelectedSessionId(null);
    }
  }, [selectedTeamId, visibleTeams]);

  useEffect(() => {
    if (!selectedTeam?.id) {
      setSelectedTeamHistorySessions([]);
      return undefined;
    }

    let cancelled = false;

    async function loadSelectedTeamHistory() {
      try {
        const normalizedTeamId = selectedTeam.teamNameNormalized || selectedTeam.id;
        const sessionsSnapshot = await getDocs(collectionGroup(db, "teamSessions"));

        if (cancelled) return;

        const sessions = sessionsSnapshot.docs
          .map((snapshot) => {
            const data = snapshot.data();
            const sessionTeamKey =
              data.teamNameNormalized ||
              data.teamId ||
              normalizeTeamName(data.teamName || "");

            if (data.quizId !== latestQuizId) return null;
            if (sessionTeamKey !== normalizedTeamId) return null;

            return {
              id: snapshot.id,
              sessionKey: `${data.eventId || "event"}__${snapshot.id}`,
              ...data,
            };
          })
          .filter(Boolean)
          .sort((a, b) => {
            const timeDifference =
              getTimestampMs(getCompletionValue(b)) - getTimestampMs(getCompletionValue(a));
            return timeDifference || (a.teamName || "").localeCompare(b.teamName || "");
          });

        setSelectedTeamHistorySessions(sessions);
      } catch (error) {
        console.error("TEAM DIRECTORY HISTORY LOAD ERROR:", error);
        if (!cancelled) {
          setSelectedTeamHistorySessions(selectedTeam?.sessions || []);
        }
      }
    }

    loadSelectedTeamHistory();

    return () => {
      cancelled = true;
    };
  }, [selectedTeam?.id]);

  useEffect(() => {
    setSelectedAnswerRoundId(selectedQuizQuestionsByRound[0]?.id || null);
  }, [activeSession?.id, selectedPubQuiz?.id]);

  useEffect(() => {
    if (!selectedSession) {
      setEditingSession(null);
      setScoreMessage("");
      setQuestionMessages({});
      return;
    }
    setEditingSession({
      ...selectedSession,
      answers: { ...(selectedSession.answers || {}) },
    });
    setScoreMessage("");
    setQuestionMessages({});
  }, [selectedSessionKey]);

  useEffect(() => {
    setScoreMessage("");
    setQuestionMessages({});
  }, [selectedQuestionRound?.id, selectedSessionKey]);

  async function handleScoreSave() {
    if (!selectedTeam || !activeSession || !canEditScores) return;

    const result = await onUpdateTeamScore({
      lobbyCode: activeSession.lobbyCode || activeSession.quizCode,
      nextTotalPoints: scoreInputRef.current?.value ?? "0",
      note: scoreNoteInputRef.current?.value ?? "",
      teamId: activeSession.teamId || activeSession.id,
      teamName: activeSession.teamName || selectedTeam.teamName,
    });

    setScoreMessage(result.message);
    if (result.ok) {
      setEditingSession((currentSession) =>
        currentSession
          ? {
              ...currentSession,
              scoreAdjustment: {
                ...(currentSession.scoreAdjustment || {}),
                note: scoreNoteInputRef.current?.value ?? "",
              },
              totalPoints: Number(scoreInputRef.current?.value ?? currentSession.totalPoints ?? 0),
            }
          : currentSession,
      );
    }
  }

  async function handleQuestionScoreSave(question) {
    if (!selectedTeam || !activeSession || !canEditScores || !onUpdateTeamQuestionScore) {
      return;
    }

    const result = await onUpdateTeamQuestionScore({
      lobbyCode: activeSession.lobbyCode || activeSession.quizCode,
      nextPointsAwarded: questionScoreInputRefs.current[question.id]?.value ?? "0",
      note: questionNoteInputRefs.current[question.id]?.value ?? "",
      questionId: question.id,
      questionTitle: question.title,
      teamId: activeSession.teamId || activeSession.id,
      teamName: activeSession.teamName || selectedTeam.teamName,
    });

    setQuestionMessages((current) => ({
      ...current,
      [question.id]: result.message,
    }));
    if (result.ok) {
      setEditingSession((currentSession) => {
        if (!currentSession) return currentSession;
        const currentAnswers = currentSession.answers || {};

        return {
          ...currentSession,
          answers: {
            ...currentAnswers,
            [question.id]: {
              ...(currentAnswers[question.id] || {}),
              pointsAwarded: Number(
                questionScoreInputRefs.current[question.id]?.value ??
                  currentAnswers[question.id]?.pointsAwarded ??
                  0,
              ),
              manualOverride: {
                ...(currentAnswers[question.id]?.manualOverride || {}),
                note: questionNoteInputRefs.current[question.id]?.value ?? "",
              },
            },
          },
        };
      });
    }
  }

  async function handleManagerAnswerSave(question) {
    if (!selectedTeam || !activeSession || !canEditScores || !onSubmitManagerAnswerForTeam) {
      return;
    }

    const result = await onSubmitManagerAnswerForTeam({
      answerText: questionAnswerInputRefs.current[question.id]?.value ?? "",
      lobbyCode: activeSession.lobbyCode || activeSession.quizCode,
      note: questionNoteInputRefs.current[question.id]?.value ?? "",
      question,
      teamId: activeSession.teamId || activeSession.id,
      teamName: activeSession.teamName || selectedTeam.teamName,
    });

    setQuestionMessages((current) => ({
      ...current,
      [question.id]: result.message,
    }));
    if (result.ok) {
      setEditingSession((currentSession) => {
        if (!currentSession) return currentSession;
        const currentAnswers = currentSession.answers || {};

        return {
          ...currentSession,
          answers: {
            ...currentAnswers,
            [question.id]: {
              ...(currentAnswers[question.id] || {}),
              managerOverride: {
                ...(currentAnswers[question.id]?.managerOverride || {}),
                active: true,
                note: questionNoteInputRefs.current[question.id]?.value ?? "",
              },
              text: questionAnswerInputRefs.current[question.id]?.value ?? "",
            },
          },
        };
      });
    }
  }

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Teamarchiv</h2>
      <p style={{ marginTop: 0, color: "#94a3b8" }}>
        Ranking-Teams und Podiums-Teams mit ihren bisherigen Pubquiz-Teilnahmen im Überblick.
      </p>
      <label style={{ display: "grid", gap: 8, marginBottom: 16 }}>
        <span style={{ color: "#cbd5e1", fontWeight: 700 }}>Team suchen</span>
        <input
          value={teamSearch}
          onChange={(event) => setTeamSearch(event.target.value)}
          placeholder="Nach Teamname suchen"
          style={inputStyle}
        />
      </label>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isNarrow
            ? "1fr"
            : "minmax(260px, 1fr) minmax(280px, 1.2fr)",
          gap: 16,
        }}
      >
        <div style={{ display: "grid", gap: 10, alignSelf: "start" }}>
          {sortedTeams.length === 0 ? (
            <p style={{ color: "#94a3b8" }}>Noch keine Teams registriert.</p>
          ) : visibleTeams.length === 0 ? (
            <p style={{ color: "#94a3b8" }}>Kein Team zu dieser Suche gefunden.</p>
          ) : (
            visibleTeams.map((team) => {
              const isSelected = selectedTeam?.id === team.id;

              return (
                <button
                  key={team.id}
                  onClick={() => {
                    setSelectedTeamId(team.id);
                    setSelectedSessionId(null);
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: isNarrow ? "1fr" : "1fr auto",
                    gap: 12,
                    alignItems: "center",
                    padding: 12,
                    border: `1px solid ${isSelected ? "#38bdf8" : "#1f2937"}`,
                    borderRadius: 12,
                    background: isSelected ? "#082f49" : "#0b1220",
                    color: "#e5e7eb",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span>
                    <strong>{team.teamName}</strong>
                    <br />
                    <span style={{ color: "#94a3b8" }}>
                      {(team.gamesPlayed ?? team.sessions.length)} PQ
                      {(team.gamesPlayed ?? team.sessions.length) === 1 ? "" : "ze"} -{" "}
                      {team.rankingOptIn ? "Jahresranking" : "nur Tagesranking"}
                    </span>
                  </span>
                  <strong>{team.totalPoints || 0} Punkte</strong>
                </button>
              );
            })
          )}
        </div>

        {selectedTeam && (
          <div
            style={{
              padding: 16,
              border: "1px solid #334155",
              borderRadius: 14,
              background: "#0b1220",
            }}
          >
            <h3 style={{ marginTop: 0 }}>{selectedTeam.teamName}</h3>
            <p style={{ color: "#cbd5e1" }}>
              Normalisiert:{" "}
              <strong>{selectedTeam.teamNameNormalized || "nicht gesetzt"}</strong>
            </p>
            <p style={{ color: "#cbd5e1" }}>
              Punkte gesamt: <strong>{selectedTeam.totalPoints || 0}</strong> -{" "}
              Teilnahmen <strong>{selectedTeam.gamesPlayed ?? selectedTeam.sessions.length}</strong>
            </p>
            <p style={{ color: "#cbd5e1" }}>
              Jahresranking:{" "}
              <strong>{selectedTeam.rankingOptIn ? "Ja" : "Nein"}</strong>
            </p>
            {selectedTeam.rankingOptIn && (
              <p style={{ color: "#cbd5e1" }}>
                Team-Passwort:{" "}
                <strong>{selectedTeam.rankingPassword || "noch nicht vergeben"}</strong>
              </p>
            )}

            <h4>Gutscheine</h4>
            {selectedTeamVouchers.length === 0 ? (
              <p style={{ color: "#94a3b8" }}>
                Dieses Team hat bisher keinen Podiums-Gutschein gewonnen.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {selectedTeamVouchers.map((voucher) => (
                  <div
                    key={voucher.id}
                    style={{
                      padding: 12,
                      border: "1px solid #1f2937",
                      borderRadius: 12,
                      background: "#020617",
                    }}
                  >
                    <strong style={{ display: "block" }}>
                      {voucher.title} - {voucher.quizLabel}
                    </strong>
                    <span style={{ display: "block", marginTop: 6, color: "#cbd5e1" }}>
                      {voucher.description}
                    </span>
                    <span style={{ display: "block", marginTop: 6, color: "#94a3b8" }}>
                      Platz {voucher.rank} - Status{" "}
                      <strong>
                        {voucher.status === "redeemed"
                          ? "eingeloest"
                          : voucher.status === "requested"
                            ? "angefragt"
                            : "offen"}
                      </strong>
                    </span>
                    {activeManager && onUpdateVoucherStatus && voucher.status !== "redeemed" && (
                      <button
                        onClick={async () => {
                          const result = await onUpdateVoucherStatus({
                            voucher,
                            nextStatus: "redeemed",
                            sourceSession: selectedSessions.find(
                              (session) => getVoucherIdForSession(session) === voucher.id,
                            ),
                            teamId: selectedTeam.id,
                            teamName: selectedTeam.teamName,
                          });
                          setVoucherMessage(result.message);
                        }}
                        style={{ marginTop: 10 }}
                      >
                        Als eingelöst markieren
                      </button>
                    )}
                    {activeManager?.headManager &&
                      onUpdateVoucherStatus &&
                      voucher.status === "redeemed" && (
                        <button
                          onClick={async () => {
                            const result = await onUpdateVoucherStatus({
                              voucher,
                              nextStatus: "earned",
                              sourceSession: selectedSessions.find(
                                (session) => getVoucherIdForSession(session) === voucher.id,
                              ),
                              teamId: selectedTeam.id,
                              teamName: selectedTeam.teamName,
                            });
                            setVoucherMessage(result.message);
                          }}
                          style={{
                            marginTop: 10,
                            background: "#1e293b",
                            color: "#e2e8f0",
                          }}
                        >
                          Einlösung zurücknehmen
                        </button>
                      )}
                  </div>
                ))}
              </div>
            )}
            {voucherMessage && (
              <p style={{ color: "#93c5fd", marginTop: 10 }}>{voucherMessage}</p>
            )}

            <h4>Mitglieder</h4>
            <div style={{ display: "grid", gap: 8 }}>
              {Array.from(
                new Set([
                  ...(selectedTeam.playerNames || []),
                  selectedTeam.playerName,
                ].filter(Boolean)),
              ).map((personName) => (
                <div
                  key={personName}
                  style={{
                    display: "grid",
                    gridTemplateColumns: isNarrow ? "1fr" : "1fr 1fr",
                    gap: 10,
                    padding: 10,
                    border: "1px solid #1f2937",
                    borderRadius: 10,
                    background: "#020617",
                  }}
                >
                  <span>{personName}</span>
                  <span style={{ color: "#94a3b8" }}>
                    {normalizePersonName(personName) || "anonym"}
                  </span>
                </div>
              ))}
            </div>

            <h4>Vergangene Pubquizzes</h4>
            <div style={{ display: "grid", gap: 8 }}>
              {selectedSessions.length === 0 ? (
                <p style={{ margin: 0, color: "#94a3b8" }}>
                  Noch kein Quiz gespeichert.
                </p>
              ) : (
                selectedSessions.map((session) => {
                  const isSelected = selectedSession?.id === session.id;

                  return (
                    <button
                      key={session.sessionKey || `${session.eventId || "event"}__${session.id}`}
                      onClick={() =>
                        setSelectedSessionId(
                          session.sessionKey || `${session.eventId || "event"}__${session.id}`,
                        )
                      }
                      style={{
                        display: "grid",
                        gridTemplateColumns: isNarrow ? "1fr" : "1fr auto",
                        gap: 12,
                        alignItems: "center",
                        padding: 10,
                        border: `1px solid ${isSelected ? "#38bdf8" : "#1f2937"}`,
                        borderRadius: 10,
                        background: isSelected ? "#082f49" : "#020617",
                        color: "#e5e7eb",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span>
                        <strong>{getQuizLabelForSession(session, pubQuizzes)}</strong>
                        <br />
                        <span style={{ color: "#94a3b8" }}>
                          {formatCompletionDate(getCompletionValue(session))} - Code{" "}
                          {session.quizCode || session.lobbyCode || "?"}
                        </span>
                      </span>
                      <strong>{session.totalPoints || 0} Punkte</strong>
                    </button>
                  );
                })
              )}
            </div>

            {activeSession && (
              <>
                <h4>Teilnahme-Details</h4>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: isNarrow ? "1fr" : "repeat(2, minmax(0, 1fr))",
                    gap: 10,
                    marginBottom: 14,
                  }}
                >
                  <div
                    style={{
                      padding: 12,
                      border: "1px solid #1f2937",
                      borderRadius: 10,
                      background: "#020617",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: 6 }}>Quiz</strong>
                    <span style={{ color: "#cbd5e1" }}>
                      {getQuizLabelForSession(activeSession, pubQuizzes)}
                    </span>
                  </div>
                  <div
                    style={{
                      padding: 12,
                      border: "1px solid #1f2937",
                      borderRadius: 10,
                      background: "#020617",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: 6 }}>Ranking</strong>
                    <span style={{ color: "#cbd5e1" }}>
                      {activeSession.rankingOptIn ? "Globales Ranking" : "Nur heute"}
                    </span>
                  </div>
                  <div
                    style={{
                      padding: 12,
                      border: "1px solid #1f2937",
                      borderRadius: 10,
                      background: "#020617",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: 6 }}>Punkte</strong>
                    <span style={{ color: "#cbd5e1" }}>{activeSession.totalPoints || 0}</span>
                    {activeSession.scoreAdjustment?.active && (
                      <span style={{ display: "block", marginTop: 6, color: "#fbbf24", fontWeight: 700 }}>
                        manuell geaendert
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      padding: 12,
                      border: "1px solid #1f2937",
                      borderRadius: 10,
                      background: "#020617",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: 6 }}>Tagesplatz</strong>
                    <span style={{ color: "#cbd5e1" }}>
                      {activeSession.rankDaily ? `${activeSession.rankDaily}. Platz` : "nicht gespeichert"}
                    </span>
                  </div>
                  <div
                    style={{
                      padding: 12,
                      border: "1px solid #1f2937",
                      borderRadius: 10,
                      background: "#020617",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: 6 }}>Mitgespielt von</strong>
                    <span style={{ color: "#cbd5e1" }}>
                      {Array.from(
                        new Set(
                          [
                            ...(activeSession.playerNames || []),
                            activeSession.playerName,
                          ].filter(Boolean),
                        ),
                      ).join(", ") || "keine Namen gespeichert"}
                    </span>
                  </div>
                </div>

                {activeSession.scoreAdjustment?.active && (
                  <div
                    style={{
                      marginBottom: 16,
                      padding: 12,
                      border: "1px solid #92400e",
                      borderRadius: 10,
                      background: "#1c1917",
                      color: "#fde68a",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: 4 }}>
                      Punkte wurden manuell angepasst
                    </strong>
                    <span>
                      Von {activeSession.scoreAdjustment.adjustedBy || "Manager"}
                      {activeSession.scoreAdjustment.previousPoints !== undefined
                        ? ` (${activeSession.scoreAdjustment.previousPoints} -> ${activeSession.totalPoints || 0})`
                        : ""}
                    </span>
                    {activeSession.scoreAdjustment.note && (
                      <span style={{ display: "block", marginTop: 6 }}>
                        Notiz: {activeSession.scoreAdjustment.note}
                      </span>
                    )}
                  </div>
                )}

                {canEditScores && (
                  <div
                    style={{
                      display: "grid",
                      gap: 10,
                      marginBottom: 16,
                      padding: 12,
                      border: "1px solid #334155",
                      borderRadius: 10,
                      background: "#020617",
                    }}
                  >
                    <strong>Punkte manuell korrigieren</strong>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span style={{ color: "#cbd5e1" }}>Neuer Gesamtpunktestand</span>
                      <input
                        key={`score__${activeSession.sessionKey || activeSession.id}`}
                        defaultValue={String(Number(activeSession.totalPoints) || 0)}
                        ref={scoreInputRef}
                        inputMode="numeric"
                        style={inputStyle}
                      />
                    </label>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span style={{ color: "#cbd5e1" }}>Notiz fuer Manager</span>
                      <input
                        key={`score-note__${activeSession.sessionKey || activeSession.id}`}
                        defaultValue={activeSession.scoreAdjustment?.note || ""}
                        ref={scoreNoteInputRef}
                        placeholder="z. B. Bewertungsfehler bei Frage 4"
                        style={inputStyle}
                      />
                    </label>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button
                        onClick={handleScoreSave}
                        style={{
                          padding: "10px 14px",
                          borderRadius: 12,
                          border: "none",
                          background: "#f59e0b",
                          color: "#111827",
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        Punkte speichern
                      </button>
                      {scoreMessage && (
                        <span style={{ alignSelf: "center", color: "#93c5fd" }}>
                          {scoreMessage}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {(selectedPubQuiz?.tiebreakerQuestion ||
                  Number.isFinite(Number(selectedPubQuiz?.tiebreakerAnswer))) && (
                  <section
                    style={{
                      marginBottom: 16,
                      padding: 14,
                      border: "1px solid #334155",
                      borderRadius: 12,
                      background: "#08111d",
                    }}
                  >
                    <strong style={{ display: "block", color: "#93c5fd", marginBottom: 8 }}>
                      Schätzfrage
                    </strong>
                    {selectedPubQuiz?.tiebreakerQuestion && (
                      <p style={{ margin: "0 0 8px", color: "#e5e7eb", fontWeight: 700 }}>
                        {selectedPubQuiz.tiebreakerQuestion}
                      </p>
                    )}
                    <p style={{ margin: "0 0 6px", color: "#cbd5e1" }}>
                      Team-Antwort:{" "}
                      <strong>
                        {activeSession.tiebreaker?.estimate ??
                          activeSession.tiebreakerEstimate ??
                          activeSession.tiebreakerGuess ??
                          "nicht gespeichert"}
                      </strong>
                    </p>
                    <p style={{ margin: 0, color: "#94a3b8" }}>
                      Richtige Antwort:{" "}
                      <strong style={{ color: "#e5e7eb" }}>
                        {Number.isFinite(Number(selectedPubQuiz?.tiebreakerAnswer))
                          ? selectedPubQuiz.tiebreakerAnswer
                          : "noch nicht gespeichert"}
                      </strong>
                    </p>
                  </section>
                )}

                <h4>Antworten</h4>
                <p style={{ color: "#94a3b8" }}>
                  {getQuizLabelForSession(activeSession, pubQuizzes)} -{" "}
                  {formatCompletionDate(getCompletionValue(activeSession))}
                </p>
                {selectedQuizQuestionsByRound.length > 0 && (
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                    {selectedQuizQuestionsByRound.map((round) => {
                      const isSelected = selectedQuestionRound?.id === round.id;

                      return (
                        <button
                          key={round.id}
                          onClick={() => setSelectedAnswerRoundId(round.id)}
                          style={{
                            padding: "10px 14px",
                            borderRadius: 999,
                            border: `1px solid ${isSelected ? "#38bdf8" : "#334155"}`,
                            background: isSelected ? "#082f49" : "#020617",
                            color: isSelected ? "#e0f2fe" : "#cbd5e1",
                            fontWeight: 700,
                          }}
                        >
                          {round.title}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div style={{ display: "grid", gap: 8 }}>
                  {selectedQuestionRound && (
                    <div
                      style={{
                        padding: "10px 12px",
                        borderRadius: 10,
                        background: "#101827",
                        border: "1px solid #1f2937",
                        color: "#93c5fd",
                        fontWeight: 700,
                      }}
                    >
                      {selectedQuestionRound.title}
                    </div>
                  )}
                  {selectedQuizQuestions.length === 0 ? (
                    <p style={{ margin: 0, color: "#94a3b8" }}>
                      Fuer diese Runde sind keine Fragen gespeichert.
                    </p>
                  ) : (
                    selectedQuizQuestions.map((question) => {
                      const answer = activeSession.answers?.[question.id];

                      return (
                        <article
                          key={question.id}
                          style={{
                            padding: 12,
                            border: "1px solid #1f2937",
                            borderRadius: 10,
                            background: "#020617",
                          }}
                        >
                          <p style={{ margin: "0 0 6px", color: "#93c5fd" }}>
                            {question.title}
                          </p>
                          <p style={{ margin: "0 0 8px", fontWeight: 700 }}>
                            {question.prompt || "Keine Frage gespeichert."}
                          </p>
                          <p style={{ margin: "0 0 6px", color: "#cbd5e1" }}>
                            Antwort:{" "}
                            <strong>{answer?.text?.trim() || "nicht beantwortet"}</strong>
                          </p>
                          <p style={{ margin: 0, color: "#94a3b8" }}>
                            {answer?.result === "correct"
                              ? "richtig"
                              : answer?.result === "incorrect"
                                ? "falsch"
                                : "offen"}{" "}
                            - {answer?.pointsAwarded || 0} Punkte
                          </p>
                          {answer?.manualOverride?.active && (
                            <p style={{ margin: "6px 0 0", color: "#fbbf24", fontWeight: 700 }}>
                              Manuell angepasst
                              {answer?.manualOverride?.previousPointsAwarded !== undefined
                                ? ` (${answer.manualOverride.previousPointsAwarded} -> ${answer?.pointsAwarded || 0})`
                                : ""}
                            </p>
                          )}
                          {answer?.manualOverride?.note && (
                            <p style={{ margin: "6px 0 0", color: "#fde68a" }}>
                              Notiz: {answer.manualOverride.note}
                            </p>
                          )}
                          {answer?.managerOverride?.active && (
                            <p style={{ margin: "6px 0 0", color: "#93c5fd", fontWeight: 700 }}>
                              Antwort nachtraeglich von Manager gespeichert
                            </p>
                          )}
                          {canEditScores && (
                            <div
                              style={{
                                display: "grid",
                                gap: 8,
                                marginTop: 12,
                                paddingTop: 12,
                                borderTop: "1px solid #1f2937",
                              }}
                            >
                              <label style={{ display: "grid", gap: 6 }}>
                                <span style={{ color: "#cbd5e1" }}>
                                  Antwort fuer diese Frage
                                </span>
                                <input
                                  key={`answer__${activeSession.sessionKey || activeSession.id}__${selectedQuestionRound?.id || "round"}__${question.id}`}
                                  defaultValue={activeSession.answers?.[question.id]?.text || ""}
                                  ref={(node) => {
                                    if (node) {
                                      questionAnswerInputRefs.current[question.id] = node;
                                    } else {
                                      delete questionAnswerInputRefs.current[question.id];
                                    }
                                  }}
                                  placeholder="Antwort fuer das Team nachtragen"
                                  style={inputStyle}
                                />
                              </label>
                              <label style={{ display: "grid", gap: 6 }}>
                                <span style={{ color: "#cbd5e1" }}>
                                  Punkte fuer diese Frage
                                </span>
                                <input
                                  key={`points__${activeSession.sessionKey || activeSession.id}__${selectedQuestionRound?.id || "round"}__${question.id}`}
                                  defaultValue={String(Number(activeSession.answers?.[question.id]?.pointsAwarded) || 0)}
                                  ref={(node) => {
                                    if (node) {
                                      questionScoreInputRefs.current[question.id] = node;
                                    } else {
                                      delete questionScoreInputRefs.current[question.id];
                                    }
                                  }}
                                  inputMode="decimal"
                                  style={inputStyle}
                                />
                              </label>
                              <label style={{ display: "grid", gap: 6 }}>
                                <span style={{ color: "#cbd5e1" }}>Notiz</span>
                                <input
                                  key={`note__${activeSession.sessionKey || activeSession.id}__${selectedQuestionRound?.id || "round"}__${question.id}`}
                                  defaultValue={
                                    activeSession.answers?.[question.id]?.manualOverride?.note ||
                                    activeSession.answers?.[question.id]?.managerOverride?.note ||
                                    ""
                                  }
                                  ref={(node) => {
                                    if (node) {
                                      questionNoteInputRefs.current[question.id] = node;
                                    } else {
                                      delete questionNoteInputRefs.current[question.id];
                                    }
                                  }}
                                  placeholder="z. B. Antwort trotzdem gelten lassen"
                                  style={inputStyle}
                                />
                              </label>
                              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                <button
                                  onClick={() => handleManagerAnswerSave(question)}
                                  style={{
                                    padding: "8px 12px",
                                    borderRadius: 10,
                                    border: "none",
                                    background: "#0ea5e9",
                                    color: "#082f49",
                                    fontWeight: 700,
                                    cursor: "pointer",
                                  }}
                                >
                                  Antwort nachtragen
                                </button>
                                <button
                                  onClick={() => handleQuestionScoreSave(question)}
                                  style={{
                                    padding: "8px 12px",
                                    borderRadius: 10,
                                    border: "none",
                                    background: "#f59e0b",
                                    color: "#111827",
                                    fontWeight: 700,
                                    cursor: "pointer",
                                  }}
                                >
                                  Frage speichern
                                </button>
                                <span style={{ alignSelf: "center", color: "#94a3b8" }}>
                                  Maximalwert laut Quiz: {question.points || 0}
                                </span>
                                {questionMessages[question.id] && (
                                  <span style={{ alignSelf: "center", color: "#93c5fd" }}>
                                    {questionMessages[question.id]}
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </article>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
function ManagerDirectory({ activeManager, managers, message, onSaveManager }) {
  const isNarrow = useIsNarrowScreen();
  const [draft, setDraft] = useState({
    active: true,
    canEditScores: false,
    headManager: false,
    key: "",
    name: "",
    password: "",
  });

  function editManager(manager) {
    setDraft({
      active: manager.active !== false,
      canEditScores: Boolean(manager.canEditScores ?? manager.headManager),
      createdAt: manager.createdAt,
      headManager: Boolean(manager.headManager),
      key: manager.key || manager.id,
      name: manager.name || "",
      password: manager.password || "",
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    await onSaveManager(draft);
    setDraft({
      active: true,
      canEditScores: false,
      headManager: false,
      key: "",
      name: "",
      password: "",
    });
  }

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Manager</h2>
      <p style={{ color: "#94a3b8" }}>
        Eingeloggt als {activeManager.name || activeManager.id}.
      </p>
      <p style={{ color: "#93c5fd" }}>
        Nur Head Manager koennen hier Manager anlegen, bearbeiten und Head-Rechte vergeben.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isNarrow
            ? "1fr"
            : "minmax(260px, 1fr) minmax(280px, 1fr)",
          gap: 16,
        }}
      >
        <div style={{ display: "grid", gap: 10, alignSelf: "start" }}>
          {managers.length === 0 ? (
            <p style={{ color: "#94a3b8" }}>Noch keine Manager angelegt.</p>
          ) : (
            managers.map((manager) => (
              <button
                key={manager.id}
                onClick={() => editManager(manager)}
                style={{
                  display: "grid",
                  gap: 4,
                  padding: 12,
                  border: "1px solid #1f2937",
                  borderRadius: 12,
                  background: "#0b1220",
                  color: "#e5e7eb",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <strong>{manager.name || manager.id}</strong>
                <span style={{ color: "#94a3b8" }}>
                  Key: {manager.key || manager.id} -{" "}
                  {manager.active === false ? "inaktiv" : "aktiv"}
                  {manager.headManager ? " - Head Manager" : ""}
                  {manager.canEditScores ? " - Score-Editing an" : ""}
                </span>
              </button>
            ))
          )}
        </div>

        <form
          onSubmit={handleSubmit}
          style={{
            display: "grid",
            gap: 12,
            padding: 16,
            border: "1px solid #334155",
            borderRadius: 14,
            background: "#0b1220",
          }}
        >
          <label style={{ display: "grid", gap: 8 }}>
            Manager-Key
            <input
              value={draft.key}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  key: normalizeManagerKey(e.target.value),
                }))
              }
              placeholder="z. B. lea"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 8 }}>
            Anzeigename
            <input
              value={draft.name}
              onChange={(e) =>
                setDraft((current) => ({ ...current, name: e.target.value }))
              }
              placeholder="Name"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 8 }}>
            Persönliches Passwort
            <input
              type="password"
              value={draft.password}
              onChange={(e) =>
                setDraft((current) => ({ ...current, password: e.target.value }))
              }
              placeholder="Neues Passwort"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) =>
                setDraft((current) => ({ ...current, active: e.target.checked }))
              }
            />
            Aktiv
          </label>
          <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={draft.canEditScores}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  canEditScores: e.target.checked,
                }))
              }
            />
            Darf Scores bearbeiten
          </label>
          <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={draft.headManager}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  headManager: e.target.checked,
                }))
              }
            />
            Head Manager
          </label>
          <button
            type="submit"
            style={{
              padding: 12,
              borderRadius: 12,
              border: "none",
              background: "#22c55e",
              color: "#0b1220",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Manager speichern
          </button>
          {message && <p style={{ color: "#93c5fd", margin: 0 }}>{message}</p>}
        </form>
      </div>
    </section>
  );
}

function LiveControlPanel({
  activeManager,
  answersRevealed,
  canRevealAnswers,
  lobbyData,
  now,
  onAddRoundExtraTime,
  onCloseNewRegistrations,
  onRevealRoundAnswers,
  onReopenNewRegistrations,
  onRoundChange,
  onSubmitManagerAnswerForTeam,
  onUpdateTeamPodiumExclusion,
  onUpdateTeamQuestionScore,
  onUpdateTeamScore,
  onUnlockRound,
  quizRounds,
  selectedQuestions,
  selectedRound,
  teamStatuses,
}) {
  const [selectedTeamId, setSelectedTeamId] = useState(null);
  const [scoreDraft, setScoreDraft] = useState("");
  const [scoreNoteDraft, setScoreNoteDraft] = useState("");
  const [scoreMessage, setScoreMessage] = useState("");
  const [questionAnswerDrafts, setQuestionAnswerDrafts] = useState({});
  const [questionScoreDrafts, setQuestionScoreDrafts] = useState({});
  const [questionNoteDrafts, setQuestionNoteDrafts] = useState({});
  const [questionMessages, setQuestionMessages] = useState({});
  const [podiumMessage, setPodiumMessage] = useState("");
  const [teamSearch, setTeamSearch] = useState("");
  const hydratedLiveTeamIdRef = useRef("");
  const roundUnlocked = canRevealAnswers || answersRevealed;
  const answerWindowEndsMs = getTimestampMs(lobbyData?.answerWindowEndsAt);
  const answerWindowClosed = isAnswerWindowClosed(lobbyData, now);
  const isNarrow = useIsNarrowScreen();
  const roundExtraMinutes = getRoundExtraMinutes(lobbyData, selectedRound.id);
  const extraTimeLimitReached = roundExtraMinutes >= 30;
  const registrationClosed = isNewTeamJoinClosed(lobbyData, now);
  const emergencyJoinWindowEndsMs = getEmergencyJoinWindowEndsMs(lobbyData);
  const emergencyJoinOpen = isEmergencyJoinWindowActive(lobbyData, now);
  const normalizedTeamSearch = normalizeTeamName(teamSearch || "");
  const visibleTeamStatuses = useMemo(
    () =>
      teamStatuses.filter((team) => {
        if (!normalizedTeamSearch) return true;

        return (
          normalizeTeamName(team.teamName || "").includes(normalizedTeamSearch) ||
          (team.teamNameNormalized || "").includes(normalizedTeamSearch)
        );
      }),
    [normalizedTeamSearch, teamStatuses],
  );
  const selectedTeam = useMemo(
    () =>
      visibleTeamStatuses.find((team) => team.id === selectedTeamId) ||
      visibleTeamStatuses[0] ||
      null,
    [selectedTeamId, visibleTeamStatuses],
  );
  const selectedQuestionIds = selectedQuestions.map((question) => question.id);
  const canEditScores = Boolean(canManagerEditScores(activeManager) && onUpdateTeamScore);

  useEffect(() => {
    if (!visibleTeamStatuses.some((team) => team.id === selectedTeamId)) {
      setSelectedTeamId(visibleTeamStatuses[0]?.id || null);
    }
  }, [selectedTeamId, visibleTeamStatuses]);

  useEffect(() => {
    if (!selectedTeam) {
      hydratedLiveTeamIdRef.current = "";
      setScoreDraft("");
      setScoreNoteDraft("");
      setScoreMessage("");
      setQuestionAnswerDrafts({});
      setQuestionScoreDrafts({});
      setQuestionNoteDrafts({});
      setQuestionMessages({});
      return;
    }

    const shouldHydrateDrafts = hydratedLiveTeamIdRef.current !== selectedTeam.id;

    if (shouldHydrateDrafts) {
      setScoreDraft(String(Number(selectedTeam.totalPoints) || 0));
      setScoreNoteDraft(selectedTeam.scoreAdjustment?.note || "");
      setScoreMessage("");
      setQuestionAnswerDrafts(
        Object.fromEntries(
          selectedQuestions.map((question) => [
            question.id,
            selectedTeam.answers?.[question.id]?.text || "",
          ]),
        ),
      );
      setQuestionScoreDrafts(
        Object.fromEntries(
          selectedQuestions.map((question) => [
            question.id,
            String(Number(selectedTeam.answers?.[question.id]?.pointsAwarded) || 0),
          ]),
        ),
      );
      setQuestionNoteDrafts(
        Object.fromEntries(
          selectedQuestions.map((question) => [
            question.id,
            selectedTeam.answers?.[question.id]?.manualOverride?.note || "",
          ]),
        ),
      );
      setQuestionMessages({});
    }

    hydratedLiveTeamIdRef.current = selectedTeam.id;
  }, [
    selectedQuestions,
    selectedTeam?.id,
  ]);

  async function handleScoreSave() {
    if (!selectedTeam || !canEditScores) return;

    const result = await onUpdateTeamScore({
      nextTotalPoints: scoreDraft,
      note: scoreNoteDraft,
      teamId: selectedTeam.id,
      teamName: selectedTeam.teamName,
    });

    setScoreMessage(result.message);
  }

  async function handleQuestionScoreSave(question) {
    if (!selectedTeam || !canEditScores || !onUpdateTeamQuestionScore) return;

    const result = await onUpdateTeamQuestionScore({
      nextPointsAwarded: questionScoreDrafts[question.id] ?? "0",
      note: questionNoteDrafts[question.id] || "",
      questionId: question.id,
      questionTitle: question.title,
      teamId: selectedTeam.id,
      teamName: selectedTeam.teamName,
    });

    setQuestionMessages((current) => ({
      ...current,
      [question.id]: result.message,
    }));
  }

  async function handleManagerAnswerSave(question) {
    if (!selectedTeam || !onSubmitManagerAnswerForTeam) return;

    const result = await onSubmitManagerAnswerForTeam({
      answerText: questionAnswerDrafts[question.id] ?? "",
      note: questionNoteDrafts[question.id] || "",
      question,
      teamId: selectedTeam.id,
      teamName: selectedTeam.teamName,
    });

    setQuestionMessages((current) => ({
      ...current,
      [question.id]: result.message,
    }));
  }

  async function handlePodiumExclusionToggle() {
    if (!selectedTeam || !onUpdateTeamPodiumExclusion) return;

    const excluded = !selectedTeam.podiumExcluded;
    const result = await onUpdateTeamPodiumExclusion({
      teamId: selectedTeam.id,
      teamName: selectedTeam.teamName,
      excluded,
    });

    setPodiumMessage(result.message);
  }

  return (
    <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 24 }}>
          {quizRounds.map((round) => {
            const isSelected = round.id === selectedRound.id;

            return (
              <button
                key={round.id}
                onClick={() => onRoundChange(round.id)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 999,
                  border: `1px solid ${isSelected ? "#38bdf8" : "#334155"}`,
                  background: isSelected ? "#082f49" : "#020617",
                  color: isSelected ? "#e0f2fe" : "#cbd5e1",
                  fontWeight: 700,
                }}
              >
                {round.title}
              </button>
            );
          })}
        </div>

        <section
          style={{
            marginTop: 24,
            padding: 18,
            border: "1px solid #334155",
            borderRadius: 14,
            background: "#0b1220",
          }}
        >
          <h2 style={{ marginTop: 0 }}>{selectedRound.title}</h2>
          <p style={{ color: "#cbd5e1" }}>
            Status: {roundUnlocked ? "freigeschaltet" : "noch gesperrt"} -
            Lösungen: {answersRevealed ? "freigeschaltet" : "gesperrt"}
          </p>
          <p style={{ color: answerWindowClosed ? "#fca5a5" : "#cbd5e1" }}>
            Antworten:{" "}
            {answerWindowEndsMs
              ? answerWindowClosed
                ? "geschlossen"
                : `offen bis ${new Date(answerWindowEndsMs).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}`
              : "erst nach Quiz-Code laden aktiv"}
          </p>
          <p style={{ color: "#cbd5e1" }}>
            Zusatzzeit fuer diese Runde:{" "}
            <strong>{roundExtraMinutes} / 30 Minuten</strong>
          </p>
          <p style={{ color: registrationClosed ? "#fca5a5" : "#86efac" }}>
            Neue Anmeldungen:{" "}
            <strong>
              {registrationClosed ? "gesperrt" : emergencyJoinOpen ? "5 Minuten offen" : "offen"}
            </strong>
            {emergencyJoinOpen && emergencyJoinWindowEndsMs
              ? ` bis ${new Date(emergencyJoinWindowEndsMs).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
              : ""}
          </p>
          <p style={{ color: "#cbd5e1" }}>
            Startfenster fuer Teams:{" "}
            <strong>
              10 Minuten nach Team-Startfreigabe
            </strong>
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={() => onUnlockRound(selectedRound.id)}>
              Runde freischalten
            </button>
            <button
              onClick={onCloseNewRegistrations}
              style={{
                background: registrationClosed ? "#7f1d1d" : "#1e293b",
                border: "none",
                color: "#f8fafc",
                fontWeight: 700,
                padding: "8px 12px",
                cursor: "pointer",
              }}
            >
              Keine neuen Anmeldungen
            </button>
            <button
              onClick={onReopenNewRegistrations}
              style={{
                background: "#0f766e",
                border: "none",
                color: "#ecfeff",
                fontWeight: 700,
                padding: "8px 12px",
                cursor: "pointer",
              }}
            >
              5 Min. oeffnen
            </button>
            <button
              disabled={extraTimeLimitReached}
              onClick={() => onAddRoundExtraTime(selectedRound.id)}
              style={{
                background: extraTimeLimitReached ? "#334155" : "#22c55e",
                border: "none",
                color: extraTimeLimitReached ? "#94a3b8" : "#052e16",
                fontWeight: 700,
                padding: "8px 12px",
                cursor: extraTimeLimitReached ? "not-allowed" : "pointer",
              }}
            >
              +10 Minuten fuer alle Teams
            </button>
            <button
              disabled={!canRevealAnswers}
              onClick={() => onRevealRoundAnswers(selectedRound.id)}
              style={{
                background: canRevealAnswers ? "#f59e0b" : "#334155",
                border: "none",
                color: canRevealAnswers ? "#111827" : "#94a3b8",
                fontWeight: 700,
                padding: "8px 12px",
                cursor: canRevealAnswers ? "pointer" : "not-allowed",
              }}
            >
              Antworten freischalten
            </button>
          </div>
          {!canRevealAnswers && !answersRevealed && (
            <p style={{ marginBottom: 0, color: "#94a3b8" }}>
              Freischalten geht, sobald die Runde frei ist. Teams sehen die
              Lösungen trotzdem erst nach ihrem eigenen Timer.
            </p>
          )}
        </section>

        <section style={{ marginTop: 24 }}>
          <h2>Heute im Quiz</h2>
          <p style={{ marginTop: 0, color: "#94a3b8" }}>
            Laufende Teams auswählen und ihre Antworten pro Runde direkt mitverfolgen.
          </p>
          <label style={{ display: "grid", gap: 8, marginBottom: 16 }}>
            <span style={{ color: "#cbd5e1", fontWeight: 700 }}>Team suchen</span>
            <input
              value={teamSearch}
              onChange={(event) => setTeamSearch(event.target.value)}
              placeholder="Nach Teamname suchen"
              style={inputStyle}
            />
          </label>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isNarrow
                ? "1fr"
                : "minmax(280px, 0.9fr) minmax(320px, 1.2fr)",
              gap: 16,
            }}
          >
            <div style={{ display: "grid", gap: 10, alignSelf: "start" }}>
              {visibleTeamStatuses.length === 0 ? (
                <p style={{ color: "#94a3b8" }}>Kein Team zu dieser Suche gefunden.</p>
              ) : visibleTeamStatuses.map((team) => {
                const answeredCount = getAnsweredQuestionCount(team, selectedQuestionIds);
                const isSelected = selectedTeam?.id === team.id;

                return (
                  <button
                    key={team.id}
                    onClick={() => setSelectedTeamId(team.id)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: 12,
                      alignItems: "center",
                      padding: 12,
                      border: `1px solid ${isSelected ? "#38bdf8" : "#1f2937"}`,
                      borderRadius: 12,
                      background: isSelected ? "#082f49" : "#0b1220",
                      color: "#e5e7eb",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span>
                      <strong style={{ display: "block" }}>{team.teamName}</strong>
                    <span style={{ color: "#94a3b8", fontSize: 14 }}>
                      {answeredCount}/{selectedQuestionIds.length} Antworten in dieser Runde
                    </span>
                    {team.podiumExcluded && (
                      <span style={{ color: "#fca5a5", fontSize: 13, fontWeight: 700 }}>
                        Von Podiumsrelevanz ausgenommen
                      </span>
                    )}
                    {team.scoreAdjustment?.active && (
                      <span style={{ color: "#fbbf24", fontSize: 13, fontWeight: 700 }}>
                        Score manuell geaendert
                      </span>
                    )}
                  </span>
                  <span
                    style={{
                        color: !team.started
                          ? "#94a3b8"
                          : team.expired
                            ? "#86efac"
                            : "#fde68a",
                        fontWeight: 700,
                      }}
                    >
                      {!team.started
                        ? "bereit"
                        : team.expired
                          ? "fertig"
                          : formatDuration(team.remainingMs)}
                    </span>
                  </button>
                );
              })}
            </div>

            {selectedTeam && (
              <div
                style={{
                  padding: 16,
                  border: "1px solid #334155",
                  borderRadius: 14,
                  background: "#0b1220",
                }}
              >
                <h3 style={{ marginTop: 0 }}>{selectedTeam.teamName}</h3>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: isNarrow ? "1fr" : "repeat(3, minmax(0, 1fr))",
                    gap: 10,
                    marginBottom: 16,
                  }}
                >
                  <div
                    style={{
                      padding: 12,
                      border: "1px solid #1f2937",
                      borderRadius: 10,
                      background: "#020617",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: 6 }}>Status</strong>
                    <span style={{ color: "#cbd5e1" }}>
                      {!selectedTeam.started
                        ? "Noch nicht gestartet"
                        : selectedTeam.expired
                          ? "Zeit abgelaufen"
                          : "Spielt gerade"}
                    </span>
                  </div>
                  <div
                    style={{
                      padding: 12,
                      border: "1px solid #1f2937",
                      borderRadius: 10,
                      background: "#020617",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: 6 }}>Zeit / Fortschritt</strong>
                    <span style={{ color: "#cbd5e1" }}>
                      {!selectedTeam.started
                        ? "Nicht gestartet"
                        : selectedTeam.expired
                          ? "Runde fertig"
                          : formatDuration(selectedTeam.remainingMs)}
                    </span>
                  </div>
                  <div
                    style={{
                      padding: 12,
                      border: "1px solid #1f2937",
                      borderRadius: 10,
                      background: "#020617",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: 6 }}>Punkte heute</strong>
                    <span style={{ color: "#cbd5e1" }}>{selectedTeam.totalPoints || 0}</span>
                  </div>
                </div>

                <p style={{ color: "#94a3b8" }}>
                  Spieler:innen:{" "}
                  {Array.from(
                    new Set(
                      [
                        ...(selectedTeam.playerNames || []),
                        selectedTeam.playerName,
                      ].filter(Boolean),
                    ),
                  ).join(", ") || "keine Namen gespeichert"}
                </p>

                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    marginBottom: 16,
                    padding: 12,
                    border: "1px solid #334155",
                    borderRadius: 10,
                    background: "#020617",
                  }}
                >
                  <strong>Podiumsrelevanz</strong>
                  <span style={{ color: selectedTeam.podiumExcluded ? "#fca5a5" : "#cbd5e1" }}>
                    {selectedTeam.podiumExcluded
                      ? "Dieses Team ist als abgebrochen markiert und blockiert die Schätzfrage nicht."
                      : "Dieses Team zählt normal für die Podiums- und Schätzfrage-Logik."}
                  </span>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      onClick={handlePodiumExclusionToggle}
                      style={{
                        padding: "10px 14px",
                        borderRadius: 12,
                        border: "none",
                        background: selectedTeam.podiumExcluded ? "#22c55e" : "#ef4444",
                        color: selectedTeam.podiumExcluded ? "#052e16" : "#fff7ed",
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      {selectedTeam.podiumExcluded
                        ? "Wieder podiumsrelevant machen"
                        : "Als abgebrochen markieren"}
                    </button>
                    {podiumMessage && (
                      <span style={{ alignSelf: "center", color: "#93c5fd" }}>
                        {podiumMessage}
                      </span>
                    )}
                  </div>
                </div>

                {selectedTeam.scoreAdjustment?.active && (
                  <div
                    style={{
                      marginBottom: 16,
                      padding: 12,
                      border: "1px solid #92400e",
                      borderRadius: 10,
                      background: "#1c1917",
                      color: "#fde68a",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: 4 }}>
                      Score wurde manuell geaendert
                    </strong>
                    <span>
                      Von {selectedTeam.scoreAdjustment?.adjustedBy || "Manager"}{" "}
                      {selectedTeam.scoreAdjustment?.previousPoints !== undefined
                        ? `(${selectedTeam.scoreAdjustment.previousPoints} -> ${selectedTeam.totalPoints || 0})`
                        : ""}
                    </span>
                    {selectedTeam.scoreAdjustment?.note && (
                      <span style={{ display: "block", marginTop: 6, color: "#fde68a" }}>
                        Notiz: {selectedTeam.scoreAdjustment.note}
                      </span>
                    )}
                  </div>
                )}

                {canEditScores && (
                  <div
                    style={{
                      display: "grid",
                      gap: 10,
                      marginBottom: 16,
                      padding: 12,
                      border: "1px solid #334155",
                      borderRadius: 10,
                      background: "#020617",
                    }}
                  >
                    <strong>Punkte manuell korrigieren</strong>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span style={{ color: "#cbd5e1" }}>Neuer Gesamtpunktestand</span>
                      <input
                        value={scoreDraft}
                        onChange={(event) => setScoreDraft(event.target.value)}
                        inputMode="numeric"
                        style={inputStyle}
                      />
                    </label>
                    <label style={{ display: "grid", gap: 6 }}>
                      <span style={{ color: "#cbd5e1" }}>Notiz fuer Manager</span>
                      <input
                        value={scoreNoteDraft}
                        onChange={(event) => setScoreNoteDraft(event.target.value)}
                        placeholder="z. B. Bewertungsfehler bei Frage 4"
                        style={inputStyle}
                      />
                    </label>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button
                        onClick={handleScoreSave}
                        style={{
                          padding: "10px 14px",
                          borderRadius: 12,
                          border: "none",
                          background: "#f59e0b",
                          color: "#111827",
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        Punkte speichern
                      </button>
                      {scoreMessage && (
                        <span style={{ alignSelf: "center", color: "#93c5fd" }}>
                          {scoreMessage}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <h4>Antworten in {selectedRound.title}</h4>
                <div style={{ display: "grid", gap: 8 }}>
                  {selectedQuestions.map((question) => {
                    const answer = selectedTeam.answers?.[question.id];
                    const answerText = answer?.text?.trim() || "";

                    return (
                      <article
                        key={question.id}
                        style={{
                          padding: 12,
                          border: "1px solid #1f2937",
                          borderRadius: 10,
                          background: "#020617",
                        }}
                      >
                        <p style={{ margin: "0 0 6px", color: "#93c5fd" }}>
                          {question.title}
                        </p>
                        <p style={{ margin: "0 0 8px", fontWeight: 700 }}>
                          {question.prompt || "Keine Frage gespeichert."}
                        </p>
                        <p style={{ margin: "0 0 6px", color: "#cbd5e1" }}>
                          Antwort: <strong>{answerText || "noch leer"}</strong>
                        </p>
                        <p style={{ margin: 0, color: "#94a3b8" }}>
                          {answer?.result === "correct"
                            ? "richtig"
                            : answer?.result === "incorrect"
                              ? "falsch"
                              : "noch offen"}{" "}
                          - {answer?.pointsAwarded || 0} Punkte
                        </p>
                          {answer?.manualOverride?.active && (
                            <p style={{ margin: "6px 0 0", color: "#fbbf24", fontWeight: 700 }}>
                              Manuell angepasst
                              {answer?.manualOverride?.previousPointsAwarded !== undefined
                                ? ` (${answer.manualOverride.previousPointsAwarded} -> ${answer?.pointsAwarded || 0})`
                                : ""}
                            </p>
                          )}
                        {answer?.managerOverride?.active && (
                          <p style={{ margin: "6px 0 0", color: "#93c5fd", fontWeight: 700 }}>
                            Antwort nachtraeglich von Manager gespeichert
                          </p>
                        )}
                        {canEditScores && (
                          <div
                            style={{
                              display: "grid",
                              gap: 8,
                              marginTop: 12,
                              paddingTop: 12,
                              borderTop: "1px solid #1f2937",
                            }}
                          >
                            <label style={{ display: "grid", gap: 6 }}>
                              <span style={{ color: "#cbd5e1" }}>
                                Antwort fuer diese Frage
                              </span>
                              <input
                                value={questionAnswerDrafts[question.id] ?? ""}
                                onChange={(event) =>
                                  setQuestionAnswerDrafts((current) => ({
                                    ...current,
                                    [question.id]: event.target.value,
                                  }))
                                }
                                placeholder="Antwort fuer das Team nachtragen"
                                style={inputStyle}
                              />
                            </label>
                            <label style={{ display: "grid", gap: 6 }}>
                              <span style={{ color: "#cbd5e1" }}>
                                Punkte fuer diese Frage
                              </span>
                              <input
                                value={questionScoreDrafts[question.id] ?? ""}
                                onChange={(event) =>
                                  setQuestionScoreDrafts((current) => ({
                                    ...current,
                                    [question.id]: event.target.value,
                                  }))
                                }
                                inputMode="decimal"
                                style={inputStyle}
                              />
                            </label>
                            <label style={{ display: "grid", gap: 6 }}>
                              <span style={{ color: "#cbd5e1" }}>Notiz</span>
                              <input
                                value={questionNoteDrafts[question.id] ?? ""}
                                onChange={(event) =>
                                  setQuestionNoteDrafts((current) => ({
                                    ...current,
                                    [question.id]: event.target.value,
                                  }))
                                }
                                placeholder="z. B. Antwort trotzdem gelten lassen"
                                style={inputStyle}
                              />
                            </label>
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                              <button
                                onClick={() => handleManagerAnswerSave(question)}
                                style={{
                                  padding: "8px 12px",
                                  borderRadius: 10,
                                  border: "none",
                                  background: "#0ea5e9",
                                  color: "#082f49",
                                  fontWeight: 700,
                                  cursor: "pointer",
                                }}
                              >
                                Antwort nachtragen
                              </button>
                              <button
                                onClick={() => handleQuestionScoreSave(question)}
                                style={{
                                  padding: "8px 12px",
                                  borderRadius: 10,
                                  border: "none",
                                  background: "#f59e0b",
                                  color: "#111827",
                                  fontWeight: 700,
                                  cursor: "pointer",
                                }}
                              >
                                Frage speichern
                              </button>
                              <span style={{ alignSelf: "center", color: "#94a3b8" }}>
                                Maximalwert laut Quiz: {question.points || 0}
                              </span>
                              {questionMessages[question.id] && (
                                <span style={{ alignSelf: "center", color: "#93c5fd" }}>
                                  {questionMessages[question.id]}
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>

        <section style={{ marginTop: 24 }}>
          <h2>Lösungen</h2>
          <div style={{ display: "grid", gap: 10 }}>
            {selectedQuestions.map((question) => (
              <div
                key={question.id}
                style={{
                  padding: 12,
                  border: "1px solid #1f2937",
                  borderRadius: 12,
                  background: "#0b1220",
                }}
              >
                <strong>{question.title}</strong>
                <p style={{ margin: "6px 0 0", color: "#cbd5e1" }}>
                  {question.acceptedAnswers.join(" / ")}
                </p>
              </div>
            ))}
          </div>
        </section>
    </>
  );
}

function PubQuizQrPanel({ quizCode }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const isNarrow = useIsNarrowScreen();
  const cleanedCode = normalizeQuizCode(quizCode || "");
  const startUrl = useMemo(() => createQuizStartUrl(cleanedCode), [cleanedCode]);

  useEffect(() => {
    let isCancelled = false;

    if (!startUrl) {
      setQrDataUrl("");
      return undefined;
    }

    QRCode.toDataURL(startUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 220,
    })
      .then((dataUrl) => {
        if (!isCancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!isCancelled) setQrDataUrl("");
      });

    return () => {
      isCancelled = true;
    };
  }, [startUrl]);

  async function copyStartUrl() {
    if (!startUrl) return;

    await navigator.clipboard?.writeText(startUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  if (!cleanedCode) {
    return (
      <div
        style={{
          padding: 12,
          border: "1px solid #1f2937",
          borderRadius: 12,
          background: "#020617",
          color: "#94a3b8",
        }}
      >
        QR-Code erscheint hier, sobald das Pubquiz gespeichert wurde.
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isNarrow ? "1fr" : "auto minmax(0, 1fr)",
        gap: 14,
        alignItems: "center",
        justifyItems: isNarrow ? "center" : "stretch",
        padding: 14,
        border: "1px solid #1f2937",
        borderRadius: 12,
        background: "#020617",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => qrDataUrl && setExpanded(true)}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && qrDataUrl) {
            event.preventDefault();
            setExpanded(true);
          }
        }}
        style={{
          width: 132,
          height: 132,
          display: "grid",
          placeItems: "center",
          borderRadius: 10,
          background: "#ffffff",
          overflow: "hidden",
          cursor: qrDataUrl ? "zoom-in" : "default",
        }}
      >
        {qrDataUrl ? (
          <img
            alt={`QR-Code fuer Quiz ${cleanedCode}`}
            src={qrDataUrl}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
        ) : (
          <span style={{ color: "#0f172a", fontWeight: 700 }}>QR</span>
        )}
      </div>
      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <strong>Scan-Link fuer Teams</strong>
        <input
          readOnly
          value={startUrl}
          style={{
            ...inputStyle,
            fontSize: 14,
            color: "#cbd5e1",
          }}
        />
        <button
          type="button"
          onClick={copyStartUrl}
          style={{
            justifySelf: "start",
            padding: "9px 12px",
            borderRadius: 10,
            border: "1px solid #38bdf8",
            background: "#082f49",
            color: "#e0f2fe",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {copied ? "Link kopiert" : "Link kopieren"}
        </button>
      </div>
      {expanded && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`QR-Code fuer Quiz ${cleanedCode}`}
          onClick={() => setExpanded(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 20,
            display: "grid",
            placeItems: "center",
            padding: 24,
            background: "rgba(2, 6, 23, 0.86)",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              display: "grid",
              gap: 14,
              justifyItems: "center",
              width: "min(420px, 100%)",
              padding: 20,
              border: "1px solid #334155",
              borderRadius: 16,
              background: "#0b1220",
            }}
          >
            <img
              alt={`QR-Code fuer Quiz ${cleanedCode}`}
              src={qrDataUrl}
              style={{
                width: "min(340px, 82vw)",
                height: "min(340px, 82vw)",
                borderRadius: 14,
                background: "#ffffff",
              }}
            />
            <strong>{cleanedCode}</strong>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #38bdf8",
                background: "#082f49",
                color: "#e0f2fe",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Schliessen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PubQuizManager({
  activeManager,
  message,
  onDeletePubQuiz,
  onLoadPubQuizByCode,
  onSavePubQuiz,
  pubQuizzes,
}) {
  const [draft, setDraft] = useState(() => createBlankPubQuizDraft());
  const [openRoundId, setOpenRoundId] = useState("round1");
  const [codeDraft, setCodeDraft] = useState("");
  const [quizPendingDelete, setQuizPendingDelete] = useState(null);
  const isNarrow = useIsNarrowScreen();
  const canDeletePubQuizzes = Boolean(activeManager?.headManager);

  function updateDraftField(field, value) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      [field]: value,
    }));
  }

  function updateRound(roundIndex, field, value) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      rounds: currentDraft.rounds.map((round, index) =>
        index === roundIndex ? { ...round, [field]: value } : round,
      ),
    }));
  }

  function updateQuestion(roundIndex, questionIndex, field, value) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      rounds: currentDraft.rounds.map((round, currentRoundIndex) => {
        if (currentRoundIndex !== roundIndex) return round;

        return {
          ...round,
          questions: round.questions.map((question, currentQuestionIndex) =>
            currentQuestionIndex === questionIndex
              ? { ...question, [field]: value }
              : question,
          ),
        };
      }),
    }));
  }

  async function handleSave() {
    const savedQuiz = await onSavePubQuiz(draft);

    if (savedQuiz?.id) {
      setDraft((currentDraft) => ({
        ...currentDraft,
        id: savedQuiz.id,
        quizCode: savedQuiz.quizCode,
      }));
    }
  }

  async function handleQuestionImages(roundIndex, questionIndex, files) {
    if (!files?.length) return;

    const nextImages = await readFilesAsImages(files);

    setDraft((currentDraft) => ({
      ...currentDraft,
      rounds: currentDraft.rounds.map((round, currentRoundIndex) => {
        if (currentRoundIndex !== roundIndex) return round;

        return {
          ...round,
          questions: round.questions.map((question, currentQuestionIndex) =>
            currentQuestionIndex === questionIndex
              ? {
                  ...question,
                  images: nextImages,
                  imagesRemoved: false,
                }
              : question,
          ),
        };
      }),
    }));
  }

  async function handleLoadCode(e) {
    e.preventDefault();
    const loaded = await onLoadPubQuizByCode(codeDraft);

    if (loaded) {
      const cleanedCode = normalizeQuizCode(codeDraft);
      const loadedQuiz = pubQuizzes.find(
        (pubQuiz) => normalizeQuizCode(pubQuiz.quizCode || "") === cleanedCode,
      );

      if (loadedQuiz) {
        setDraft(createPubQuizDraftFromData(loadedQuiz));
        setOpenRoundId(loadedQuiz.rounds?.[0]?.id || "round1");
      }
    }
  }

  async function handleConfirmDelete() {
    if (!quizPendingDelete?.id) return;

    const deleted = await onDeletePubQuiz?.(quizPendingDelete.id);

    if (!deleted) return;

    if (draft.id === quizPendingDelete.id) {
      setDraft(createBlankPubQuizDraft());
      setOpenRoundId("round1");
    }

    setQuizPendingDelete(null);
  }

  return (
    <section style={{ marginTop: 24 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isNarrow
            ? "1fr"
            : "minmax(220px, 0.85fr) minmax(0, 2fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        <aside
          style={{
            padding: 16,
            border: "1px solid #334155",
            borderRadius: 14,
            background: "#0b1220",
          }}
        >
          <button
            onClick={() => {
              setDraft(createBlankPubQuizDraft());
              setOpenRoundId("round1");
            }}
            style={{
              width: "100%",
              padding: 12,
              border: "none",
              borderRadius: 10,
              background: "#22c55e",
              color: "#0b1220",
              fontWeight: 700,
            }}
          >
            Neues Pubquiz
          </button>

          <button
            onClick={() => {
              setDraft(createPubQuizTestTemplate());
              setOpenRoundId("round1");
            }}
            style={{
              width: "100%",
              padding: 12,
              border: "1px solid #38bdf8",
              borderRadius: 10,
              background: "#082f49",
              color: "#e0f2fe",
              fontWeight: 700,
              marginTop: 10,
            }}
          >
            Vorlage laden
          </button>

          <form onSubmit={handleLoadCode} style={{ display: "grid", gap: 8, marginTop: 12 }}>
            <label style={{ display: "grid", gap: 6, fontWeight: 700 }}>
              Quiz-Code laden
              <input
                value={codeDraft}
                onChange={(event) =>
                  setCodeDraft(normalizeQuizCode(event.target.value))
                }
                placeholder="ABC123"
                maxLength={6}
                style={{
                  ...inputStyle,
                  fontSize: 16,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                }}
              />
            </label>

            <button
              type="submit"
              style={{
                width: "100%",
                padding: 10,
                border: "1px solid #38bdf8",
                borderRadius: 10,
                background: "#082f49",
                color: "#e0f2fe",
                fontWeight: 700,
              }}
            >
              Laden
            </button>
          </form>

          <h2 style={{ margin: "22px 0 12px", fontSize: 22 }}>Pubquizzes</h2>
          {pubQuizzes.length === 0 ? (
            <p style={{ color: "#94a3b8" }}>Noch keine Pubquizzes gespeichert.</p>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {pubQuizzes.map((pubQuiz) => (
                <article
                  key={pubQuiz.id}
                  style={{
                    padding: 12,
                    border: `1px solid ${
                      draft.id === pubQuiz.id ? "#38bdf8" : "#1f2937"
                    }`,
                    borderRadius: 10,
                    background: draft.id === pubQuiz.id ? "#082f49" : "#111827",
                  }}
                >
                  <button
                    onClick={() => {
                      setDraft(createPubQuizDraftFromData(pubQuiz));
                      setOpenRoundId(pubQuiz.rounds?.[0]?.id || "round1");
                    }}
                    style={{
                      width: "100%",
                      border: "none",
                      background: "transparent",
                      color: "#e5e7eb",
                      textAlign: "left",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    <strong>{pubQuiz.title || "Unbenanntes Pubquiz"}</strong>
                    <span
                      style={{
                        display: "block",
                        marginTop: 4,
                        color: "#94a3b8",
                        fontSize: 13,
                      }}
                    >
                      {pubQuiz.rounds?.length || 0} Runden
                      {pubQuiz.quizCode ? ` - Code ${pubQuiz.quizCode}` : ""}
                    </span>
                  </button>
                  {canDeletePubQuizzes && (
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                      <button
                        type="button"
                        onClick={() => setQuizPendingDelete(pubQuiz)}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 9,
                          border: "1px solid rgba(248, 113, 113, 0.45)",
                          background: "rgba(127, 29, 29, 0.35)",
                          color: "#fecaca",
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        Loeschen
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </aside>

        <section
          style={{
            padding: 18,
            border: "1px solid #334155",
            borderRadius: 14,
            background: "#0b1220",
          }}
        >
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontWeight: 700 }}>
              Quiz-Titel
              <input
                value={draft.title}
                onChange={(event) => updateDraftField("title", event.target.value)}
                placeholder="z. B. April Pubquiz"
                style={inputStyle}
              />
            </label>

            <label style={{ display: "grid", gap: 6, fontWeight: 700 }}>
              Quiz-Code
              <input
                value={draft.quizCode || "Wird beim Speichern erstellt"}
                readOnly
                style={{
                  ...inputStyle,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  color: draft.quizCode ? "#e5e7eb" : "#94a3b8",
                }}
              />
            </label>

            <PubQuizQrPanel quizCode={draft.quizCode} />

            <label style={{ display: "grid", gap: 6, fontWeight: 700 }}>
              Schätzfrage
              <textarea
                value={draft.tiebreakerQuestion}
                onChange={(event) =>
                  updateDraftField("tiebreakerQuestion", event.target.value)
                }
                placeholder="z. B. Wie viele Kronkorken sind im Glas?"
                rows={3}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </label>

            <label style={{ display: "grid", gap: 6, fontWeight: 700 }}>
              Richtige Antwort der Schätzfrage
              <input
                type="number"
                step="any"
                value={draft.tiebreakerAnswer}
                onChange={(event) =>
                  updateDraftField("tiebreakerAnswer", event.target.value)
                }
                placeholder="z. B. 237"
                style={inputStyle}
              />
            </label>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
            {draft.rounds.map((round) => {
              const isSelected = openRoundId === round.id;

              return (
                <button
                  key={round.id}
                  onClick={() => setOpenRoundId(round.id)}
                  style={{
                    padding: "10px 14px",
                    borderRadius: 999,
                    border: `1px solid ${isSelected ? "#38bdf8" : "#334155"}`,
                    background: isSelected ? "#082f49" : "#020617",
                    color: isSelected ? "#e0f2fe" : "#cbd5e1",
                    fontWeight: 700,
                  }}
                >
                  {round.title}
                </button>
              );
            })}
          </div>

          {draft.rounds.map((round, roundIndex) => {
            if (round.id !== openRoundId) return null;

            return (
              <section key={round.id} style={{ marginTop: 18 }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: isNarrow ? "1fr" : "1fr 160px",
                    gap: 12,
                  }}
                >
                  <label style={{ display: "grid", gap: 6, fontWeight: 700 }}>
                    Kategorie
                    <input
                      value={round.category}
                      onChange={(event) =>
                        updateRound(roundIndex, "category", event.target.value)
                      }
                      placeholder="z. B. Musik, Filme, Sport..."
                      style={inputStyle}
                    />
                  </label>

                  <label style={{ display: "grid", gap: 6, fontWeight: 700 }}>
                    Minuten
                    <input
                      min={1}
                      type="number"
                      value={round.durationMinutes}
                      onChange={(event) =>
                        updateRound(
                          roundIndex,
                          "durationMinutes",
                          event.target.value,
                        )
                      }
                      style={inputStyle}
                    />
                  </label>
                </div>

                <div style={{ display: "grid", gap: 14, marginTop: 18 }}>
                  {round.questions.map((question, questionIndex) => (
                    <section
                      key={question.id}
                      style={{
                        padding: 14,
                        border: "1px solid #1f2937",
                        borderRadius: 12,
                        background: "#111827",
                      }}
                    >
                      <h3 style={{ margin: "0 0 12px" }}>
                        Frage {questionIndex + 1}
                        {questionIndex === 4 ? " - Bildfrage" : ""}
                        {questionIndex === 5 ? " - kein Hinweis" : ""}
                      </h3>

                      <div style={{ display: "grid", gap: 10 }}>
                        <label style={{ display: "grid", gap: 6 }}>
                          Frage
                          <textarea
                            value={question.prompt}
                            onChange={(event) =>
                              updateQuestion(
                                roundIndex,
                                questionIndex,
                                "prompt",
                                event.target.value,
                              )
                            }
                            placeholder="Was sollen die Teams beantworten?"
                            rows={2}
                            style={{ ...inputStyle, resize: "vertical" }}
                          />
                        </label>

                        {questionIndex !== 5 && (
                          <label style={{ display: "grid", gap: 6 }}>
                            Hinweis
                            <input
                              value={question.hint}
                              onChange={(event) =>
                                updateQuestion(
                                  roundIndex,
                                  questionIndex,
                                  "hint",
                                  event.target.value,
                                )
                              }
                              placeholder="Optionaler Hinweis"
                              style={inputStyle}
                            />
                          </label>
                        )}

                        <label style={{ display: "grid", gap: 6 }}>
                          Lösungen
                          <textarea
                            value={question.answersText}
                            onChange={(event) =>
                              updateQuestion(
                                roundIndex,
                                questionIndex,
                                "answersText",
                                event.target.value,
                              )
                            }
                            placeholder={"Eine richtige Lösung pro Zeile"}
                            rows={2}
                            style={{ ...inputStyle, resize: "vertical" }}
                          />
                        </label>

                        {questionIndex === 4 && (
                          <>
                            <label style={{ display: "grid", gap: 6 }}>
                              Bildnotiz
                              <input
                                value={question.mediaNote}
                                onChange={(event) =>
                                  updateQuestion(
                                    roundIndex,
                                    questionIndex,
                                    "mediaNote",
                                    event.target.value,
                                  )
                                }
                                placeholder="Welche Bilder werden gebraucht?"
                                style={inputStyle}
                              />
                            </label>

                            <label style={{ display: "grid", gap: 6 }}>
                              Bilder für das Team-PDF
                              <input
                                accept="image/*"
                                multiple
                                onChange={(event) =>
                                  handleQuestionImages(
                                    roundIndex,
                                    questionIndex,
                                    event.target.files,
                                  )
                                }
                                type="file"
                                style={inputStyle}
                              />
                            </label>

                            {question.images?.length > 0 && (
                              <div
                                style={{
                                  display: "flex",
                                  gap: 10,
                                  flexWrap: "wrap",
                                  alignItems: "center",
                                }}
                              >
                                {question.images.map((image, imageIndex) => (
                                  <div
                                    key={`${image.name}-${imageIndex}`}
                                    style={{
                                      width: 86,
                                      display: "grid",
                                      gap: 6,
                                      color: "#94a3b8",
                                      fontSize: 12,
                                    }}
                                  >
                                    <img
                                      alt={image.alt || image.name}
                                      src={image.src}
                                      style={{
                                        width: 86,
                                        height: 64,
                                        objectFit: "contain",
                                        border: "1px solid #334155",
                                        borderRadius: 8,
                                        background: "#020617",
                                      }}
                                    />
                                    <span>{image.name}</span>
                                  </div>
                                ))}
                                <button
                                  onClick={() =>
                                    setDraft((currentDraft) => ({
                                      ...currentDraft,
                                      rounds: currentDraft.rounds.map(
                                        (currentRound, currentRoundIndex) => {
                                          if (currentRoundIndex !== roundIndex) {
                                            return currentRound;
                                          }

                                          return {
                                            ...currentRound,
                                            questions: currentRound.questions.map(
                                              (currentQuestion, currentQuestionIndex) =>
                                                currentQuestionIndex === questionIndex
                                                  ? {
                                                      ...currentQuestion,
                                                      images: [],
                                                      imagesRemoved: true,
                                                    }
                                                  : currentQuestion,
                                            ),
                                          };
                                        },
                                      ),
                                    }))
                                  }
                                >
                                  Bilder entfernen
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </section>
                  ))}
                </div>
              </section>
            );
          })}

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
              marginTop: 20,
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "#93c5fd" }}>{message}</span>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {draft.id && (
                <button
                  onClick={() => createPrintableTeamQuizPdf(draft)}
                  style={{
                    padding: "12px 18px",
                    border: "1px solid #38bdf8",
                    borderRadius: 12,
                    background: "#082f49",
                    color: "#e0f2fe",
                    fontWeight: 700,
                  }}
                >
                  Team-PDF erstellen
                </button>
              )}
              <button
                onClick={handleSave}
                style={{
                  padding: "12px 18px",
                  border: "none",
                  borderRadius: 12,
                  background: "#22c55e",
                  color: "#0b1220",
                  fontWeight: 700,
                }}
              >
                Pubquiz speichern
              </button>
            </div>
          </div>
        </section>
      </div>
      {quizPendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Pubquiz ${quizPendingDelete.title || "Unbenanntes Pubquiz"} loeschen`}
          onClick={() => setQuizPendingDelete(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 30,
            display: "grid",
            placeItems: "center",
            padding: 24,
            background: "rgba(2, 6, 23, 0.86)",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(420px, 100%)",
              display: "grid",
              gap: 14,
              padding: 20,
              border: "1px solid #334155",
              borderRadius: 16,
              background: "#0b1220",
            }}
          >
            <h3 style={{ margin: 0 }}>Pubquiz wirklich loeschen?</h3>
            <p style={{ margin: 0, color: "#cbd5e1" }}>
              "{quizPendingDelete.title || "Unbenanntes Pubquiz"}"
              {quizPendingDelete.quizCode ? ` mit Code ${quizPendingDelete.quizCode}` : ""} wird
              dauerhaft entfernt.
            </p>
            <p style={{ margin: 0, color: "#fca5a5", fontSize: 14 }}>
              Diese Aktion kann nicht rueckgaengig gemacht werden.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setQuizPendingDelete(null)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #334155",
                  background: "#111827",
                  color: "#e5e7eb",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid rgba(248, 113, 113, 0.5)",
                  background: "#7f1d1d",
                  color: "#fee2e2",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Ja, loeschen
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function WaitingRoomScreen({
  canOpenRanking,
  isAdmin,
  lobbyCode,
  onOpenAdmin,
  onOpenFaq,
  onOpenMain,
  onOpenRanking,
  onOpenVouchers,
  onRoundChange,
  onUnlockRound,
  quizRounds,
  registeredTeams,
  selectedRound,
  sessionData,
}) {
  return (
    <main style={pageStyle}>
      <AppMenu
        canOpenRanking={canOpenRanking}
        isAdmin={isAdmin}
        onOpenAdmin={onOpenAdmin}
        onOpenFaq={onOpenFaq}
        onOpenMain={onOpenMain}
        onOpenRanking={onOpenRanking}
        onOpenVouchers={onOpenVouchers}
      />
      <section
        style={{
          maxWidth: 860,
          margin: "40px auto",
          padding: 28,
          border: "1px solid #1f2937",
          borderRadius: 16,
          background: "#111827",
        }}
      >
        <p style={{ margin: 0, color: "#93c5fd", fontWeight: 700 }}>
          Lobby {lobbyCode}
        </p>
        <h1 style={{ margin: "8px 0 0", fontSize: 42 }}>Warteraum</h1>
        <p style={{ color: "#cbd5e1", fontSize: 18 }}>
          {sessionData.teamName} - {sessionData.playerName || "Anonym"}
        </p>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
          {quizRounds.map((round, roundIndex) => {
            const isSelected = round.id === selectedRound.id;
            const publicRoundTitle = getRoundPublicTitle(round, roundIndex, null);

            return (
              <button
                key={round.id}
                onClick={() => onRoundChange(round.id)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 999,
                  border: `1px solid ${isSelected ? "#38bdf8" : "#334155"}`,
                  background: isSelected ? "#082f49" : "#020617",
                  color: isSelected ? "#e0f2fe" : "#cbd5e1",
                  fontWeight: 700,
                }}
              >
                {publicRoundTitle} - {round.durationMinutes} Min.
              </button>
            );
          })}
        </div>

        {isAdmin ? (
          <button
            onClick={() => onUnlockRound(selectedRound.id)}
            style={{
              marginTop: 22,
              padding: "12px 18px",
              borderRadius: 12,
              border: "none",
              background: "#22c55e",
              color: "#0b1220",
              fontSize: 18,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {getRoundDisplayTitle(selectedRound, quizRounds.findIndex((round) => round.id === selectedRound.id))} freischalten
          </button>
        ) : (
          <p style={{ marginTop: 22, color: "#94a3b8", fontSize: 18 }}>
            Der Admin startet die Runde, sobald alle Teams drin sind.
          </p>
        )}

        <TeamList registeredTeams={registeredTeams} />
      </section>
    </main>
  );
}

function TeamList({ registeredTeams }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ marginBottom: 12 }}>Registrierte Teams</h2>
      {registeredTeams.length === 0 ? (
        <p style={{ color: "#94a3b8" }}>Noch keine Teams registriert.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {registeredTeams.map((team) => (
            <div
              key={team.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                padding: 12,
                border: "1px solid #1f2937",
                borderRadius: 12,
                background: "#0b1220",
              }}
            >
              <strong>{team.teamName}</strong>
              <span style={{ color: "#94a3b8" }}>
                {team.playerName || "Anonym"}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function QuizScreen({
  activeRound,
  answerDrafts,
  allTeamsFinishedFinalRound,
  allTeamsReadyForRanking,
  canOpenRanking,
  lobbyData,
  message,
  now,
  isAdmin,
  onAnswerChange,
  onCheckAnswer,
  onFinalReady,
  onOpenAdmin,
  onOpenFaq,
  onOpenMain,
  onOpenRanking,
  onOpenVouchers,
  onRevealHint,
  onRoundChange,
  onStartTeamRound,
  onTiebreakerReady,
  onTiebreakerSubmit,
  onUnlockRound,
  pointToast,
  questions,
  quizRounds,
  sessionData,
  sessionId,
  teamFinalReady,
  tiebreakerClientId,
  tiebreakerEligible,
  tiebreakerFinalRoundFinished,
}) {
  const activeRoundIndex = quizRounds.findIndex((round) => round.id === activeRound.id);
  const activeRoundPublicTitle = getRoundPublicTitle(
    activeRound,
    activeRoundIndex >= 0 ? activeRoundIndex : 0,
    lobbyData,
  );
  const activeQuestions = activeRound.questionIds
    .map((questionId) => questions[questionId])
    .filter(Boolean);
  const answeredCount = activeQuestions.filter((question) => {
    const savedText = sessionData?.answers?.[question.id]?.text;

    return typeof savedText === "string" && savedText.trim().length > 0;
  }).length;
  const hintBudget = hintBudgets[activeRound.id] || 0;
  const revealedHints = sessionData?.hints?.[activeRound.id] || {};
  const usedHints = Object.values(revealedHints).filter(Boolean).length;
  const remainingHints = Math.max(0, hintBudget - usedHints);
  const roundUnlocked = isRoundUnlocked(lobbyData, activeRound.id);
  const roundUnlockMs = getRoundUnlockMs(lobbyData, activeRound.id);
  const roundEligibilityMs = getRoundEligibilityMs(
    sessionData,
    lobbyData,
    activeRound.id,
    now,
    quizRounds,
  );
  const roundStartMs = getEffectiveRoundStartMs(
    sessionData,
    lobbyData,
    activeRound.id,
    now,
    quizRounds,
  );
  const roundDurationMs = getRoundDurationMs(activeRound, lobbyData);
  const remainingRoundMs =
    roundStartMs === null ? null : roundStartMs + roundDurationMs - now;
  const roundHasStarted = roundStartMs !== null;
  const roundExpired = roundHasStarted && remainingRoundMs <= 0;
  const roundStartWindowExpired =
    Boolean(roundEligibilityMs) &&
    !getManualRoundStartMs(sessionData, activeRound.id) &&
    roundHasStarted;
  const autoStartMs = roundEligibilityMs ? roundEligibilityMs + ROUND_START_WINDOW_MS : null;
  const roundExtraMinutes = getRoundExtraMinutes(lobbyData, activeRound.id);
  const roundExtraAnnouncement = lobbyData?.roundExtraAnnouncements?.[activeRound.id];
  const answersRevealed = isRoundAnswersRevealed(lobbyData, activeRound.id);
  const answerWindowEndsMs = getTimestampMs(lobbyData?.answerWindowEndsAt);
  const answerWindowClosed = isAnswerWindowClosed(lobbyData, now);
  const shouldShowQuizMessage =
    message &&
    /abgelaufen|Bitte|Fehler|fehlgeschlagen|konnte|ungueltig|ungültig/i.test(
      message,
    );
  const [pendingHint, setPendingHint] = useState(null);

  async function confirmHint() {
    if (!pendingHint) return;

    await onRevealHint(pendingHint.roundId, pendingHint.questionId);
    setPendingHint(null);
  }

  return (
    <main style={pageStyle}>
      <AppMenu
        canOpenRanking={canOpenRanking}
        isAdmin={isAdmin}
        onOpenAdmin={onOpenAdmin}
        onOpenFaq={onOpenFaq}
        onOpenMain={onOpenMain}
        onOpenRanking={onOpenRanking}
        onOpenVouchers={onOpenVouchers}
      />
      <header
        style={{
          maxWidth: 980,
          margin: "0 auto 24px",
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div>
          <p style={{ margin: 0, color: "#93c5fd", fontWeight: 700 }}>
            Lobby {sessionData.lobbyCode}
          </p>
          <h1 style={{ margin: "6px 0 0", fontSize: 42 }}>Quiz</h1>
          <p style={{ margin: "8px 0 0", color: "#cbd5e1", fontSize: 18 }}>
            {sessionData.teamName} - {sessionData.playerName || "Anonym"}
          </p>
        </div>

        <div style={{ textAlign: "right" }}>
          <p style={{ margin: 0, color: "#94a3b8" }}>
            Ranking: {sessionData.rankingOptIn ? "Ja" : "Nein"}
          </p>
          <p style={{ margin: "8px 0 0", fontSize: 28, fontWeight: 700 }}>
            {sessionData.totalPoints ?? 0} Punkte
          </p>
          {pointToast && (
            <p
              key={pointToast.id}
              style={{
                margin: "8px 0 0",
                padding: "8px 10px",
                border: "1px solid #22c55e",
                borderRadius: 10,
                background: "#052e1a",
                color: "#bbf7d0",
                fontWeight: 700,
              }}
            >
              {repairMojibake(pointToast.message)}
            </p>
          )}
          <p style={{ margin: "8px 0 0", color: "#cbd5e1" }}>
            {activeRoundPublicTitle}: {answeredCount}/{activeQuestions.length} beantwortet
          </p>
          <p style={{ margin: "8px 0 0", color: "#cbd5e1" }}>
            Hinweise: {remainingHints}/{hintBudget}
          </p>
          {roundExtraMinutes > 0 && (
            <p style={{ margin: "8px 0 0", color: "#86efac", fontWeight: 700 }}>
              Zusatzzeit aktiv: +{roundExtraMinutes} Minuten
            </p>
          )}
          <p
            style={{
              margin: "8px 0 0",
              color: roundExpired || answerWindowClosed ? "#fca5a5" : "#fde68a",
              fontSize: 22,
              fontWeight: 700,
            }}
          >
            {answerWindowClosed
              ? "Antwortzeit geschlossen"
              : roundHasStarted
              ? roundExpired
                ? "Zeit abgelaufen"
                : formatDuration(remainingRoundMs)
              : "Noch nicht gestartet"}
          </p>
          {answerWindowEndsMs > 0 && !answerWindowClosed && (
            <p style={{ margin: "8px 0 0", color: "#cbd5e1" }}>
              Antworten offen bis{" "}
              {new Date(answerWindowEndsMs).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
        </div>
      </header>

      {shouldShowQuizMessage && (
        <p
          style={{
            maxWidth: 980,
            margin: "0 auto 16px",
            padding: "10px 12px",
            border: "1px solid #7f1d1d",
            borderRadius: 12,
            background: "#450a0a",
            color: "#fecaca",
            fontWeight: 700,
          }}
        >
          {message}
        </p>
      )}

      {roundExtraMinutes > 0 && (
        <section
          style={{
            maxWidth: 980,
            margin: "0 auto 16px",
            padding: "12px 14px",
            border: "1px solid #16a34a",
            borderRadius: 12,
            background: "#052e16",
            color: "#dcfce7",
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            Sorry, wir haben einen Fehler gemacht.
          </strong>
          <span>
            {roundExtraAnnouncement?.message ||
              "Hier sind ein paar Minuten extra fuer alle Teams."}{" "}
            +{roundExtraMinutes} Minuten fuer {activeRoundPublicTitle}.
          </span>
        </section>
      )}

      {tiebreakerFinalRoundFinished && !allTeamsReadyForRanking && (
        <section
          style={{
            maxWidth: 980,
            margin: "0 auto 24px",
            padding: 18,
            border: "1px solid #334155",
            borderRadius: 14,
            background: "#111827",
            color: "#cbd5e1",
          }}
        >
          <h2 style={{ marginTop: 0 }}>Quiz fertig?</h2>
          <p style={{ marginTop: 0 }}>
            {repairMojibake(
              "Markiert euer Team als bereit, sobald Runde 3 wirklich abgeschlossen ist. Die Schätzfrage erscheint erst, wenn alle Teams fertig und bereit sind.",
            )}
          </p>
          {!tiebreakerEligible && (
            <p style={{ marginTop: 0, color: "#94a3b8" }}>
              Euer Team nimmt nicht an der Schätzfrage teil.
            </p>
          )}
          {!teamFinalReady && (
            <button
              onClick={onFinalReady}
              style={{
                padding: "10px 14px",
                borderRadius: 12,
                border: "none",
                background: "#22c55e",
                color: "#0b1220",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {repairMojibake("Bereit fürs Ranking")}
            </button>
          )}
          {teamFinalReady && (
            <p style={{ marginBottom: 0, color: "#86efac" }}>
              Euer Team ist bereit. {allTeamsFinishedFinalRound
                ? "Sobald alle Teams bereit sind, geht es weiter."
                : "Die anderen Teams spielen Runde 3 noch zu Ende."}
            </p>
          )}
        </section>
      )}

      {tiebreakerEligible && tiebreakerFinalRoundFinished && allTeamsReadyForRanking && (
        <TiebreakerTeamPanel
          lobbyData={lobbyData}
          clientId={tiebreakerClientId}
          finalRoundFinished={tiebreakerFinalRoundFinished}
          now={now}
          onReady={onTiebreakerReady}
          onSubmit={onTiebreakerSubmit}
          sessionId={sessionId}
          teamName={sessionData.teamName}
        />
      )}

      <section
        style={{
          maxWidth: 980,
          margin: "0 auto",
          borderTop: "1px solid #1f2937",
          paddingTop: 20,
        }}
      >
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {quizRounds.map((round, roundIndex) => {
            const isActive = round.id === activeRound.id;
            const hasQuestions = round.questionIds.length > 0;
            const publicRoundTitle = getRoundPublicTitle(round, roundIndex, lobbyData);

            return (
              <button
                key={round.id}
                disabled={!hasQuestions}
                onClick={() => onRoundChange(round.id)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 999,
                  border: `1px solid ${isActive ? "#38bdf8" : "#334155"}`,
                  background: isActive ? "#082f49" : "#020617",
                  color: hasQuestions
                    ? isActive
                      ? "#e0f2fe"
                      : "#cbd5e1"
                    : "#64748b",
                  fontWeight: 700,
                  cursor: hasQuestions ? "pointer" : "not-allowed",
                }}
              >
                {publicRoundTitle}
                {isRoundUnlocked(lobbyData, round.id) ? " - frei" : ""}
              </button>
            );
          })}
        </div>

        {!roundUnlocked && (
          <div
            style={{
              marginTop: 24,
              padding: 18,
              border: "1px solid #334155",
              borderRadius: 14,
              background: "#111827",
            }}
          >
            {isAdmin ? (
              <button onClick={() => onUnlockRound(activeRound.id)}>
                {getRoundDisplayTitle(activeRound, activeRoundIndex >= 0 ? activeRoundIndex : 0)} freischalten
              </button>
            ) : (
              <p style={{ margin: 0, color: "#94a3b8" }}>
                Diese Runde wurde noch nicht freigeschaltet.
              </p>
            )}
          </div>
        )}

        {roundUnlocked && !roundHasStarted && (
          <div
            style={{
              marginTop: 24,
              padding: 18,
              border: "1px solid #334155",
              borderRadius: 14,
              background: "#111827",
            }}
          >
            <p style={{ marginTop: 0, color: "#cbd5e1" }}>
              Die Runde ist freigeschaltet. Startet euren Timer, wenn ihr bereit
              seid.
            </p>
            <p style={{ color: roundStartWindowExpired ? "#fca5a5" : "#94a3b8" }}>
              {autoStartMs
                ? `Wenn ihr nicht selbst startet, beginnt der Timer automatisch um ${new Date(
                    autoStartMs,
                  ).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}.`
                : "Wenn ihr nicht selbst startet, beginnt der Timer 10 Minuten nach eurem Einstieg oder nach dem Abschluss der vorherigen Runde automatisch."}
            </p>
            <button
              onClick={() => onStartTeamRound(activeRound.id)}
              style={{
                minHeight: 48,
                padding: "12px 18px",
                borderRadius: 12,
                border: "1px solid #38bdf8",
                background: "#0ea5e9",
                color: "#020617",
                fontSize: 18,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Timer für unser Team starten
            </button>
          </div>
        )}

        {roundHasStarted && activeQuestions.length === 0 && (
          <p style={{ marginTop: 28, color: "#94a3b8", fontSize: 18 }}>
            Diese Runde hat noch keine Fragen.
          </p>
        )}

        {roundHasStarted &&
          activeQuestions.map((question, index) => (
            <QuestionCard
              answer={answerDrafts[question.id] ?? ""}
              disabled={!roundUnlocked || roundExpired || answerWindowClosed}
              hintBudget={hintBudget}
              hintRevealed={Boolean(revealedHints[question.id])}
              isSixthQuestion={index === 5}
              key={question.id}
              onAnswerChange={(value) => onAnswerChange(question.id, value)}
              onCheckAnswer={() => onCheckAnswer(question)}
              onRevealHint={() =>
                setPendingHint({
                  questionId: question.id,
                  questionTitle: question.title,
                  roundId: activeRound.id,
                })
              }
              question={question}
              remainingHints={remainingHints}
              roundTitle={activeRoundPublicTitle}
              savedQuestion={sessionData?.answers?.[question.id]}
              showAnswer={answersRevealed && roundExpired}
            />
          ))}
      </section>

      {pendingHint && (
        <HintConfirmModal
          remainingHints={remainingHints}
          questionTitle={pendingHint.questionTitle}
          onCancel={() => setPendingHint(null)}
          onConfirm={confirmHint}
        />
      )}
    </main>
  );
}

function TiebreakerTeamPanel({
  clientId,
  finalRoundFinished,
  lobbyData,
  now,
  onReady,
  onSubmit,
  sessionId,
  teamName,
}) {
  const [estimate, setEstimate] = useState("");
  const isReady = Boolean(lobbyData?.tiebreakerReady?.[sessionId]);
  const isActive = lobbyData?.tiebreakerStatus === "active";
  const participant = getTiebreakerParticipant(lobbyData, sessionId);
  const claimedByAnotherDevice =
    Boolean(participant?.clientId) && participant.clientId !== clientId;
  const submission = getTiebreakerSubmission(lobbyData, sessionId);
  const answer = Number(lobbyData?.tiebreakerAnswer);
  const distance = getTiebreakerDistance(lobbyData, sessionId);
  const elapsedMs = isActive
    ? (submission
        ? getTimestampMs(submission.submittedAt)
        : now) - getTimestampMs(lobbyData?.tiebreakerStartedAt)
    : 0;

  async function handleSubmit(e) {
    e.preventDefault();
    await onSubmit(estimate);
  }

  return (
    <section
      style={{
        maxWidth: 980,
        margin: "0 auto 24px",
        padding: 18,
        border: "1px solid #f59e0b",
        borderRadius: 14,
        background: "#451a03",
        color: "#fde68a",
      }}
    >
      <h2 style={{ marginTop: 0 }}>Schätzfrage</h2>
      <p style={{ color: "#fed7aa" }}>
        {teamName} ist im Gleichstand um die Top 3. Nur die erste Abgabe eures
        Teams zählt.
      </p>
      {lobbyData?.tiebreakerQuestion && (
        <p style={{ fontSize: 20, fontWeight: 700 }}>{lobbyData.tiebreakerQuestion}</p>
      )}
      {isActive && (
        <p style={{ margin: "0 0 12px", fontSize: 26, fontWeight: 700 }}>
          {formatStopwatch(elapsedMs)}
        </p>
      )}

      {!finalRoundFinished && !isReady && !submission && (
        <p style={{ marginBottom: 0 }}>
          Ihr könnt beitreten, sobald eure dritte Runde fertig ist.
        </p>
      )}

      {claimedByAnotherDevice && !submission && (
        <p style={{ marginBottom: 0 }}>
          {participant.playerName || "Ein Teammitglied"} hat die Schätzfrage
          bereits für dieses Team geöffnet. Nur dieses Gerät kann abgeben.
        </p>
      )}

      {finalRoundFinished && !isReady && !claimedByAnotherDevice && !submission && (
        <button
          onClick={onReady}
          style={{
            padding: "10px 14px",
            borderRadius: 12,
            border: "none",
            background: "#22c55e",
            color: "#0b1220",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {isActive ? "Schätzfrage öffnen" : "Bereit"}
        </button>
      )}

      {isReady && !isActive && !claimedByAnotherDevice && (
        <p style={{ marginBottom: 0 }}>Bereit. Die Schätzfrage startet, sobald alle betroffenen Teams bereit sind.</p>
      )}

      {isActive && !submission && !claimedByAnotherDevice && isReady && (
        <form onSubmit={handleSubmit} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="number"
            step="any"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            placeholder="Eure Schätzung"
            style={{
              ...inputStyle,
              maxWidth: 220,
              background: "#111827",
            }}
          />
          <button
            type="submit"
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "none",
              background: "#38bdf8",
              color: "#082f49",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Einmalig abgeben
          </button>
        </form>
      )}

      {submission && (
        <p style={{ marginBottom: 0 }}>
          Abgegeben: {submission.estimate}
          {getTimestampMs(submission.submittedAt) &&
          getTimestampMs(lobbyData?.tiebreakerStartedAt)
            ? ` - Zeit ${formatStopwatch(elapsedMs)}`
            : ""}
          {Number.isFinite(answer) && distance !== null
            ? ` - ${submission.estimate === answer ? "richtig" : `Abstand ${distance}`}`
            : ""}
        </p>
      )}
    </section>
  );
}

function HintConfirmModal({
  remainingHints,
  questionTitle,
  onCancel,
  onConfirm,
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10,
        display: "grid",
        placeItems: "center",
        padding: 20,
        background: "rgba(2, 6, 23, 0.78)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hint-confirm-title"
        style={{
          width: "min(420px, 100%)",
          padding: 22,
          border: "1px solid #334155",
          borderRadius: 16,
          background: "#111827",
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.45)",
        }}
      >
        <h2 id="hint-confirm-title" style={{ margin: 0, fontSize: 24 }}>
          Hinweis verwenden?
        </h2>
        <p style={{ color: "#cbd5e1", fontSize: 17, lineHeight: 1.45 }}>
          Fuer {questionTitle} wird ein Hinweis verbraucht. Danach bleiben noch{" "}
          {Math.max(0, remainingHints - 1)} Hinweise in dieser Runde.
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            marginTop: 20,
          }}
        >
          <button onClick={onCancel}>Abbrechen</button>
          <button
            onClick={onConfirm}
            style={{
              background: "#f59e0b",
              border: "none",
              color: "#111827",
              fontWeight: 700,
              padding: "8px 12px",
            }}
          >
            Ja, Hinweis nutzen
          </button>
        </div>
      </div>
    </div>
  );
}

function QuestionCard({
  answer,
  disabled,
  hintBudget,
  hintRevealed,
  isSixthQuestion,
  onAnswerChange,
  onCheckAnswer,
  onRevealHint,
  question,
  remainingHints,
  roundTitle,
  savedQuestion,
  showAnswer,
}) {
  const hintAllowed = hintBudget > 0 && !isSixthQuestion && Boolean(question.hint);
  const canRevealHint =
    hintAllowed && !hintRevealed && remainingHints > 0 && !disabled;
  const result = savedQuestion?.result;
  const [wrongFlash, setWrongFlash] = useState(false);
  const questionText = question.prompt || question.title;
  const questionLabel = question.prompt ? question.title : roundTitle;

  useEffect(() => {
    if (result !== "incorrect") return undefined;

    setWrongFlash(true);
    const timeout = window.setTimeout(() => setWrongFlash(false), 900);

    return () => window.clearTimeout(timeout);
  }, [result, savedQuestion?.text]);

  const resultStyles = {
    correct: {
      background: "#052e1a",
      borderColor: "#22c55e",
      boxShadow: "0 0 0 1px rgba(34, 197, 94, 0.25)",
    },
    partial: {
      background: "#2b1d05",
      borderColor: "#f59e0b",
      boxShadow: "0 0 0 1px rgba(245, 158, 11, 0.25)",
    },
    incorrect: {
      background: wrongFlash ? "#7f1d1d" : "#111827",
      borderColor: wrongFlash ? "#f87171" : "#334155",
      boxShadow: wrongFlash
        ? "0 0 0 3px rgba(248, 113, 113, 0.28)"
        : "none",
    },
  };
  const statusStyle = resultStyles[result] || {};

  return (
    <div
      style={{
        marginTop: 28,
        padding: 24,
        border: `1px solid ${statusStyle.borderColor || "#1f2937"}`,
        borderRadius: 16,
        background: statusStyle.background || "#111827",
        boxShadow: statusStyle.boxShadow || "none",
        color: "#f8fafc",
        transition: "background 180ms ease, border-color 180ms ease, box-shadow 180ms ease",
      }}
    >
      <p style={{ margin: 0, color: "#94a3b8", fontWeight: 700 }}>
        {roundTitle} - {questionLabel}
      </p>
      <h2
        style={{
          margin: "8px 0 20px",
          color: "#f8fafc",
          fontSize: 26,
          fontWeight: 800,
          lineHeight: 1.25,
          overflowWrap: "anywhere",
        }}
      >
        {questionText}
      </h2>

      {question.media?.type === "image" && (
        <ImageQuestionMedia images={question.media.images || []} />
      )}

      {hintAllowed && (
        <div
          style={{
            marginBottom: 18,
            padding: 14,
            border: "1px solid #334155",
            borderRadius: 12,
            background: "#111827",
          }}
        >
          {hintRevealed ? (
            <p style={{ margin: 0, color: "#fde68a" }}>{question.hint}</p>
          ) : (
            <button disabled={!canRevealHint} onClick={onRevealHint}>
              {remainingHints > 0 ? "Hinweis verwenden" : "Keine Hinweise übrig"}
            </button>
          )}
        </div>
      )}

      <input
        value={answer}
        onChange={(e) => onAnswerChange(e.target.value)}
        placeholder="Antwort eingeben..."
        disabled={disabled || savedQuestion?.locked}
        style={{
          ...inputStyle,
          borderColor: wrongFlash ? "#f87171" : "#cbd5e1",
          background: "#f8fafc",
          color: "#0f172a",
          opacity: disabled || savedQuestion?.locked ? 0.7 : 1,
          boxShadow: wrongFlash ? "0 0 0 3px rgba(248, 113, 113, 0.35)" : "none",
        }}
      />

      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          disabled={disabled}
          onClick={onCheckAnswer}
          style={{
            minHeight: 44,
            padding: "10px 16px",
            borderRadius: 12,
            border: "1px solid #22c55e",
            background: disabled ? "#334155" : "#22c55e",
            color: disabled ? "#94a3b8" : "#052e16",
            fontSize: 17,
            fontWeight: 800,
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          Prüfen
        </button>
      </div>

      {savedQuestion?.matchedSegments?.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 24 }}>
          {savedQuestion.matchedSegments.map((seg, i) => {
            if (seg.kind === "space") {
              return <span key={i}>&nbsp;</span>;
            }

            if (seg.kind === "correct") {
              return (
                <span key={i} style={{ color: "#22c55e", fontWeight: 700 }}>
                  {seg.text}
                </span>
              );
            }

            return (
              <span key={i} style={{ color: "#ef4444", fontWeight: 700 }}>
                {seg.text}
              </span>
            );
          })}
        </div>
      )}

      {showAnswer && (
        <div
          style={{
            marginTop: 16,
            padding: 14,
            border: "1px solid #22c55e",
            borderRadius: 12,
            background: "#052e1a",
            color: "#bbf7d0",
          }}
        >
          <strong>Lösung:</strong> {question.acceptedAnswers.join(" / ")}
        </div>
      )}
    </div>
  );
}

function ImageQuestionMedia({ images }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 12,
        marginBottom: 18,
      }}
    >
      {images.map((image, index) => (
        <div
          key={image.src || image.label || index}
          style={{
            minHeight: 140,
            border: "1px solid #334155",
            borderRadius: 12,
            background: "#111827",
            display: "grid",
            placeItems: "center",
            overflow: "hidden",
          }}
        >
          {image.src ? (
            <img
              alt={image.alt || image.label || `Bild ${index + 1}`}
              src={image.src}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <span style={{ color: "#94a3b8", fontWeight: 700 }}>
              {image.label || `Bild ${index + 1}`}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export default App;
