/**
 * A fake "AI agent" CLI that proves the end-to-end loop: it pretends to
 * think, and while you'd normally stare at a spinner, Moola plays an ad.
 *
 *   npm run demo              (context: aws python)
 *   npm run demo -- test      (context: test)
 */
import { playAd } from 'moola-sdk';

const context = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (context.length === 0) context.push('aws', 'python');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log(`🤖 agent> Analyzing your ${context.join(' + ')} setup...`);

// A short real spinner first, so the ad reads as filling a genuine wait state.
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const spinnerStart = Date.now();
while (Date.now() - spinnerStart < 1500) {
  const f = spinnerFrames[Math.floor((Date.now() - spinnerStart) / 80) % spinnerFrames.length];
  if (process.stdout.isTTY) process.stdout.write(`\r${f} thinking...`);
  await sleep(40);
}
if (process.stdout.isTTY) process.stdout.write('\r             \r');

const outcome = await playAd({ context, debug: process.argv.includes('--debug') });

if (outcome.played) {
  console.log(`(ad ${outcome.playback === 'skipped' ? 'skipped by keypress' : 'finished'})`);
}

console.log('🤖 agent> Done! Here is my expert conclusion:');
console.log(`   Your ${context[0]} configuration looks great. Ship it. 🚀`);
