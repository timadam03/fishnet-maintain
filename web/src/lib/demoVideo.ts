/**
 * The demo video shown in the robot window: a recorded run of one robot in the Isaac simulation.
 *
 * Put the file at `web/public/videos/robot-demo.mp4` (H.264 MP4 plays everywhere; 1280×720 or
 * larger stays sharp when the window zooms to the full stage). Video files are not committed: see
 * `web/public/videos/README.md`. Without the file, the window falls back to the drawn feed.
 */
export const DEMO_VIDEO = {
  src: '/videos/robot-demo.mp4',
  /** Pens whose drones play the video; null means every drone. */
  pens: null as number[] | null,
};
