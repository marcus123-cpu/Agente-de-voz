import { cvortexReady } from '../server/src/cvortex-provider.ts';
console.log('cvortexReady:', await cvortexReady());
process.exit(0);
