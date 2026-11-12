// Translation keys are checked: `t("posts.title")` must exist in the English strings of its namespace.

import "i18next";
import type { en } from "@/locales";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof en;
  }
}
