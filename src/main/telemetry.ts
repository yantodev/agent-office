export type ExecutionUsageRow = {
  durationMs?: number | null
  outputBytes?: number | null
}

export function summarizeExecutionUsage(rows: ExecutionUsageRow[]) {
  return rows.reduce<{ durationMs: number; outputBytes: number }>((summary, row) => ({
    durationMs: summary.durationMs + Number(row.durationMs ?? 0),
    outputBytes: summary.outputBytes + Number(row.outputBytes ?? 0),
  }), { durationMs: 0, outputBytes: 0 })
}
