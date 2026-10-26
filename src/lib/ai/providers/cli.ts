import { invoke } from '@tauri-apps/api/core'
import type { AiProvider, ResolvedAiConfig } from '../../pdf/types'

type CliResponse = {
  stdout: string
  stderr: string
  code: number
}

function defaultCliBinary(provider: AiProvider): string {
  return provider === 'codex' ? 'codex' : 'claude'
}

/** 支持引号的简单参数解析：--model "foo bar" / --tools "" */
function splitCliArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasContent = false
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasContent = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        args.push(current)
        current = ''
        hasContent = false
      }
      continue
    }
    current += char
    hasContent = true
  }
  if (hasContent) args.push(current)
  return args
}

export async function callAiCli(
  settings: ResolvedAiConfig,
  prompt: string,
): Promise<string> {
  const program =
    settings.cliPath.trim() || defaultCliBinary(settings.provider)
  const extraArgs = splitCliArgs(settings.cliArgs)
  // PDF 学习只需要文本生成：默认禁用 Claude Code 的文件/命令工具，
  // 避免误读工程文件，也避免被文档内容诱导执行操作。
  // 用户可在「额外参数」显式填写 --tools default 覆盖。
  if (
    settings.provider === 'claude-code' &&
    !extraArgs.some((arg) => arg === '--tools' || arg.startsWith('--tools='))
  ) {
    extraArgs.push('--tools', '')
  }

  const result = await invoke<CliResponse>('run_ai_cli', {
    request: {
      program,
      args: extraArgs,
      prompt,
      provider: settings.provider,
    },
  })

  if (result.code !== 0) {
    const err = (result.stderr || result.stdout || '').trim()
    throw new Error(
      err || `CLI exited with code ${result.code}. Is "${program}" installed?`,
    )
  }
  const text = (result.stdout || '').trim()
  if (!text) {
    throw new Error(
      (result.stderr || '').trim() || 'CLI returned empty output',
    )
  }
  return text
}
