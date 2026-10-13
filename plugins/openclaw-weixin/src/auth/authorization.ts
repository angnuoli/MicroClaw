import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  resolveCommandAuthorizedFromAuthorizers,
  shouldComputeCommandAuthorized,
} from "openclaw/plugin-sdk/command-auth-native";

export function resolveWeixinCommandAuthorization(
  cfg: OpenClawConfig,
  rawBody: string,
  senderId: string,
  allowFrom: string[],
): { senderAllowedForCommands: boolean; commandAuthorized: boolean | undefined } {
  // Preserve the released plugin's empty-list legacy DM behavior; command
  // access remains subject to the host's access-groups policy.
  const senderAllowedForCommands = allowFrom.length === 0 || allowFrom.includes(senderId);
  const commandAuthorized = shouldComputeCommandAuthorized(rawBody, cfg)
    ? resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: cfg.commands?.useAccessGroups !== false,
        authorizers: [
          { configured: allowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;
  return { senderAllowedForCommands, commandAuthorized };
}
