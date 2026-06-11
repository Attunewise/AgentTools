const normalizeConcurrency = (value, fallback = 1) => {
  const raw = value === undefined || value === null || value === '' ? fallback : value
  const number = Number(raw)
  if (!Number.isInteger(number) || number < 1) throw new Error('work queue concurrency must be a positive integer')
  return number
}

const runWorkQueue = async ({ items = [], concurrency = 1, worker }) => {
  if (typeof worker !== 'function') throw new Error('work queue worker is required')
  const list = Array.from(items || [])
  const results = new Array(list.length)
  if (!list.length) return results

  let nextIndex = 0
  const workerCount = Math.min(normalizeConcurrency(concurrency), list.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= list.length) return
      results[index] = await worker(list[index], index)
    }
  }))
  return results
}

module.exports = {
  normalizeConcurrency,
  runWorkQueue
}
