import logo from "@meetsanctum/brand/sanctum-logo-white.png";

import { productName } from "../../../client/src/brand";
import { repositoryUrl, siteUrl, xUrl } from "../site";
import { waitlistEmail } from "./email";

/**
 * The waitlist's confirmation as this site sends it to a contact. Mail apps
 * fetch the logo from the site, where the build put it, and the way off the
 * list is the site's too; `site` names another copy of the site for both.
 */
export const confirmation = (contact: string, site = siteUrl) =>
  waitlistEmail({
    productName,
    siteUrl,
    logoUrl: `${site}${logo.src}`,
    repositoryUrl,
    xUrl,
    unsubscribeUrl: `${site}/unsubscribe/${contact}`,
    oneClickUrl: `${site}/api/unsubscribe/${contact}`,
  });
