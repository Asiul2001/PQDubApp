# PQDubApp

Broader development of the original PubQuiz app: a reusable live pub quiz
system with team sessions, manager controls, rankings, tiebreak questions,
QR-code joins, and Firebase persistence.

## Features

- Pubquiz creation with unique quiz codes
- QR links that prefill the quiz code for teams
- Three-round quiz flow with hints and locked correct answers
- Daily ranking and yearly ranking
- Optional yearly ranking participation per team
- Tiebreak question flow for tied top places
- Manager login with Head Manager permissions
- Team archive with quiz/date-specific answers
- Feedback inbox and FAQ

## Local Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Deploy To GitHub Pages

This repo includes `.github/workflows/deploy.yml`. After pushing to the `main`
branch, GitHub Actions builds the app and deploys `dist` to GitHub Pages.

One-time setup in GitHub:

1. Open the repository on GitHub.
2. Go to `Settings` -> `Pages`.
3. Under `Build and deployment`, choose `GitHub Actions`.
4. Push to `main`.
5. Open the deployed URL shown in the finished Actions run.

QR links use the current deployed URL and add the quiz code as a query
parameter, for example:

```text
https://asiul2001.github.io/PQDubApp/?quiz=ABC123
```
