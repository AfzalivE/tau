export const JVM_PROXY_ENV = "TAU_SANDBOX_JVM_PROXY";

export interface JvmProxyEndpoint {
  host: "127.0.0.1";
  port: number;
}

export function formatJvmProxyEndpoint(endpoint: JvmProxyEndpoint): string {
  return `${endpoint.host}:${endpoint.port}`;
}

export function composeJavaToolOptions(
  inheritedOptions: string | undefined,
  endpoint: JvmProxyEndpoint,
): string {
  const options = inheritedOptions?.trim() ? inheritedOptions.trim().split(/\s+/u) : [];
  const requiredOptions = [
    "-Djava.net.preferIPv4Stack=true",
    `-Dhttp.proxyHost=${endpoint.host}`,
    `-Dhttp.proxyPort=${endpoint.port}`,
    `-Dhttps.proxyHost=${endpoint.host}`,
    `-Dhttps.proxyPort=${endpoint.port}`,
  ];

  for (const option of requiredOptions) {
    if (!options.includes(option)) options.push(option);
  }

  return options.join(" ");
}

export function applyJvmProxyEnvironment(env: NodeJS.ProcessEnv): boolean {
  const value = env[JVM_PROXY_ENV];
  delete env[JVM_PROXY_ENV];

  const endpoint = parseJvmProxyEndpoint(value);
  if (!endpoint) return false;

  env.JAVA_TOOL_OPTIONS = composeJavaToolOptions(env.JAVA_TOOL_OPTIONS, endpoint);
  return true;
}

function parseJvmProxyEndpoint(value: string | undefined): JvmProxyEndpoint | null {
  const match = value?.match(/^127\.0\.0\.1:(\d{1,5})$/u);
  if (!match) return null;

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  return { host: "127.0.0.1", port };
}
