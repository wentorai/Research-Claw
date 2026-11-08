export function teamRequestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unknown method:\s*rc\.team\./i.test(message)) {
    return '当前网关尚未加载科研群组接口。请重启 ResearchClaw 网关后重新连接；仅刷新页面不会更新后端插件。';
  }
  return message;
}
