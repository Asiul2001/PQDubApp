import test from "node:test";
import assert from "node:assert/strict";

import {
  getDailyRankingWithTiebreakers,
  getMaximumPossiblePoints,
  getTiebreakerState,
} from "../src/tiebreaker.js";
import { isRoundFinished } from "../src/quizTiming.js";

const finalRound = {
  id: "round3",
  durationMinutes: 45,
  questionIds: ["q13", "q14", "q15", "q16", "q17", "q18"],
};

const questionPointsById = {
  q13: 1,
  q14: 1,
  q15: 1,
  q16: 1,
  q17: 1,
  q18: 2,
};

function createTeam(id, totalPoints, answers = {}) {
  return {
    id,
    teamId: id,
    teamName: id,
    totalPoints,
    answers,
    roundStarts: {
      round3: new Date("2026-05-25T18:00:00.000Z"),
    },
  };
}

function answeredAll() {
  return Object.fromEntries(
    finalRound.questionIds.map((questionId) => [questionId, { text: "ok" }]),
  );
}

test("daily ranking uses tiebreaker distance to resolve podium ties", () => {
  const teams = [createTeam("alpha", 10), createTeam("beta", 10), createTeam("gamma", 8)];
  const lobbyData = {
    tiebreakerAnswer: 200,
    tiebreakerSubmissions: {
      alpha: { estimate: 210, submittedAt: new Date("2026-05-25T20:00:10.000Z") },
      beta: { estimate: 203, submittedAt: new Date("2026-05-25T20:00:15.000Z") },
    },
  };

  const ranking = getDailyRankingWithTiebreakers(teams, lobbyData).ranking.map((team) => team.id);

  assert.deepEqual(ranking, ["beta", "alpha", "gamma"]);
});

test("maximum possible points include unanswered final-round questions", () => {
  const team = createTeam("alpha", 10, {
    q13: { text: "done" },
    q14: { text: "done" },
  });

  assert.equal(getMaximumPossiblePoints(team, finalRound, questionPointsById), 15);
});

test("tiebreaker waits for unresolved podium contenders", () => {
  const teams = [
    createTeam("alpha", 10, answeredAll()),
    createTeam("beta", 10, answeredAll()),
    createTeam("gamma", 9),
  ];

  const state = getTiebreakerState({
    teams,
    lobbyData: {
      tiebreakerReady: { alpha: true, beta: true },
    },
    finalRound,
    now: new Date("2026-05-25T18:20:00.000Z").getTime(),
    isRoundFinished,
    questionPointsById,
  });

  assert.equal(state.status, "waiting-for-relevant-teams");
  assert.deepEqual(state.relevantTeamIds.sort(), ["alpha", "beta", "gamma"]);
});

test("tiebreaker can start before every team finishes if trailing teams are mathematically out", () => {
  const teams = [
    createTeam("alpha", 10, answeredAll()),
    createTeam("beta", 10, answeredAll()),
    createTeam("gamma", 9, answeredAll()),
    createTeam("delta", 1),
  ];

  const state = getTiebreakerState({
    teams,
    lobbyData: {
      tiebreakerReady: { alpha: true, beta: true },
    },
    finalRound,
    now: new Date("2026-05-25T18:20:00.000Z").getTime(),
    isRoundFinished,
    questionPointsById,
  });

  assert.equal(state.status, "ready-to-start");
  assert.deepEqual(state.tiedTeamIds, ["alpha", "beta"]);
  assert.deepEqual(state.relevantTeamIds.sort(), ["alpha", "beta", "gamma"]);
});

test("manager-excluded team no longer blocks tiebreaker relevance", () => {
  const teams = [
    createTeam("alpha", 10, answeredAll()),
    createTeam("beta", 10, answeredAll()),
    createTeam("gamma", 9, answeredAll()),
    createTeam("delta", 9),
  ];

  const state = getTiebreakerState({
    teams,
    lobbyData: {
      tiebreakerReady: { alpha: true, beta: true },
      tiebreakerExcludedTeams: {
        delta: { active: true, updatedBy: "Manager" },
      },
    },
    finalRound,
    now: new Date("2026-05-25T18:20:00.000Z").getTime(),
    isRoundFinished,
    questionPointsById,
  });

  assert.equal(state.status, "ready-to-start");
  assert.deepEqual(state.excludedTeamIds, ["delta"]);
});

test("tiebreaker reports active and then completed once all tied teams submit", () => {
  const teams = [
    createTeam("alpha", 10, answeredAll()),
    createTeam("beta", 10, answeredAll()),
    createTeam("gamma", 9, answeredAll()),
  ];

  const activeState = getTiebreakerState({
    teams,
    lobbyData: {
      tiebreakerStatus: "active",
      tiebreakerReady: { alpha: true, beta: true },
      tiebreakerSubmissions: {
        alpha: { estimate: 100 },
      },
    },
    finalRound,
    now: new Date("2026-05-25T18:20:00.000Z").getTime(),
    isRoundFinished,
    questionPointsById,
  });

  assert.equal(activeState.status, "active");

  const completedState = getTiebreakerState({
    teams,
    lobbyData: {
      tiebreakerStatus: "active",
      tiebreakerReady: { alpha: true, beta: true },
      tiebreakerSubmissions: {
        alpha: { estimate: 100 },
        beta: { estimate: 101 },
      },
    },
    finalRound,
    now: new Date("2026-05-25T18:20:00.000Z").getTime(),
    isRoundFinished,
    questionPointsById,
  });

  assert.equal(completedState.status, "completed");
});

test("added round time delays timeout-based completion", () => {
  const team = createTeam("alpha", 10);
  const lobbyData = {
    roundExtraMinutes: {
      round3: 10,
    },
  };

  const baseEnd = new Date("2026-05-25T18:45:00.000Z").getTime();
  const extendedEnd = new Date("2026-05-25T18:55:00.000Z").getTime();

  assert.equal(isRoundFinished(team, finalRound, baseEnd + 1000, lobbyData), false);
  assert.equal(isRoundFinished(team, finalRound, extendedEnd + 1000, lobbyData), true);
});
