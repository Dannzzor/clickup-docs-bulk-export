#!/usr/bin/env node

import 'dotenv/config'
import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { ClickUpExporter } from './exporter.js'
import type { ExportOptions } from './clickup/types.js'

const program = new Command()

program
  .name('clickup-docs-exporter')
  .description('Export ClickUp Docs and Wikis to markdown files')
  .version('1.0.0')

program
  .option(
    '-t, --token <token>',
    'ClickUp API token (optional if CLICKUP_API_TOKEN is set in environment or .env — see .env.example)'
  )
  .requiredOption('-w, --workspace <id>', 'ClickUp Workspace ID')
  .option('-o, --output <dir>', 'Output directory', './clickup-docs')
  .option('-d, --doc <id>', 'Export single doc by ID (optional)')
  .option(
    '-r, --resume',
    'Skip page content API calls when the target markdown file already exists; reuse .clickup-export/page-listing.json when present',
    false
  )
  .option('--include-archived', 'Include archived docs in the workspace doc list', false)
  .option('--include-deleted', 'Include deleted docs in the workspace doc list', false)
  .option('--skip-report', 'Do not write export-report.json / export-report.md', false)
  .option(
    '--layout <mode>',
    'Output layout: flat (default) or hierarchy (Space / Folder / List / Doc folders)',
    'flat'
  )
  .option('-v, --verbose', 'Verbose output', false)
  .action(async (opts) => {
    const tokenFromFlag = typeof opts.token === 'string' ? opts.token.trim() : ''
    const tokenFromEnv = process.env.CLICKUP_API_TOKEN?.trim() ?? ''
    const token = tokenFromFlag || tokenFromEnv

    if (!token) {
      console.error()
      console.error(
        chalk.red('Error:'),
        'Missing API token. Pass --token, set CLICKUP_API_TOKEN, or copy .env.example to .env.'
      )
      console.error()
      process.exit(1)
    }

    console.log()
    console.log(chalk.bold.cyan('📚 ClickUp Docs Exporter'))
    console.log(chalk.gray('─'.repeat(40)))
    console.log()

    const layoutRaw = typeof opts.layout === 'string' ? opts.layout.toLowerCase() : 'flat'
    const layout = layoutRaw === 'hierarchy' ? 'hierarchy' : 'flat'

    const options: ExportOptions = {
      token,
      workspaceId: opts.workspace,
      outputDir: opts.output,
      docId: opts.doc,
      verbose: opts.verbose,
      resume: Boolean(opts.resume),
      includeArchived: Boolean(opts.includeArchived),
      includeDeleted: Boolean(opts.includeDeleted),
      noReport: Boolean(opts.skipReport),
      layout,
    }

    // Mask token for display
    const maskedToken = options.token.length > 12
      ? `${options.token.slice(0, 6)}...${options.token.slice(-4)}`
      : '***'

    const tokenSource = tokenFromFlag ? '' : ' (from CLICKUP_API_TOKEN)'
    console.log(chalk.gray('  Token:'), maskedToken + tokenSource)
    console.log(chalk.gray('  Workspace:'), options.workspaceId)
    console.log(chalk.gray('  Output:'), options.outputDir)
    if (options.docId) {
      console.log(chalk.gray('  Doc ID:'), options.docId)
    }
    if (options.resume) {
      console.log(chalk.gray('  Resume:'), 'yes (skip existing page files & cached listings)')
    }
    if (options.includeArchived) {
      console.log(chalk.gray('  Include archived docs:'), 'yes')
    }
    if (options.includeDeleted) {
      console.log(chalk.gray('  Include deleted docs:'), 'yes')
    }
    console.log(chalk.gray('  Layout:'), options.layout)
    console.log()

    const spinner = ora('Starting export...').start()

    try {
      const exporter = new ClickUpExporter(options)
      
      spinner.text = 'Connecting to ClickUp...'
      const result = await exporter.export()

      spinner.succeed('Export complete!')
      console.log()
      console.log(chalk.bold.green('✨ Export Summary'))
      console.log(chalk.gray('─'.repeat(40)))
      console.log(chalk.gray('  Docs exported:'), chalk.white(result.totalDocs))
      console.log(chalk.gray('  Pages exported:'), chalk.white(result.totalPages))
      console.log(chalk.gray('  Output directory:'), chalk.white(result.outputDir))

      const problemCount = result.issues.filter((i) => i.kind !== 'resume_skipped_content').length
      if (result.reportJsonPath && result.reportMdPath) {
        console.log(chalk.gray('  Report:'), chalk.white(result.reportMdPath))
        if (problemCount > 0) {
          console.log(
            chalk.yellow(`  Export issues (excluding resume skips): ${problemCount} — see report above`)
          )
        }
      }

      if (result.errors.length > 0) {
        console.log()
        console.log(chalk.yellow(`  ⚠ ${result.errors.length} warning(s):`))
        result.errors.slice(0, 8).forEach((err) => {
          console.log(chalk.gray(`    - ${err}`))
        })
        if (result.errors.length > 8) {
          console.log(chalk.gray(`    ... and ${result.errors.length - 8} more (full list in export-report.json)`))
        }
      }

      console.log()
      console.log(chalk.gray('Need a hosted solution? Check out'), chalk.cyan('https://wikibeem.com'))
      console.log()

    } catch (error: any) {
      spinner.fail('Export failed')
      console.error()
      console.error(chalk.red('Error:'), error.message)
      
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        console.error()
        console.error(chalk.yellow('Tip: Make sure your API token is valid.'))
        console.error(chalk.gray('Get your token at: https://app.clickup.com/settings/apps'))
      }
      
      process.exit(1)
    }
  })

program.parse()
