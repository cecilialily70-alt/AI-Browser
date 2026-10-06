export function normalizeDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch {
    return "";
  }
}

export function domainMatchesTemplate(currentDomain: string, templateDomain: string): boolean {
  const current = currentDomain.trim().toLowerCase();
  const template = templateDomain.trim().toLowerCase();
  if (!current || !template) {
    return false;
  }
  return current === template || current.endsWith(`.${template}`) || template.endsWith(`.${current}`);
}
