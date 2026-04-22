export const latestQuizId = "quiz_v1";

export const hintBudgets = {
  round1: 2,
  round2: 1,
  round3: 0,
};

// Question 5 in every round is reserved for an image or image-series question.
// Question 6 never has a hint.
export const questions = {
  q1: {
    id: "q1",
    title: "Frage 1",
    acceptedAnswers: ["Tanzfläche"],
    points: 1,
    hint: "3 - eine Zahl, 1 - Buchstabe sieht wie 2 aus, 6 - ein Koordinatensystem flach gelegt ist eine...?",
  },
  q2: {
    id: "q2",
    title: "Frage 2",
    acceptedAnswers: ["Mischpult"],
    points: 1,
    hint: "5 - bevor man Karten spielt, was macht man mit den Karten?, 3 - wenn man eine Tür nicht schiebt, sondern zieht, 1 - Logo von Tesla",
  },
  q3: {
    id: "q3",
    title: "Frage 3",
    acceptedAnswers: ["Einlass"],
    points: 1,
    hint: '2 - Man fragt sich ob das Lebensmittel gesund ist, 1 - Abkürzung Niederland, 4 - Synonym beginnend mit "l"',
  },
  q4: {
    id: "q4",
    title: "Frage 4",
    acceptedAnswers: ["Techno"],
    points: 1,
    hint: "3 - Wenn man in Erfurt zur Mall geht, 3 - Wo geht man wenn es im Ohr weh tut?",
  },
  q5: {
    id: "q5",
    title: "Frage 5 - Bildfrage",
    acceptedAnswers: ["Keta"],
    points: 1,
    hint: '4 - bekannte Droge für Pferde beginnend mit "K"',
    media: {
      type: "image",
      images: [{ label: "BITTE_BILD_URL_R1_5_EINFUEGEN" }],
    },
  },
  q6: {
    id: "q6",
    title: "Frage 6",
    acceptedAnswers: ["One Night Stand"],
    points: 2,
  },
  q7: {
    id: "q7",
    title: "Frage 1",
    acceptedAnswers: ["Stummfilm"],
    points: 1,
    hint: '5 - mit "st" am Anfang, 4 - Synonym für Movie',
  },
  q8: {
    id: "q8",
    title: "Frage 2",
    acceptedAnswers: ["Spannung"],
    points: 1,
    hint: '3 - geht man um sich zu ausruhen und vllt um eine Massage zu bekommen, 5 - Synonym für Schimmer in diesem Kontext "keinen Plan"',
  },
  q9: {
    id: "q9",
    title: "Frage 3",
    acceptedAnswers: ["Szene"],
    points: 1,
    hint: '2 - Abkürzung regionale Tageszeitung, 3 - sächsische Aussprache für "eine"',
  },
  q10: {
    id: "q10",
    title: "Frage 4",
    acceptedAnswers: ["Abspann"],
    points: 1,
    hint: "2 - Anrufbeantworter, 5 - Was macht man mit dem Gurt wenn man festzieht?",
  },
  q11: {
    id: "q11",
    title: "Frage 5 - Bildfrage",
    acceptedAnswers: ["Cliffhanger"],
    points: 1,
    hint: "BITTE_HINWEIS_EINFÜGEN_2_5",
    media: {
      type: "image",
      images: [{ label: "BITTE_BILD_URL_R2_5_EINFUEGEN" }],
    },
  },
  q12: {
    id: "q12",
    title: "Frage 6",
    acceptedAnswers: ["Vierte Wand"],
    points: 2,
  },
  q13: {
    id: "q13",
    title: "Frage 1",
    acceptedAnswers: ["Adrenalin"],
    points: 1,
  },
  q14: {
    id: "q14",
    title: "Frage 2",
    acceptedAnswers: ["Verletzung"],
    points: 1,
  },
  q15: {
    id: "q15",
    title: "Frage 3",
    acceptedAnswers: ["Protein Shake"],
    points: 1,
  },
  q16: {
    id: "q16",
    title: "Frage 4",
    acceptedAnswers: ["Teamgeist"],
    points: 1,
  },
  q17: {
    id: "q17",
    title: "Frage 5 - Bildfrage",
    acceptedAnswers: ["Schweiß"],
    points: 1,
    media: {
      type: "image",
      images: [{ label: "BITTE_BILD_URL_R3_5_EINFUEGEN" }],
    },
  },
  q18: {
    id: "q18",
    title: "Frage 6",
    acceptedAnswers: ["Pokal"],
    points: 2,
  },
};

export const quizRounds = [
  {
    id: "round1",
    title: "Runde 1: Im Nachtclub",
    durationMinutes: 30,
    questionIds: ["q1", "q2", "q3", "q4", "q5", "q6"],
  },
  {
    id: "round2",
    title: "Runde 2: Auf der Leinwand",
    durationMinutes: 35,
    questionIds: ["q7", "q8", "q9", "q10", "q11", "q12"],
  },
  {
    id: "round3",
    title: "Runde 3: Beim Sport",
    durationMinutes: 45,
    questionIds: ["q13", "q14", "q15", "q16", "q17", "q18"],
  },
];
