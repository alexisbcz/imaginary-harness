// Every language's strings, by namespace: one file per area of the app (src/web/locales/<language>/<area>.ts).

import enAuth from "./en/auth";
import enBuilder from "./en/builder";
import enCommon from "./en/common";
import enEditor from "./en/editor";
import enLayout from "./en/layout";
import enMail from "./en/mail";
import enNewsletter from "./en/newsletter";
import enProjects from "./en/projects";
import enSocial from "./en/social";
import frAuth from "./fr/auth";
import frBuilder from "./fr/builder";
import frCommon from "./fr/common";
import frEditor from "./fr/editor";
import frLayout from "./fr/layout";
import frMail from "./fr/mail";
import frNewsletter from "./fr/newsletter";
import frProjects from "./fr/projects";
import frSocial from "./fr/social";

export const en = {
  common: enCommon,
  auth: enAuth,
  layout: enLayout,
  builder: enBuilder,
  projects: enProjects,
  mail: enMail,
  social: enSocial,
  newsletter: enNewsletter,
  editor: enEditor,
};

export const resources = {
  en,
  fr: {
    common: frCommon,
    auth: frAuth,
    layout: frLayout,
    builder: frBuilder,
    projects: frProjects,
    mail: frMail,
    social: frSocial,
    newsletter: frNewsletter,
    editor: frEditor,
  },
};

export const LANGUAGES = [
  { code: "en", label: "English", intl: "en-GB" },
  { code: "fr", label: "Français", intl: "fr-FR" },
] as const;
export type Language = (typeof LANGUAGES)[number]["code"];
