/**
 * 取一段适合写日志的错误描述。
 * 连接失败时 Node 常抛出 message 为空的 AggregateError（IPv4 和 IPv6 各失败一次），所以要展开来看。
 */
export function errorText(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return [...new Set(err.errors.map(errorText))].join('；');
  }
  if (err instanceof Error) return err.message || (err as NodeJS.ErrnoException).code || err.name;
  return String(err);
}
