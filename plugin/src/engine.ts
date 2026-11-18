// Bridge to the Python engine: one subprocess per tool call, JSON over stdio.
// State lives in SQLite, so no process has to stay alive between calls.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-error'

/** Engine replies are plain JSON. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export interface EngineOptions {
  python: string
  engineDir: string
  db: string
  bank: string
  sources: string
  vault: string
  indexFolder: string
  pdftotext: string
  learner: string
  course: string
  demo?: boolean
}

/** The engine refused the call; the message tells the model what to do instead. */
export class TutorRefusal extends HarnessError {
  constructor(message: string) {
    super(message, 'TUTOR_REFUSED')
  }
}

export function callEngine(
  opts: EngineOptions,
  command: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Json> {
  const args = [
    '-m', 'tutor_engine',
    '--db', opts.db,
    '--bank', opts.bank,
    '--sources', opts.sources,
    ...(opts.vault ? ['--vault', opts.vault, '--index-folder', opts.indexFolder, '--pdftotext', opts.pdftotext] : []),
    '--learner', opts.learner,
    '--course', opts.course,
    ...(opts.demo ? ['--demo'] : []),
    command,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(opts.python, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONPATH: join(opts.engineDir, 'src') },
      signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', () => {
      let reply: { ok: boolean; result: Json; error?: string }
      try {
        reply = JSON.parse(stdout)
      } catch {
        reject(new Error(`tutor engine crashed: ${stderr.trim() || stdout.trim() || 'no output'}`))
        return
      }
      if (reply.ok) resolve(reply.result)
      else reject(new TutorRefusal(reply.error ?? 'refused'))
    })
    child.stdin.end(JSON.stringify(params))
  })
}
