import type { ProfileIpGeo } from "../types";

export function countryFlag(countryCode: string | null | undefined): string {
  const code = countryCode?.trim().toUpperCase();
  if (!code || code.length !== 2 || code === "--") {
    return "";
  }
  const chars = [...code];
  if (!chars.every((char) => char >= "A" && char <= "Z")) {
    return "";
  }
  return String.fromCodePoint(...chars.map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
}

export function buildProfileIpGeoMap(entries: ProfileIpGeo[]): Map<string, ProfileIpGeo> {
  return new Map(entries.map((entry) => [entry.profile_id, entry]));
}

export function formatProfileIpCell(
  entry: ProfileIpGeo | undefined,
  options?: { loading?: boolean },
): {
  primary: string;
  secondary: string;
  title?: string;
} {
  if (!entry) {
    if (options?.loading) {
      return { primary: "查询中…", secondary: "" };
    }
    return { primary: "—", secondary: "" };
  }

  if (entry.status === "no_proxy") {
    return { primary: "—", secondary: "未绑代理" };
  }

  if (entry.status === "error") {
    const raw = entry.message?.trim() ?? "";
    const short =
      raw.includes("egress") || raw.includes("ipify")
        ? "代理出口 IP 解析失败"
        : raw.includes("GeoIP") || raw.includes("mmdb")
          ? "时区解析失败"
          : raw.length > 24
            ? `${raw.slice(0, 24)}…`
            : raw || "无法解析出口 IP";
    return {
      primary: "查询失败",
      secondary: short,
      title: raw || undefined,
    };
  }

  const ip = entry.ip?.trim() || "—";
  const country = entry.country?.trim() || "未知";
  const flag = countryFlag(entry.country_code);
  return {
    primary: ip,
    secondary: flag ? `${flag} ${country}` : country,
    title: entry.country_code ? `${country} (${entry.country_code})` : country,
  };
}
