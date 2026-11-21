import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";

// Конфигурация веб-приложения Firebase не является секретом. Пароли 1С и
// токены к ней сюда не попадают: они обрабатываются только шлюзом ОПОРА.
const firebaseConfig = {
  apiKey: "AIzaSyC7cDpJ1xo2rLm8hr9wpymlod2sPCem0kw",
  authDomain: "oporabuhserv.firebaseapp.com",
  projectId: "oporabuhserv",
  storageBucket: "oporabuhserv.firebasestorage.app",
  messagingSenderId: "741486647644",
  appId: "1:741486647644:web:3c1cae5d5bcd1db54bc999",
  measurementId: "G-Y5V78F2751",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const notify = (user, error = "") => window.dispatchEvent(new CustomEvent("opora-auth", {
  detail: { user: user ? { name: user.displayName || user.email || "Сотрудник", email: user.email || "" } : null, error },
}));

window.NeilaAuth = {
  async signIn() {
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      const domain = error?.code === "auth/unauthorized-domain";
      notify(null, domain
        ? "Адрес рабочего кабинета ещё не разрешён в Firebase Authentication."
        : "Не удалось выполнить вход через Google. Попробуйте ещё раз.");
    }
  },
  signOut: () => signOut(auth),
};

onAuthStateChanged(auth, user => notify(user));
window.dispatchEvent(new Event("opora-auth-ready"));
