/**
 * ffmpeg-static exports the path to the ffmpeg binary it downloaded for this
 * platform, or null when it has none for it. It ships no types of its own.
 */
declare module 'ffmpeg-static' {
  const path: string | null;
  export default path;
}
