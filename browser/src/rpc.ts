export async function rpc<T>(message: Record<string, unknown>): Promise<T> {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展连接已断开，请刷新网页后重试。');
  return result.data as T;
}
