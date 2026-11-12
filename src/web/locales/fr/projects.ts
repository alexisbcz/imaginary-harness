// Les projets et les discussions : l'accueil, la page d'un projet, une discussion seule, et leurs noms.

import type en from "../en/projects";
import type { Messages } from "../types";

const fr: Messages<typeof en> = {
  home: {
    title: "Que puis-je faire pour vous ?",
    subtitle: "Demandez ce que vous voulez : Richelieu réfléchit avec vous, cherche sur le web et s'occupe de vos mails.",
    placeholder: "Demandez à Richelieu…",
    startLabel: "Que lancer",
    startChat: "Discuter",
    startProject: "Construire une app",
    newProject: "Nouveau projet",
    noProjects: "Pas encore de projet. Passez à « Construire une app » pour en lancer un, ou créez-en un vide.",
  },
  project: {
    rename: "Renommer le projet",
    delete: "Supprimer le projet",
    composerPlaceholder: "Lancer une discussion dans {{name}}…",
    chats: "Discussions",
    noChats: "Pas encore de discussion. Lancez-en une ci-dessus : chacune travaille sur l'app du projet.",
    chatName: "Discussion",
    lastMessage: "Dernier message",
    app: "App",
    appBody: "Toutes les discussions du projet construisent la même app.",
    appEmpty: "L'app apparaît avec la première discussion du projet.",
    openApp: "Ouvrir l'app",
    published: "La voir en ligne",
    description: "À propos",
    descriptionPlaceholder: "Qu'est-ce que ce projet, et pour qui ?",
    instructions: "Instructions",
    instructionsPlaceholder: "Toujours rédiger en français. Garder un design sobre…",
    instructionsHint: "Richelieu les suit dans toutes les discussions du projet.",
    missingTitle: "Projet introuvable",
    missingBody: "Il a été supprimé, ou il appartient à quelqu'un d'autre.",
    missingBack: "Retour à l'accueil",
  },
  chat: {
    placeholder: "Demandez ce que vous voulez…",
    rename: "Renommer la discussion",
    renameNamed: "Renommer {{title}}",
    deleteNamed: "Supprimer {{title}}",
    newChat: "Nouvelle discussion",
    newInProject: "Lancer une nouvelle discussion dans ce projet",
  },
  create: {
    title: "Nouveau projet",
    name: "Nom",
    namePlaceholder: "Livre de recettes",
    description: "À propos (facultatif)",
    descriptionPlaceholder: "Qu'est-ce que c'est, et pour qui ?",
    confirm: "Créer le projet",
  },
  rename: {
    projectTitle: "Renommer le projet",
    chatTitle: "Renommer la discussion",
    name: "Nom",
    confirm: "Renommer",
  },
};

export default fr;
