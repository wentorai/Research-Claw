import {
  DEFAULT_ILINK_BOT_TYPE,
  WEIXIN_DEFAULT_SESSION_KEY,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "../auth/login-qr.js";
import { loadWeixinAccount, DEFAULT_BASE_URL } from "../auth/accounts.js";

/**
 * Raw JSON Schema for the tool parameters.
 * Cannot use @sinclair/typebox here — it lives in OC's node_modules which is
 * outside this plugin's module resolution path. jiti resolves from the file's
 * location, not the OC process root.
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
 * Mirrors the WhatsApp `whatsapp_login` tool pattern from OC core.
 *
 * Usage flow (from agent):
 *   1. Call weixin_login { action: "start" } → returns QR code URL
 *   2. Display QR as markdown image: ![qr](url)
 *   3. Call weixin_login { action: "wait" } → blocks until user scans or timeout
 */
export function createWeixinLoginTool() {
  return {
    label: "WeChat Login",
    name: "weixin_login",
    ownerOnly: true,
    description:
      "Generate a WeChat QR code for linking, or wait for the scan to complete.",
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
          timeoutMs: typedArgs.timeoutMs,
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

      if (!result.qrcodeUrl) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: { qr: false },
        };
      }

      const text = [
        result.message,
        "",
        "打开微信扫描以下二维码：",
        "",
        `![weixin-qr](${result.qrcodeUrl})`,
      ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { qr: true },
      };
    },
  };
}
