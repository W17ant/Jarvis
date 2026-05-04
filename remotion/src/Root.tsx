/** Root.tsx — composition registry.
 *
 *  Single composition: FlatOutOverview, 1920x1080 landscape (the kiosk's native
 *  aspect — operators run on a 27"+ display). Frame count is read from the audio
 *  manifest so the runtime adapts when narration is regenerated.  */
import React from 'react';
import { Composition } from 'remotion';
import { FlatOutOverview, getTotalFrames } from './FlatOutOverview';
import { FlatOutUninstall, getUninstallTotalFrames } from './FlatOutUninstall';
import { FlatOutCapabilities, getCapabilitiesTotalFrames } from './FlatOutCapabilities';
import { FlatOutTikTok, getTikTokTotalFrames } from './FlatOutTikTok';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="FlatOutOverview"
        component={FlatOutOverview}
        durationInFrames={getTotalFrames()}
        fps={30}
        width={1920}
        height={1080}
      />
      {/* Companion clip — short uninstall walkthrough. Same brand chrome, same
       * Daniel narration, mirrors tools/uninstall-wizard.sh's actual flow. */}
      <Composition
        id="FlatOutUninstall"
        component={FlatOutUninstall}
        durationInFrames={getUninstallTotalFrames()}
        fps={30}
        width={1920}
        height={1080}
      />
      {/* Deep-dive capabilities tour — 10 scenes covering the full surface of
       * what Flat-Out can do (voice, vision, edit, brand pack, comms, NLEs,
       * memory + style, on-location, MCP). */}
      <Composition
        id="FlatOutCapabilities"
        component={FlatOutCapabilities}
        durationInFrames={getCapabilitiesTotalFrames()}
        fps={30}
        width={1920}
        height={1080}
      />
      {/* Vertical 9:16 social cut for TikTok / Reels / Shorts. ~25s, hook-first
       * pacing, big stacked typography, brand-red cut flashes. */}
      <Composition
        id="FlatOutTikTok"
        component={FlatOutTikTok}
        durationInFrames={getTikTokTotalFrames()}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
