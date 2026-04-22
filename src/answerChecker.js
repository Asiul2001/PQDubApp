function normalizeAnswer(value) {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ÃŸ/g, "ss")
    .replace(/-/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collapseAnswer(value) {
  return normalizeAnswer(value).replace(/\s+/g, "");
}

function missingWord(word) {
  return Array.from(word).map(() => ({ text: "_", kind: "missing" }));
}

function buildProgressiveSegments(targetAnswer, rawInput) {
  const words = normalizeAnswer(targetAnswer).split(" ").filter(Boolean);
  const input = collapseAnswer(rawInput);
  const segments = [];
  let inputIndex = 0;
  let matches = 0;
  let displayedWords = 0;

  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    const word = words[wordIndex];
    const wordSegments = [];
    let wordMatches = 0;

    for (const targetChar of word) {
      if (input[inputIndex] === targetChar) {
        wordSegments.push({ text: targetChar, kind: "correct" });
        inputIndex += 1;
        matches += 1;
        wordMatches += 1;
      } else {
        wordSegments.push({ text: "_", kind: "missing" });
      }
    }

    if (displayedWords > 0) {
      segments.push({ text: " ", kind: "space" });
    }
    segments.push(...wordSegments);
    displayedWords += 1;

    const wordComplete = wordMatches === word.length;
    const inputConsumed = inputIndex >= input.length;
    const hasNextWord = wordIndex < words.length - 1;

    if (inputConsumed) {
      if (wordComplete && hasNextWord) {
        segments.push({ text: " ", kind: "space" });
        segments.push(...missingWord(words[wordIndex + 1]));
      }
      break;
    }

    if (wordIndex > 0 && wordMatches === 0) {
      break;
    }
  }

  return {
    segments,
    matches,
    startsCorrectly: input[0] === collapseAnswer(targetAnswer)[0],
    typedLength: input.length,
  };
}

export function checkAnswer(rawInput, acceptedAnswers, points = 1) {
  const normalizedInput = normalizeAnswer(rawInput);
  const normalizedAccepted = acceptedAnswers.map(normalizeAnswer);

  if (!normalizedInput) {
    return {
      result: "incorrect",
      pointsAwarded: 0,
      matchedSegments: [],
    };
  }

  if (normalizedAccepted.includes(normalizedInput)) {
    return {
      result: "correct",
      pointsAwarded: points,
      matchedSegments: [{ text: rawInput.trim(), kind: "correct" }],
    };
  }

  const target = normalizedAccepted[0];
  const aligned = buildProgressiveSegments(target, rawInput);
  const typedMatchRatio = aligned.matches / aligned.typedLength;

  if (
    aligned.startsCorrectly &&
    aligned.matches >= 2 &&
    typedMatchRatio >= 0.6
  ) {
    return {
      result: "partial",
      pointsAwarded: 0,
      matchedSegments: aligned.segments,
    };
  }

  return {
    result: "incorrect",
    pointsAwarded: 0,
    matchedSegments: [],
  };
}
