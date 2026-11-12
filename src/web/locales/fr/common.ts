// Les mots que toutes les parties partagent : boutons, états et sections de l'app.

import type en from "../en/common";
import type { Messages } from "../types";

const fr: Messages<typeof en> = {
  cancel: "Annuler",
  close: "Fermer",
  save: "Enregistrer",
  saved: "Enregistré",
  saving: "Enregistrement…",
  delete: "Supprimer",
  remove: "Retirer",
  edit: "Modifier",
  back: "Retour",
  next: "Suivant",
  previous: "Précédent",
  retry: "Réessayer",
  dismiss: "Fermer",
  done: "Terminé",
  loading: "Chargement",
  copy: "Copier",
  copied: "Copié",
  search: "Rechercher",
  more: "Plus",
  open: "Ouvrir",
  apply: "Appliquer",
  untitled: "Sans titre",
  rename: "Renommer",
  saveFailed: "Non enregistré",
  sections: {
    newChat: "Nouvelle discussion",
    newProject: "Nouveau projet",
    mail: "Mail",
    social: "Réseaux sociaux",
    newsletter: "Newsletter",
    projects: "Projets",
    chats: "Discussions",
  },
  ui: {
    previousSlide: "Diapositive précédente",
    nextSlide: "Diapositive suivante",
    commandPalette: "Palette de commandes",
    commandPaletteDescription: "Recherchez une commande à lancer…",
    scrollToEnd: "Aller à la fin",
    scrollToStart: "Aller au début",
    previousPage: "Page précédente",
    nextPage: "Page suivante",
    morePages: "Plus de pages",
    skip: "Passer",
    submit: "Envoyer",
    sidebar: "Barre latérale",
    sidebarDescription: "Affiche la barre latérale sur mobile.",
    toggleSidebar: "Afficher ou masquer la barre latérale",
    closeToast: "Fermer la notification",
  },
  language: {
    label: "Langue",
    change: "Changer de langue",
  },
};

export default fr;
