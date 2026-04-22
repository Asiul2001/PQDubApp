# PQDubApp

Pubquiz web app built with React, Vite, and Firebase.

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
https://your-name.github.io/your-repo/?quiz=ABC123
```
