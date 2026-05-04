/** index.ts — Remotion entry point. registerRoot wires Root.tsx into the studio. */
import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);
