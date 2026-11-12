// La barre latérale, le cadre des pages et le menu de commandes.

import type en from "../en/layout";
import type { Messages } from "../types";

const fr: Messages<typeof en> = {
  sidebar: {
    label: "Projets et discussions",
    close: "Masquer la barre latérale",
    open: "Afficher la barre latérale",
    search: "Rechercher",
    noProjects: "Lancez un projet pour construire une app.",
    noChats: "Vos discussions apparaissent ici.",
    rename: "Renommer {{name}}",
    delete: "Supprimer {{name}}",
    signOut: "Se déconnecter",
    deleteTitle: "Supprimer « {{title}} » ?",
    deleteProjectBody_one:
      "Le projet, son app et sa discussion quittent Richelieu pour de bon. C'est irréversible.",
    deleteProjectBody_other:
      "Le projet, son app et ses {{count}} discussions quittent Richelieu pour de bon. C'est irréversible.",
    deleteChatBody: "La discussion et ses messages quittent Richelieu pour de bon. C'est irréversible.",
    deleteProjectConfirm: "Supprimer le projet",
    deleteChatConfirm: "Supprimer la discussion",
  },
  commands: {
    title: "Menu de commandes",
    actions: "Actions",
    newChat: "Nouvelle discussion",
    newChatKeywords: "démarrer demander conversation parler question chat",
    newProject: "Nouveau projet",
    newProjectKeywords: "créer démarrer app application nouveau construire dossier",
    social: "Réseaux sociaux : calendrier et copilote",
    socialKeywords: "réseaux sociaux publications calendrier programmer linkedin twitter instagram statistiques",
    newsletter: "Newsletter : articles Substack, idées et copilote",
    newsletterKeywords: "newsletter substack article brouillon publier email notes abonnés",
    hideSidebar: "Masquer la barre latérale",
    showSidebar: "Afficher la barre latérale",
    sidebarKeywords: "afficher masquer navigation panneau tiroir",
    projects: "Projets",
    projectKeywords: "projet ouvrir aller",
    chats: "Discussions",
    chatKeywords: "discussion conversation chat ouvrir aller",
    settings: "Réglages",
    changeTheme: "Changer de thème",
    themeKeywords: "apparence sombre clair mode couleurs thème",
    changeLanguage: "Changer de langue",
    languageKeywords: "langue anglais français english language traduire",
    signOut: "Se déconnecter",
    signOutKeywords: "déconnexion compte quitter",
    theme: "Thème",
    language: "Langue",
    themes: { system: "Système", light: "Clair", dark: "Sombre" },
    back: "Retour à toutes les commandes",
    searchLabel: "Rechercher des commandes, des projets et des discussions",
    searchPlaceholder: "Rechercher des projets, des discussions, des actions et des réglages…",
    searchThemes: "Rechercher un thème…",
    searchLanguages: "Rechercher une langue…",
    nothing: "Rien ne correspond à « {{query}} ».",
    move: "Naviguer",
    select: "Choisir",
    goBack: "Retour",
    toggle: "Ouvrir/fermer",
  },
};

export default fr;
