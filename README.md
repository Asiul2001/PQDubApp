# PQDubApp
Broader development of original PubQuiz App
# PQDubApp

## 🚀 Features
- 3 rounds, 6 questions each
- Max points: 21
- Q6 = 2 points, no hints
- Hints limited per round
- Partial correctness (green + red blanks)
- Live team sessions (same team name = same session)
- Optional global ranking
- Tie-break system for top 3
- Manager-controlled answer reveal
- Round lock after timer + 24h hard close

---

## 📱 Screens
1. Join page
2. Play page
3. Review page
4. Tiebreak lobby
5. Admin login
6. Admin dashboard
7. Admin quiz editor
8. Admin teams page
9. Admin scoreboard
10. Admin tiebreak page

---

## 🧠 Core Rules
- Same team name joins same session
- Ranking is optional
- Ranked teams get a generated team code
- Similar team names are not allowed
- Correct answers lock permanently
- Partial answers show only correct parts + red blanks
- Answers only revealed after manager releases them

---

## 🛠 Build Order
1. Firebase setup
2. Join page
3. Team session system
4. Play page
5. Answer checking
6. Admin login
7. Quiz editor
8. Teams page
9. Scoreboard
10. Tiebreak system

---

## 🗄 Data Structure
- quizzes
- rounds
- questions
- teams
- quizSessions
- scoreboards
- tiebreakers
- managers

---

## 🎯 Goal
Build a reusable pub quiz system with:
- live team syncing
- optional ranking
- fair scoring
- manager control


firebase:

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBypsKwl5VXtswcylgvA6i5RhkOqxnk4Ks",
  authDomain: "dubpqapp.firebaseapp.com",
  projectId: "dubpqapp",
  storageBucket: "dubpqapp.firebasestorage.app",
  messagingSenderId: "874435675782",
  appId: "1:874435675782:web:c8e525c9688c2a0e19f307",
  measurementId: "G-56WVPWMCQV"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
