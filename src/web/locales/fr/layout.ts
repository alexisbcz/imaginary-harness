// La barre latérale, le cadre des pages et le menu de commandes.

import type en from "../en/layout";
import type { Messages } from "../types";

const fr: Messages<typeof en> = {
  sidebar: {
    projectsLabel: "Projets",
    close: "Masquer la barre latérale",
    open: "Afficher la barre latérale",
    search: "Rechercher",
    empty: "Vos projets apparaissent ici.",
    deleteProject: "Supprimer {{title}}",
    signOut: "Se déconnecter",
    deleteTitle: "Supprimer « {{title}} » ?",
    deleteBody: "Le projet et sa conversation quittent Richelieu pour de bon. C'est irréversible.",
    deleteConfirm: "Supprimer le projet",
  },
  commands: {
    title: "Menu de commandes",
    actions: "Actions",
    newProject: "Nouveau projet",
    newProjectKeywords: "créer démarrer app application nouveau",
    social: "Réseaux sociaux : calendrier et copilote",
    socialKeywords: "réseaux sociaux publications calendrier programmer linkedin twitter instagram statistiques",
    newsletter: "Newsletter : articles Substack, idées et copilote",
    newsletterKeywords: "newsletter substack article brouillon publier email notes abonnés",
    hideSidebar: "Masquer la barre latérale",
    showSidebar: "Afficher la barre latérale",
    sidebarKeywords: "afficher masquer navigation panneau tiroir",
    projects: "Projets",
    projectKeywords: "projet ouvrir aller",
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
    searchLabel: "Rechercher des commandes et des projets",
    searchPlaceholder: "Rechercher des projets, des actions et des réglages…",
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
