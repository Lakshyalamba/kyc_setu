/* global console, process */
// The advisory face detector runs from files we serve ourselves: the customer's browser contacts nobody else.
// The wasm runtime is copied out of node_modules (it is ~9 MB, so it is not committed); the model is committed under
// public/models with its licence noted in public/models/README.md.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The package does not export its package.json, so go from the entry file (…/tasks-vision/vision_bundle.cjs).
const pkg = path.dirname(require.resolve('@mediapipe/tasks-vision'));
const from = path.join(pkg, 'wasm');
const to = path.resolve(import.meta.dirname, '../public/mediapipe/wasm');
if (!existsSync(from)) throw new Error(`no wasm directory at ${from}`);
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`mediapipe wasm copied to ${path.relative(process.cwd(), to)}`);
