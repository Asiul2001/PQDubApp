import test from "node:test";
import assert from "node:assert/strict";

import {
  getEffectiveRoundStartMs,
  getRoundEligibilityMs,
  isRoundFinished,
} from "../src/quizTiming.js";

const quizRounds = [
  {
    id: "round1",
    durationMinutes: 30,
    questionIds: ["q1", "q2"],
  },
  {
    id: "round2",
    durationMinutes: 35,
    questionIds: ["q3", "q4"],
  },
];

test("round 1 auto-start window begins when the team first enters after unlock", () => {
  const lobbyData = {
    roundStarts: {
      round1: new Date("2026-05-25T18:00:00.000Z"),
    },
  };
  const sessionData = {
    createdAt: new Date("2026-05-25T18:07:00.000Z"),
  };

  const eligibilityMs = getRoundEligibilityMs(
    sessionData,
    lobbyData,
    "round1",
    new Date("2026-05-25T18:08:00.000Z").getTime(),
    quizRounds,
  );
  const autoStartMs = getEffectiveRoundStartMs(
    sessionData,
    lobbyData,
    "round1",
    new Date("2026-05-25T18:18:00.000Z").getTime(),
    quizRounds,
  );

  assert.equal(eligibilityMs, new Date("2026-05-25T18:07:00.000Z").getTime());
  assert.equal(autoStartMs, new Date("2026-05-25T18:17:00.000Z").getTime());
});

test("round 2 auto-start window begins when the previous round is actually finished", () => {
  const lobbyData = {
    roundStarts: {
      round1: new Date("2026-05-25T18:00:00.000Z"),
      round2: new Date("2026-05-25T18:20:00.000Z"),
    },
  };
  const sessionData = {
    createdAt: new Date("2026-05-25T18:00:00.000Z"),
    roundStarts: {
      round1: new Date("2026-05-25T18:03:00.000Z"),
    },
    answers: {
      q1: { text: "ok", updatedAt: new Date("2026-05-25T18:28:00.000Z") },
      q2: { text: "ok", updatedAt: new Date("2026-05-25T18:31:00.000Z") },
    },
  };

  const eligibilityMs = getRoundEligibilityMs(
    sessionData,
    lobbyData,
    "round2",
    new Date("2026-05-25T18:32:00.000Z").getTime(),
    quizRounds,
  );
  const autoStartMs = getEffectiveRoundStartMs(
    sessionData,
    lobbyData,
    "round2",
    new Date("2026-05-25T18:42:00.000Z").getTime(),
    quizRounds,
  );

  assert.equal(eligibilityMs, new Date("2026-05-25T18:31:00.000Z").getTime());
  assert.equal(autoStartMs, new Date("2026-05-25T18:41:00.000Z").getTime());
});

test("a team that finishes the previous round late keeps its own manual-start window", () => {
  const lobbyData = {
    roundStarts: {
      round1: new Date("2026-05-25T18:00:00.000Z"),
      round2: new Date("2026-05-25T18:10:00.000Z"),
    },
  };
  const sessionData = {
    createdAt: new Date("2026-05-25T18:00:00.000Z"),
    roundStarts: {
      round1: new Date("2026-05-25T18:05:00.000Z"),
    },
  };

  assert.equal(
    isRoundFinished(
      sessionData,
      quizRounds[1],
      new Date("2026-05-25T18:25:00.000Z").getTime(),
      lobbyData,
      quizRounds,
    ),
    false,
  );

  assert.equal(
    getEffectiveRoundStartMs(
      sessionData,
      lobbyData,
      "round2",
      new Date("2026-05-25T18:44:00.000Z").getTime(),
      quizRounds,
    ),
    null,
  );
});
