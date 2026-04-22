import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBypsKwl5VXtswcylgvA6i5RhkOqxnk4Ks",
  authDomain: "dubpqapp.firebaseapp.com",
  projectId: "dubpqapp",
  storageBucket: "dubpqapp.firebasestorage.app",
  messagingSenderId: "874435675782",
  appId: "1:874435675782:web:c8e525c9688c2a0e19f307"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;