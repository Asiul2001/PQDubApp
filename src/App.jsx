import { useEffect, useMemo, useState } from "react";
import { db } from "./firebase";
import {
  arrayUnion,
  collection,
  collectionGroup,
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
import QRCode from "qrcode";
import {
  hintBudgets,
  latestQuizId,
  questions as defaultQuestions,
  quizRounds as defaultQuizRounds,
} from "./quiz";

const pageStyle = {
  minHeight: "100vh",
  background: "#0f172a",
  color: "#e5e7eb",
  fontFamily: "Arial, sans-serif",
  padding: "80px 24px 24px",
  boxSizing: "border-box",
};

const inputStyle = {
  width: "100%",
  padding: 14,
  borderRadius: 12,
  border: "1px solid #334155",
  background: "#020617",
  color: "#e5e7eb",
  fontSize: 18,
  boxSizing: "border-box",
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

function getEventRef(code) {
  return doc(db, "quizEvents", getEventId(code));
}

function getTeamRef(teamId) {
  return doc(db, "teams", teamId);
}

function getTeamSessionRef(code, teamId) {
  return doc(db, "quizEvents", getEventId(code), "teamSessions", teamId);
}

function getTeammateRef(teamId, teammateId) {
  return doc(db, "teams", teamId, "teammates", teammateId);
}

function getRoundStartMs(lobbyData, roundId) {
  const startedAt = lobbyData?.roundStarts?.[roundId];
  const startedAtMs = getTimestampMs(startedAt);

  return startedAtMs || null;
}

function isRoundUnlocked(lobbyData, roundId) {
  return Boolean(lobbyData?.unlockedRounds?.[roundId]);
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

function getTimestampMs(value) {
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

function isAnswerWindowClosed(lobbyData, now) {
  const endsAtMs = getTimestampMs(lobbyData?.answerWindowEndsAt);

  return Boolean(endsAtMs && now > endsAtMs);
}

function canManageManagerRecords(activeManager, managers) {
  if (!activeManager) return false;
  if (activeManager.headManager) return true;

  return !managers.some((manager) => manager.headManager);
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

function isRoundFinished(team, round, now) {
  const startMs = getRoundStartMs(team, round.id);

  if (startMs === null) return false;

  const durationMs = round.durationMinutes * 60 * 1000;
  if (startMs + durationMs <= now) return true;

  return round.questionIds.every((questionId) => {
    const savedText = team?.answers?.[questionId]?.text;

    return typeof savedText === "string" && savedText.trim().length > 0;
  });
}

function aggregateYearlyRanking(teams) {
  const groupedTeams = new Map();
  const lobbyGroups = new Map();
  const rankingTeamKeys = new Set();

  teams.forEach((team) => {
    const key = team.teamNameNormalized || normalizeTeamName(team.teamName || "");
    if (team.rankingOptIn && key) rankingTeamKeys.add(key);
  });

  teams
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
        totalQuizPoints: current.totalQuizPoints + (team.totalPoints || 0),
        totalPoints: current.totalPoints + (team.totalPoints || 0),
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

    const podiumTeams = [...lobbyTeams]
      .sort(
        (a, b) =>
          (b.totalPoints || 0) - (a.totalPoints || 0) ||
          a.teamName.localeCompare(b.teamName),
      )
      .slice(0, 3);
    const podiumPoints = [1.5, 1, 0.5];

    podiumTeams.forEach((team, index) => {
      const key = team.teamNameNormalized || normalizeTeamName(team.teamName || "");
      if (!key) return;

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
        podiums: current.podiums + 1,
        totalPoints: current.totalPoints + podiumPoints[index],
      });
    });
  });

  return Array.from(groupedTeams.values()).sort(
    (a, b) => b.totalPoints - a.totalPoints || a.teamName.localeCompare(b.teamName),
  );
}

function getTiebreakerSubmission(lobbyData, teamId) {
  return lobbyData?.tiebreakerSubmissions?.[teamId] || null;
}

function getTiebreakerParticipant(lobbyData, teamId) {
  return lobbyData?.tiebreakerParticipants?.[teamId] || null;
}

function getEstimateValue(lobbyData, teamId) {
  const rawEstimate = getTiebreakerSubmission(lobbyData, teamId)?.estimate;
  const estimate = Number(rawEstimate);

  return Number.isFinite(estimate) ? estimate : null;
}

function getTiebreakerSubmittedMs(lobbyData, teamId) {
  return getTimestampMs(getTiebreakerSubmission(lobbyData, teamId)?.submittedAt);
}

function getTiebreakerDistance(lobbyData, teamId) {
  const answer = Number(lobbyData?.tiebreakerAnswer);
  const estimate = getEstimateValue(lobbyData, teamId);

  if (!Number.isFinite(answer) || estimate === null) return null;

  return Math.abs(estimate - answer);
}

function getDailyRankingWithTiebreakers(teams, lobbyData) {
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

function aggregateTeamDirectory(teams) {
  const groupedTeams = new Map();

  teams.forEach((team) => {
    const key = team.teamNameNormalized || normalizeTeamName(team.teamName || "");
    if (!key) return;

    const current = groupedTeams.get(key) || {
      id: key,
      normalizedPlayerNames: [],
      playerNames: [],
      rankingOptIn: false,
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
      rankingOptIn: current.rankingOptIn || Boolean(team.rankingOptIn),
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

function createEmptyPubQuizQuestion(roundIndex, questionIndex) {
  return {
    id: `r${roundIndex + 1}q${questionIndex + 1}`,
    title: `Frage ${questionIndex + 1}`,
    prompt: "",
    hint: questionIndex === 5 ? "" : "",
    answersText: "",
    points: 1,
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
        points: Number(question.points) || 1,
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
        points: Number(question.points) || 1,
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
      title: round.title || `Runde ${roundIndex + 1}`,
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderPrintableTeamQuizCopy(round, quizTitle, copyLabel) {
  const category = round.category || round.title;
  const roundNumber = round.id?.match(/\d+/)?.[0] || round.title.match(/\d+/)?.[0] || "";

  return `
    <section class="copy">
      <div class="copy-inner">
        <p class="copy-title">${escapeHtml(quizTitle)} - ${escapeHtml(copyLabel)}</p>
        <p class="category-line">Kategorie ${escapeHtml(roundNumber)} "${escapeHtml(category)}":</p>
        <div class="questions">
          ${round.questions
            .map(
              (question, index) => `
                <section class="question-block">
                  <div class="question-title">Frage ${index + 1}${
                    Number(question.points) > 1 ? ` (${escapeHtml(question.points)} Punkte)` : ""
                  }:</div>
                  <div class="prompt">${escapeHtml(question.prompt || "Noch keine Frage eingetragen.")}</div>
                  ${
                    question.mediaNote
                      ? `<div class="note">Bildnotiz: ${escapeHtml(question.mediaNote)}</div>`
                      : ""
                  }
                  ${
                    question.images?.length
                      ? `<div class="print-images">
                          ${question.images
                            .map(
                              (image) => `
                                <img
                                  alt="${escapeHtml(image.alt || image.name || "Bildfrage")}"
                                  src="${escapeHtml(image.src)}"
                                />
                              `,
                            )
                            .join("")}
                        </div>`
                      : ""
                  }
                </section>
              `,
            )
            .join("")}
        </div>
      </div>
    </section>
  `;
}

function createPrintableTeamQuizPdf(draft) {
  const quiz = sanitizePubQuizDraft(draft);
  const printWindow = window.open("", "_blank");

  if (!printWindow) return;

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(quiz.title)} - Druck-PDF</title>
        <style>
          @page {
            size: A4;
            margin: 10mm;
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            color: #111827;
            font-family: Arial, sans-serif;
            background: #ffffff;
          }

          .page {
            position: relative;
            height: 277mm;
            overflow: hidden;
            break-after: page;
            break-inside: avoid;
            page-break-after: always;
            page-break-inside: avoid;
          }

          .page:last-child {
            page-break-after: auto;
          }

          .copy {
            position: absolute;
            left: 0;
            right: 0;
            height: calc((277mm - 6mm) / 2);
            padding: 5mm 9mm;
            overflow: hidden;
            break-inside: avoid;
            page-break-inside: avoid;
          }

          .copy:first-child {
            top: 0;
          }

          .copy:last-child {
            bottom: 0;
          }

          .copy-inner {
            transform-origin: top left;
            width: 100%;
          }

          .copy-title {
            margin: 0 0 1mm;
            font-size: 6.5pt;
            color: #6b7280;
          }

          .category-line {
            margin: 0 0 1.5mm;
            font-size: 8.5pt;
            font-weight: 700;
          }

          .questions {
            display: grid;
            gap: 0.9mm;
          }

          .question-block {
            break-inside: auto;
            page-break-inside: auto;
          }

          .question-title {
            font-weight: 700;
            font-size: 8pt;
          }

          .prompt {
            margin-top: 0.1mm;
            font-size: 8.4pt;
            line-height: 1.16;
          }

          .print-images {
            display: flex;
            gap: 1.3mm;
            flex-wrap: wrap;
            align-items: flex-start;
            margin-top: 0.5mm;
          }

          .print-images img {
            max-width: 50mm;
            max-height: 50mm;
            object-fit: contain;
          }

          .note {
            margin-top: 0.2mm;
            font-size: 7pt;
            color: #374151;
          }
        </style>
      </head>
      <body>
        ${quiz.rounds
          .map(
            (round) => `
              <main class="page">
                ${renderPrintableTeamQuizCopy(round, quiz.title, "Exemplar 1")}
                ${renderPrintableTeamQuizCopy(round, quiz.title, "Exemplar 2")}
              </main>
            `,
          )
          .join("")}
        <script>
          function fitQuizCopies() {
            document.querySelectorAll(".copy").forEach((copy) => {
              const inner = copy.querySelector(".copy-inner");

              if (!inner) return;

              inner.style.transform = "none";
              inner.style.width = "100%";

              const availableHeight = copy.clientHeight;
              const availableWidth = copy.clientWidth;
              const neededHeight = inner.scrollHeight;
              const neededWidth = inner.scrollWidth;
              const heightScale = availableHeight / Math.max(neededHeight, 1);
              const widthScale = availableWidth / Math.max(neededWidth, 1);
              const scale = Math.min(1, heightScale, widthScale);

              if (scale < 1) {
                inner.style.transform = \`scale(\${scale})\`;
                inner.style.width = \`\${100 / scale}%\`;
              }
            });
          }

          window.addEventListener("load", async () => {
            await Promise.all(
              Array.from(document.images).map((image) =>
                image.complete
                  ? Promise.resolve()
                  : new Promise((resolve) => {
                      image.onload = resolve;
                      image.onerror = resolve;
                    }),
              ),
            );
            fitQuizCopies();
            window.addEventListener("beforeprint", fitQuizCopies);
            window.focus();
            window.print();
          });
        </script>
      </body>
    </html>
  `;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

function App() {
  const [clientId] = useState(() => getClientId());
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
  const [lobbyCode, setLobbyCode] = useState(() => getInitialQuizCode());
  const [teamName, setTeamName] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [managerKey, setManagerKey] = useState("");
  const [managerPassword, setManagerPassword] = useState("");
  const [activeManager, setActiveManager] = useState(null);
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [lobbyData, setLobbyData] = useState(null);
  const [registeredTeams, setRegisteredTeams] = useState([]);
  const [allTeams, setAllTeams] = useState([]);
  const [managers, setManagers] = useState([]);
  const [feedbackEntries, setFeedbackEntries] = useState([]);
  const [answerDrafts, setAnswerDrafts] = useState({});
  const [now, setNow] = useState(() => Date.now());
  const [pendingTeamCreate, setPendingTeamCreate] = useState(null);
  const [appView, setAppView] = useState("main");
  const [pointToast, setPointToast] = useState(null);
  const [pubQuizzes, setPubQuizzes] = useState([]);
  const [quizManagerMessage, setQuizManagerMessage] = useState("");

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
    if (!sessionId || !sessionData?.lobbyCode) return undefined;

    const sessionRef = getTeamSessionRef(sessionData.lobbyCode, sessionId);

    return onSnapshot(sessionRef, (snapshot) => {
      if (!snapshot.exists()) return;

      const data = snapshot.data();
      setSessionData(data);
      setAnswerDrafts((currentDrafts) => {
        const nextDrafts = { ...currentDrafts };

        Object.entries(data?.answers || {}).forEach(([questionId, savedAnswer]) => {
          nextDrafts[questionId] = savedAnswer?.text ?? "";
        });

        return nextDrafts;
      });
    });
  }, [sessionData?.lobbyCode, sessionId]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 80);

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
    if (!sessionData?.lobbyCode || activePubQuiz) return undefined;

    let cancelled = false;

    async function loadQuizForSession() {
      const quizzesQuery = query(
        collection(db, "pubQuizzes"),
        where("quizCode", "==", sessionData.lobbyCode),
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
  }, [activePubQuiz, sessionData?.lobbyCode]);

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
    if (!activeManager && !sessionData) return undefined;

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
  }, [sessionData]);

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

  useEffect(() => {
    if (!activeManager || !sessionData?.lobbyCode) return;

    const dailyRows = getDailyRankingWithTiebreakers(registeredTeams, lobbyData)
      .ranking.map((team, index) => ({
        rank: index + 1,
        teamId: team.teamId || team.teamNameNormalized || team.id,
        teamName: team.teamName,
        totalPoints: team.totalPoints || 0,
        tiebreakerEstimate: getEstimateValue(lobbyData, team.id),
        tiebreakerDistance: getTiebreakerDistance(lobbyData, team.id),
        podiumBonusPoints: index === 0 ? 1.5 : index === 1 ? 1 : index === 2 ? 0.5 : 0,
      }));
    const globalRows = aggregateYearlyRanking(allTeams).map((team, index) => ({
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
  }, [activeManager, allTeams, lobbyData, registeredTeams, sessionData?.lobbyCode]);

  function updateAnswerDraft(questionId, value) {
    setAnswerDrafts((currentDrafts) => ({
      ...currentDrafts,
      [questionId]: value,
    }));
  }

  async function ensureLobby(cleanedCode, { deployForToday = false } = {}) {
    const lobbyRef = getEventRef(cleanedCode);
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
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } else {
      await setDoc(
        teamRef,
        createTeamRecord({ cleanedName, normalized, rankingOptIn }),
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
          headManager: true,
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
          return;
        }

        validatedManager = {
          id: managerSnapshot.id,
          ...managerData,
        };

        await updateDoc(managerRef, {
          lastLoginAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
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
          };

          await updateDoc(managerRef, {
            lastLoginAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }

        setActiveManager(validatedManager);
      } else {
        setActiveManager(null);
      }

      setActivePubQuiz(selectedPubQuiz);
      setActiveRoundId(
        selectedPubQuiz.rounds?.[0]?.id || defaultQuizRounds[0].id,
      );

      await ensureLobby(cleanedCode);

      const teamProfileRef = getTeamRef(normalized);
      const teamProfileSnapshot = await getDoc(teamProfileRef);
      const teamProfile = teamProfileSnapshot.exists()
        ? teamProfileSnapshot.data()
        : null;
      const existing = await getDoc(sessionRef);

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

    try {
      await saveTeamSession({
        cleanedCode,
        cleanedName,
        displayName,
        normalized,
        rankingOptIn,
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
      setMessage(`Neue Session erstellt für: ${cleanedName}`);
      setPendingTeamCreate(null);
    } catch (error) {
      console.error("CREATE TEAM ERROR:", error);
      setMessage(`Fehler beim Erstellen der Session: ${error.message}`);
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

      await setDoc(
        quizRef,
        {
          ...payload,
          id: quizId,
          quizCode,
          imageStorageEstimate: finalImageStorageEstimate,
          updatedAt: serverTimestamp(),
          createdAt: draft.id ? draft.createdAt || serverTimestamp() : serverTimestamp(),
        },
        { merge: true },
      );

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

      setQuizManagerMessage(`"${payload.title}" gespeichert.`);
      return { id: quizId, quizCode };
    } catch (error) {
      console.error("PUBQUIZ SAVE ERROR:", error);
      setQuizManagerMessage(`Speichern fehlgeschlagen: ${error.message}`);
      return null;
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
    const dailyRanking = getDailyRankingWithTiebreakers(registeredTeams, lobbyData);
    const finalRound = quizRounds[quizRounds.length - 1];
    const eligibleIds = new Set(
      dailyRanking.tieGroups.flatMap((group) =>
        group.teams
          .filter((team) => isRoundFinished(team, finalRound, now))
          .map((team) => team.id),
      ),
    );
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
          ...(allEligibleReady
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

  if (!sessionData) {
    return (
      <LobbyScreen
        canOpenRanking={false}
        lobbyCode={lobbyCode}
        isAdmin={isAdmin}
        managerKey={managerKey}
        managerPassword={managerPassword}
        message={message}
        onOpenRanking={() => setAppView("ranking")}
        playerName={playerName}
        teamName={teamName}
        onJoin={handleJoin}
        onAdminChange={(nextIsAdmin) => {
          setIsAdmin(nextIsAdmin);
          if (!nextIsAdmin) setActiveManager(null);
        }}
        onLobbyCodeChange={setLobbyCode}
        onManagerKeyChange={setManagerKey}
        onManagerPasswordChange={setManagerPassword}
        onPlayerNameChange={setPlayerName}
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

  if (appView === "ranking") {
    return (
      <RankingScreen
        isAdmin={isAdmin}
        allTeams={allTeams.length ? allTeams : registeredTeams}
        lobbyData={lobbyData}
        onOpenAdmin={() => setAppView("admin")}
        onOpenFaq={() => setAppView("faq")}
        onOpenMain={() => setAppView("main")}
        registeredTeams={registeredTeams}
        sessionData={sessionData}
        sessionId={sessionId}
      />
    );
  }

  if (appView === "faq") {
    return (
      <FaqScreen
        isAdmin={isAdmin}
        message={message}
        onOpenAdmin={() => setAppView("admin")}
        onOpenMain={() => setAppView("main")}
        onOpenRanking={() => setAppView("ranking")}
        onSubmitFeedback={submitFeedback}
        sessionData={sessionData}
      />
    );
  }

  if (appView === "admin" && isAdmin && activeManager) {
    return (
      <AdminScreen
        activeManager={activeManager}
        allTeams={allTeams}
        lobbyData={lobbyData}
        now={now}
        onOpenAdmin={() => setAppView("admin")}
        onOpenMain={() => setAppView("main")}
        onOpenFaq={() => setAppView("faq")}
        onOpenRanking={() => setAppView("ranking")}
        onLoadPubQuizByCode={loadPubQuizByCode}
        onRevealRoundAnswers={revealRoundAnswers}
        onSaveManager={saveManager}
        onSavePubQuiz={savePubQuiz}
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
      />
    );
  }

  if (!anyRoundUnlocked) {
    return (
      <WaitingRoomScreen
        canOpenRanking
        isAdmin={isAdmin}
        lobbyCode={sessionData.lobbyCode}
        onOpenAdmin={() => setAppView("admin")}
        onOpenFaq={() => setAppView("faq")}
        onOpenMain={() => setAppView("main")}
        onOpenRanking={() => setAppView("ranking")}
        onRoundChange={setActiveRoundId}
        onUnlockRound={unlockRound}
        quizRounds={quizRounds}
        registeredTeams={registeredTeams}
        selectedRound={activeRound}
        sessionData={sessionData}
      />
    );
  }

  return (
    <QuizScreen
      activeRound={activeRound}
      answerDrafts={answerDrafts}
      lobbyData={lobbyData}
      now={now}
      onAnswerChange={updateAnswerDraft}
      onCheckAnswer={checkAndSaveAnswer}
      onOpenAdmin={() => setAppView("admin")}
      onOpenFaq={() => setAppView("faq")}
      onOpenMain={() => setAppView("main")}
      onRevealHint={revealHint}
      onOpenRanking={() => setAppView("ranking")}
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
      tiebreakerClientId={clientId}
      tiebreakerEligible={getDailyRankingWithTiebreakers(
        registeredTeams,
        lobbyData,
      ).tieGroups.some((group) =>
        group.teams.some((team) => team.id === sessionId),
      )}
      tiebreakerFinalRoundFinished={isRoundFinished(
        sessionData,
        quizRounds[quizRounds.length - 1],
        now,
      )}
    />
  );
}

function LobbyScreen({
  canOpenRanking,
  isAdmin,
  lobbyCode,
  managerKey,
  managerPassword,
  message,
  onOpenRanking,
  playerName,
  teamName,
  onAdminChange,
  onCancelRankingPrompt,
  onConfirmRankingPrompt,
  onJoin,
  onLobbyCodeChange,
  onManagerKeyChange,
  onManagerPasswordChange,
  onPlayerNameChange,
  onTeamNameChange,
  pendingTeamCreate,
}) {
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
          {isAdmin
            ? "Als Manager einloggen und den Quizabend vorbereiten."
            : "Quiz-Code eingeben, Team eintragen, losquizzen."}
        </p>

        <form onSubmit={onJoin} style={{ display: "grid", gap: 14, marginTop: 24 }}>
          {!isAdmin && (
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

          <label
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              fontSize: 16,
            }}
          >
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => onAdminChange(e.target.checked)}
            />
            Admin-Modus
          </label>

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
            style={{
              padding: 14,
              borderRadius: 12,
              border: "none",
              background: "#22c55e",
              color: "#0b1220",
              fontWeight: 700,
              fontSize: 18,
              cursor: "pointer",
            }}
          >
            {isAdmin ? "Manager einloggen" : "Team beitreten"}
          </button>
        </form>

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

function AppMenu({
  canOpenRanking = true,
  isAdmin = false,
  onOpenAdmin,
  onOpenFaq,
  onOpenMain,
  onOpenRanking,
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
  isAdmin,
  lobbyData,
  onOpenAdmin,
  onOpenFaq,
  onOpenMain,
  registeredTeams,
  sessionData,
  sessionId,
}) {
  const [rankingTab, setRankingTab] = useState("daily");
  const isNarrow = useIsNarrowScreen();
  const dailyRanking = getDailyRankingWithTiebreakers(registeredTeams, lobbyData);
  const dailyTeams = dailyRanking.ranking;
  const yearlyTeams = aggregateYearlyRanking(allTeams || registeredTeams);
  const rankingTeams = rankingTab === "daily" ? dailyTeams : yearlyTeams;
  const hasDailyPodiumTie = dailyRanking.tieGroups.length > 0;
  const hasTiebreakerAnswer = Number.isFinite(Number(lobbyData?.tiebreakerAnswer));
  const currentTeamRank =
    dailyTeams.findIndex((team) => team.id === sessionId) + 1;
  const currentTeamSubmission = getTiebreakerSubmission(lobbyData, sessionId);

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
            {rankingTab === "daily" && hasDailyPodiumTie && (
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
                  gridTemplateColumns: "52px minmax(0, 1fr) auto",
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
                {question}
              </summary>
              <p style={{ color: "#cbd5e1", lineHeight: 1.5 }}>{answer}</p>
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

function AdminScreen({
  activeManager,
  allTeams,
  feedbackEntries,
  lobbyData,
  managers,
  now,
  onOpenAdmin,
  onOpenFaq,
  onOpenMain,
  onOpenRanking,
  onLoadPubQuizByCode,
  onRevealRoundAnswers,
  onSaveManager,
  onSavePubQuiz,
  onRoundChange,
  onUnlockRound,
  pubQuizzes,
  quizManagerMessage,
  questions,
  quizRounds,
  registeredTeams,
  selectedRound,
  sessionData,
}) {
  const [personalTab, setPersonalTab] = useState("live");
  const canManageManagers = canManageManagerRecords(activeManager, managers);
  const isNarrow = useIsNarrowScreen();
  const selectedQuestions = selectedRound.questionIds
    .map((questionId) => questions[questionId])
    .filter(Boolean);
  const roundUnlocked = isRoundUnlocked(lobbyData, selectedRound.id);
  const answersRevealed = isRoundAnswersRevealed(lobbyData, selectedRound.id);
  const teamStatuses = registeredTeams.map((team) => {
    const startMs = getRoundStartMs(team, selectedRound.id);
    const durationMs = selectedRound.durationMinutes * 60 * 1000;
    const remainingMs = startMs === null ? null : startMs + durationMs - now;
    const expired = startMs !== null && remainingMs <= 0;

    return {
      ...team,
      expired,
      remainingMs,
      started: startMs !== null,
    };
  });
  const canRevealAnswers = roundUnlocked && !answersRevealed;
  const tabs = [
    ["live", "Live-Steuerung"],
    ["teams", "Teams"],
    ["feedback", "Meinungen"],
    ...(canManageManagers ? [["managers", "Manager"]] : []),
    ["quizzes", "Pubquizzes"],
  ];

  useEffect(() => {
    if (personalTab === "managers" && !canManageManagers) {
      setPersonalTab("live");
    }
  }, [canManageManagers, personalTab]);

  return (
    <main style={pageStyle}>
      <AppMenu
        canOpenRanking
        isAdmin={true}
        onOpenAdmin={onOpenAdmin}
        onOpenFaq={onOpenFaq}
        onOpenMain={onOpenMain}
        onOpenRanking={onOpenRanking}
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
            const isSelected = personalTab === tabId;

            return (
              <button
                key={tabId}
                onClick={() => setPersonalTab(tabId)}
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

        {personalTab === "live" ? (
          <LiveControlPanel
            answersRevealed={answersRevealed}
            canRevealAnswers={canRevealAnswers}
            lobbyData={lobbyData}
            now={now}
            onRevealRoundAnswers={onRevealRoundAnswers}
            onRoundChange={onRoundChange}
            onUnlockRound={onUnlockRound}
            quizRounds={quizRounds}
            selectedQuestions={selectedQuestions}
            selectedRound={selectedRound}
            teamStatuses={teamStatuses}
          />
        ) : personalTab === "teams" ? (
          <TeamDirectory
            pubQuizzes={pubQuizzes}
            teams={allTeams.length ? allTeams : registeredTeams}
          />
        ) : personalTab === "feedback" ? (
          <FeedbackInbox entries={feedbackEntries} />
        ) : personalTab === "managers" && canManageManagers ? (
          <ManagerDirectory
            activeManager={activeManager}
            managers={managers}
            message={quizManagerMessage}
            onSaveManager={onSaveManager}
          />
        ) : (
          <PubQuizManager
            message={quizManagerMessage}
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

function TeamDirectory({ pubQuizzes, teams }) {
  const [selectedTeamId, setSelectedTeamId] = useState(null);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const isNarrow = useIsNarrowScreen();
  const sortedTeams = aggregateTeamDirectory(teams);
  const selectedTeam =
    sortedTeams.find((team) => team.id === selectedTeamId) || sortedTeams[0];
  const selectedSessions = selectedTeam?.sessions || [];
  const selectedSession =
    selectedSessions.find((session) => session.id === selectedSessionId) ||
    selectedSessions[0];
  const selectedPubQuiz = pubQuizzes.find(
    (pubQuiz) =>
      pubQuiz.quizCode === selectedSession?.lobbyCode ||
      pubQuiz.id === selectedSession?.quizId,
  );
  const selectedQuiz = createRuntimeQuizFromPubQuiz(selectedPubQuiz);
  const selectedQuizQuestions = selectedQuiz.quizRounds.flatMap((round) =>
    round.questionIds
      .map((questionId) => {
        const question = selectedQuiz.questions[questionId];

        if (!question) return null;

        return {
          ...question,
          roundTitle: round.title,
        };
      })
      .filter(Boolean),
  );

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Alle Teams</h2>
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
          ) : (
            sortedTeams.map((team) => {
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
                      {team.sessions.length} Quiz
                      {team.sessions.length === 1 ? "" : "ze"} -{" "}
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
              Quizze <strong>{selectedTeam.sessions.length}</strong>
            </p>
            <p style={{ color: "#cbd5e1" }}>
              Jahresranking:{" "}
              <strong>{selectedTeam.rankingOptIn ? "Ja" : "Nein"}</strong>
            </p>

            <h4>Personen</h4>
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

            <h4>Quiz auswaehlen</h4>
            <div style={{ display: "grid", gap: 8 }}>
              {selectedSessions.length === 0 ? (
                <p style={{ margin: 0, color: "#94a3b8" }}>
                  Noch kein Quiz gespeichert.
                </p>
              ) : (
                selectedSessions.map((session) => {
                  const pubQuiz = pubQuizzes.find(
                    (quiz) =>
                      quiz.quizCode === session.lobbyCode ||
                      quiz.id === session.quizId,
                  );
                  const isSelected = selectedSession?.id === session.id;

                  return (
                    <button
                      key={session.id}
                      onClick={() => setSelectedSessionId(session.id)}
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
                        <strong>{pubQuiz?.title || "Pubquiz"}</strong>
                        <br />
                        <span style={{ color: "#94a3b8" }}>
                          {formatCompletionDate(getCompletionValue(session))}
                        </span>
                      </span>
                      <strong>{session.totalPoints || 0} Punkte</strong>
                    </button>
                  );
                })
              )}
            </div>

            {selectedSession && (
              <>
                <h4>Antworten</h4>
                <p style={{ color: "#94a3b8" }}>
                  {selectedPubQuiz?.title || "Pubquiz"} -{" "}
                  {formatCompletionDate(getCompletionValue(selectedSession))}
                </p>
                <div style={{ display: "grid", gap: 8 }}>
                  {selectedQuizQuestions.length === 0 ? (
                    <p style={{ margin: 0, color: "#94a3b8" }}>
                      Fuer dieses Quiz sind keine Fragen gespeichert.
                    </p>
                  ) : (
                    selectedQuizQuestions.map((question) => {
                      const answer = selectedSession.answers?.[question.id];

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
                            {question.roundTitle} - {question.title}
                          </p>
                          <p style={{ margin: "0 0 8px", fontWeight: 700 }}>
                            {question.prompt || "Keine Frage gespeichert."}
                          </p>
                          <p style={{ margin: "0 0 6px", color: "#cbd5e1" }}>
                            Antwort:{" "}
                            <strong>{answer?.text?.trim() || "nicht beantwortet"}</strong>
                          </p>
                          <p style={{ margin: 0, color: "#94a3b8" }}>
                            {answer?.result === "correct" ? "richtig" : "offen/falsch"} -{" "}
                            {answer?.pointsAwarded || 0} Punkte
                          </p>
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
    headManager: false,
    key: "",
    name: "",
    password: "",
  });

  function editManager(manager) {
    setDraft({
      active: manager.active !== false,
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
  answersRevealed,
  canRevealAnswers,
  lobbyData,
  now,
  onRevealRoundAnswers,
  onRoundChange,
  onUnlockRound,
  quizRounds,
  selectedQuestions,
  selectedRound,
  teamStatuses,
}) {
  const roundUnlocked = canRevealAnswers || answersRevealed;
  const answerWindowEndsMs = getTimestampMs(lobbyData?.answerWindowEndsAt);
  const answerWindowClosed = isAnswerWindowClosed(lobbyData, now);
  const isNarrow = useIsNarrowScreen();

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
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={() => onUnlockRound(selectedRound.id)}>
              Runde freischalten
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
          <h2>Teamstatus</h2>
          <div style={{ display: "grid", gap: 10 }}>
            {teamStatuses.map((team) => (
              <div
                key={team.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: isNarrow ? "1fr" : "1fr auto",
                  gap: 12,
                  alignItems: "center",
                  padding: 12,
                  border: "1px solid #1f2937",
                  borderRadius: 12,
                  background: "#0b1220",
                }}
              >
                <strong>{team.teamName}</strong>
                <span style={{ color: team.expired ? "#86efac" : "#fde68a" }}>
                  {!team.started
                    ? "nicht gestartet"
                    : team.expired
                      ? "Zeit vorbei"
                      : formatDuration(team.remainingMs)}
                </span>
              </div>
            ))}
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

function PubQuizManager({ message, onLoadPubQuizByCode, onSavePubQuiz, pubQuizzes }) {
  const [draft, setDraft] = useState(() => createBlankPubQuizDraft());
  const [openRoundId, setOpenRoundId] = useState("round1");
  const [codeDraft, setCodeDraft] = useState("");
  const isNarrow = useIsNarrowScreen();

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
                <button
                  key={pubQuiz.id}
                  onClick={() => {
                    setDraft(createPubQuizDraftFromData(pubQuiz));
                    setOpenRoundId(pubQuiz.rounds?.[0]?.id || "round1");
                  }}
                  style={{
                    padding: 12,
                    border: `1px solid ${
                      draft.id === pubQuiz.id ? "#38bdf8" : "#1f2937"
                    }`,
                    borderRadius: 10,
                    background: draft.id === pubQuiz.id ? "#082f49" : "#111827",
                    color: "#e5e7eb",
                    textAlign: "left",
                    cursor: "pointer",
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
                {round.title} - {round.durationMinutes} Min.
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
            {selectedRound.title} freischalten
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
  canOpenRanking,
  lobbyData,
  message,
  now,
  isAdmin,
  onAnswerChange,
  onCheckAnswer,
  onOpenAdmin,
  onOpenFaq,
  onOpenMain,
  onOpenRanking,
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
  tiebreakerClientId,
  tiebreakerEligible,
  tiebreakerFinalRoundFinished,
}) {
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
  const roundStartMs = getRoundStartMs(sessionData, activeRound.id);
  const roundDurationMs = activeRound.durationMinutes * 60 * 1000;
  const remainingRoundMs =
    roundStartMs === null ? null : roundStartMs + roundDurationMs - now;
  const roundHasStarted = roundStartMs !== null;
  const roundExpired = roundHasStarted && remainingRoundMs <= 0;
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
              {pointToast.message}
            </p>
          )}
          <p style={{ margin: "8px 0 0", color: "#cbd5e1" }}>
            {activeRound.title}: {answeredCount}/{activeQuestions.length} beantwortet
          </p>
          <p style={{ margin: "8px 0 0", color: "#cbd5e1" }}>
            Hinweise: {remainingHints}/{hintBudget}
          </p>
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

      {tiebreakerEligible && tiebreakerFinalRoundFinished && (
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
          {quizRounds.map((round) => {
            const isActive = round.id === activeRound.id;
            const hasQuestions = round.questionIds.length > 0;

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
                {round.title}
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
                {activeRound.title} freischalten
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
              roundTitle={activeRound.title}
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
