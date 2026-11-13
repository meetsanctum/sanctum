// Where the site is published: the address its emails and the install prompt
// point back to. SITE_URL replaces it for a copy published somewhere else;
// the page takes it in when the site is built, the emails when it runs.
export const siteUrl = (
  process.env.SITE_URL || "https://meetsanctum.com"
).replace(/\/+$/, "");

export const repositoryUrl = "https://github.com/meetsanctum/sanctum";
export const xUrl = "https://x.com/meetsanctum";
