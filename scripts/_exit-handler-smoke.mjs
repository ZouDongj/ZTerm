// Semantics smoke: does process.on('exit') run when a top-level await rejects?
import { writeFileSync, rmSync } from 'node:fs';
const MARK = process.env.TEMP + '\\exit-handler-ran.txt';
rmSync(MARK, { force: true });
process.on('exit', () => writeFileSync(MARK, 'ran'));
await new Promise((resolve, reject) => setTimeout(() => reject(new Error('boom')), 50));
