import {
  DEFAULT_ILINK_BOT_TYPE,
  WEIXIN_DEFAULT_SESSION_KEY,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "../auth/login-qr.js";
import { loadWeixinAccount, DEFAULT_BASE_URL } from "../auth/accounts.js";
import { renderQrDataUrl } from "../util/qr-image.js";

/**
 * Raw JSON Schema for the tool parameters.
 * Cannot use @sinclair/typebox here — it lives in OC's node_modules which is
 * outside this plugin's module resolution path.
 */
const PARAMETERS_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["start", "wait"] },
    timeoutMs: { type: "number" },
    force: { type: "boolean" },
    accountId: { type: "string" },
  },
  required: ["action"],
};

/**
 * Agent tool for WeChat QR-code login.
 *
 * Two-step flow:
 *   1. weixin_login { action: "start" } → returns inline QR code image (data URL)
 *   2. weixin_login { action: "wait" } → blocks until user scans or timeout
 *
 * The agent MUST display the QR image from step 1, then IMMEDIATELY call step 2.
 */
export function createWeixinLoginTool() {
  return {
    label: "WeChat Login",
    name: "weixin_login",
    ownerOnly: true,
    description:
      "Connect WeChat: action='start' generates an inline QR code image, action='wait' blocks until user scans. You MUST call start first, display the returned QR image to the user, then IMMEDIATELY call wait.",
    parameters: PARAMETERS_SCHEMA,
    execute: async (_toolCallId: string, args: unknown) => {
      const typedArgs = args as {
        action?: string;
        timeoutMs?: number;
        force?: boolean;
        accountId?: string;
      };
      const action = typedArgs.action ?? "start";

      if (action === "wait") {
        const sessionKey =
          typedArgs.accountId || WEIXIN_DEFAULT_SESSION_KEY;
        const savedBaseUrl = typedArgs.accountId
          ? loadWeixinAccount(typedArgs.accountId)?.baseUrl?.trim()
          : "";
        const result = await waitForWeixinLogin({
          sessionKey,
          apiBaseUrl: savedBaseUrl || DEFAULT_BASE_URL,
          timeoutMs: typedArgs.timeoutMs ?? 120_000,
          botType: DEFAULT_ILINK_BOT_TYPE,
        });
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: { connected: result.connected },
        };
      }

      // action === "start"
      const savedBaseUrl = typedArgs.accountId
        ? loadWeixinAccount(typedArgs.accountId)?.baseUrl?.trim()
        : "";
      const result = await startWeixinLoginWithQr({
        accountId: typedArgs.accountId,
        apiBaseUrl: savedBaseUrl || DEFAULT_BASE_URL,
        botType: DEFAULT_ILINK_BOT_TYPE,
        force: typedArgs.force,
        timeoutMs: typedArgs.timeoutMs,
      });

      if (!result.qrcode) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: { qr: false },
        };
      }

      // Generate inline data URL so the dashboard can render it as <img>
      const qrDataUrl = renderQrDataUrl(result.qrcodeUrl || result.qrcode);

      const text = [
        result.message,
        "",
        `![weixin-qr](${qrDataUrl})`,
        "",
        "IMPORTANT: Now call weixin_login with action='wait' to await the scan result.",
      ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { qr: true },
      };
    },
  };
}
