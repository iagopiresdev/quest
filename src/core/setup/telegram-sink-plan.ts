// Pure helpers that translate the wizard's telegram sink-plan `args` into a concrete sink input.
// Lives outside cli.ts so unit tests can exercise every branch (HTML opt-in, OpenClaw token
// import, env/secret-store auth modes) without spawning an interactive readline session.

export type TelegramSinkPlanInput = {
  botTokenEnv?: string | undefined;
  botTokenSecretRef?: string | undefined;
  chatId: string;
  importOpenClawBotToken?: string | undefined;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2" | undefined;
};

function findArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

export function parseTelegramSinkPlan(args: readonly string[]): TelegramSinkPlanInput {
  const chatId = findArg(args, "--chat-id");
  if (!chatId) {
    throw new Error("telegram sink plan missing --chat-id");
  }

  const parseModeRaw = findArg(args, "--parse-mode");
  const parseMode =
    parseModeRaw === "HTML" || parseModeRaw === "Markdown" || parseModeRaw === "MarkdownV2"
      ? parseModeRaw
      : undefined;

  return {
    botTokenEnv: findArg(args, "--bot-token-env"),
    botTokenSecretRef: findArg(args, "--bot-token-secret-ref"),
    chatId,
    importOpenClawBotToken: findArg(args, "--import-openclaw-bot-token"),
    parseMode,
  };
}
