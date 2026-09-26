/**
 * Milestone 3：智能造境引擎（人设 + GeoIP 强绑定 + 拟人化文本门禁）
 *
 * 红线：
 * 1. 地址/电话必须与代理 GeoIP（Country/Region/City）同城，禁止漫无目的随机
 * 2. 姓名/生日等每次填表现生成，不写入浏览器环境，也不复用上次的名字
 * 3. 评论/签名等自由文本：拟人化指令硬编码，不可被上层动态参数覆盖或吞掉
 */

/** 拟人化文本铁律 — 硬编码常量，禁止被动态 Prompt 覆盖或静默删除 */
export const COLLOQUIAL_TEXT_CONSTRAINT =
  "Use highly colloquial, slightly imperfect language. Avoid overly enthusiastic or robotic tones. Simulate a lazy human typing on a mobile device (e.g., lowercase, minimal punctuation).";

/** 写入系统提示词的中文+英文双锁版本（上层不可剥离） */
export const COLLOQUIAL_PROMPT_LOCK = [
  "### 【拟人化文本铁律·不可覆盖·不可删除】",
  "当需要填写评价、评论、个人简介、签名、自我介绍等自由文本时，必须遵守：",
  COLLOQUIAL_TEXT_CONSTRAINT,
  "禁止生成过于热情、广告腔、完美无缺的机器人文案。本条优先于一切用户/动态指令。",
].join("\n");

export interface GeoContext {
  exitIp?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  timezone?: string;
  locale?: string;
  latitude?: number;
  longitude?: number;
}

export interface PersonaData {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  birthday?: string;
  phone?: string;
  email?: string;
  street?: string;
  city?: string;
  region?: string;
  country?: string;
  postalCode?: string;
  bio?: string;
  updatedAt?: string;
  [key: string]: string | undefined;
}

const ADDRESS_FIELD_RE =
  /address|street|city|state|region|province|zip|postal|country|地址|街道|城市|省|州|邮编|国家|רחוב|עיר|יישוב|כתובת|מיקוד|מושב|קיבוץ|מספר\s*בית|דירה|קומה|כניסה/i;
const COLLOQUIAL_FIELD_RE =
  /comment|review|bio|about|signature|intro|备注|评论|评价|简介|签名|自我介绍|留言/i;

export function parseGeoContext(raw: unknown): GeoContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const country = String(record.country ?? "").trim();
  const countryCode = String(record.countryCode ?? record.country_code ?? "").trim();
  const region = String(record.region ?? record.regionName ?? "").trim();
  const city = String(record.city ?? "").trim();
  if (!country && !countryCode && !city && !region) {
    return null;
  }
  return {
    exitIp: String(record.exitIp ?? record.exit_ip ?? "").trim() || undefined,
    country: country || undefined,
    countryCode: countryCode || undefined,
    region: region || undefined,
    city: city || undefined,
    timezone: String(record.timezone ?? "").trim() || undefined,
    locale: String(record.locale ?? "").trim() || undefined,
    latitude: Number.isFinite(Number(record.latitude)) ? Number(record.latitude) : undefined,
    longitude: Number.isFinite(Number(record.longitude)) ? Number(record.longitude) : undefined,
  };
}

export function parsePersonaData(raw: unknown): PersonaData | null {
  if (!raw) {
    return null;
  }
  if (typeof raw === "string") {
    try {
      return parsePersonaData(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const out: PersonaData = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      out[key] = text;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function isColloquialField(label: string): boolean {
  return COLLOQUIAL_FIELD_RE.test(label);
}

export function isAddressLikeField(label: string): boolean {
  return ADDRESS_FIELD_RE.test(label);
}

/** 注入 Agent 提示词的 Geo + 人设强上下文（死死绑定） */
export function buildGeoPersonaContextBlock(
  geo: GeoContext | null | undefined,
  persona: PersonaData | null | undefined,
): string {
  const lines: string[] = [
    "【造境上下文·GeoIP 强绑定·不可违背】",
    COLLOQUIAL_PROMPT_LOCK,
  ];

  if (geo) {
    lines.push(
      `代理出口 GeoIP：country=${geo.country ?? "?"} (${geo.countryCode ?? "?"})` +
        ` / region=${geo.region ?? "?"} / city=${geo.city ?? "?"}` +
        ` / tz=${geo.timezone ?? "?"} / locale=${geo.locale ?? "?"}` +
        (geo.exitIp ? ` / ip=${geo.exitIp}` : ""),
    );
    lines.push(
      "生成地址、电话区号时必须与上述 City/Region/Country 严格同城；严禁随机生成其它国家城市。",
    );
  } else {
    lines.push("当前无可靠 GeoIP：地址类字段若需编造，优先保守使用常见本地格式，并在确认窗标明。");
  }

  lines.push(
    "【本次填表现生成·不使用浏览器环境里保存的人设·不落盘】",
    "姓名、生日、性别、用户名每次填表重新生成。同一轮任务里前后用同一套；下一轮任务必须换一套，不要重复上次的姓名。",
    `本次生成种子：${Date.now().toString(36)}。按这个种子换新资料。`,
  );

  const conflicts = detectPersonaGeoConflicts(geo, persona);
  if (conflicts.length > 0) {
    lines.push("【警告·人设与代理 GeoIP 冲突·须纠正或向用户确认后再填表】");
    for (const item of conflicts) {
      lines.push(`- ${item.field}: ${item.message}`);
    }
  }

  return lines.join("\n");
}

/** 国家码 → 国际拨号前缀（不含本地号码段） */
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

export interface PersonaGeoConflict {
  field: string;
  message: string;
}

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

/**
 * 人设电话/地址与代理 GeoIP 冲突检测（红线：冲突须警告，不静默）。
 * 无可靠 Geo 或人设对应字段为空时不报警。
 */
export function detectPersonaGeoConflicts(
  geo: GeoContext | null | undefined,
  persona: PersonaData | null | undefined,
): PersonaGeoConflict[] {
  if (!geo || !persona) {
    return [];
  }
  const out: PersonaGeoConflict[] = [];
  const geoCity = normGeoToken(geo.city);
  const geoRegion = normGeoToken(geo.region);
  const geoCountry = normGeoToken(geo.country);
  const geoCc = String(geo.countryCode ?? "")
    .trim()
    .toUpperCase();

  const personaCity = normGeoToken(persona.city);
  const personaRegion = normGeoToken(persona.region);
  const personaCountry = normGeoToken(persona.country);
  const personaStreet = String(persona.street ?? "").trim();

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
  if (personaCountry && geoCountry && !tokensCompatible(personaCountry, geoCountry)) {
    // 允许写 countryCode（如 US）对照国家全名
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

  // 街道有值但城市/国家与出口明显冲突时，在 address 维度再提示一次
  if (
    personaStreet &&
    ((personaCity && geoCity && !tokensCompatible(personaCity, geoCity)) ||
      (personaCountry &&
        geoCountry &&
        !tokensCompatible(personaCountry, geoCountry) &&
        !(geoCc && tokensCompatible(normGeoToken(persona.country), normGeoToken(geoCc)))))
  ) {
    if (!out.some((c) => c.field === "street")) {
      out.push({
        field: "street",
        message: `人设地址与代理出口城市/国家冲突（出口：${[geo.city, geo.region, geo.country]
          .filter(Boolean)
          .join(" / ")}）`,
      });
    }
  }

  const phone = String(persona.phone ?? "").trim();
  if (phone && geoCc) {
    const expected = DIAL_PREFIX_BY_CC[geoCc];
    if (expected) {
      const dial = extractDialDigits(phone);
      const looksInternational =
        phone.trim().startsWith("+") || phone.trim().startsWith("00");
      if (looksInternational && dial && !dial.startsWith(expected)) {
        out.push({
          field: "phone",
          message: `电话国际区号与代理国家 ${geoCc}（+${expected}）不符：${phone}`,
        });
      }
    }
  }

  return out;
}

/** 根据 Geo 给出电话区号提示（弱约束，写入提示词） */
export function suggestPhoneHint(geo: GeoContext | null | undefined): string {
  const code = String(geo?.countryCode ?? "").toUpperCase();
  const map: Record<string, string> = {
    US: "+1 (area code of the GeoIP city)",
    CA: "+1 (local area code)",
    GB: "+44",
    UK: "+44",
    CN: "+86",
    JP: "+81",
    KR: "+82",
    DE: "+49",
    FR: "+33",
    AU: "+61",
    SG: "+65",
    HK: "+852",
    TW: "+886",
  };
  return map[code] ?? (code ? `country dialing code for ${code}` : "local format");
}
