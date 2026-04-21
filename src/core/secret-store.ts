import { QuestDomainError } from "./errors";
import { runSubprocess } from "./runs/process";
import { buildProcessEnv } from "./runs/process-env";

type SecretStoreCommandResult = Awaited<ReturnType<typeof runSubprocess>>;
const keychainItemMissingExitCode = 44;

type SecretStoreOptions = {
  platform?: NodeJS.Platform | undefined;
  runCommand?: (options: {
    cmd: string[];
    cwd: string;
    env: Record<string, string | undefined>;
    stdin?: string | undefined;
  }) => Promise<SecretStoreCommandResult>;
  serviceName?: string | undefined;
};

export type SecretStoreStatus = {
  backend: "macos-keychain";
  exists: boolean;
  name: string;
};

function normalizeSecretName(name: string): string {
  const normalized = name.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalized)) {
    throw new QuestDomainError({
      code: "invalid_worker_definition",
      details: { name },
      message: `Invalid secret name: ${name}`,
      statusCode: 1,
    });
  }

  return normalized;
}

export class SecretStore {
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: NonNullable<SecretStoreOptions["runCommand"]>;
  private readonly serviceName: string;

  constructor(options: SecretStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? runSubprocess;
    this.serviceName = options.serviceName ?? Bun.env.QUEST_SECRET_STORE_SERVICE_NAME ?? "quest";
  }

  private requireSupportedPlatform(): void {
    if (this.platform !== "darwin") {
      throw new QuestDomainError({
        code: "quest_unavailable",
        details: { platform: this.platform },
        message: `Secret storage is not implemented for platform ${this.platform}`,
        statusCode: 1,
      });
    }
  }

  private async runSecurityCommand(
    cmd: string[],
    options: { stdin?: string | undefined } = {},
  ): Promise<SecretStoreCommandResult> {
    this.requireSupportedPlatform();
    return await this.runCommand({
      cmd,
      cwd: process.cwd(),
      env: buildProcessEnv(),
      stdin: options.stdin,
    });
  }

  private isMissingSecretResult(result: SecretStoreCommandResult): boolean {
    return result.exitCode === keychainItemMissingExitCode;
  }

  async getSecret(name: string): Promise<string> {
    const secretName = normalizeSecretName(name);
    const result = await this.runSecurityCommand([
      "security",
      "find-generic-password",
      "-a",
      secretName,
      "-s",
      this.serviceName,
      "-w",
    ]);

    if (this.isMissingSecretResult(result)) {
      throw new QuestDomainError({
        code: "quest_unavailable",
        details: { name: secretName, stderr: result.stderr, stdout: result.stdout },
        message: `Secret ${secretName} was not found in the keychain`,
        statusCode: 1,
      });
    }

    if (result.exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_storage_failure",
        details: { name: secretName, stderr: result.stderr, stdout: result.stdout },
        message: `Failed to read secret ${secretName} from the keychain`,
        statusCode: 1,
      });
    }

    return result.stdout.trimEnd();
  }

  async setSecret(name: string, value: string): Promise<void> {
    const secretName = normalizeSecretName(name);
    const result = await this.runSecurityCommand(
      [
        "security",
        "add-generic-password",
        "-a",
        secretName,
        "-s",
        this.serviceName,
        "-U",
        // Avoid putting the secret on argv because same-user process inspection can read it before
        // Keychain stores it. `security` prompts twice when `-w` has no inline value, so we
        // provide the exact payload over stdin instead.
        "-w",
      ],
      { stdin: `${value}\n${value}\n` },
    );

    if (result.exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_storage_failure",
        details: { name: secretName, stderr: result.stderr, stdout: result.stdout },
        message: `Failed to store secret ${secretName} in the keychain`,
        statusCode: 1,
      });
    }
  }

  async deleteSecret(name: string): Promise<void> {
    const secretName = normalizeSecretName(name);
    const result = await this.runSecurityCommand([
      "security",
      "delete-generic-password",
      "-a",
      secretName,
      "-s",
      this.serviceName,
    ]);

    if (this.isMissingSecretResult(result)) {
      throw new QuestDomainError({
        code: "quest_unavailable",
        details: { name: secretName, stderr: result.stderr, stdout: result.stdout },
        message: `Secret ${secretName} was not found in the keychain`,
        statusCode: 1,
      });
    }

    if (result.exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_storage_failure",
        details: { name: secretName, stderr: result.stderr, stdout: result.stdout },
        message: `Failed to delete secret ${secretName} from the keychain`,
        statusCode: 1,
      });
    }
  }

  async getStatus(name: string): Promise<SecretStoreStatus> {
    const secretName = normalizeSecretName(name);
    const result = await this.runSecurityCommand([
      "security",
      "find-generic-password",
      "-a",
      secretName,
      "-s",
      this.serviceName,
    ]);

    if (this.isMissingSecretResult(result)) {
      return {
        backend: "macos-keychain",
        exists: false,
        name: secretName,
      };
    }

    if (result.exitCode !== 0) {
      throw new QuestDomainError({
        code: "quest_storage_failure",
        details: { name: secretName, stderr: result.stderr, stdout: result.stdout },
        message: `Failed to read keychain status for ${secretName}`,
        statusCode: 1,
      });
    }

    return { backend: "macos-keychain", exists: true, name: secretName };
  }
}
