/**
 * 人设与代理出口 GeoIP 的冲突提示（前端侧）。
 * 规则与 sidecar/src/persona_engine.ts detectPersonaGeoConflicts 对齐。
 *
 * 保留原因：环境人设表单已下线，但「规则」窗口里的人设条目仍会用于自动填表，
 * 地址/电话与出口城市冲突时必须显式警告，禁止静默填错城（宪法 §1.4）。
 */

export interface PersonaGeoHint {
  country?: string | null;
  country_code?: string | null;
  region?: string | null;
  city?: string | null;
  status?: string;
}

export interface PersonaGeoConflict {
  field: string;
  message: string;
}

/** 参与冲突检测的最小字段集合 */
export interface PersonaGeoComparable {
  street?: string;
  city?: string;
  region?: string;
  country?: string;
  phone?: string;
}

const DIAL_PREFIX_BY_CC: Record<string, string> = {
  US: "1",
  CA: "1",
  GB: "44",
  UK: "44",
  CN: "86",
  JP: "81",
  KR: "82",
  DE: "49",
  FR: "33",
  AU: "61",
  SG: "65",
  HK: "852",
  TW: "886",
};

function normGeoToken(raw: string | undefined | null): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_,./\\()（）]+/g, "");
}

function tokensCompatible(a: string, b: string): boolean {
  if (!a || !b) return true;
  return a === b || a.includes(b) || b.includes(a);
}

function extractDialDigits(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    return digits.slice(1).replace(/\D/g, "");
  }
  if (digits.startsWith("00")) {
    return digits.slice(2).replace(/\D/g, "");
  }
  return digits.replace(/\D/g, "");
}

export function detectPersonaGeoConflicts(
  persona: PersonaGeoComparable,
  geo: PersonaGeoHint | null | undefined,
): PersonaGeoConflict[] {
  if (!geo || geo.status === "error" || geo.status === "no_proxy") {
    return [];
  }
  const geoCity = normGeoToken(geo.city);
  const geoRegion = normGeoToken(geo.region);
  const geoCountry = normGeoToken(geo.country);
  const geoCc = String(geo.country_code ?? "")
    .trim()
    .toUpperCase();
  if (!geoCity && !geoRegion && !geoCountry && !geoCc) {
    return [];
  }

  const out: PersonaGeoConflict[] = [];
  const personaCity = normGeoToken(persona.city);
  const personaRegion = normGeoToken(persona.region);
  const personaCountry = normGeoToken(persona.country);
  const street = String(persona.street ?? "").trim();

  if (personaCity && geoCity && !tokensCompatible(personaCity, geoCity)) {
    out.push({
      field: "city",
      message: `人设城市「${persona.city}」与代理出口城市「${geo.city}」不一致`,
    });
  }
  if (personaRegion && geoRegion && !tokensCompatible(personaRegion, geoRegion)) {
    out.push({
      field: "region",
      message: `人设省/州「${persona.region}」与代理出口「${geo.region}」不一致`,
    });
  }
  if (personaCountry && geoCountry) {
    const countryOk =
      (geoCc && tokensCompatible(personaCountry, normGeoToken(geoCc))) ||
      tokensCompatible(personaCountry, geoCountry);
    if (!countryOk) {
      out.push({
        field: "country",
        message: `人设国家「${persona.country}」与代理出口「${geo.country ?? geoCc}」不一致`,
      });
    }
  }

  if (
    street &&
    ((personaCity && geoCity && !tokensCompatible(personaCity, geoCity)) ||
      (personaCountry &&
        geoCountry &&
        !tokensCompatible(personaCountry, geoCountry) &&
        !(geoCc && tokensCompatible(personaCountry, normGeoToken(geoCc)))))
  ) {
    out.push({
      field: "street",
      message: `人设地址与代理出口冲突（出口：${[geo.city, geo.region, geo.country]
        .filter(Boolean)
        .join(" / ")}）`,
    });
  }

  const phone = String(persona.phone ?? "").trim();
  if (phone && geoCc) {
    const expected = DIAL_PREFIX_BY_CC[geoCc];
    if (expected) {
      const dial = extractDialDigits(phone);
      const looksInternational = phone.startsWith("+") || phone.startsWith("00");
      if (looksInternational && dial && !dial.startsWith(expected)) {
        out.push({
          field: "phone",
          message: `电话国际区号与代理国家 ${geoCc}（+${expected}）不符`,
        });
      }
    }
  }

  return out;
}

export function formatGeoHintLabel(geo: PersonaGeoHint | null | undefined): string {
  if (!geo || geo.status === "no_proxy") {
    return "未绑定代理或尚未解析出口";
  }
  if (geo.status === "error") {
    return "出口 GeoIP 解析失败";
  }
  const parts = [geo.city, geo.region, geo.country].map((v) => String(v ?? "").trim()).filter(Boolean);
  if (geo.country_code?.trim()) {
    parts.push(`(${geo.country_code.trim().toUpperCase()})`);
  }
  return parts.length > 0 ? parts.join(" · ") : "已启动过环境后可对照出口城市";
}
