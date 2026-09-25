#!/usr/bin/env node
import { createDefaultDependencies, runAgentCli } from './lib/agent-cli.mjs'

process.exitCode = await runAgentCli(process.argv.slice(2), createDefaultDependencies())
