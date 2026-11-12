// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

/** 拼 className，忽略假值 */
export function cls(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}
