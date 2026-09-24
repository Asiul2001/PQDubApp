# PQ App: Product, Technical, and Release Status

**Last reviewed:** 2026-09-24  
**Repository version:** `1.8.0`  
**Package version:** `0.0.0` (not yet aligned with the repository version)  
**Runtime:** React 19, Vite 8, Firebase Firestore

This document describes the behavior implemented in the current repository. It is
not a wish list or a record of the original discussions. Items that are planned,
ambiguous, risky, or need a product decision are explicitly called out below.

## 1. What The App Does Today

PQ App runs a multi-team pub quiz with a manager control area and a team-facing
quiz area. Its major functions are:

- Create and start live quiz events from reusable `pubQuizzes` templates.
- Register teams, collect answers, score questions, and manage three rounds.
- Run manager-controlled answer windows and per-team round timing.
- Show a live daily ranking ordered by highest score first.
- Build an opt-in yearly ranking from team sessions across events.
- Create, display, request, redeem, and delete vouchers.
- Run a team-specific Schaetzfrage as a podium tiebreaker.
- Start a demo event containing generated teams and a manager-owned demo team.
- Persist live event, team, score, ranking, voucher, and Schaetzfrage state in
  Firestore.

## 2. Roles And Access In The User Interface

### Teams

- A team joins an event and receives its own team session.
- Team members can see their own quiz, answers, score progress, timing state,
  ranking, vouchers, and relevant Schaetzfrage status.
- Normal quiz answers are locked after a correct scoring decision.
- A team may opt into the yearly ranking according to the team/profile flow.

### Managers

- Managers can control the live event, rounds, scoring, rankings, vouchers,
  team archive, and Schaetzfrage.
- The UI distinguishes normal managers from the Head Manager.
- The Head Manager has special voucher creation and management permissions in
  the UI.

### Important Security Limitation

Manager roles are currently a client-side application concept. Firestore rules
validate the *shape* and types of data, but they allow public reads and allow
many writes without `request.auth` or a verified manager role. Someone with
technical access to the Firebase project could bypass the UI and write valid-
shaped data directly.

This is not suitable as the long-term authorization model for a live product.

## 3. Quiz And Timing Specification

### Quiz Flow

- The quiz supports three rounds.
- The manager can unlock rounds and control answer windows.
- A team receives a round start state in its own team session. This allows a
  team that enters or completes the previous round later to have the correct
  individual timing window.
- The test suite covers first-round entry timing, round-two timing after a
  prior round is complete, late finishes, and added round-time delays.
- The intended maximum base score is 21 points: seven points per round.

### Daily Ranking

- The daily ranking is stored in `quizEvents/{eventId}/rankings/daily` and
  subscribed to in real time.
- Teams are ordered by total points descending.
- A podium tie is resolved by the Schaetzfrage once a valid answer exists:
  exact estimate, then smallest absolute distance from the correct answer,
  then the saved decision time, then a deterministic fallback.
- Manual ranking order exists as a manager capability and is persisted with the
  ranking state.

### Yearly Ranking

- The public yearly ranking is built from team sessions that opted in to the
  yearly ranking, including compatibility with historical opt-in fields.
- Its source is a Firestore collection-group query over `teamSessions`.
- The current view is live: updates to the qualifying team sessions are
  reflected without manually refreshing the ranking screen.

## 4. Schaetzfrage Specification: Actual Current Behavior

The Schaetzfrage is a manager-controlled tiebreaker for a tie affecting the
daily podium. It is not a general question shown to every team.

### Setup

1. A manager enters the question and numeric correct answer in live control.
2. Both values are stored on the active `quizEvents/{eventId}` document.
3. The setup remains editable until the manager shows the question to at least
   one team.
4. Once any team has seen the question, the question and answer are locked to
   prevent the scoring basis changing mid-tiebreaker.

### Which Teams Can Participate

1. Teams excluded by the manager do not block or participate in the
   Schaetzfrage calculation.
2. Teams already tied for a podium position are candidates.
3. A team still working on the final round is also relevant when it can still
   mathematically reach the podium cutoff with its unanswered final-round
   points.
4. The tiebreaker waits until all relevant teams have finished the final round.
5. The actual answering participant list is the tied team set, after the
   manager's readiness rules are satisfied.

### Team-Specific Visibility And Submission

1. The manager selects one eligible team in live control.
2. `Frage zeigen` makes the question visible only to that team ID.
3. `Antworten oeffnen` starts that team's timer and enables an answer.
4. Each action is one-time in normal operation; state transitions are guarded
   through Firestore transactions.
5. The team sees the question, but only one device can claim answer entry via
   `Dieses Handy benutzen`.
6. Other devices of the same team can still see the question but cannot enter
   a competing answer.
7. A submitted estimate is final for the team. It disappears from the team
   device after submission.
8. The manager can see the submitted estimate, saved time, and a completed
   visual state. The manager can correct the numerical estimate but cannot
   edit the saved decision time.
9. The manager can stop a team's time independently, for example to take an
   average of spoken team guesses, and later resume it. Paused time is excluded
   from the elapsed duration.

### Ranking Decision

1. Exact answer wins over a non-exact answer.
2. Otherwise, the smaller absolute distance to the correct answer wins.
3. Equal distance is resolved by the saved stop time, or the submission time
   when no manual stop time exists. Earlier wins.
4. If still tied, numerical estimate and then team name provide deterministic
   display order.
5. The completed tiebreaker result is visible in manager live control and is
   used to resolve the daily ranking.

### Persistence

- Question, correct answer, status, team visibility, timer state, device
  claim, readiness, and submissions are stored in the event document.
- The team session stores a `tiebreaker` field for session-level compatibility.
- Resetting a demo resets the demo event's Schaetzfrage state. It does not
  reset a real event.
- Current event data is retained; there is no implemented automatic deletion
  after the final ranking is decided.

## 5. Voucher Specification: Actual Current Behavior

### Data Model

- A voucher is mirrored in both locations:
  `quizEvents/{eventId}/vouchers/{voucherId}` and
  `teams/{teamId}/vouchers/{voucherId}`.
- The mirror allows an event-focused manager view and a team-focused history.
- Legacy voucher records are normalized and can be mirrored into the event
  path for compatibility.

### Manager View

- Events are listed even when they do not yet have vouchers.
- Event list ordering uses voucher creation time, with fallbacks for older
  data that lacks `createdAt`.
- If the selected event has historical team sessions, the manager can select
  exactly the teams recorded for that event.
- If an event has no saved team sessions, the manager may choose from eligible
  yearly-ranking teams as a fallback.
- The Head Manager can create, update, redeem, and delete voucher assignments.

### Team View

- A team sees its own earned vouchers and the current status: earned,
  requested, or redeemed.
- A team can request redemption when the voucher is eligible.
- Voucher history is now loaded with a collection-group query for that single
  team instead of reading every event one by one.

### Remaining Voucher Risks

- Mirrored records require both copies to stay consistent. The current writes
  use batches, but historical/partial data can still need migration or repair.
- Deletion is allowed directly by current Firestore rules and is not limited to
  a verified Head Manager at the database layer.

## 6. Demo Specification

- Personal/manager area can start a demo event from a dedicated demo template.
- The demo creates five generated teams plus a manager-owned demo team.
- Demo round controls and Schaetzfrage use the same Firestore-backed logic as
  the normal quiz where possible.
- `Runde fertig` simulates completion and assigns random points while keeping
  the intended maximum total at 21 points.
- Leaving/resetting demo clears demo event state, including Schaetzfrage state.
- Demo is for operational testing. It should not be treated as a replacement
  for multi-device production acceptance testing.

## 7. Firestore Reads And Cost Position

### Improvements Included In Version 1.8.0

- Removed a duplicate global real-time `teamSessions` listener from the ranking
  screen.
- The remaining listener now supplies both the team index and session data.
- Voucher history fetches one team's sessions through a collection-group query
  rather than reading every event plus a team-session document for each event.
- Historical daily ranking documents no longer reload whenever any event
  document changes.
- Historical ranking data is loaded only in views that use it: archive or
  voucher views. The public ranking screen retains its dedicated live data.

### What Still Costs Reads

- The yearly ranking currently observes all `teamSessions` and filters results
  in the client. Costs grow with the full historical session count.
- Manager archive/voucher views read event, team, and voucher collections so
  they can support historical data and legacy compatibility.
- Each open real-time listener is billed initially and whenever matching
  documents change; each active manager/team device increases this usage.
- The current app cannot report actual Firebase billing or usage logs from
  source code. Those must be reviewed in the Firebase Console and Google Cloud
  Billing reports for project `dubpqapp`.

## 8. Recommended Tightening Work

### Priority 0: Security Before Broader Use

1. Add Firebase Authentication for managers and team sessions.
2. Store manager roles as verified custom claims or protected server-managed
   documents.
3. Rewrite Firestore rules to use `request.auth`, role checks, and team-scoped
   permissions.
4. Move the correct Schaetzfrage answer to a manager-only trusted backend path
   or a callable Cloud Function. It is currently stored in a publicly readable
   event document, so a technically capable team can inspect it.
5. Restrict voucher create/update/delete to the verified Head Manager.
6. Restrict score and live-control writes to verified managers.

### Priority 1: Reliability And Cost

1. Create a server-maintained yearly ranking collection or aggregation rather
   than subscribing to all historical team sessions in every public ranking
   view.
2. Add query indexes and pagination where collection-group history grows.
3. Replace legacy dual voucher storage with one canonical record plus a
   server-maintained index, or add a migration and integrity checker.
4. Add Firestore Emulator tests for rules and multi-device concurrency.
5. Track failed writes and rejected transactions in a structured error service.
6. Add Firebase usage-budget alerts and dashboard reviews after each quiz night.

### Priority 2: Front-End Health

1. Split the large `App.jsx` into feature modules for quiz flow, rankings,
   vouchers, manager control, and Schaetzfrage.
2. Resolve the current ESLint backlog. The latest lint run reported 34 errors
   and 13 warnings, mostly pre-existing unused code, effect dependencies, and
   synchronous state updates in effects.
3. Code-split large dependencies. The production build currently reports a
   main JavaScript chunk around 1.2 MB before gzip compression.
4. Add end-to-end tests using two managers and several team browser sessions.
5. Add accessible, responsive visual regression checks for narrow phones.

## 9. Open Product Decisions

The following require an explicit decision before implementation because they
affect rules, stored data, or user expectations.

1. **Manager identity:** Should managers sign in with email/password, magic
   link, Google account, or a managed PIN plus a second factor?
2. **Team identity:** Should a team be able to recover its session on a new
   phone, and who is allowed to transfer its answering device?
3. **Schaetzfrage visibility:** Must the correct answer be hidden from every
   non-manager at the database level, or is client-side obscurity acceptable?
4. **Voucher source of truth:** Should event vouchers or team vouchers be the
   canonical record after a one-time migration?
5. **Data retention:** How long should event answers, timer data, device claims,
   and Schaetzfrage submissions be retained after a quiz night?
6. **Yearly ranking rules:** Does yearly ranking count every attended event,
   best N events, only teams with a password, or another season policy?
7. **Multi-manager conflict policy:** If two manager accounts open the same
   event, should both have equal authority, should there be a lead manager lock,
   or should control actions require confirmation/audit entries?
8. **Operational recovery:** Who can close a broken event, unlock a round,
   correct a submitted score, or replay a failed voucher write during a live
   night?

## 10. Versioning And Release Process

- `VERSION.md` is the concise human release ledger.
- This document is the detailed functional and technical baseline.
- Recommended version policy:
  - `major`: data migrations, auth model changes, or breaking user flows.
  - `minor`: completed user-visible features.
  - `patch`: bug fixes, tuning, tests, and documentation.
- Before each release: run `npm test`, `npm run build`, review Firestore rules,
  and record the version/date/change summary.
- Align `package.json` with the repository version as part of the next release
  process decision.
