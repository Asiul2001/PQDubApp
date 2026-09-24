# Project Versions

## 1.8.1 - 2026-09-24

- Added the detailed product, technical, security, and delivery baseline in `PROJECT_STATUS.md`.
- Documented actual Schaetzfrage, voucher, ranking, demo, and Firestore behavior.
- Recorded open decisions and prioritized reliability, cost, and authorization work.

## 1.8.0 - 2026-09-24

- Hardened the live Schätzfrage flow with Firestore-backed state transitions.
- Locked the shared question and correct answer after the first team sees it.
- Reduced Firestore reads for rankings, vouchers, and historical data.

## 1.7.0 - 2026-09-14

- Added the team-specific Schätzfrage manager controls, timer, pause/resume, and tie ordering.
- Added demo quiz simulation and reset behavior.
- Repaired live daily/yearly ranking and voucher behavior.

## Versioning Rules

- Use semantic versions: `major.minor.patch`.
- Increment `minor` for user-visible features and `patch` for fixes.
- Add the release date and a concise summary for every deployed version.
