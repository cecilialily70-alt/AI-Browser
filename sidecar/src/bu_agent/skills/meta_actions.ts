/**
 * Skill 元工具：list_skills / recall_skill / detect_page_blockers
 * 挂入同一 BU registry，不改指纹面。
 */
import { registerAction, type ActionContext } from "../registry.js";
import type { ActionResult } from "../views.js";
import {
  buildSkillsSystemAppendix,
  ensureSkillsLoaded,
  getSkillById,
  getSkillsRoot,
  listSkillCatalog,
} from "./runtime.js";

function ok(content: string, extra?: Partial<ActionResult>): ActionResult {
  return { extractedContent: content, longTermMemory: content.slice(0, 500), success: true, ...extra };
}

function fail(error: string): ActionResult {
  return { error, success: false };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

interface BlockerFinding {
  type: string;
  severity: "high" | "medium" | "low";
  evidence: string;
  suggestedSkill: string;
  suggestedAction: string;
}

export function registerSkillMetaActions(): void {
  ensureSkillsLoaded();

  registerAction("list_skills", async () => {
    const catalog = listSkillCatalog();
    const payload = {
      root: getSkillsRoot(),
      count: catalog.length,
      skills: catalog,
      hint: "细则用 recall_skill(skill_id)；仅疑似阻断或停滞时再用 detect_page_blockers",
    };
    const content = JSON.stringify(payload, null, 0).slice(0, 8000);
    return ok(content, { includeExtractedContentOnlyOnce: true, extractedContent: content });
  });

  registerAction("recall_skill", async (params) => {
    const id = str(params.skill_id || params.id || params.name).trim();
    if (!id) return fail("recall_skill 需要 skill_id（见 list_skills）");
    const skill = getSkillById(id);
    if (!skill) {
      const ids = listSkillCatalog()
        .map((s) => s.id)
        .join(", ");
      return fail(`未知 skill_id: ${id}。可用: ${ids}`);
    }
    const content = [
      `# Skill: ${skill.id}`,
      skill.description,
      "",
      skill.body,
    ].join("\n");
    return ok(content.slice(0, 14_000), {
      includeExtractedContentOnlyOnce: true,
      extractedContent: content.slice(0, 14_000),
      longTermMemory: `已召回技能 ${skill.id}`,
    });
  });

  registerAction("detect_page_blockers", async (_params, ctx: ActionContext) => {
    try {
      const findings = await ctx.page.evaluate(() => {
        const out: BlockerFinding[] = [];
        const text = String(document.body?.innerText || "")
          .replace(/\s+/g, " ")
          .slice(0, 12_000);
        const lower = text.toLowerCase();
        const push = (
          type: string,
          severity: BlockerFinding["severity"],
          evidence: string,
          suggestedSkill: string,
          suggestedAction: string,
        ) => {
          out.push({ type, severity, evidence: evidence.slice(0, 160), suggestedSkill, suggestedAction });
        };

        const rules: Array<{
          re: RegExp;
          type: string;
          severity: BlockerFinding["severity"];
          skill: string;
          action: string;
        }> = [
          {
            re: /captcha|recaptcha|hcaptcha|cf-turnstile|人机验证|滑动验证|安全验证|verify you are human/,
            type: "captcha",
            severity: "high",
            skill: "auth-hitl",
            action: "AI 视觉执行；memory 计次，满 3 次不过再 HITL（未满 3 次勿交人）",
          },
          {
            re: /短信验证|邮箱验证|邮件验证|email\s*code|sms\s*code|authenticator|google\s*auth|totp|2fa|两步验证|two[-\s]?factor|one[-\s]?time/,
            type: "otp_2fa",
            severity: "high",
            skill: "auth-hitl",
            action: "邮箱码：fetch_email_otp（IMAP/临时邮，或显式启用的网页邮箱；禁止自己打开邮箱或改指纹）→ 失败再 ask_user；短信码：fetch_sms_otp（须显式启用）→ 失败再 ask_user；验证器：必须 ask_user；禁止 AI 猜码",
          },
          {
            re: /cloudflare|attention required|just a moment|checking your browser|访问频率|请稍候/,
            type: "anti_bot_challenge",
            severity: "high",
            skill: "anti-bot-recovery",
            action: "wait 后复检；持续则 handover_to_human；禁止改指纹",
          },
          {
            re: /access denied|403 forbidden|请求被拒绝|账号异常|风控|unusual traffic/,
            type: "access_denied",
            severity: "high",
            skill: "anti-bot-recovery",
            action: "换入口或 handover/done(success=false)",
          },
          {
            re: /accept (all )?cookies|cookie (settings|preference)|同意.*cookie|接受全部|隐私设置|gdpr/,
            type: "cookie_banner",
            severity: "medium",
            skill: "overlays-modals",
            action: "先 click 同意/关闭，再主任务",
          },
          {
            re: /create account|sign up|signup|register|注册账号|注册账户|立即注册|创建账号/,
            type: "register_wall",
            severity: "medium",
            skill: "account-lifecycle",
            action: "注册目标：recall account-lifecycle；填表后人设；OTP 走 P1 三层",
          },
          {
            re: /sign in|log in|登录|請登入|please log/,
            type: "login_wall",
            severity: "medium",
            skill: "auth-hitl",
            action: "若任务需要登录则走登录流；缺凭证 ask_user",
          },
          {
            re: /订票|预订|机票|航班|酒店|旅客信息|乘客信息|passenger|traveler|book(ing)?\s*(flight|hotel)|train\s*ticket|火车票|高铁/,
            type: "booking",
            severity: "high",
            skill: "travel-booking",
            action:
              "订票流：recall travel-booking 至 stop_before_pay；乘客资料按本次 Geo 现生成，证件号 ask_user；支付 critical 走 HITL，禁止自动提交/扣款",
          },
          {
            re: /payment|checkout|支付|付款|cvv|card number|银行卡|购物车|结算|add to cart/,
            type: "payment",
            severity: "high",
            skill: "commerce-checkout",
            action:
              "购物流：recall commerce-checkout 至 stop_before_pay；支付 critical 走 HITL（auth-hitl），禁止自动提交/扣款",
          },
          {
            re: /loading…|loading\.\.\.|加载中|请稍等|skeleton/,
            type: "loading",
            severity: "low",
            skill: "execution-framework",
            action: "本步仅 wait，勿抢跑",
          },
          {
            re: /subscribe|newsletter|开通会员|立即订阅|no thanks|不再提示/,
            type: "promo_modal",
            severity: "medium",
            skill: "overlays-modals",
            action: "关闭/跳过订阅弹层",
          },
        ];

        for (const r of rules) {
          const m = lower.match(r.re) || text.match(r.re);
          if (m) {
            push(r.type, r.severity, m[0] || r.type, r.skill, r.action);
          }
        }

        // 粗检：大面积 fixed/绝对定位遮罩
        try {
          const nodes = Array.from(document.querySelectorAll("body *")).slice(0, 400);
          let overlayHits = 0;
          for (const el of nodes) {
            const st = window.getComputedStyle(el);
            if (st.display === "none" || st.visibility === "hidden") continue;
            const pos = st.position;
            if (pos !== "fixed" && pos !== "sticky") continue;
            const zi = Number.parseInt(st.zIndex || "0", 10);
            if (!Number.isFinite(zi) || zi < 20) continue;
            const r = el.getBoundingClientRect();
            if (r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.35) {
              overlayHits += 1;
            }
          }
          if (overlayHits >= 1) {
            push(
              "viewport_overlay",
              "medium",
              `检测到约 ${overlayHits} 个大尺寸 fixed/sticky 层`,
              "overlays-modals",
              "优先关闭遮罩；Esc / 点同意或关闭",
            );
          }
        } catch {
          /* ignore */
        }

        return out.slice(0, 12);
      });

      const high = findings.filter((f) => f.severity === "high");
      const payload = {
        url: ctx.page.url(),
        findings,
        skillHint:
          high[0]?.suggestedSkill ||
          findings[0]?.suggestedSkill ||
          "execution-framework",
        next:
          findings.length === 0
            ? "未检测到典型阻断；按 execution-framework 继续当前 plan"
            : `优先处理 severity=high；可 recall_skill("${high[0]?.suggestedSkill || findings[0]?.suggestedSkill}")`,
      };
      const content = JSON.stringify(payload).slice(0, 6000);
      return ok(content, {
        includeExtractedContentOnlyOnce: true,
        extractedContent: content,
        longTermMemory:
          findings.length === 0
            ? "页面阻断检测：无"
            : `页面阻断: ${findings.map((f) => f.type).join(",")}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`detect_page_blockers 失败: ${msg}`);
    }
  });
}

/** 供测试/诊断：强制重载技能并返回附录长度 */
export function debugSkillsAppendix(): string {
  ensureSkillsLoaded(true);
  return buildSkillsSystemAppendix();
}
