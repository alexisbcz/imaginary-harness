// Les textes de connexion et de création de compte.

import type en from "../en/auth";
import type { Messages } from "../types";

const fr: Messages<typeof en> = {
  error: "Une erreur est survenue",
  email: "E-mail",
  password: "Mot de passe",
  name: "Nom",
  namePlaceholder: "Marie Curie",
  enterName: "Saisissez votre nom",
  signIn: "Se connecter",
  signOut: "Se déconnecter",
  checkEmail: "Consultez vos e-mails",
  login: {
    title: "Bienvenue sur Richelieu",
    description: "Connectez-vous pour créer des apps en les décrivant.",
    forgot: "Oublié ?",
    noAccount: "Pas encore de compte ?",
    signUp: "Créer un compte",
  },
  signUp: {
    title: "Créez votre compte",
    description: "Décrivez une app, et regardez Richelieu la construire.",
    repeatPassword: "Confirmez le mot de passe",
    submit: "Créer le compte",
    passwordsMismatch: "Les mots de passe ne correspondent pas",
    confirm: "Confirmez votre compte grâce au lien envoyé, puis connectez-vous.",
    haveAccount: "Vous avez déjà un compte ?",
  },
  forgot: {
    title: "Réinitialisez votre mot de passe",
    description: "Saisissez votre e-mail : nous vous enverrons un lien pour en choisir un nouveau.",
    submit: "Envoyer le lien",
    remembered: "Ça vous revient ?",
    sent: "Si un compte utilise cette adresse, un lien de réinitialisation est en route.",
    backToSignIn: "Retour à la connexion",
  },
  update: {
    title: "Choisissez un nouveau mot de passe",
    description: "Vous resterez connecté avec celui-ci.",
    newPassword: "Nouveau mot de passe",
    submit: "Enregistrer le mot de passe",
  },
  nameForm: {
    title: "Comment vous appelez-vous ?",
    description: "Votre nom s'affiche en bas de la barre latérale.",
    submit: "Enregistrer votre nom",
  },
};

export default fr;
