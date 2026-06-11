const firstNumber = (...values) => {
  for (const value of values) {
    if (typeof value === 'number' && !Number.isNaN(value)) return value
  }
  return undefined
}

const openai_uinit = () => ({
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0
})

const to_openai = usage => {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = firstNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.inputTokens,
    usage.cacheReadInputTokens,
    usage.cache_read_input_tokens
  )
  const completion = firstNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.outputTokens
  )
  const total = firstNumber(
    usage.total_tokens,
    usage.totalTokens,
    typeof prompt === 'number' && typeof completion === 'number' ? prompt + completion : undefined
  )
  const out = {}
  if (prompt !== undefined) out.prompt_tokens = prompt
  if (completion !== undefined) out.completion_tokens = completion
  if (total !== undefined) out.total_tokens = total
  return Object.keys(out).length ? out : undefined
}

module.exports = { openai_uinit, to_openai }
