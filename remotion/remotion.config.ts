/** remotion.config.ts — render config for the Flat-Out video.
 *
 *  Why H.264 + AAC + 30fps: the final lands in ~/Downloads as a Mac-default-friendly
 *  MP4 the operator can drop into Premiere, send to clients, or upload to YouTube
 *  without re-encoding. Quality "high" + crf 18 = visually lossless at 1920x1080
 *  while keeping the file size under ~50 MB for a 2-3 min runtime.
 */
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.setConcurrency(4);
Config.setCodec('h264');
Config.setCrf(18);
