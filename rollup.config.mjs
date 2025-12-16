import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import fg from 'fast-glob'
import path from 'path'

const base = path.resolve(process.cwd())

const entries = [
  'src/index.ts',
  'src/agent.ts',
  'src/agent-orchestrator.ts',
  'src/opencode.ts',
  'src/provenance.ts',
  'src/workflow-schema.ts',
  ...fg.sync('src/workflows/*.workflow.ts')
]

export default {
  input: entries,
  external: ['@opencode-ai/sdk', 'zod'],
  plugins: [
    nodeResolve({ preferBuiltins: true }),
    json(),
    commonjs(),
    typescript({ tsconfig: path.join(base, 'tsconfig.json'), sourceMap: true })
  ],
  output: {
    dir: 'dist',
    format: 'esm',
    sourcemap: true,
    preserveModules: true,
    entryFileNames: '[name].js',
    preserveModulesRoot: 'src'
  }
}
